import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import type { Comparison, ComparisonSegment } from "./comparisons.js";

describe("file comparison reviews", () => {
  let root: string;
  let target: string;
  const before = "# Policy\r\n\r\nold first\r\nunchanged\r\nold last";
  const after = "# Policy\r\n\r\nnew first\r\nunchanged\r\nnew last";
  const api = () =>
    createApp({
      homeDir: root,
      comparisonsDir: path.join(root, "comparisons"),
      staticDirPath: root,
    }).app;
  const changes = (review: Comparison) =>
    review.segments.filter(
      (segment: ComparisonSegment) => segment.kind === "change",
    );
  const create = (mode = "proposal", extra = {}) =>
    request(api())
      .post("/api/comparisons")
      .send({
        mode,
        targetPath: target,
        beforeText: before,
        afterText: after,
        ...extra,
      });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-comparison-"));
    target = path.join(root, "AGENTS.md");
    fs.writeFileSync(target, before, { mode: 0o640 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists choices separately and only applies selected proposed blocks, preserving exact bytes and mode", async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.body.targetChanged).toBe(false);
    const blocks = changes(created.body);
    expect(blocks).toHaveLength(2);
    const selected = await request(api())
      .post(`/api/comparisons/${created.body.id}/decisions`)
      .send({
        revision: created.body.revision,
        comment: "Please preserve spacing",
        decisions: [
          { id: blocks[0].id, decision: "after", comment: "yes" },
          { id: blocks[1].id, decision: "before" },
        ],
      });
    expect(selected.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const reloaded = await request(api()).get(
      `/api/comparisons/${created.body.id}`,
    );
    expect(reloaded.body.comment).toBe("Please preserve spacing");
    expect(changes(reloaded.body)[0].comment).toBe("yes");
    const applied = await request(api())
      .post(`/api/comparisons/${created.body.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    expect(applied.body.completion).toMatchObject({
      fileWritten: true,
      targetPath: target,
      accepted: 1,
      reverted: 0,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(
      before.replace("old first", "new first"),
    );
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("keeps or reverts already-applied blocks without writing during selection", async () => {
    fs.writeFileSync(target, after);
    const review = (await create("applied")).body;
    const blocks = changes(review);
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: [
          { id: blocks[0].id, decision: "after" },
          { id: blocks[1].id, decision: "before" },
        ],
      });
    expect(selected.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe(after);
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    expect(applied.body.completion).toMatchObject({
      accepted: 1,
      reverted: 1,
      fileWritten: true,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(
      before.replace("old first", "new first"),
    );
  });

  it("blocks an unfinished selection and finishes without applying or changing the file", async () => {
    const review = (await create()).body;
    const incomplete = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: review.revision });
    expect(incomplete.status).toBe(409);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const finished = await request(api())
      .post(`/api/comparisons/${review.id}/complete`)
      .send({ revision: review.revision });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({
      status: "completed",
      completion: { fileWritten: false },
    });
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("rejects stale browser revisions without losing saved choices", async () => {
    const review = (await create()).body;
    const block = changes(review)[0];
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: [{ id: block.id, decision: "after" }],
      });
    expect(selected.status).toBe(200);
    const stale = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: [{ id: block.id, decision: "before" }],
      });
    expect(stale.status).toBe(409);
    const persisted = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(changes(persisted.body)[0].decision).toBe("after");
  });

  it("blocks newer destination edits, retains decisions, and refreshes explicitly", async () => {
    const review = (await create()).body;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block: ComparisonSegment) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const newer = `new heading\r\n${before}`;
    fs.writeFileSync(target, newer);
    const stale = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(stale.status).toBe(409);
    expect(fs.readFileSync(target, "utf8")).toBe(newer);
    const persisted = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(persisted.body.targetChanged).toBe(true);
    expect(
      changes(persisted.body).every(
        (block: ComparisonSegment) => block.decision === "after",
      ),
    ).toBe(true);
    const refreshed = await request(api())
      .post(`/api/comparisons/${review.id}/refresh`)
      .send({ revision: selected.body.revision });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.beforeText).toBe(newer);
    expect(refreshed.body.afterText).toBe(after);
    expect(refreshed.body.targetChanged).toBe(false);
    expect(
      changes(refreshed.body).filter(
        (block: ComparisonSegment) =>
          block.before === "old last" && block.after === "new last",
      )[0].decision,
    ).toBe("after");
    expect(
      changes(refreshed.body).some(
        (block: ComparisonSegment) => block.decision === "pending",
      ),
    ).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(newer);
  });

  it("never writes comparisons and converts only to an explicitly matching destination", async () => {
    const created = await create("compare", { targetPath: undefined });
    expect(created.status).toBe(201);
    const review = created.body;
    expect(review.targetPath).toBeNull();
    expect(
      (
        await request(api())
          .post(`/api/comparisons/${review.id}/apply`)
          .send({ revision: review.revision })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(api())
          .post(`/api/comparisons/${review.id}/decisions`)
          .send({
            revision: review.revision,
            decisions: [{ id: changes(review)[0].id, decision: "after" }],
          })
      ).status,
    ).toBe(400);
    const converted = await request(api())
      .post(`/api/comparisons/${review.id}/convert`)
      .send({ revision: review.revision, targetPath: target });
    expect(converted.status).toBe(201);
    expect(converted.body).toMatchObject({
      mode: "proposal",
      targetPath: target,
      status: "open",
    });
    expect(converted.body.id).not.toBe(review.id);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    fs.writeFileSync(target, "newer");
    expect(
      (
        await request(api())
          .post(`/api/comparisons/${review.id}/convert`)
          .send({ revision: review.revision, targetPath: target })
      ).status,
    ).toBe(409);
  });

  it("does not replay an applied write after restart or overwrite subsequent edits", async () => {
    const review = (await create()).body;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block: ComparisonSegment) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    fs.writeFileSync(target, "later independent edit");
    const repeated = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(repeated.status).toBe(200);
    expect(repeated.body.completion).toEqual(applied.body.completion);
    expect(fs.readFileSync(target, "utf8")).toBe("later independent edit");
  });

  it("reads source paths once and does not normalize an unchanged comparison", async () => {
    const candidate = path.join(root, "candidate.md");
    fs.writeFileSync(candidate, after);
    const created = await request(api())
      .post("/api/comparisons")
      .send({ mode: "proposal", targetPath: target, afterPath: candidate });
    expect(created.status).toBe(201);
    fs.writeFileSync(candidate, "replaced candidate");
    expect(
      (await request(api()).get(`/api/comparisons/${created.body.id}`)).body
        .afterText,
    ).toBe(after);
    const identical = await create("compare", {
      targetPath: undefined,
      afterText: before,
    });
    expect(identical.status).toBe(201);
    expect(changes(identical.body)).toHaveLength(0);
    expect(
      identical.body.segments
        .map((segment: ComparisonSegment) => segment.before)
        .join(""),
    ).toBe(before);
  });

  it("rejects invalid modes, nonexistent files, traversal IDs and mismatched targets with clear errors", async () => {
    expect((await create("wrong")).status).toBe(400);
    expect((await create("applied")).status).toBe(409);
    expect((await create("compare")).status).toBe(400);
    expect(
      (
        await request(api())
          .post("/api/comparisons")
          .send({
            mode: "proposal",
            targetPath: path.join(root, "missing.md"),
            afterText: "hi",
          })
      ).status,
    ).toBe(400);
    expect((await request(api()).get("/api/comparisons/unknown")).status).toBe(
      404,
    );
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });
  it("keeps the mounted inode on EBUSY and truncates replaced contents without changing mode", async () => {
    const review = (await create("proposal", { afterText: "# Short" }))
      .body as Comparison;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const inode = fs.statSync(target).ino;
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === target)
        throw Object.assign(new Error("Device or resource busy"), {
          code: "EBUSY",
        });
      rename(source, destination);
    });
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe("# Short");
    expect(fs.statSync(target).ino).toBe(inode);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("recovers a completed write after a failed completion-record save without repeating it", async () => {
    const review = (await create()).body as Comparison;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const rename = fs.renameSync.bind(fs);
    let targetRenamed = false;
    let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (targetRenamed && !failed) {
        failed = true;
        throw Object.assign(
          new Error("Simulated completion-record disk error"),
          { code: "EIO" },
        );
      }
      rename(source, destination);
      if (destination === target) targetRenamed = true;
    });
    const interrupted = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(interrupted.status).toBe(500);
    expect(fs.readFileSync(target, "utf8")).toBe(after);
    vi.restoreAllMocks();
    const recovered = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      status: "applied",
      completion: { fileWritten: true, accepted: 2 },
    });
    fs.writeFileSync(target, "later edit after crash");
    const retried = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(retried.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe("later edit after crash");
  });

  it("reports a no-op apply without rewriting the target and keeps comments independent of decisions", async () => {
    const review = (await create()).body as Comparison;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block) => ({
          id: block.id,
          decision: "before",
        })),
      });
    const commented = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: selected.body.revision,
        decisions: [{ id: changes(review)[0].id, comment: "Skip this" }],
      });
    expect(changes(commented.body)[0]).toMatchObject({
      decision: "before",
      comment: "Skip this",
    });
    const stat = fs.statSync(target);
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: commented.body.revision });
    expect(applied.status).toBe(200);
    expect(applied.body.completion).toMatchObject({
      fileWritten: false,
      accepted: 0,
    });
    expect(fs.statSync(target).ino).toBe(stat.ino);
    expect(fs.statSync(target).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("preserves BOM, Unicode, blank lines and an empty replacement without serialization", async () => {
    const unusual = "\ufeff# Café  \r\n\r\n  tab\tend";
    fs.writeFileSync(target, unusual);
    const review = (
      await create("proposal", { beforeText: unusual, afterText: "" })
    ).body as Comparison;
    expect(review.beforeText).toBe(unusual);
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    expect(fs.readFileSync(target)).toEqual(Buffer.alloc(0));
  });

  it("persists native comment threads separately through reload, refresh and completion", async () => {
    const review = (await create()).body as Comparison;
    const anchor = changes(review)[0].id;
    const comments = [
      {
        id: "comment-one",
        changeId: anchor,
        content: "Explain this",
        createdAt: "2026-11-11T12:00:00.000Z",
        authorType: "user",
        parentCommentId: anchor,
      },
      {
        id: "comment-reply",
        changeId: anchor,
        content: "A reply",
        createdAt: "2026-11-11T12:01:00.000Z",
        authorType: "ai",
        authorId: "agent",
        parentCommentId: "comment-one",
      },
    ];
    const saved = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        reviewComments: comments,
        decisions: [{ id: anchor, comment: "Older inline feedback" }],
      });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const reloaded = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(reloaded.body.reviewComments).toEqual(comments);

    // The original anchor disappears when another editor changes that source block.
    const newer = before.replace("old first", "another edit");
    fs.writeFileSync(target, newer);
    const refreshed = await request(api())
      .post(`/api/comparisons/${review.id}/refresh`)
      .send({ revision: saved.body.revision });
    expect(refreshed.status).toBe(200);
    expect(
      changes(refreshed.body).some((segment) => segment.id === anchor),
    ).toBe(false);
    expect(refreshed.body.reviewComments).toEqual(
      expect.arrayContaining(comments),
    );
    expect(refreshed.body.reviewComments).toContainEqual(
      expect.objectContaining({
        id: `legacy:${anchor}`,
        changeId: anchor,
        content: "Older inline feedback",
        scope: "document",
      }),
    );
    const edited = (
      refreshed.body.reviewComments as Comparison["reviewComments"]
    ).map((comment) => ({
      ...comment,
      content: `${comment.content} updated`,
    }));
    const updated = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({ revision: refreshed.body.revision, reviewComments: edited });
    expect(updated.status).toBe(200);
    const completed = await request(api())
      .post(`/api/comparisons/${review.id}/complete`)
      .send({ revision: updated.body.revision });
    expect(completed.status).toBe(200);
    const finished = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(finished.body.reviewComments).toEqual(edited);
    expect(fs.readFileSync(target, "utf8")).toBe(newer);
  });

  it("rejects invalid or stale native comments without saving partial choices", async () => {
    const review = (await create()).body as Comparison;
    const anchor = changes(review)[0].id;
    const comment = {
      id: "comment-one",
      changeId: anchor,
      content: "Feedback",
      createdAt: "2026-11-11T12:00:00.000Z",
      parentCommentId: anchor,
    };
    for (const invalid of [
      null,
      {},
      [{ ...comment, changeId: "missing" }],
      [{ ...comment, content: 3 }],
      [{ ...comment, authorType: "other" }],
      [comment, comment],
    ]) {
      const rejected = await request(api())
        .post(`/api/comparisons/${review.id}/decisions`)
        .send({
          revision: review.revision,
          reviewComments: invalid,
          decisions: [{ id: anchor, decision: "after" }],
        });
      expect(rejected.status).toBe(400);
    }
    const unchanged = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(unchanged.body.revision).toBe(review.revision);
    expect(changes(unchanged.body)[0].decision).toBe("pending");
    const saved = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({ revision: review.revision, reviewComments: [comment] });
    expect(saved.status).toBe(200);
    const stale = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({ revision: review.revision, reviewComments: [] });
    expect(stale.status).toBe(409);
    const reloaded = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(reloaded.body.reviewComments).toEqual([comment]);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("loads pre-threaded-review records and can save native feedback", async () => {
    const review = (await create()).body as Comparison;
    const filename = path.join(root, "comparisons", `${review.id}.json`);
    const legacy = JSON.parse(fs.readFileSync(filename, "utf8"));
    delete legacy.reviewComments;
    fs.writeFileSync(filename, JSON.stringify(legacy));
    const loaded = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(loaded.body.reviewComments).toEqual([]);
    const comments = [
      {
        id: "new-comment",
        changeId: changes(review)[0].id,
        content: "Still works",
        createdAt: new Date().toISOString(),
      },
    ];
    const saved = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({ revision: loaded.body.revision, reviewComments: comments });
    expect(saved.status).toBe(200);
    expect(saved.body.reviewComments).toEqual(comments);
  });
});
