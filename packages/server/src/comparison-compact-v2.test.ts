import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewDraftSignature } from "@roughdraft/rfm";
import request from "supertest";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/compact-v2/", import.meta.url),
);
const original = `Owner A: old\n\nOwner B: old\n\nOwner C: old\n\n${"Unchanged ordinary paragraph preserves the complete review and its source spelling.\n\n".repeat(1400)}`;
let root: string;
let host: ReturnType<typeof createApp>;
let clock: number;
const metrics: Array<Record<string, unknown>> = [];
const start = () =>
  createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "comparisons"),
    staticDirPath: root,
  });
beforeEach(() => {
  clock = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  host = start();
});
afterEach(() => {
  vi.restoreAllMocks();
  host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
async function open(markdown = original) {
  const target = path.join(root, "source.md");
  fs.writeFileSync(target, markdown);
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  expect(opened.status).toBe(201);
  const state = (
    await request(host.app).get(`/api/comparisons/${opened.body.id}/state`)
  ).body;
  return {
    target,
    state,
    route: `/api/comparisons/${opened.body.id}/reconcile`,
  };
}
function body(
  state: Awaited<ReturnType<typeof open>>["state"],
  operationId: string,
  page: string,
  markdown: string,
  sequence = 1,
) {
  return {
    operationId,
    pageInstanceId: page,
    operationSequence: sequence,
    operationContext: state.operationContext,
    expectedRevision: state.revision,
    baseRevision: state.revision,
    baseSignature: state.signature,
    base: state.draft,
    draft: { ...state.draft, markdown, cleanMarkdown: markdown },
    expectedDisk: state.disk,
    writeFile: true,
    localGeneration: sequence,
    reason: "sync",
  };
}
function withoutContext(value: Record<string, unknown>) {
  const { operationContext: _context, ...rest } = value;
  return rest;
}

test("compact-v2 removes only a saved-text duplicate from real 100 KiB state packets while v1 stays self-contained", async () => {
  const { state, route } = await open();
  const first = await request(host.app)
    .post(route)
    .send(body(state, "first", "a", original.replace("A: old", "A: new")));
  expect(first.body.status).toBe("committed");
  const query = `/api/comparisons/${state.review.id}/state`;
  const v1 = await request(host.app)
    .get(query)
    .set("X-Roughdraft-Sync", "compact-v1")
    .set("X-Roughdraft-Reference", state.review.referenceVersion);
  const v2 = await request(host.app)
    .get(query)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion);
  expect(v1.body.reviewFormat).toBe("compact-v1");
  expect(v1.body.review.savedText).toBe(first.body.state.draft.cleanMarkdown);
  expect(v2.body.reviewFormat).toBe("compact-v2");
  expect(v2.body.savedTextFromDraft).toBe(true);
  expect(v2.body.review.savedText).toBeUndefined();
  const decoded = {
    ...v2.body,
    reviewFormat: "compact-v1",
    review: { ...v2.body.review, savedText: v2.body.draft.cleanMarkdown },
  };
  delete decoded.savedTextFromDraft;
  expect(decoded).toEqual(v1.body);
  expect(Buffer.byteLength(v2.text)).toBeLessThan(
    Buffer.byteLength(v1.text) * 0.75,
  );
  metrics.push({
    packet: "saved-state",
    v1Bytes: Buffer.byteLength(v1.text),
    v2Bytes: Buffer.byteLength(v2.text),
    removedSavedTextBytes: Buffer.byteLength(
      first.body.state.draft.cleanMarkdown,
    ),
  });
  for (const reference of [undefined, "wrong-reference"]) {
    const read = request(host.app)
      .get(query)
      .set("X-Roughdraft-Sync", "compact-v2");
    if (reference) read.set("X-Roughdraft-Reference", reference);
    const complete = await read;
    expect(complete.body.reviewFormat).toBeUndefined();
    expect(complete.body.review.savedText).toBe(
      first.body.state.draft.cleanMarkdown,
    );
  }
});

test("compact-v2 retains a saved-text value that differs from the current review draft", async () => {
  const { state, route } = await open();
  const saved = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .send({
      ...body(state, "review-only", "a", original.replace("A: old", "A: new")),
      writeFile: false,
    });
  expect(saved.body.status).toBe("committed");
  expect(saved.body.state.reviewFormat).toBe("compact-v2");
  expect(saved.body.state.savedTextFromDraft).toBeUndefined();
  expect(saved.body.state.review.savedText).toBe(original);
});

test("v2 retry markers preserve exact durable outcomes, fair merge turns and restart classification with fewer flushes", async () => {
  const { state, route, target } = await open();
  const aText = original.replace("A: old", "A: new");
  const a = await request(host.app)
    .post(route)
    .send(body(state, "a", "a", aText));
  expect(a.body.status).toBe("committed");
  const holder = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .send(body(state, "holder", "b", original.replace("B: old", "B: new")));
  expect(holder.body.status).toBe("client-merge-required");
  expect(holder.body.state.draft.markdown).toBe(aText);
  expect(holder.body.reservation).toBeTruthy();
  clock += 200;
  const cBody = body(
    state,
    "c-blocked",
    "c",
    original.replace("C: old", "C: new"),
  );
  const flush = vi.spyOn(fs, "fsyncSync");
  const blocked = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .send(cBody);
  const v2Flushes = flush.mock.calls.length;
  flush.mockClear();
  const legacy = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v1")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .send(body(state, "d-blocked", "d", original));
  const v1Flushes = flush.mock.calls.length;
  flush.mockRestore();
  expect(blocked.body.status).toBe("retry-later");
  expect(blocked.body.state).toBeUndefined();
  expect(blocked.body.retryAfter).toBe(550);
  expect(blocked.body.retryRevision).toBe(a.body.state.revision);
  expect(blocked.body.operationContext).toMatchObject({
    owner: state.operationContext.owner,
    epoch: state.operationContext.epoch,
  });
  expect(legacy.body.state.draft.markdown).toBe(aText);
  const journal = path.join(
    root,
    "comparisons",
    "operations",
    "c-blocked.json",
  );
  const raw = fs.readFileSync(journal, "utf8");
  const record = JSON.parse(raw);
  expect(record.phase).toBe("done");
  expect(record.resultPayload).toBeUndefined();
  expect(record.result).toEqual(blocked.body);
  expect(Buffer.byteLength(raw)).toBeLessThan(4096);
  expect(v2Flushes).toBeLessThanOrEqual(v1Flushes - 2);
  metrics.push({
    packet: "retry-later",
    v1Bytes: Buffer.byteLength(legacy.text),
    v2Bytes: Buffer.byteLength(blocked.text),
    v1Flushes,
    v2Flushes,
    journalBytes: Buffer.byteLength(raw),
  });
  const replay = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .send(cBody);
  expect(withoutContext(replay.body)).toEqual(withoutContext(blocked.body));
  const holderState = a.body.state;
  const ab = aText.replace("B: old", "B: new");
  const merged = await request(host.app)
    .post(route)
    .send({
      ...body(holderState, "holder-commit", "b", ab, 2),
      reservationToken: holder.body.reservation.token,
    });
  expect(merged.body.status).toBe("committed");
  const cTurn = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .send({ ...cBody, operationId: "c-next", operationSequence: 2 });
  expect(cTurn.body.status).toBe("client-merge-required");
  const abc = ab.replace("C: old", "C: new");
  const cCommitted = await request(host.app)
    .post(route)
    .send({
      ...body(merged.body.state, "c-commit", "c", abc, 3),
      reservationToken: cTurn.body.reservation.token,
    });
  expect(cCommitted.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(abc);
  host.dispose();
  host = start();
  const recovered = await request(host.app).get(
    "/api/comparisons/operations/c-blocked",
  );
  expect(withoutContext(recovered.body)).toEqual(withoutContext(blocked.body));
  expect(recovered.body.operationContext.epoch).not.toBe(
    blocked.body.operationContext.epoch,
  );
  expect(recovered.body.operationContext.acceptUntil).toBeGreaterThan(
    Date.now(),
  );
  expect(fs.readFileSync(journal, "utf8")).toBe(raw);
  console.info(
    JSON.stringify({
      severity: "info",
      component: "compact-v2-resource",
      metrics,
    }),
  );
});

test("v2 publication deferrals retain the complete recoverable publication state", async () => {
  const { state, route, target } = await open();
  const filename = path.join(root, "comparisons", `${state.review.id}.json`);
  const review = JSON.parse(fs.readFileSync(filename, "utf8"));
  review.pendingPublication = {
    owner: "another-owner",
    processInstance: "stopped-process",
    startedAt: state.operationContext.acceptUntil - 120_000 - 31_000,
    operation: {
      operationId: "unfinished-publication",
      pageInstanceId: "other-page",
      operationSequence: 1,
      operationContext: state.operationContext,
    },
    draft: state.draft,
    path: target,
    expectedDisk: state.disk,
    writeFile: true,
    reason: "sync",
  };
  fs.writeFileSync(filename, JSON.stringify(review));
  const deferred = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .send(body(state, "publication-deferred", "a", original));
  expect(deferred.body.status).toBe("retry-later");
  expect(deferred.body.state?.publishing).toMatchObject({
    operationId: "unfinished-publication",
    recoverable: true,
    retryAfter: 0,
  });
  expect(deferred.body.state.draft.markdown).toBe(original);
  host.dispose();
  host = start();
  const recovered = await request(host.app).get(
    "/api/comparisons/operations/publication-deferred",
  );
  expect(recovered.body.state.publishing).toEqual(
    deferred.body.state.publishing,
  );
  expect(recovered.body.state.draft.markdown).toBe(original);
  expect(fs.readFileSync(target, "utf8")).toBe(original);
});

test("an exact opted-in large commit aliases only its sent text while journal and lost-response recovery retain the complete draft", async () => {
  const { state, route, target } = await open();
  const sent = body(
    state,
    "text-reference",
    "a",
    original.replace("A: old", "A: new"),
  );
  const saved = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .set("X-Roughdraft-Draft-Reference", reviewDraftSignature(sent.draft))
    .send(sent);
  expect(saved.body.status).toBe("committed");
  expect(saved.body.state.draftTextFromRequest).toBe(true);
  expect(saved.body.state.draft.markdown).toBeUndefined();
  expect(saved.body.state.draft.cleanMarkdown).toBeUndefined();
  const {
    markdown: _markdown,
    cleanMarkdown: _clean,
    ...metadata
  } = sent.draft;
  expect(saved.body.state.draft).toEqual(metadata);
  expect(Buffer.byteLength(saved.text)).toBeLessThan(16 * 1024);
  const ordinary = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .send(sent);
  expect(ordinary.body.state.draftTextFromRequest).toBeUndefined();
  expect(ordinary.body.state.draft).toEqual(sent.draft);
  const journal = path.join(
    root,
    "comparisons",
    "operations",
    "text-reference.json",
  );
  const persisted = fs.readFileSync(journal, "utf8");
  host.dispose();
  host = start();
  const status = await request(host.app).get(
    "/api/comparisons/operations/text-reference",
  );
  expect(status.body.state.draft).toEqual(sent.draft);
  expect(status.body.state.draftTextFromRequest).toBeUndefined();
  const resolved = await request(host.app)
    .post("/api/comparisons/operations/text-reference/resolve")
    .send({ ...sent, reviewId: state.review.id, draft: undefined });
  expect(resolved.body.state.draft).toEqual(sent.draft);
  expect(fs.readFileSync(journal, "utf8")).toBe(persisted);
  expect(fs.readFileSync(target, "utf8")).toBe(sent.draft.cleanMarkdown);
  console.info(
    JSON.stringify({
      severity: "info",
      component: "draft-text-reference-resource",
      fullV2Bytes: Buffer.byteLength(ordinary.text),
      aliasedBytes: Buffer.byteLength(saved.text),
      markdownBytes: Buffer.byteLength(sent.draft.markdown),
      cleanMarkdownBytes: Buffer.byteLength(sent.draft.cleanMarkdown),
    }),
  );
});

test.each([
  "no header",
  "wrong signature",
  "wrong frozen reference",
  "v1",
  "missing clean text",
])("draft text stays explicit without every exact opt-in guard: %s", async (scenario) => {
  const { state, route } = await open();
  const sent = body(
    state,
    `guard-${scenario.replaceAll(" ", "-")}`,
    "a",
    original.replace("A: old", "A: new"),
  );
  if (scenario === "missing clean text") delete sent.draft.cleanMarkdown;
  const response = request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", scenario === "v1" ? "compact-v1" : "compact-v2")
    .set(
      "X-Roughdraft-Reference",
      scenario === "wrong frozen reference"
        ? "wrong"
        : state.review.referenceVersion,
    );
  if (scenario !== "no header")
    response.set(
      "X-Roughdraft-Draft-Reference",
      scenario === "wrong signature"
        ? "wrong"
        : reviewDraftSignature(sent.draft),
    );
  const saved = await response.send(sent);
  expect(saved.body.status).toBe("committed");
  expect(saved.body.state.draftTextFromRequest).toBeUndefined();
  expect(saved.body.state.draft.markdown).toBe(sent.draft.markdown);
  expect(saved.body.state.draft.cleanMarkdown).toBe(sent.draft.cleanMarkdown);
});

test("text aliasing retains authoritative normalized History metadata instead of borrowing request metadata", async () => {
  const { state, route } = await open();
  const sent = body(
    state,
    "normalized-history",
    "a",
    original.replace("A: old", "A: new"),
  );
  sent.draft.reviewed = [
    {
      id: "decision-example",
      decision: "accept",
      oldText: "old",
      newText: "new",
      inverse: [],
      guard: { from: 0, to: 0, slice: null },
      stale: false,
      keptIds: [],
    },
  ];
  sent.draft.reviewComments = [
    {
      id: "c1",
      changeId: "document",
      content: "Authoritative feedback",
      createdAt: "2026-11-26T12:00:00.000Z",
      authorType: "ai",
      authorId: null,
      parentCommentId: null,
      legacyNote: "request-only metadata",
    },
  ];
  const saved = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .set("X-Roughdraft-Draft-Reference", reviewDraftSignature(sent.draft))
    .send(sent);
  expect(saved.body.status).toBe("committed");
  expect(saved.body.state.signature).toBe(reviewDraftSignature(sent.draft));
  expect(saved.body.state.draftTextFromRequest).toBe(true);
  expect(saved.body.state.draft.reviewed).toHaveLength(1);
  expect(
    Object.hasOwn(saved.body.state.draft.reviewComments[0], "legacyNote"),
  ).toBe(false);
  expect(saved.body.state.draft.reviewComments[0]).toMatchObject({
    authorType: "ai",
    authorId: null,
    parentCommentId: null,
  });
  expect(saved.body.state.draft.reviewed[0]).toMatchObject({
    stale: false,
    keptIds: [],
    guard: { from: 0, to: 0, slice: null },
  });
});

test.each([
  false,
  true,
])("a changed incoming result keeps its complete draft despite an exact request header (large fallback=%s)", async (large) => {
  const source = large ? original : "Owner A: old\n\nOwner B: old\n";
  const { state, route } = await open(source);
  const first = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "incoming-first",
        "peer",
        source.replace("A: old", "A: peer"),
      ),
    );
  expect(first.body.status).toBe("committed");
  const sent = body(
    state,
    "changed-incoming",
    "local",
    source.replace("B: old", "B: mine"),
  );
  const saved = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .set("X-Roughdraft-Draft-Reference", reviewDraftSignature(sent.draft))
    .send(sent);
  expect(saved.body.status).toBe(large ? "client-merge-required" : "committed");
  expect(saved.body.state.draftTextFromRequest).toBeUndefined();
  expect(saved.body.state.draft.markdown).toContain("A: peer");
  if (!large) expect(saved.body.state.draft.markdown).toContain("B: mine");
});

