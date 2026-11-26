import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComparisonLockBusy, ComparisonLocks } from "./comparison-locks.js";

describe("synchronous process-released review locks", () => {
  const parent = fileURLToPath(
    new URL("../../../.test-tmp/backend-locks/", import.meta.url),
  );
  let directory: string;
  beforeEach(() => {
    fs.mkdirSync(parent, { recursive: true });
    directory = fs.mkdtempSync(path.join(parent, "run-"));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("keeps the lock after the helper exits and releases it after a thrown mutation", () => {
    const first = new ComparisonLocks(directory);
    const second = new ComparisonLocks(directory);
    expect(first.available).toBe(true);
    expect(() =>
      first.run(["review"], () => {
        expect(() => second.run(["review"], () => undefined)).toThrow(
          ComparisonLockBusy,
        );
        first.run(["review"], () => undefined);
        throw new Error("write failed");
      }),
    ).toThrow("write failed");
    expect(second.run(["review"], () => "released")).toBe("released");
  });

  it("bounds lock files for unique autosave IDs and closes partially acquired sets", () => {
    const locks = new ComparisonLocks(directory);
    const second = new ComparisonLocks(directory);
    locks.run(["shared"], () => {
      expect(() => second.run(["another", "shared"], () => undefined)).toThrow(
        ComparisonLockBusy,
      );
    });
    expect(second.run(["another", "shared"], () => true)).toBe(true);
    locks.run(
      Array.from({ length: 300 }, (_, index) => `operation-${index}`),
      () => undefined,
    );
    expect(fs.readdirSync(directory).length).toBeLessThanOrEqual(256);
  });

  it("uses the explicit no-native-lock fallback when flock is unavailable", () => {
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const locks = new ComparisonLocks(directory);
      expect(locks.available).toBe(false);
      expect(locks.run(["review"], () => "fallback")).toBe("fallback");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
