import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/automatic-wait-cleanup/", import.meta.url),
);
let root: string;
let host: ReturnType<typeof createApp>;
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  host = createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "comparisons"),
    staticDirPath: root,
  });
});
afterEach(() => {
  host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
const privateUi = {
  comments: {
    c1: { value: "Private unfinished feedback", original: "", editing: true },
  },
};

test.each([
  "covered",
  "rejected",
  "stale generation",
  "future claim",
  "entry private feedback",
  "latest private feedback",
  "genuine conflict",
  "legacy checkpoint",
  "different page",
] as const)("ordinary sync cleans only its fully covered automatic wait: %s", async (scenario) => {
  const source = path.join(root, "practice.md");
  fs.writeFileSync(source, "Saved review.\n");
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: source, autosave: "none" });
  expect(opened.status).toBe(201);
  const route = `/api/comparisons/${opened.body.id}`;
  const base = (await request(host.app).get(`${route}/state`)).body;
  const changed = {
    ...base.draft,
    markdown: "Saved review.\n\nTyped after the wait.\n",
    cleanMarkdown: "Saved review.\n\nTyped after the wait.\n",
  };
  const checkpoint = async (
    generation: number,
    automaticWait: boolean | undefined,
    uiDrafts: object,
  ) => {
    const saved = await request(host.app).post(`${route}/checkpoint`).send({
      pageInstanceId: "page",
      recoveryId: "wait-episode",
      conflictId: "file-wait",
      generation,
      automaticWait,
      workingDraft: changed,
      uiDrafts,
      reason: "A temporary file wait",
    });
    expect(saved.status).toBe(200);
    return saved.body.checkpointId as string;
  };
  let generation = scenario === "stale generation" ? 2 : 1;
  const id = await checkpoint(
    generation,
    scenario === "legacy checkpoint" ? undefined : true,
    scenario === "entry private feedback" ? privateUi : {},
  );
  if (
    scenario === "entry private feedback" ||
    scenario === "latest private feedback"
  ) {
    generation = 2;
    await checkpoint(
      generation,
      true,
      scenario === "latest private feedback" ? privateUi : {},
    );
  }
  if (scenario === "genuine conflict") {
    await checkpoint(2, false, {});
    await checkpoint(3, true, {});
    generation = 3;
  }
  const synced = await request(host.app)
    .post(`${route}/reconcile`)
    .send({
      operationId: "covered-sync",
      operationSequence: 1,
      pageInstanceId: "page",
      operationContext: base.operationContext,
      expectedRevision: base.revision,
      baseRevision: base.revision,
      baseSignature: base.signature,
      base: base.draft,
      draft: changed,
      expectedDisk: {
        path: scenario === "rejected" ? "/wrong-path.md" : base.disk.path,
        version: base.disk.version,
        hash: base.disk.hash,
      },
      localGeneration: generation,
      reason: "sync",
      writeFile: false,
      coveredCheckpoint: {
        recoveryId: "wait-episode",
        pageInstanceId: scenario === "different page" ? "another-page" : "page",
        generation:
          scenario === "stale generation"
            ? 1
            : scenario === "future claim"
              ? generation + 1
              : generation,
      },
    });
  expect(synced.status).toBe(200);
  expect(synced.body.status).toBe(
    scenario === "rejected" ? "binding-changed" : "committed",
  );
  if (scenario === "covered") {
    // Replays refresh transport permission; the committed result stays exact.
    const durableResult = (value: typeof synced.body) => ({
      ...value,
      state: { ...value.state, operationContext: undefined },
    });
    const replay = await request(host.app).post(`${route}/reconcile`).send({
      operationId: "covered-sync",
      operationSequence: 1,
      pageInstanceId: "page",
      operationContext: base.operationContext,
    });
    expect(durableResult(replay.body)).toEqual(durableResult(synced.body));
    host.dispose();
    host = createApp({
      homeDir: root,
      comparisonsDir: path.join(root, "comparisons"),
      staticDirPath: root,
    });
    const afterRestart = await request(host.app)
      .post(`${route}/reconcile`)
      .send({
        operationId: "covered-sync",
        operationSequence: 1,
        pageInstanceId: "page",
        operationContext: base.operationContext,
      });
    expect(durableResult(afterRestart.body)).toEqual(
      durableResult(synced.body),
    );
  }
  const current = (await request(host.app).get(`${route}/state`)).body;
  const entry = current.review.recoveryCheckpoints.find(
    (value: { id: string }) => value.id === id,
  );
  expect(entry).toBeTruthy();
  if (scenario === "covered") expect(entry.resolvedAt).toBeTruthy();
  else expect(entry.resolvedAt).toBeUndefined();
  if (scenario === "covered") {
    await checkpoint(generation, true, {});
    const late = (
      await request(host.app).get(`${route}/state`)
    ).body.review.recoveryCheckpoints.find(
      (value: { id: string }) => value.id === id,
    );
    expect(
      late.resolvedAt,
      "a delayed covered checkpoint cannot reopen retired work",
    ).toBe(entry.resolvedAt);
    await checkpoint(generation + 1, true, privateUi);
    const newer = (
      await request(host.app).get(`${route}/state`)
    ).body.review.recoveryCheckpoints.find(
      (value: { id: string }) => value.id === id,
    );
    expect(
      newer.resolvedAt,
      "new private work must remain recoverable",
    ).toBeUndefined();
    expect(newer.generation).toBe(generation + 1);
  }
  const preserved = (await request(host.app).get(`${route}/checkpoints/${id}`))
    .body;
  expect(preserved.workingDraft).toEqual(changed);
  if (scenario === "entry private feedback")
    expect(preserved.entryUiDrafts).toEqual(privateUi);
  if (scenario === "latest private feedback")
    expect(preserved.uiDrafts).toEqual(privateUi);
  if (scenario === "genuine conflict")
    expect(preserved.automaticWait).toBe(false);
  expect(fs.readFileSync(source, "utf8")).toBe("Saved review.\n");
});
