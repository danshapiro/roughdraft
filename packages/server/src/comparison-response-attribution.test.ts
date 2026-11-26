import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/response-attribution/", import.meta.url),
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

test("a save response names its committed operation and has the same registry generation as the next unchanged state read", async () => {
  const target = path.join(root, "source.md");
  const original = "The original paragraph.\n";
  fs.writeFileSync(target, original);
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  expect(opened.status).toBe(201);
  const route = `/api/comparisons/${opened.body.id}`;
  const base = (await request(host.app).get(`${route}/state`)).body;
  const changed = "The updated paragraph.\n";
  const operationId = "newly-committed-operation";
  const saved = await request(host.app)
    .post(`${route}/reconcile`)
    .send({
      operationId,
      pageInstanceId: "writer",
      operationSequence: 1,
      operationContext: base.operationContext,
      expectedRevision: base.revision,
      baseRevision: base.revision,
      baseSignature: base.signature,
      base: base.draft,
      draft: { ...base.draft, markdown: changed, cleanMarkdown: changed },
      expectedDisk: {
        path: target,
        version: base.disk.version,
        hash: base.disk.hash,
      },
      reason: "sync",
      localGeneration: 1,
      writeFile: true,
    });
  expect(saved.status).toBe(200);
  expect(saved.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(changed);
  const next = await request(host.app).get(`${route}/state`);
  expect(next.status).toBe(200);
  expect.soft(saved.body.state.review.lastOperation?.id).toBe(operationId);
  expect
    .soft(saved.body.state.registryGeneration)
    .toBe(next.body.registryGeneration);
  expect(next.body.review.lastOperation.id).toBe(operationId);
  expect(next.body.disk.version).toBe(saved.body.state.disk.version);
});