test("a newly created review keeps complete text even when its request explicitly supplies the text reference", async () => {
  const { state } = await open();
  const working = { ...state.draft, cleanMarkdown: state.draft.markdown };
  const saved = await request(host.app)
    .post(`/api/comparisons/${state.review.id}/copy`)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .set("X-Roughdraft-Draft-Reference", reviewDraftSignature(working))
    .send({
      operationId: "different-review",
      operationSequence: 1,
      pageInstanceId: "a",
      operationContext: state.operationContext,
      generation: 1,
      workingDraft: working,
      draft: working,
      path: path.join(root, "separate.md"),
      relativeLinksAcknowledged: true,
    });
  expect(saved.body.status).toBe("committed");
  expect(saved.body.state.review.id).not.toBe(state.review.id);
  expect(saved.body.state.draftTextFromRequest).toBeUndefined();
  expect(saved.body.state.draft).toEqual(working);
  expect(saved.body.state.review.beforeText).toBe(state.review.beforeText);
});

test("a malformed opted-in request still receives the complete authoritative rejection state", async () => {
  const { state, route } = await open();
  const first = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "prepare-malformed-reference",
        "a",
        original.replace("A: old", "A: new"),
      ),
    );
  expect(first.body.status).toBe("committed");
  const current = first.body.state;
  const sent = body(
    current,
    "malformed-reference",
    "a",
    current.draft.markdown,
    2,
  );
  sent.draft.reviewComments = null;
  const rejected = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .set("X-Roughdraft-Reference", current.review.referenceVersion)
    .set("X-Roughdraft-Draft-Reference", current.signature)
    .send(sent);
  expect(rejected.status).toBe(200);
  expect(rejected.body.status).toBe("rejected");
  expect(rejected.body.state.draftTextFromRequest).toBeUndefined();
  expect(rejected.body.state.draft).toEqual(current.draft);
});

