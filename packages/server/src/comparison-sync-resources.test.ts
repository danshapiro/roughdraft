import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/sync-resources/", import.meta.url),
);
let root: string;
let host: ReturnType<typeof createApp>;
const original = `# Large ordinary review\n\n${Array.from({ length: 1200 }, (_, index) => `Paragraph ${index}: ordinary prose retained through repeated guarded saves, without frozen input copies.`).join("\n\n")}\n`;
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
async function open() {
  const target = path.join(root, "source.md");
  fs.writeFileSync(target, original);
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  expect(opened.status).toBe(201);
  const state = await request(host.app).get(
    `/api/comparisons/${opened.body.id}/state`,
  );
  expect(state.status).toBe(200);
  return { target, state: state.body };
}
function payload(state: Awaited<ReturnType<typeof open>>["state"], id: string) {
  const markdown = original.replace("ordinary prose", "updated prose");
  return {
    operationId: id,
    pageInstanceId: "resource-page",
    operationSequence: 1,
    operationContext: state.operationContext,
    expectedRevision: state.revision,
    baseRevision: state.revision,
    baseSignature: state.signature,
    base: state.draft,
    draft: { ...state.draft, markdown, cleanMarkdown: markdown },
    expectedDisk: state.disk,
    localGeneration: 1,
    reason: "sync",
    writeFile: true,
  };
}

test("a 100 KiB guarded save bounds response and durable outcome size instead of repeating frozen input snapshots", async () => {
  const { state } = await open();
  expect(Buffer.byteLength(original)).toBeGreaterThan(100 * 1024);
  const body = payload(state, "bounded-outcome");
  const saved = await request(host.app)
    .post(`/api/comparisons/${state.review.id}/reconcile`)
    .set("X-Roughdraft-Sync", "compact-v1")
    .set("X-Roughdraft-Reference", state.review.referenceVersion)
    .send(body);
  expect(saved.status).toBe(200);
  expect(saved.body.status).toBe("committed");
  const budget = Buffer.byteLength(original) * 3 + 16 * 1024;
  expect(Buffer.byteLength(saved.text)).toBeLessThanOrEqual(budget);
  const journal = path.join(
    root,
    "comparisons",
    "operations",
    "bounded-outcome.json",
  );
  expect(fs.statSync(journal).size).toBeLessThanOrEqual(budget);
  const resolved = await request(host.app)
    .post("/api/comparisons/operations/bounded-outcome/resolve")
    .send({ ...body, reviewId: state.review.id });
  expect(resolved.body.status).toBe("committed");
  expect(resolved.body.state.review.beforeText).toBe(state.review.beforeText);
  expect(resolved.body.state.review.afterText).toBe(state.review.afterText);
  expect(resolved.body.state.draft.cleanMarkdown).toBe(
    body.draft.cleanMarkdown,
  );
  for (const reference of [undefined, "a-different-frozen-reference"]) {
    const replay = request(host.app).post(
      `/api/comparisons/${state.review.id}/reconcile`,
    );
    if (reference)
      replay
        .set("X-Roughdraft-Sync", "compact-v1")
        .set("X-Roughdraft-Reference", reference);
    const complete = await replay.send(body);
    expect(complete.body.status).toBe("committed");
    expect(complete.body.state.reviewFormat).toBeUndefined();
    expect(complete.body.state.review.beforeText).toBe(state.review.beforeText);
    expect(complete.body.state.review.afterText).toBe(state.review.afterText);
    expect(complete.body.state.review.draft.cleanMarkdown).toBe(
      body.draft.cleanMarkdown,
    );
  }
});

test("a same-revision signature-guarded save uses its cached base without uploading the complete document again", async () => {
  const { target, state } = await open();
  const { base: _base, ...body } = payload(state, "cached-base");
  const saved = await request(host.app)
    .post(`/api/comparisons/${state.review.id}/reconcile`)
    .send(body);
  expect(saved.status).toBe(200);
  expect(saved.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(body.draft.cleanMarkdown);
  const wrong = await request(host.app)
    .post(`/api/comparisons/${state.review.id}/reconcile`)
    .send({
      ...body,
      operationId: "wrong-base",
      operationSequence: 2,
      baseSignature: "not-the-retained-base",
    });
  expect(wrong.body.status).not.toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(body.draft.cleanMarkdown);
});
