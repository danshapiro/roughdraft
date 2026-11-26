import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SyncState } from "@roughdraft/rfm";
import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Comparison } from "./comparisons.js";
import { DocumentWatcherRegistry } from "./document-watchers.js";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/review-regressions/", import.meta.url),
);
let root: string;
let target: string;
let host: ReturnType<typeof createApp> | undefined;
let watchers: DocumentWatcherRegistry | undefined;
const original = "# Review\n\nThe original passage.\n";
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  target = path.join(root, "practice.md");
  fs.writeFileSync(target, original);
});
afterEach(() => {
  host?.dispose();
  host = undefined;
  watchers?.close();
  watchers = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});
async function open(autosave = "none", unobservable = false) {
  if (unobservable)
    watchers = new DocumentWatcherRegistry({ unobservablePaths: [target] });
  host = createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "comparisons"),
    staticDirPath: root,
    ...(watchers ? { watchers } : {}),
  });
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave });
  expect(opened.status).toBe(201);
  const state = await request(host.app).get(
    `/api/comparisons/${opened.body.id}/state`,
  );
  expect(state.status).toBe(200);
  return state.body as SyncState<Comparison>;
}
function api() {
  if (!host) throw new Error("Expected the test server to be open");
  return request(host.app);
}

test("an unobservable mounted file remains writable through fresh guards without reporting unchanged bytes as drift", async () => {
  const state = await open(target, true);
  expect(state.disk?.message).toMatch(/mounted file/i);
  const changed = original.replace("original", "edited");
  const saved = await api()
    .post(`/api/comparisons/${state.review.id}/reconcile`)
    .send({
      operationId: "mounted-file-save",
      pageInstanceId: "mounted-page",
      operationSequence: 1,
      operationContext: state.operationContext,
      expectedRevision: state.revision,
      baseRevision: state.revision,
      baseSignature: state.signature,
      base: state.draft,
      draft: { ...state.draft, markdown: changed, cleanMarkdown: changed },
      expectedDisk: state.disk,
      localGeneration: 1,
      reason: "sync",
      writeFile: true,
    });
  expect(saved.status).toBe(200);
  expect(saved.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(changed);
  expect(state.review.targetChanged).toBe(false);
});

test("the review endpoint used by CLI read reports autosave-none live source drift without rewriting the saved review", async () => {
  const state = await open();
  const record = path.join(root, "comparisons", `${state.review.id}.json`);
  const stored = fs.readFileSync(record, "utf8");
  const changed = original.replace("original", "outside edit");
  fs.writeFileSync(target, changed);
  const read = await api().get(`/api/comparisons/${state.review.id}`);
  expect(read.status).toBe(200);
  expect(fs.readFileSync(record, "utf8")).toBe(stored);
  expect(fs.readFileSync(target, "utf8")).toBe(changed);
  expect(read.body.targetChanged).toBe(true);
  expect(read.body.liveSourceChanged).toBe(true);
});

test("evolving automatic wait recovery stays bounded while retaining the entry and latest draft with unfinished feedback", async () => {
  const state = await open();
  let latest: { checkpointId: string } | undefined;
  const feedback = {
    comments: {
      c1: { value: "An unfinished reply", original: "", editing: true },
    },
  };
  for (let generation = 0; generation <= 25; generation++) {
    const response = await api()
      .post(`/api/comparisons/${state.review.id}/checkpoint`)
      .send({
        pageInstanceId: "composing-page",
        recoveryId: "composing-wait",
        conflictId: `waiting-draft-${generation}`,
        generation,
        workingDraft: {
          ...state.draft,
          markdown: generation
            ? `${original}\nComposed word ${generation}.\n`
            : original,
        },
        uiDrafts: feedback,
        reason: "The outside update is waiting for safe mapping.",
      });
    expect(response.status).toBe(200);
    latest = response.body;
  }
  const other = await api()
    .post(`/api/comparisons/${state.review.id}/checkpoint`)
    .send({
      pageInstanceId: "composing-page",
      recoveryId: "another-wait",
      conflictId: "another-conflict",
      generation: 26,
      workingDraft: { ...state.draft, markdown: "A separate incident.\n" },
      uiDrafts: feedback,
      reason: "The outside update is waiting for safe mapping.",
    });
  expect(other.status).toBe(200);
  expect(other.body.checkpointId).not.toBe(latest?.checkpointId);
  const separate = await api().get(
    `/api/comparisons/${state.review.id}/checkpoints/${other.body.checkpointId}`,
  );
  expect(separate.body.entryDraft.markdown).toBe("A separate incident.\n");
  const current = await api().get(`/api/comparisons/${state.review.id}/state`);
  expect(current.status).toBe(200);
  expect(current.body.review.recoveryCheckpoints.length).toBeLessThanOrEqual(
    20,
  );
  const directory = path.join(
    root,
    "comparisons",
    "checkpoints",
    state.review.id,
  );
  expect(
    fs
      .readdirSync(directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length,
  ).toBeLessThanOrEqual(20);
  if (!latest) throw new Error("Expected a retained latest checkpoint");
  const recovery = await api().get(
    `/api/comparisons/${state.review.id}/checkpoints/${latest.checkpointId}`,
  );
  expect(recovery.status).toBe(200);
  expect(recovery.body.entryDraft.markdown).toBe(original);
  expect(recovery.body.workingDraft.markdown).toContain("Composed word 25.");
  expect(recovery.body.uiDrafts).toEqual(feedback);
});