function delayOperationJournal(operationId: string, duringFlush?: () => void) {
  const write = fs.writeFileSync.bind(fs);
  const flush = fs.fsyncSync.bind(fs);
  const delay = { triggered: false };
  let running = false;
  vi.spyOn(fs, "writeFileSync").mockImplementation(
    (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[1] === "string") {
        try {
          const value = JSON.parse(args[1]);
          if (
            value.phase === "running" &&
            value.operation?.operationId === operationId
          )
            running = true;
        } catch {
          /* Non-journal writes never activate the controlled flush delay. */
        }
      }
      return write(...args);
    },
  );
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (running && !delay.triggered) {
      delay.triggered = true;
      clock += 600;
      duringFlush?.();
    }
    return flush(fd);
  });
  return delay;
}

test("journal flushes cannot turn a writer blocked at entry into an owner after another page's merge turn expires", async () => {
  const { state, route, target } = await open();
  const seedText = original.replace("A: old", "A: seeded");
  const seed = await request(host.app)
    .post(route)
    .send(body(state, "seed-before-turn", "seed", seedText));
  expect(seed.body.status).toBe("committed");
  const holder = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "turn-holder",
        "holder",
        original.replace("B: old", "B: holder"),
      ),
    );
  expect(holder.body.status).toBe("client-merge-required");
  const turn = holder.body.reservation;
  clock += 200;
  const atEntry = clock;
  const delay = delayOperationJournal("blocked-slow-journal");
  const peerText = seedText.replace("C: old", "C: peer");
  const blocked = await request(host.app)
    .post(route)
    .send(body(seed.body.state, "blocked-slow-journal", "peer", peerText));
  expect(delay.triggered).toBe(true);
  expect(clock - atEntry).toBeCloseTo(600, 6);
  expect(blocked.body.status).toBe("retry-later");
  expect(blocked.body.retryAfter).toBe(25);
  expect(blocked.body.state.revision).toBe(seed.body.state.revision);
  expect(fs.readFileSync(target, "utf8")).toBe(seedText);
  const replay = await request(host.app).get(
    "/api/comparisons/operations/blocked-slow-journal",
  );
  expect(replay.body.status).toBe("retry-later");
  // The old token really expired; denying the earlier peer must not extend it.
  const oldHolder = await request(host.app)
    .post(route)
    .send({
      ...body(
        state,
        "expired-holder",
        "holder",
        seedText.replace("B: old", "B: holder"),
        2,
      ),
      expectedRevision: seed.body.state.revision,
      expectedDisk: seed.body.state.disk,
      reservationToken: turn.token,
    });
  expect(oldHolder.body.status).toBe("retry-later");
  const next = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "queued-peer-next",
        "peer",
        original.replace("C: old", "C: peer"),
        2,
      ),
    );
  expect(next.body.status).toBe("client-merge-required");
  const final = await request(host.app)
    .post(route)
    .send({
      ...body(seed.body.state, "queued-peer-commit", "peer", peerText, 3),
      reservationToken: next.body.reservation.token,
    });
  expect(final.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(peerText);
});

