import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SyncResult } from "@roughdraft/rfm";
import request from "supertest";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonOperations } from "./comparison-operations.js";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/operation-payloads/", import.meta.url),
);
let root: string;
let operations: ComparisonOperations<unknown>;
let host: ReturnType<typeof createApp> | undefined;
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  operations = new ComparisonOperations(
    path.join(root, "reviews"),
    path.join(root, "process"),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  host?.dispose();
  host = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});
const text = Array.from(
  { length: 1200 },
  (_, index) =>
    `Paragraph ${index}: retain the complete document, comments and copied feedback after a lost save response.`,
).join("\n\n");
const result = (): SyncResult<unknown> => ({
  status: "committed",
  savedPath: "/separate.md",
  reviewUrl: "?comparison=separate",
  uiDrafts: {
    comments: { c1: { value: "Unsubmitted private reply", editing: true } },
  },
  state: {
    review: { beforeText: text, afterText: text, draft: { markdown: text } },
    draft: {
      markdown: text,
      cleanMarkdown: text,
      decisions: {},
      reviewComments: [],
    },
    revision: 2,
    signature: "retained",
    disk: null,
    registryGeneration: "2",
    operationContext: operations.context(),
  },
});
const identity = (id: string, sequence = 1) => ({
  operationId: id,
  operationSequence: sequence,
  pageInstanceId: "page",
  operationContext: operations.context(),
});
const file = (id: string) =>
  path.join(root, "reviews", "operations", `${id}.json`);
function payloadFile(id: string) {
  const header = JSON.parse(fs.readFileSync(file(id), "utf8"));
  expect(header.resultPayload?.file).toBeTruthy();
  return path.join(
    root,
    "reviews",
    "operations",
    "payloads",
    header.resultPayload.file,
  );
}

async function saveHttp() {
  host = createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "http-reviews"),
    staticDirPath: root,
  });
  const target = path.join(root, "source.md");
  fs.writeFileSync(target, text);
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  const state = (
    await request(host.app).get(`/api/comparisons/${opened.body.id}/state`)
  ).body;
  const changed = text.replace("Paragraph 0", "Updated paragraph 0");
  const saved = await request(host.app)
    .post(`/api/comparisons/${state.review.id}/reconcile`)
    .send({
      ...identity("http-result"),
      operationContext: state.operationContext,
      expectedRevision: state.revision,
      baseRevision: state.revision,
      baseSignature: state.signature,
      base: state.draft,
      draft: { ...state.draft, markdown: changed, cleanMarkdown: changed },
      expectedDisk: {
        path: state.disk.path,
        version: state.disk.version,
        hash: state.disk.hash,
      },
      reason: "sync",
      localGeneration: 1,
      writeFile: true,
    });
  expect(saved.status).toBe(200);
  expect(saved.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(changed);
  const journal = path.join(
    root,
    "http-reviews",
    "operations",
    "http-result.json",
  );
  return { target, state, changed, journal };
}

test("an actual HTTP 100 KiB save keeps its durable journal header small independently of response format", async () => {
  const { journal, changed } = await saveHttp();
  expect(fs.statSync(journal).size).toBeLessThan(16 * 1024);
  if (!host) throw new Error("Expected the HTTP test server");
  const recovered = await request(host.app).get(
    "/api/comparisons/operations/http-result",
  );
  expect(recovered.body.status).toBe("committed");
  expect(recovered.body.state.draft.markdown).toBe(changed);
});

for (const phase of ["prepared", "done"] as const) {
  test.each([
    "missing",
    "corrupt",
  ] as const)(`HTTP status and resolve keep a ${phase} operation indeterminate when its payload is %s`, async (damage) => {
    const { journal, state, target, changed } = await saveHttp();
    const header = JSON.parse(fs.readFileSync(journal, "utf8"));
    header.phase = phase;
    fs.writeFileSync(journal, JSON.stringify(header));
    const payload = path.join(
      path.dirname(journal),
      "payloads",
      header.resultPayload.file,
    );
    if (damage === "missing") fs.unlinkSync(payload);
    else {
      const corrupted = fs.readFileSync(payload);
      corrupted[0] ^= 255;
      fs.writeFileSync(payload, corrupted);
    }
    const reviewFile = path.join(
      root,
      "http-reviews",
      `${state.review.id}.json`,
    );
    const before = fs.readFileSync(reviewFile, "utf8");
    if (!host) throw new Error("Expected the HTTP test server");
    const status = await request(host.app).get(
      "/api/comparisons/operations/http-result",
    );
    expect(status.body.status).toBe("indeterminate");
    const resolved = await request(host.app)
      .post("/api/comparisons/operations/http-result/resolve")
      .send({
        ...identity("http-result"),
        operationContext: state.operationContext,
        reviewId: state.review.id,
      });
    expect(resolved.body.status).toBe("indeterminate");
    expect(fs.readFileSync(reviewFile, "utf8")).toBe(before);
    expect(fs.readFileSync(target, "utf8")).toBe(changed);
  });
}

test("prepared and completed phases retain one immutable payload and replay complete copy feedback over restart", () => {
  const record = operations.begin(identity("copy-result"), "review");
  const complete = result();
  operations.prepare(record, complete);
  expect(fs.statSync(file("copy-result")).size).toBeLessThan(16 * 1024);
  const payload = payloadFile("copy-result");
  const before = fs.statSync(payload);
  operations.finish(record);
  expect(fs.statSync(payload).ino).toBe(before.ino);
  expect(fs.statSync(payload).mtimeMs).toBe(before.mtimeMs);
  const restarted = new ComparisonOperations(
    path.join(root, "reviews"),
    path.join(root, "process"),
  );
  expect(restarted.read("copy-result")?.result).toEqual({
    ...complete,
    operationId: "copy-result",
  });
});

