import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
async function open() {
  const target = path.join(root, "source.md");
  fs.writeFileSync(target, original);
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
    startedAt: Date.now() - 31_000,
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