test.each([
  "current",
  "older",
])("a valid holder admitted inside the mutation lock keeps its %s base request when its own journal flush passes the turn deadline", async (baseVersion) => {
  const { state, route, target } = await open();
  const seedText = original.replace("A: old", "A: seeded");
  const seed = await request(host.app)
    .post(route)
    .send(body(state, "holder-seed", "seed", seedText));
  expect(seed.body.status).toBe("committed");
  const held = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "holder-admission",
        "holder",
        original.replace("B: old", "B: holder"),
      ),
    );
  expect(held.body.status).toBe("client-merge-required");
  clock += 200;
  const atEntry = clock;
  const delay = delayOperationJournal("admitted-holder-commit");
  const candidate = seedText.replace("B: old", "B: holder");
  const committed = await request(host.app)
    .post(route)
    .send({
      ...body(
        baseVersion === "current" ? seed.body.state : state,
        "admitted-holder-commit",
        "holder",
        candidate,
        2,
      ),
      expectedRevision: seed.body.state.revision,
      expectedDisk: seed.body.state.disk,
      reservationToken: held.body.reservation.token,
    });
  expect(delay.triggered).toBe(true);
  expect(clock - atEntry).toBeCloseTo(600, 6);
  expect(committed.body.status).toBe("committed");
  expect(committed.body.state.revision).toBe(seed.body.state.revision + 1);
  expect(fs.readFileSync(target, "utf8")).toBe(candidate);
});

