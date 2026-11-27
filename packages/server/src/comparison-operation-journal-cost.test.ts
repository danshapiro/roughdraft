import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SyncResult } from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonOperations } from "./comparison-operations.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/operation-journal-cost/", import.meta.url),
);
let root: string;
let operations: ComparisonOperations<unknown>;
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
  fs.rmSync(root, { recursive: true, force: true });
});

const identity = () => ({
  operationId: "deferred-save",
  pageInstanceId: "typing-page",
  operationSequence: 1,
  operationContext: operations.context(),
});
const text = Array.from(
  { length: 1200 },
  (_, index) =>
    `Paragraph ${index}: preserve complete edits and feedback when another browser has the next merge turn.`,
).join("\n\n");

test.each([
  false,
  true,
])("a deferred %s large-document save durably stores its terminal outcome without a redundant header flush", (large) => {
  const operation = identity();
  const result: SyncResult<unknown> = {
    status: "retry-later",
    retryAfter: 25,
    ...(large
      ? {
          state: {
            review: { beforeText: text, afterText: text },
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
        }
      : {}),
  };
  // Exercise the real atomic-file path, including its running intent and
  // page index. Completion needs one outcome header, plus a large payload.
  const flush = vi.spyOn(fs, "fsyncSync");
  expect(operations.reject(operation, "review", result)).toEqual({
    ...result,
    operationId: operation.operationId,
  });
  const completionFlushes = flush.mock.calls.length;
  vi.restoreAllMocks();

  const restarted = new ComparisonOperations(
    path.join(root, "reviews"),
    path.join(root, "process"),
  );
  expect(restarted.read(operation.operationId)).toMatchObject({
    phase: "done",
    result: { ...result, operationId: operation.operationId },
  });
  expect(restarted.lost(operation)).toBe(false);
  expect(completionFlushes).toBeLessThanOrEqual(large ? 8 : 6);
});

test("a committed result still requires completion after its prepared outcome", () => {
  const operation = identity();
  const record = operations.begin(operation, "review");
  operations.prepare(record, { status: "committed" });
  expect(operations.read(operation.operationId)?.phase).toBe("prepared");
  const flush = vi.spyOn(fs, "fsyncSync");
  operations.finish(record);
  expect(flush).toHaveBeenCalledTimes(2);
  expect(operations.read(operation.operationId)?.phase).toBe("done");
});

test("a terminal rejection is replayable if the process stops before finish", () => {
  const operation = identity();
  const record = operations.begin(operation, "review");
  const result: SyncResult<unknown> = {
    status: "client-merge-required",
    reservation: { token: "turn", revision: 2, expiresAt: Date.now() + 750 },
  };
  operations.prepare(record, result, { terminal: true });
  const restarted = new ComparisonOperations(
    path.join(root, "reviews"),
    path.join(root, "process"),
  );
  expect(restarted.read(operation.operationId)).toMatchObject({
    phase: "done",
    result: { ...result, operationId: operation.operationId },
  });
  const flush = vi.spyOn(fs, "fsyncSync");
  operations.finish(record);
  expect(flush).not.toHaveBeenCalled();
});

test("committed outcomes cannot opt out of the authoritative commit ordering", () => {
  const operation = identity();
  const record = operations.begin(operation, "review");
  expect(() =>
    operations.prepare(record, { status: "committed" }, { terminal: true }),
  ).toThrow("authoritative review commit");
  expect(operations.read(operation.operationId)?.phase).toBe("running");
});