test("acknowledgment and retention inspect small headers without decoding the saved document payload", () => {
  const record = operations.begin(identity("large"), "review");
  operations.prepare(record, result());
  operations.finish(record);
  const read = fs.readFileSync.bind(fs);
  let largeReads = 0;
  vi.spyOn(fs, "readFileSync").mockImplementation(
    (...args: Parameters<typeof fs.readFileSync>) => {
      const value = read(...args);
      if (
        Buffer.byteLength(value) > 64 * 1024 ||
        String(args[0]).endsWith(".gz")
      )
        largeReads++;
      return value;
    },
  );
  operations.begin(
    { ...identity("next", 2), acknowledgedOperationIds: ["large"] },
    "review",
  );
  operations.maintenance();
  expect(largeReads).toBe(0);
});

test.each([
  "missing",
  "corrupt",
] as const)("a %s result payload remains discoverably indeterminate and cannot become not received", (damage) => {
  const operation = identity("damaged");
  const record = operations.begin(operation, "review");
  operations.prepare(record, result());
  operations.finish(record);
  const payload = payloadFile("damaged");
  const intact = fs.readFileSync(payload);
  if (damage === "missing") fs.unlinkSync(payload);
  else fs.writeFileSync(payload, "corrupt payload bytes");
  const read = operations.read("damaged");
  expect(read).not.toBeNull();
  expect(read?.phase).toBe("done");
  expect(read).toMatchObject({ resultUnavailable: true });
  expect(operations.lost(operation)).toBe(true);
  fs.writeFileSync(payload, intact);
  expect(operations.read("damaged")?.result?.status).toBe("committed");
  expect(operations.lost(operation)).toBe(false);
});

test("exact durable prune coverage and marker cleanup guard removal of both header and owned payload", () => {
  let allow = false;
  operations = new ComparisonOperations(
    path.join(root, "reviews"),
    path.join(root, "process"),
    (record) => {
      expect(
        operations.wasPruned(
          record.operation.pageInstanceId,
          record.operation.operationSequence,
        ),
      ).toBe(true);
      return allow;
    },
  );
  const record = operations.begin(identity("retained"), "review");
  operations.prepare(record, result());
  operations.finish(record);
  const payload = payloadFile("retained");
  const header = JSON.parse(fs.readFileSync(file("retained"), "utf8"));
  header.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file("retained"), JSON.stringify(header));
  operations.maintenance();
  expect(fs.existsSync(payload)).toBe(true);
  expect(operations.read("retained")?.result?.status).toBe("committed");
  allow = true;
  operations.maintenance();
  expect(fs.existsSync(payload)).toBe(false);
  expect(operations.read("retained")).toBeNull();
  expect(operations.lost(identity("retained"))).toBe(true);
});

test("legacy inline results remain readable with complete feedback", () => {
  const operation = identity("legacy-inline");
  const complete = { ...result(), operationId: operation.operationId };
  fs.writeFileSync(
    file(operation.operationId),
    JSON.stringify({
      operation,
      reviewId: "review",
      createdAt: Date.now(),
      phase: "done",
      result: complete,
    }),
  );
  expect(operations.read(operation.operationId)?.result).toEqual(complete);
});

test("a crash after payload publication preserves running work, then grace cleanup removes only its superseded orphan", () => {
  const record = operations.begin(identity("interrupted"), "review");
  const rename = fs.renameSync.bind(fs);
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === file("interrupted"))
      throw Object.assign(new Error("Stopped before prepared header"), {
        code: "EIO",
      });
    return rename(from, to);
  });
  expect(() => operations.prepare(record, result())).toThrow(
    "Stopped before prepared header",
  );
  vi.restoreAllMocks();
  const directory = path.join(root, "reviews", "operations", "payloads");
  const names = fs.readdirSync(directory);
  expect(names).toHaveLength(1);
  const orphan = path.join(directory, names[0]);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(orphan, old, old);
  expect(operations.read("interrupted")?.phase).toBe("running");
  operations.maintenance();
  expect(fs.existsSync(orphan)).toBe(true);
  operations.prepare(record, { status: "rejected" });
  operations.finish(record);
  operations.maintenance();
  expect(fs.existsSync(orphan)).toBe(false);
  expect(operations.read("interrupted")?.result?.status).toBe("rejected");
});

test("orphan cleanup does bounded work per maintenance call and makes progress without waiting another grace period", () => {
  const directory = path.join(root, "reviews", "operations", "payloads");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (let index = 0; index < 130; index++) {
    const filename = path.join(
      directory,
      `orphan-${String(index).padStart(3, "0")}.${"a".repeat(64)}.json.gz`,
    );
    fs.writeFileSync(filename, "unreferenced test payload");
    fs.utimesSync(filename, old, old);
  }
  operations.maintenance();
  const remaining = fs.readdirSync(directory).length;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(130);
  for (let run = 0; run < 3; run++) operations.maintenance();
  expect(fs.readdirSync(directory)).toEqual([]);
});

test("a lost header does not make an unacknowledged operation's only result disposable", () => {
  const operation = identity("lost-header");
  const record = operations.begin(operation, "review");
  operations.prepare(record, result());
  operations.finish(record);
  const payload = payloadFile("lost-header");
  fs.unlinkSync(file("lost-header"));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(payload, old, old);
  operations.maintenance();
  expect(fs.existsSync(payload)).toBe(true);
  expect(operations.lost(operation)).toBe(true);
});