test("an admitted holder still rejects an outside file edit that arrives during its durable journal write", async () => {
  const { state, route, target } = await open();
  const seedText = original.replace("A: old", "A: seeded");
  const seed = await request(host.app)
    .post(route)
    .send(body(state, "disk-guard-seed", "seed", seedText));
  expect(seed.body.status).toBe("committed");
  const held = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "disk-guard-holder",
        "holder",
        original.replace("B: old", "B: holder"),
      ),
    );
  expect(held.body.status).toBe("client-merge-required");
  clock += 200;
  const write = fs.writeFileSync.bind(fs);
  const delay = delayOperationJournal("guarded-admitted-holder", () =>
    write(target, "New outside file D2\n"),
  );
  const result = await request(host.app)
    .post(route)
    .send({
      ...body(
        state,
        "guarded-admitted-holder",
        "holder",
        seedText.replace("B: old", "B: holder"),
        2,
      ),
      expectedRevision: seed.body.state.revision,
      expectedDisk: seed.body.state.disk,
      reservationToken: held.body.reservation.token,
    });
  expect(delay.triggered).toBe(true);
  expect(result.body.status).toBe("incoming-changed");
  expect(fs.readFileSync(target, "utf8")).toBe("New outside file D2\n");
  expect(result.body.state.revision).toBe(seed.body.state.revision);
});
