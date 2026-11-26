import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reviewDraftSignature,
  type SyncDraft,
  type SyncState,
} from "@roughdraft/rfm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparisonOperations } from "./comparison-operations.js";
import type { Comparison } from "./comparisons.js";
import { createApp } from "./index.js";

describe("guarded live review reconciliation", () => {
  const parent = fileURLToPath(
    new URL("../../../.test-tmp/backend-sync/", import.meta.url),
  );
  let root: string;
  let target: string;
  let host: ReturnType<typeof createApp>;
  const original = "# Notes\n\nFirst paragraph.\n\nSecond paragraph.\n";
  const api = () => request(host.app);
  const freshHost = (documentRoot?: string) =>
    createApp({
      homeDir: root,
      comparisonsDir: path.join(root, "comparisons"),
      staticDirPath: root,
      ...(documentRoot ? { assetRoot: documentRoot } : {}),
    });
  const draft = (state: SyncState<Comparison>, text: string): SyncDraft => ({
    ...state.draft,
    markdown: text,
    cleanMarkdown: text,
  });
  const operation = (
    state: SyncState<Comparison>,
    id: string,
    page = "page-a",
    sequence = 1,
  ) => ({
    operationId: id,
    pageInstanceId: page,
    operationSequence: sequence,
    operationContext: state.operationContext,
  });
  const payload = (
    state: SyncState<Comparison>,
    next: SyncDraft,
    id: string,
    page = "page-a",
    sequence = 1,
  ) => ({
    ...operation(state, id, page, sequence),
    expectedRevision: state.revision,
    baseRevision: state.revision,
    baseSignature: state.signature,
    base: state.draft,
    draft: next,
    expectedDisk: state.disk
      ? {
          path: state.disk.path,
          version: state.disk.version,
          hash: state.disk.hash,
        }
      : null,
    localGeneration: sequence,
    reason: "sync",
    writeFile: true,
  });
  const open = async (autosave = target) => {
    const result = await api()
      .post("/api/comparisons/document")
      .send({ targetPath: target, autosave });
    expect(result.status).toBe(201);
    const state = await api().get(`/api/comparisons/${result.body.id}/state`);
    expect(state.status).toBe(200);
    return state.body as SyncState<Comparison>;
  };

  beforeEach(() => {
    fs.mkdirSync(parent, { recursive: true });
    root = fs.mkdtempSync(path.join(parent, "run-"));
    target = path.join(root, "notes.md");
    fs.writeFileSync(target, original);
    host = freshHost();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    host.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rebases two stale independent saves and replays the exact outcome without another write", async () => {
    const base = await open();
    const route = `/api/comparisons/${base.review.id}/reconcile`;
    const first = await api()
      .post(route)
      .send(
        payload(
          base,
          draft(base, original.replace("First", "Edited first")),
          "first",
        ),
      );
    expect(first.body.status).toBe("committed");
    const body = payload(
      base,
      draft(base, original.replace("Second", "Edited second")),
      "second",
      "page-b",
    );
    let second = await api().post(route).send(body);
    if (second.body.status === "client-merge-required") {
      const current = second.body.state as SyncState<Comparison>;
      const candidate = original
        .replace("First", "Edited first")
        .replace("Second", "Edited second");
      second = await api()
        .post(route)
        .send({
          ...payload(
            current,
            draft(current, candidate),
            "second-reserved",
            "page-b",
            2,
          ),
          reservationToken: second.body.reservation.token,
        });
      Object.assign(body, {
        operationId: "second-reserved",
        operationSequence: 2,
      });
    }
    expect(second.body.status).toBe("committed");
    expect(second.body.state.draft.markdown).toContain("Edited first");
    expect(second.body.state.draft.markdown).toContain("Edited second");
    const inode = fs.statSync(target).ino;
    expect(fs.readFileSync(target, "utf8")).toBe(
      second.body.state.draft.cleanMarkdown,
    );
    const repeated = await api().post(route).send(body);
    expect(repeated.body.state.signature).toBe(second.body.state.signature);
    expect(repeated.body.state.revision).toBe(second.body.state.revision);
    expect(fs.statSync(target).ino).toBe(inode);
  });

  it("retains annotated review data while rejecting actual publication without a clean projection", async () => {
    const base = await open();
    const next = {
      ...base.draft,
      markdown: "{++Unaccepted proposal++}{#s1}\n",
    };
    const body = payload(base, next, "missing-projection");
    const saved = await api()
      .post(`/api/comparisons/${base.review.id}/reconcile`)
      .send(body);
    expect(saved.body.status).toBe("rejected");
    expect(saved.body.message).toContain("exclude pending suggestions");
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(
      (
        await api()
          .post(`/api/comparisons/${base.review.id}/reconcile`)
          .send(body)
      ).body.status,
    ).toBe("rejected");
  });

  it("roundtrips the unchanged complex annotated source state without changing its canonical signature or file", async () => {
    const fixture = fs.readFileSync(
      new URL("../../../docs/spec/fixtures/editing-review.md", import.meta.url),
      "utf8",
    );
    fs.writeFileSync(target, fixture);
    const base = await open();
    expect(base.draft.markdown).toBe(fixture);
    expect(base.signature).toBe(reviewDraftSignature(base.draft));
    const inode = fs.statSync(target).ino;
    const saved = await api()
      .post(`/api/comparisons/${base.review.id}/reconcile`)
      .send({
        ...payload(base, base.draft, "complex-identical"),
        writeFile: false,
      });
    expect(saved.body.status).toBe("committed");
    expect(saved.body.state.signature).toBe(base.signature);
    expect(saved.body.state.draft).toEqual(base.draft);
    expect(fs.readFileSync(target, "utf8")).toBe(fixture);
    expect(fs.statSync(target).ino).toBe(inode);
  });

  it("does not acknowledge an agent's newer file write observed after publication", async () => {
    const base = await open();
    const rename = fs.renameSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (to === target && !replaced) {
        replaced = true;
        fs.writeFileSync(target, "Agent D2, after our publication");
      }
    });
    const saved = await api()
      .post(`/api/comparisons/${base.review.id}/reconcile`)
      .send(payload(base, draft(base, "Browser D1"), "d1-d2"));
    expect(saved.body.status).toBe("incoming-changed");
    expect(saved.body.state.review.savedText).toBe(original);
    expect(saved.body.state.disk.text).toBe("Agent D2, after our publication");
    expect(fs.readFileSync(target, "utf8")).toBe(
      "Agent D2, after our publication",
    );
  });

  it("settles the inspected overlap while unrelated remote edits continue", async () => {
    const base = await open();
    const route = `/api/comparisons/${base.review.id}/reconcile`;
    const first = await api()
      .post(route)
      .send(
        payload(
          base,
          draft(base, original.replace("First", "Incoming first")),
          "conflict-first",
        ),
      );
    expect(first.body.status).toBe("committed");
    const local = draft(
      base,
      `${original.replace("First", "Local first")}\nLocal independent text.\n`,
    );
    const conflicted = await api()
      .post(route)
      .send(payload(base, local, "conflict-local", "page-b"));
    expect(conflicted.body.status).toBe("conflict");
    const signature = conflicted.body.merge.signature;
    const unrelated = await api()
      .post(route)
      .send(
        payload(
          first.body.state,
          draft(
            first.body.state,
            first.body.state.draft.markdown.replace(
              "Second",
              "Incoming second",
            ),
          ),
          "conflict-unrelated",
          "page-a",
          2,
        ),
      );
    expect(unrelated.body.status).toBe("committed");
    const settled = await api()
      .post(route)
      .send({
        ...payload(base, local, "conflict-resolved", "page-b", 2),
        reason: "resolve",
        resolution: { choice: "incoming", signature },
      });
    expect(settled.body.status).toBe("committed");
    expect(settled.body.state.draft.markdown).toContain("Incoming first");
    expect(settled.body.state.draft.markdown).toContain("Incoming second");
    expect(settled.body.state.draft.markdown).toContain(
      "Local independent text",
    );
    expect(settled.body.state.review.recoveryCheckpoints).toHaveLength(2);
  });

  it("requires browser renumbering for a new suggestion ID collision without partially installing it", async () => {
    const base = await open("none");
    const route = `/api/comparisons/${base.review.id}/reconcile`;
    const annotated = (word: string): SyncDraft => ({
      ...base.draft,
      cleanMarkdown: original,
      markdown: original.replace("First", `First {++${word}++}{#s13}`),
    });
    const a = await api()
      .post(route)
      .send({
        ...payload(base, annotated("A"), "suggest-a"),
        writeFile: false,
      });
    expect(a.body.status).toBe("committed");
    const b = await api()
      .post(route)
      .send({
        ...payload(base, annotated("B"), "suggest-b", "page-b"),
        writeFile: false,
      });
    expect(b.body.status).toBe("client-merge-required");
    expect(b.body.state.draft.markdown).toBe(annotated("A").markdown);
    expect(b.body.state.signature).toBe(a.body.state.signature);
    expect(b.body.idRemap).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("checks operation status without writing and fences a late original before resuming under a new ID", async () => {
    const state = await open();
    const identity = operation(state, "delayed");
    const before = fs
      .readdirSync(path.join(root, "comparisons", "operations"))
      .sort();
    const read = await api().get("/api/comparisons/operations/delayed");
    expect(read.body.status).toBe("indeterminate");
    expect(
      fs.readdirSync(path.join(root, "comparisons", "operations")).sort(),
    ).toEqual(before);
    const resolved = await api()
      .post("/api/comparisons/operations/delayed/resolve")
      .send({ ...identity, reviewId: state.review.id });
    expect(resolved.body.status).toBe("not-received");
    const late = await api()
      .post(`/api/comparisons/${state.review.id}/reconcile`)
      .send(payload(state, draft(state, "Late text"), "delayed"));
    expect(late.body.status).toBe("not-received");
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    const resumed = await api()
      .post(`/api/comparisons/${state.review.id}/reconcile`)
      .send(
        payload(state, draft(state, "Exactly once"), "resumed", "page-a", 2),
      );
    expect(resumed.body.status).toBe("committed");
    expect(fs.readFileSync(target, "utf8")).toBe("Exactly once");
  });

  it("never calls a committed operation not-received when its journal payload disappears", async () => {
    const base = await open();
    const saved = await api()
      .post(`/api/comparisons/${base.review.id}/reconcile`)
      .send(payload(base, draft(base, "Already committed"), "lost-result"));
    expect(saved.body.status).toBe("committed");
    fs.rmSync(path.join(root, "comparisons", "operations", "lost-result.json"));
    const result = await api()
      .post("/api/comparisons/operations/lost-result/resolve")
      .send({ ...operation(base, "lost-result"), reviewId: base.review.id });
    expect(result.body.status).toBe("indeterminate");
    expect(fs.readFileSync(target, "utf8")).toBe("Already committed");
  });

  it("bounds abandoned-page review markers after durable exact pruning while preserving pending and newer outcomes", async () => {
    host.dispose();
    let elapsed = 0;
    const start = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => start + elapsed);
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    host = freshHost();
    const base = await open("none");
    const route = `/api/comparisons/${base.review.id}`;
    const saved = await api()
      .post(`${route}/reconcile`)
      .send({
        ...payload(base, base.draft, "abandoned-result", "closed-page"),
        writeFile: false,
      });
    expect(saved.body.status).toBe("committed");
    const operations = new ComparisonOperations(
      path.join(root, "comparisons"),
      path.join(root, ".roughdraft"),
    );
    const pendingOperation = {
      operationId: "old-unresolved",
      pageInstanceId: "pending-page",
      operationSequence: 1,
      operationContext: operations.context(),
    };
    operations.begin(pendingOperation, base.review.id);

    elapsed += 8 * 24 * 60 * 60 * 1000;
    const current = (await api().get(`${route}/state`))
      .body as SyncState<Comparison>;
    const newer = await api()
      .post(`${route}/reconcile`)
      .send({
        ...payload(current, current.draft, "newer-result", "active-page"),
        writeFile: false,
      });
    expect(newer.body.status).toBe("committed");
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(root, "comparisons", `${base.review.id}.json`),
        "utf8",
      ),
    );
    expect(stored.operationOutcomes["closed-page"]).toBeUndefined();
    expect(stored.operationOutcomes["active-page"].id).toBe("newer-result");
    expect(
      (await api().get("/api/comparisons/operations/old-unresolved")).body
        .status,
    ).toBe("publishing");
    expect(
      (
        await api()
          .post("/api/comparisons/operations/abandoned-result/resolve")
          .send({
            ...operation(base, "abandoned-result", "closed-page"),
            reviewId: base.review.id,
          })
      ).body.status,
    ).toBe("indeterminate");
    expect(
      (
        await api()
          .post("/api/comparisons/operations/never-received-hole/resolve")
          .send({
            ...operation(base, "never-received-hole", "closed-page", 2),
            reviewId: base.review.id,
          })
      ).body.status,
    ).toBe("not-received");
    expect(
      (await api().get("/api/comparisons/operations/newer-result")).body.status,
    ).toBe("committed");
  });

  it("resolves expired never-received operations and retains a committed unacknowledged result over restart", async () => {
    const state = await open();
    const expired = {
      ...operation(state, "offline"),
      operationContext: {
        ...state.operationContext,
        acceptUntil: Date.now() - 240_000,
      },
    };
    expect(
      (
        await api()
          .post("/api/comparisons/operations/offline/resolve")
          .send({ ...expired, reviewId: state.review.id })
      ).body.status,
    ).toBe("not-received");
    const committed = await api()
      .post(`/api/comparisons/${state.review.id}/reconcile`)
      .send(
        payload(
          state,
          draft(state, "Committed before restart"),
          "saved",
          "page-b",
        ),
      );
    expect(committed.body.status).toBe("committed");
    host.dispose();
    host = freshHost();
    const result = await api()
      .post("/api/comparisons/operations/saved/resolve")
      .send({
        ...operation(state, "saved", "page-b"),
        reviewId: state.review.id,
      });
    expect(result.body.status).toBe("committed");
    expect(result.body.state.draft.markdown).toBe("Committed before restart");
    expect(result.body.state.operationContext.epoch).not.toBe(
      state.operationContext.epoch,
    );
    const missed = await api()
      .post("/api/comparisons/operations/pre-restart/resolve")
      .send({
        ...operation(state, "pre-restart", "page-c"),
        reviewId: state.review.id,
      });
    expect(missed.body.status).toBe("not-received");
  });

  it("offers a browser merge turn for large stale documents and accepts its exact-base candidate", async () => {
    const text = `${original}\n${"Unchanged paragraph.\n\n".repeat(3000)}`;
    fs.writeFileSync(target, text);
    const base = await open();
    const route = `/api/comparisons/${base.review.id}/reconcile`;
    const aText = text.replace("First", "A first");
    const a = await api()
      .post(route)
      .send(payload(base, draft(base, aText), "large-a"));
    expect(a.body.status).toBe("committed");
    const bText = text.replace("Second", "B second");
    const b = await api()
      .post(route)
      .send(payload(base, draft(base, bText), "large-b", "page-b"));
    expect(b.body.status).toBe("client-merge-required");
    expect(b.body.reservation.expiresAt - Date.now()).toBeLessThanOrEqual(750);
    const blocked = await api()
      .post(route)
      .send(
        payload(
          a.body.state,
          draft(a.body.state, `${aText}C`),
          "large-c",
          "page-c",
        ),
      );
    expect(blocked.body.status).toBe("retry-later");
    const current = b.body.state as SyncState<Comparison>;
    const candidate = aText.replace("Second", "B second");
    const merged = await api()
      .post(route)
      .send({
        ...payload(
          current,
          draft(current, candidate),
          "large-b-merged",
          "page-b",
          2,
        ),
        reservationToken: b.body.reservation.token,
      });
    expect(merged.body.status).toBe("committed");
    expect(fs.readFileSync(target, "utf8")).toBe(candidate);
  });

  it("keeps a new outside disk write guarded, then records an explicit no-file adoption", async () => {
    const base = await open("none");
    expect(base.disk?.path).toBe(target);
    fs.writeFileSync(target, "New agent text");
    const stale = await api()
      .post(`/api/comparisons/${base.review.id}/reconcile`)
      .send(payload(base, draft(base, "My queued text"), "stale"));
    expect(stale.body.status).toBe("incoming-changed");
    const current = stale.body.state as SyncState<Comparison>;
    const adopted = await api()
      .post(`/api/comparisons/${base.review.id}/reconcile`)
      .send({
        ...payload(
          current,
          draft(current, "New agent text"),
          "adopt",
          "page-a",
          2,
        ),
        reason: "adopt",
        writeFile: false,
      });
    expect(adopted.body.status).toBe("committed");
    expect(adopted.body.state.review.autosave).toBe("none");
    expect(adopted.body.state.review.savedText).toBe("New agent text");
    expect(fs.readFileSync(target, "utf8")).toBe("New agent text");
    expect(
      (
        await api()
          .post("/api/comparisons/document")
          .send({ targetPath: target, autosave: "none" })
      ).body.id,
    ).toBe(base.review.id);
  });

  it("sends merged feedback and adopts inspected source text without writing the file", async () => {
    const base = await open("none");
    const route = `/api/comparisons/${base.review.id}`;
    const first = await api()
      .post(`${route}/reconcile`)
      .send({
        ...payload(
          base,
          {
            ...base.draft,
            reviewComments: [
              {
                id: "c1",
                changeId: "document",
                content: "Other tab feedback",
                createdAt: "2026-11-26T17:00:00.000Z",
              },
            ],
          },
          "send-comment",
        ),
        writeFile: false,
      });
    expect(first.body.status).toBe("committed");
    const sent = await api()
      .post(`${route}/send`)
      .send({
        ...payload(
          base,
          draft(base, "Queued sender text"),
          "send-stale",
          "page-b",
        ),
        comment: "Ready for agent",
      });
    expect(sent.body.status).toBe("committed");
    expect(sent.body.state.review.feedback.reviewComments[0].content).toBe(
      "Other tab feedback",
    );
    expect(sent.body.state.review.feedback.draft.markdown).toBe(
      "Queued sender text",
    );
    expect(sent.body.state.review.feedback.saved).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(original);

    fs.writeFileSync(target, "New agent source");
    const readIncoming = await api()
      .post(`${route}/reconcile`)
      .send({
        ...payload(
          sent.body.state,
          sent.body.state.draft,
          "inspect-new-source",
          "page-b",
          2,
        ),
        writeFile: false,
      });
    expect(readIncoming.body.status).toBe("incoming-changed");
    const current = readIncoming.body.state as SyncState<Comparison>;
    const inode = fs.statSync(target).ino;
    const adopted = await api()
      .post(`${route}/send`)
      .send({
        ...payload(
          current,
          draft(current, "New agent source"),
          "send-adopt",
          "page-b",
          3,
        ),
        reason: "adopt",
      });
    expect(adopted.body.status).toBe("committed");
    expect(adopted.body.state.review.savedText).toBe("New agent source");
    expect(adopted.body.state.review.feedback.saved).toBe(true);
    expect(fs.statSync(target).ino).toBe(inode);
  });

  it("guards binding and handoff by their changed fields, preserves newer text, and replays binding exactly", async () => {
    const base = await open();
    const route = `/api/comparisons/${base.review.id}`;
    const edited = await api()
      .post(`${route}/reconcile`)
      .send(payload(base, draft(base, "Newer editor text"), "before-settings"));
    expect(edited.body.status).toBe("committed");
    const handoff = await api().post(`${route}/handoff`).send({
      revision: base.revision,
      expectedHandoff: base.review.handoff,
      handoff: "button",
    });
    expect(handoff.status).toBe(200);
    expect(handoff.body.draft.markdown).toBe("Newer editor text");
    const lateHandoff = await api()
      .post(`${route}/handoff`)
      .send({ expectedHandoff: base.review.handoff, handoff: "chat" });
    expect(lateHandoff.status).toBe(409);
    const body = {
      ...operation(base, "binding-none"),
      expectedPath: target,
      path: "none",
    };
    const rebound = await api().post(`${route}/binding`).send(body);
    expect(rebound.body.status).toBe("committed");
    expect(rebound.body.state.review.autosave).toBe("none");
    expect(rebound.body.state.draft.markdown).toBe("Newer editor text");
    const replay = await api().post(`${route}/binding`).send(body);
    expect(replay.body.state.revision).toBe(rebound.body.state.revision);
    const wrong = await api()
      .post(`${route}/binding`)
      .send({
        ...body,
        operationId: "binding-stale",
        operationSequence: 2,
        path: path.join(root, "other.md"),
        expectedVersion: null,
      });
    expect(wrong.body.status).toBe("binding-changed");
    expect(fs.existsSync(path.join(root, "other.md"))).toBe(false);
  });

  it("creates an exclusive separate file and complete review while preserving original identity and checkpoint", async () => {
    const base = await open();
    const next = {
      ...draft(base, "Saved separately"),
      reviewComments: [
        {
          id: "c1",
          changeId: "document",
          content: "Keep this feedback",
          createdAt: "2026-11-26T17:00:00.000Z",
          scope: "document" as const,
        },
      ],
    };
    const originalBytes = fs.readFileSync(
      path.join(root, "comparisons", `${base.review.id}.json`),
      "utf8",
    );
    const checkpoint = await api()
      .post(`/api/comparisons/${base.review.id}/checkpoint`)
      .send({
        pageInstanceId: "page-a",
        conflictId: "overlap",
        generation: 3,
        workingDraft: next,
        uiDrafts: { reply: "Unfinished" },
      });
    expect(checkpoint.body.checkpointId).toBeTruthy();
    expect(
      fs.readFileSync(
        path.join(root, "comparisons", `${base.review.id}.json`),
        "utf8",
      ),
    ).toBe(originalBytes);
    const destination = await api().get(
      `/api/comparisons/${base.review.id}/copy-destination`,
    );
    expect(destination.body.allowed).toBe(true);
    const body = {
      ...operation(base, "copy"),
      generation: 3,
      workingDraft: next,
      path: destination.body.displayPath,
      relativeLinksAcknowledged: true,
      conflictCheckpointId: checkpoint.body.checkpointId,
      uiDrafts: { reply: "Unfinished" },
    };
    const copied = await api()
      .post(`/api/comparisons/${base.review.id}/copy`)
      .send(body);
    expect(copied.body.status).toBe("committed");
    expect(copied.body.savedPath).toBe(destination.body.path);
    expect(copied.body.state.draft.reviewComments).toEqual(next.reviewComments);
    expect(copied.body.uiDrafts).toEqual({ reply: "Unfinished" });
    expect(fs.readFileSync(copied.body.canonicalPath, "utf8")).toBe(
      "Saved separately",
    );
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    const again = await api()
      .post(`/api/comparisons/${base.review.id}/copy`)
      .send(body);
    expect(again.body.state.review.id).toBe(copied.body.state.review.id);
    const reopenOriginal = await api()
      .post("/api/comparisons/document")
      .send({ targetPath: target });
    expect(reopenOriginal.body.id).toBe(base.review.id);
    const reopenCopy = await api()
      .post("/api/comparisons/document")
      .send({ targetPath: copied.body.canonicalPath });
    expect(reopenCopy.body.id).toBe(copied.body.state.review.id);
    const metadata = (
      await api().get(`/api/comparisons/${base.review.id}/state`)
    ).body.review.recoveryCheckpoints;
    expect(metadata[0]).toMatchObject({
      savedCopyId: copied.body.state.review.id,
    });
  });

  it("keeps unfinished feedback discoverable on a separate review after copy-result acknowledgment and pruning", async () => {
    const base = await open();
    const next = {
      ...base.draft,
      reviewComments: [
        {
          id: "c1",
          changeId: "document",
          content: "Existing comment",
          createdAt: "2026-11-26T17:00:00.000Z",
        },
      ],
    };
    const uiDrafts = {
      comments: {
        c1: {
          value: "Unfinished reply for the agent",
          original: "Existing comment",
          editing: true,
        },
      },
    };
    const destination = path.join(root, "feedback-copy.md");
    const copied = await api()
      .post(`/api/comparisons/${base.review.id}/copy`)
      .send({
        ...operation(base, "feedback-copy"),
        generation: 1,
        workingDraft: next,
        path: destination,
        relativeLinksAcknowledged: true,
        uiDrafts,
      });
    expect(copied.body.status).toBe("committed");
    let current = copied.body.state as SyncState<Comparison>;
    let previous = "feedback-copy";
    for (let sequence = 2; sequence <= 21; sequence++) {
      const id = `feedback-ack-${sequence}`;
      const saved = await api()
        .post(`/api/comparisons/${current.review.id}/reconcile`)
        .send({
          ...payload(current, current.draft, id, "page-a", sequence),
          writeFile: false,
          acknowledgedOperationIds: [previous],
        });
      expect(saved.body.status).toBe("committed");
      current = saved.body.state;
      previous = id;
    }
    expect(
      fs.existsSync(
        path.join(root, "comparisons", "operations", "feedback-copy.json"),
      ),
    ).toBe(false);
    host.dispose();
    host = freshHost();
    const review = (await api().get(`/api/comparisons/${current.review.id}`))
      .body;
    const metadata = review.recoveryCheckpoints?.find(
      (entry: { reason: string }) =>
        entry.reason === "Unfinished feedback saved with separate copy",
    );
    expect(metadata).toBeDefined();
    expect(metadata.uiDrafts).toEqual(uiDrafts);
    expect(metadata.entryUiDrafts).toEqual(uiDrafts);
    const preserved = (
      await api().get(
        `/api/comparisons/${current.review.id}/checkpoints/${metadata.id}`,
      )
    ).body;
    expect(preserved.uiDrafts).toEqual(uiDrafts);
    expect(preserved.entryUiDrafts).toEqual(uiDrafts);
    expect(preserved.workingDraft).toEqual(next);
    expect(review.reviewComments).toEqual(next.reviewComments);
    expect(fs.readFileSync(destination, "utf8")).not.toContain(
      "Unfinished reply",
    );
    const descendants = (await api().get(`/api/comparisons/${base.review.id}`))
      .body.recoveredReviews;
    expect(
      descendants.find(
        (entry: { id: string }) => entry.id === current.review.id,
      ).recoveryCheckpoints,
    ).toContainEqual(expect.objectContaining({ id: metadata.id, uiDrafts }));
  });

  it("retains conflict-entry unfinished feedback separately from newer feedback and working text", async () => {
    const base = await open("none");
    const route = `/api/comparisons/${base.review.id}`;
    const entryUiDrafts = {
      comments: {
        c1: {
          value: "Initial unfinished feedback",
          original: "Comment",
          editing: true,
        },
      },
    };
    const latestUiDrafts = {
      comments: {
        c1: {
          value: "Latest unfinished feedback",
          original: "Comment",
          editing: true,
        },
      },
    };
    const checkpoint = await api().post(`${route}/checkpoint`).send({
      pageInstanceId: "page-a",
      conflictId: "overlapping-text",
      generation: 1,
      workingDraft: base.draft,
      uiDrafts: entryUiDrafts,
    });
    const latestDraft = draft(base, "Newer working text");
    const updated = await api().post(`${route}/checkpoint`).send({
      pageInstanceId: "page-a",
      conflictId: "overlapping-text",
      generation: 2,
      workingDraft: latestDraft,
      uiDrafts: latestUiDrafts,
    });
    expect(updated.body.checkpointId).toBe(checkpoint.body.checkpointId);
    const saved = (
      await api().get(`${route}/checkpoints/${checkpoint.body.checkpointId}`)
    ).body;
    expect(saved.entryDraft).toEqual(base.draft);
    expect(saved.entryUiDrafts).toEqual(entryUiDrafts);
    expect(saved.workingDraft).toEqual(latestDraft);
    expect(saved.uiDrafts).toEqual(latestUiDrafts);
    await api().post(`${route}/checkpoint`).send({
      pageInstanceId: "page-a",
      conflictId: "overlapping-text",
      generation: 1,
      workingDraft: base.draft,
      uiDrafts: entryUiDrafts,
    });
    expect(
      (await api().get(`${route}/checkpoints/${checkpoint.body.checkpointId}`))
        .body,
    ).toEqual(saved);
  });

  it("returns root-relative paths, warns about moved links, and rejects existing copies", async () => {
    host.dispose();
    host = freshHost(root);
    fs.writeFileSync(
      target,
      "[Guide](guide.md)\n\n![Picture](images/photo.png)\n\n```md\n[Literal](ignore.md)\n```\n",
    );
    fs.mkdirSync(path.join(root, "copies"));
    const base = await open();
    const selected = await api()
      .get(`/api/comparisons/${base.review.id}/copy-destination`)
      .query({ path: "Documents/copies/review.md" });
    expect(selected.body).toMatchObject({
      allowed: true,
      displayPath: "Documents/copies/review.md",
      relativeLinks: ["guide.md", "images/photo.png"],
    });
    const body = {
      ...operation(base, "root-copy"),
      generation: 1,
      workingDraft: base.draft,
      path: selected.body.displayPath,
      relativeLinksAcknowledged: false,
    };
    const warning = await api()
      .post(`/api/comparisons/${base.review.id}/copy`)
      .send(body);
    expect(warning.body.status).toBe("rejected");
    expect(fs.existsSync(selected.body.path)).toBe(false);
    const copied = await api()
      .post(`/api/comparisons/${base.review.id}/copy`)
      .send({
        ...body,
        operationId: "root-copy-confirmed",
        operationSequence: 2,
        relativeLinksAcknowledged: true,
      });
    expect(copied.body.status).toBe("committed");
    expect(copied.body.savedPath).toBe("Documents/copies/review.md");
    expect(
      (
        await api()
          .get(`/api/comparisons/${base.review.id}/copy-destination`)
          .query({ path: copied.body.savedPath })
      ).body.allowed,
    ).toBe(false);
  });

  it("requires a retained inode witness before adopting an identical interrupted copy", async () => {
    const base = await open();
    const destination = path.join(root, "separate.md");
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (to === destination)
        throw Object.assign(new Error("Publication stopped"), { code: "EIO" });
      link(from, to);
    });
    const result = await api()
      .post(`/api/comparisons/${base.review.id}/copy`)
      .send({
        ...operation(base, "unpublished-copy"),
        generation: 1,
        workingDraft: draft(base, "Identical bytes"),
        path: destination,
        relativeLinksAcknowledged: true,
      });
    expect(result.body.status).toBe("publishing");
    vi.restoreAllMocks();
    const operationFile = path.join(
      root,
      "comparisons",
      "operations",
      "unpublished-copy.json",
    );
    const record = JSON.parse(fs.readFileSync(operationFile, "utf8"));
    const reviewFile = path.join(
      root,
      "comparisons",
      `${record.reviewId}.json`,
    );
    const interrupted = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
    fs.writeFileSync(destination, "Identical bytes");
    const stat = fs.statSync(destination);
    // Model an abandoned staging inode being reused by another creator. A bare
    // device/inode equality cannot establish publication ownership after this.
    interrupted.pendingPublication.publishedIdentity = {
      device: stat.dev,
      inode: stat.ino,
      inPlace: false,
    };
    fs.writeFileSync(reviewFile, JSON.stringify(interrupted));
    const recovered = await api()
      .post("/api/comparisons/operations/unpublished-copy/resolve")
      .send({
        ...operation(base, "unpublished-copy"),
        reviewId: base.review.id,
      });
    expect(recovered.body.status).toBe("rejected");
    expect(recovered.body.checkpointId).toBeTruthy();
    expect(fs.readFileSync(destination, "utf8")).toBe("Identical bytes");
  });

  it.each([
    [false, "before-file"],
    [false, "after-file"],
    [false, "before-review"],
    [false, "after-outcome"],
    [true, "before-file"],
    [true, "after-file"],
    [true, "before-review"],
    [true, "after-outcome"],
  ] as const)("recovers an entire draft across publication interruption (copy=%s, stage=%s)", async (copy, stage) => {
    const base = await open();
    const filename = copy ? path.join(root, "crash-copy.md") : target;
    const operationId = `barrier-${copy}-${stage}`;
    const next: SyncDraft = {
      ...draft(base, "Complete recovered text"),
      reviewComments: [
        {
          id: "c1",
          changeId: "document",
          content: "Complete recovered feedback",
          createdAt: "2026-11-26T17:00:00.000Z",
          scope: "document",
        },
      ],
    };
    let interrupted = false;
    const stop = () => {
      interrupted = true;
      throw Object.assign(new Error(`Stopped at ${stage}`), { code: "EIO" });
    };
    const rename = fs.renameSync.bind(fs);
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!interrupted && !copy && to === filename && stage === "before-file")
        stop();
      if (
        !interrupted &&
        stage === "before-review" &&
        typeof to === "string" &&
        path.dirname(to) === path.join(root, "comparisons") &&
        to.endsWith(".json")
      ) {
        const pending = JSON.parse(fs.readFileSync(from, "utf8"));
        if (pending.operationOutcomes?.["page-a"]?.id === operationId) stop();
      }
      rename(from, to);
      if (!interrupted && !copy && to === filename && stage === "after-file")
        stop();
      if (
        !interrupted &&
        to ===
          path.join(root, "comparisons", "operations", `${operationId}.json`) &&
        stage === "after-outcome"
      ) {
        const saved = JSON.parse(fs.readFileSync(to, "utf8"));
        if (saved.phase === "done") stop();
      }
    });
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (!interrupted && copy && to === filename && stage === "before-file")
        stop();
      link(from, to);
      if (!interrupted && copy && to === filename && stage === "after-file")
        stop();
    });
    if (copy)
      await api()
        .post(`/api/comparisons/${base.review.id}/copy`)
        .send({
          ...operation(base, operationId),
          generation: 1,
          workingDraft: next,
          path: filename,
          relativeLinksAcknowledged: true,
          uiDrafts: { reply: "Unsent reply" },
        });
    else
      await api()
        .post(`/api/comparisons/${base.review.id}/reconcile`)
        .send(payload(base, next, operationId));
    expect(interrupted).toBe(true);
    vi.restoreAllMocks();
    const record = JSON.parse(
      fs.readFileSync(
        path.join(root, "comparisons", "operations", `${operationId}.json`),
        "utf8",
      ),
    );
    const reviewFile = path.join(
      root,
      "comparisons",
      `${record.reviewId}.json`,
    );
    const beforeGet = fs.readFileSync(reviewFile, "utf8");
    host.dispose();
    host = freshHost();
    expect(
      (await api().get(`/api/comparisons/${record.reviewId}/state`)).status,
    ).toBe(200);
    expect(fs.readFileSync(reviewFile, "utf8")).toBe(beforeGet);
    const result = await api()
      .post(`/api/comparisons/operations/${operationId}/resolve`)
      .send({
        ...operation(base, operationId),
        reviewId: base.review.id,
      });
    if (stage === "before-file") {
      expect(result.body.status).toBe("rejected");
      expect(result.body.checkpointId).toBeTruthy();
      const preserved = await api().get(
        `/api/comparisons/${record.reviewId}/checkpoints/${result.body.checkpointId}`,
      );
      expect(preserved.body.workingDraft).toEqual(next);
      if (copy) expect(fs.existsSync(filename)).toBe(false);
      else expect(fs.readFileSync(filename, "utf8")).toBe(original);
    } else {
      expect(result.body.status).toBe("committed");
      expect(result.body.state.draft).toEqual(next);
      expect(fs.readFileSync(filename, "utf8")).toBe(next.cleanMarkdown);
      if (copy) {
        expect(result.body.canonicalPath).toBe(filename);
        expect(result.body.uiDrafts).toEqual({ reply: "Unsent reply" });
      }
    }
    expect(
      fs.readdirSync(root).filter((name) => name.endsWith(".publication")),
    ).toEqual([]);
  });

  it("does not report a separate copy saved when a newer file edit arrives after publication", async () => {
    const base = await open();
    const destination = path.join(root, "copy-d2.md");
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      link(from, to);
      if (to === destination) fs.writeFileSync(destination, "New agent D2");
    });
    const copied = await api()
      .post(`/api/comparisons/${base.review.id}/copy`)
      .send({
        ...operation(base, "copy-d2"),
        generation: 1,
        workingDraft: draft(base, "Browser D1"),
        path: destination,
        relativeLinksAcknowledged: true,
      });
    expect(copied.body.status).toBe("rejected");
    expect(fs.readFileSync(destination, "utf8")).toBe("New agent D2");
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("keeps History remapping and detached-comment fields through ordinary sync and old-client omission", async () => {
    const base = await open("none");
    const next: SyncDraft = {
      ...base.draft,
      reviewed: [
        {
          id: "history",
          decision: "accept",
          oldText: "old",
          newText: "new",
          inverse: [],
          guard: { from: 0, to: 0, slice: null },
          stale: true,
          staleReason: "needs-remap",
          unmappedSince: "origin:1",
          originSignature: "source",
        },
      ],
      reviewComments: [
        {
          id: "c1",
          changeId: "document",
          content: "Detached",
          createdAt: "2026-11-26T17:00:00.000Z",
          scope: "document",
          originalQuote: "Original passage",
          detachedReason: "Agent rewrote it",
        },
      ],
      outdatedSuggestions: [
        {
          id: "s1",
          originalText: "Old",
          proposedText: "New",
          reason: "Passage changed",
          createdAt: "2026-11-26T17:00:00.000Z",
          authorType: "ai",
          authorId: "agent",
        },
      ],
    };
    const saved = await api()
      .post(`/api/comparisons/${base.review.id}/reconcile`)
      .send({ ...payload(base, next, "metadata"), writeFile: false });
    expect(saved.body.status).toBe("committed");
    expect(saved.body.state.signature).toBe(reviewDraftSignature(next));
    const old = {
      ...next.reviewed![0],
      staleReason: undefined,
      unmappedSince: undefined,
      originSignature: undefined,
    };
    const oldComment = {
      ...next.reviewComments[0],
      originalQuote: undefined,
      detachedReason: undefined,
    };
    const legacy = await api()
      .post(`/api/comparisons/${base.review.id}/draft`)
      .send({
        revision: saved.body.state.revision,
        markdown: next.markdown,
        decisions: {},
        reviewed: [old],
        reviewComments: [oldComment],
      });
    expect(legacy.status).toBe(200);
    expect(legacy.body.draft.reviewed[0]).toMatchObject({
      staleReason: "needs-remap",
      originSignature: "source",
    });
    expect(legacy.body.reviewComments[0]).toMatchObject({
      originalQuote: "Original passage",
      detachedReason: "Agent rewrote it",
    });
    expect(legacy.body.outdatedSuggestions).toEqual(next.outdatedSuggestions);
  });
  it("retains the displaced snapshot and overwrite notice through later saves, legacy drafts and restart", async () => {
    const base = await open("none");
    const route = `/api/comparisons/${base.review.id}`;
    const incoming = await api()
      .post(`${route}/reconcile`)
      .send({
        ...payload(
          base,
          draft(base, original.replace("First", "Incoming first")),
          "notice-incoming",
          "peer",
        ),
        writeFile: false,
      });
    expect(incoming.body.status).toBe("committed");
    const local = draft(base, original.replace("First", "Local first"));
    const resolved = await api()
      .post(`${route}/reconcile`)
      .send({
        ...payload(
          incoming.body.state,
          local,
          "notice-overwrite",
          "resolver",
          2,
        ),
        reason: "resolve",
        resolution: {
          choice: "local",
          signature: "browser-inspected-conflict",
        },
        writeFile: false,
      });
    expect(resolved.body.status).toBe("committed");
    const notice = resolved.body.state.review.lastOverwrite;
    expect(notice).toMatchObject({
      operationId: "notice-overwrite",
      pageInstanceId: "resolver",
      displacedSignature: incoming.body.state.signature,
      checkpointId: expect.any(String),
    });
    const checkpoint = await api().get(
      `${route}/checkpoints/${notice.checkpointId}`,
    );
    expect(checkpoint.body.workingDraft).toEqual(incoming.body.state.draft);
    const next = resolved.body.state as SyncState<Comparison>;
    const ordinary = await api()
      .post(`${route}/reconcile`)
      .send({
        ...payload(
          next,
          draft(next, next.draft.markdown.replace("Second", "Later second")),
          "notice-later",
          "resolver",
          3,
        ),
        writeFile: false,
      });
    expect(ordinary.body.status).toBe("committed");
    expect(ordinary.body.state.review.lastOverwrite).toEqual(notice);
    const legacy = await api().post(`${route}/draft`).send({
      revision: ordinary.body.state.revision,
      markdown: ordinary.body.state.draft.markdown,
      decisions: {},
      reviewComments: [],
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body.lastOverwrite).toEqual(notice);
    host.dispose();
    host = freshHost();
    expect(
      (await api().get(`${route}/state`)).body.review.lastOverwrite,
    ).toEqual(notice);
    expect(
      (await api().get(`${route}/checkpoints/${notice.checkpointId}`)).body
        .workingDraft,
    ).toEqual(incoming.body.state.draft);
  });
});
