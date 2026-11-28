import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComparisonOperations,
  readOperation,
} from "./comparison-operations.js";

describe("durable save outcomes", () => {
  const parent = fileURLToPath(
    new URL("../../../.test-tmp/backend-operations/", import.meta.url),
  );
  let root: string;
  let operations: ComparisonOperations<unknown>;
  const identity = (id: string, sequence: number, pageInstanceId = "page") => ({
    operationId: id,
    operationSequence: sequence,
    pageInstanceId,
    operationContext: operations.context(),
  });
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

  it("keeps owner identity stable when a container hostname and process epoch change", () => {
    const first = operations.context();
    vi.spyOn(os, "hostname").mockReturnValue("replacement-container");
    const restarted = new ComparisonOperations(
      path.join(root, "reviews"),
      path.join(root, "process"),
    );
    expect(restarted.context().owner).toBe(first.owner);
    expect(restarted.context().epoch).not.toBe(first.epoch);
    expect(
      restarted.valid({ ...identity("old", 1), operationContext: first }),
    ).toBe(false);
  });

  it("preserves rejected outcomes and only prunes exact acknowledged sequences", () => {
    operations.begin(identity("unresolved-copy", 10), "review");
    let acknowledged: string[] = [];
    for (let sequence = 11; sequence < 32; sequence++) {
      const id = `operation-${sequence}`;
      const record = operations.begin(
        { ...identity(id, sequence), acknowledgedOperationIds: acknowledged },
        "review",
      );
      operations.prepare(record, {
        status: sequence === 11 ? "retry-later" : "committed",
      });
      operations.finish(record);
      acknowledged = [...acknowledged, id].slice(-16);
    }
    expect(operations.read("unresolved-copy")?.phase).toBe("running");
    expect(operations.lost(identity("unresolved-copy", 10))).toBe(false);
    expect(operations.lost(identity("operation-11", 11))).toBe(true);
    expect(operations.lost(identity("not-received", 33))).toBe(false);
    expect(operations.lost(identity("another-page", 11, "other"))).toBe(false);
    const pages = fs
      .readdirSync(path.join(root, "reviews", "operations"))
      .filter((name) => name.startsWith("page-"));
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(root, "reviews", "operations", pages[0]),
        "utf8",
      ),
    );
    expect(metadata.pruned).toHaveLength(1);
    expect(metadata.operations.length).toBeLessThanOrEqual(18);
  });

  it("indexes direct denials with the same exact ACK retention and sequence coverage", () => {
    operations.begin(identity("unresolved-copy", 10), "review");
    let acknowledged: string[] = [];
    for (let sequence = 11; sequence < 32; sequence++) {
      const id = `denied-${sequence}`;
      const result = operations.deny(
        {
          ...identity(id, sequence),
          // A caller cannot acknowledge this response before receiving it.
          acknowledgedOperationIds: [...acknowledged, id],
        },
        "review",
        { status: "retry-later", retryAfter: 100 },
      );
      expect(operations.read(id)).toMatchObject({
        phase: "done",
        reviewId: "review",
        result,
      });
      acknowledged = [...acknowledged, id].slice(-16);
    }
    expect(operations.read("unresolved-copy")?.phase).toBe("running");
    expect(operations.lost(identity("unresolved-copy", 10))).toBe(false);
    expect(operations.read("denied-11")).toBeNull();
    expect(operations.wasPruned("page", 11)).toBe(true);
    expect(operations.lost(identity("denied-11", 11))).toBe(true);
    expect(operations.lost(identity("never-received", 32))).toBe(false);
    expect(operations.lost(identity("another-page", 11, "other"))).toBe(false);
    const pages = fs
      .readdirSync(path.join(root, "reviews", "operations"))
      .filter((name) => name.startsWith("page-"));
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(root, "reviews", "operations", pages[0]),
        "utf8",
      ),
    );
    expect(metadata.operations.at(-1)).toEqual({
      id: "denied-31",
      sequence: 31,
    });
    expect(metadata.pruned).toEqual([[11, 14]]);
    expect(metadata.operations).toHaveLength(18);
  });

  it("replays a direct denial if its page write fails and fences the orphan before eventual cleanup", () => {
    const operation = identity("denied-before-page", 1);
    const rename = fs.renameSync;
    const failedPage = vi
      .spyOn(fs, "renameSync")
      .mockImplementation((...args: Parameters<typeof fs.renameSync>) => {
        if (path.basename(String(args[1])).startsWith("page-"))
          throw Object.assign(new Error("interrupted page write"), {
            code: "EIO",
          });
        rename(...args);
      });
    expect(() =>
      operations.deny(operation, "review", {
        status: "retry-later",
        retryAfter: 123,
      }),
    ).toThrow("interrupted page write");
    failedPage.mockRestore();
    const result = {
      status: "retry-later",
      retryAfter: 123,
      operationId: operation.operationId,
    };
    expect(operations.read(operation.operationId)).toMatchObject({
      operation,
      reviewId: "review",
      phase: "done",
      result,
    });
    expect(
      fs.readdirSync(path.join(root, "reviews", "operations")),
    ).not.toContainEqual(expect.stringMatching(/^page-/));

    let fencedBeforeRemoval = false;
    operations = new ComparisonOperations(
      path.join(root, "reviews"),
      path.join(root, "process"),
      (record) => {
        fencedBeforeRemoval = operations.wasPruned(
          record.operation.pageInstanceId,
          record.operation.operationSequence,
        );
        return true;
      },
    );
    expect(operations.read(operation.operationId)?.result).toEqual(result);
    const filename = path.join(
      root,
      "reviews",
      "operations",
      `${operation.operationId}.json`,
    );
    const header = JSON.parse(fs.readFileSync(filename, "utf8"));
    header.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(filename, JSON.stringify(header));
    operations.maintenance();
    expect(fencedBeforeRemoval).toBe(true);
    expect(operations.read(operation.operationId)).toBeNull();
    expect(operations.lost(operation)).toBe(true);
  });

  it("does not confuse a missing expected journal with a never-used operation", () => {
    fs.rmSync(path.join(root, "reviews", "operations"), { recursive: true });
    const restarted = new ComparisonOperations(
      path.join(root, "reviews"),
      path.join(root, "process"),
    );
    expect(
      restarted.lost({
        ...identity("missing", 1),
        operationContext: restarted.context(),
      }),
    ).toBe(true);
  });

  it("detects a journal removed while this server is still running", () => {
    const operation = identity("committed", 1);
    const record = operations.begin(operation, "review");
    operations.prepare(record, { status: "committed" });
    operations.finish(record);
    fs.rmSync(path.join(root, "reviews", "operations", "generation.json"));
    fs.rmSync(path.join(root, "reviews", "operations", "committed.json"));
    expect(operations.lost(operation)).toBe(true);
  });

  it("expires terminal orphan results after seven days but retains discoverable running intents", () => {
    const ended = operations.begin(identity("terminal", 1), "review");
    operations.prepare(ended, { status: "rejected" });
    operations.finish(ended);
    operations.begin(identity("running", 2), "review");
    const filename = path.join(root, "reviews", "operations", "terminal.json");
    const old = JSON.parse(fs.readFileSync(filename, "utf8"));
    old.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(filename, JSON.stringify(old));
    operations.maintenance();
    expect(operations.read("terminal")).toBeNull();
    expect(operations.lost(identity("terminal", 1))).toBe(true);
    expect(operations.read("running")?.phase).toBe("running");
  });

  it("requires a complete, finite operation identity and rejects an implausible deadline", () => {
    expect(() => readOperation({})).toThrow("complete save operation");
    expect(() =>
      readOperation({ ...identity("invalid", 1), operationSequence: 0 }),
    ).toThrow();
    expect(
      operations.valid({
        ...identity("far-future", 1),
        operationContext: {
          ...operations.context(),
          acceptUntil: Date.now() + 24 * 60 * 60 * 1000,
        },
      }),
    ).toBe(false);
  });

  it("retains a result while matching-marker cleanup is blocked, with exact pruning already durable", () => {
    let cleanupAllowed = false;
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
        return cleanupAllowed;
      },
    );
    const operation = identity("blocked-cleanup", 4);
    const record = operations.begin(operation, "review");
    operations.prepare(record, { status: "committed" });
    operations.finish(record);
    const filename = path.join(
      root,
      "reviews",
      "operations",
      "blocked-cleanup.json",
    );
    const stored = JSON.parse(fs.readFileSync(filename, "utf8"));
    stored.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(filename, JSON.stringify(stored));
    operations.maintenance();
    expect(operations.read(operation.operationId)?.result?.status).toBe(
      "committed",
    );
    expect(operations.wasPruned(operation.pageInstanceId, 3)).toBe(false);
    cleanupAllowed = true;
    operations.maintenance();
    expect(operations.read(operation.operationId)).toBeNull();
    expect(operations.lost(operation)).toBe(true);
  });
});
