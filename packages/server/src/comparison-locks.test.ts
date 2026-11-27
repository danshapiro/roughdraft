import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComparisonLockBusy, ComparisonLocks } from "./comparison-locks.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

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

  it("takes all three publication locks with one expensive parent process start", () => {
    const locks = new ComparisonLocks(directory);
    expect(locks.available).toBe(true);
    vi.mocked(spawnSync).mockClear();
    locks.run(
      ["review:abc", "operation:unique", "file:/home/x/review.md"],
      () => {
        expect(spawnSync).toHaveBeenCalledTimes(1);
        expect(fs.readdirSync(directory)).toHaveLength(3);
      },
    );
  });

  it("keeps every existing lock file owned by the parent against a real separate flock process", () => {
    const keys = ["review:abc", "operation:unique", "file:/home/x/review.md"];
    const files = keys.map((key) =>
      path.join(
        directory,
        crypto.createHash("sha256").update(key).digest("hex").slice(0, 2),
      ),
    );
    const locks = new ComparisonLocks(directory);
    const contend = (filename: string) =>
      spawnSync("flock", ["-xn", filename, "true"], { timeout: 3000 }).status;
    locks.run(keys, () => {
      for (const filename of files) expect(contend(filename)).toBe(1);
    });
    for (const filename of files) expect(contend(filename)).toBe(0);
  });

  it("releases an acquired prefix after a later cross-process lock conflict", () => {
    const keys = ["prefix-a", "prefix-b", "prefix-c"].sort((left, right) =>
      crypto
        .createHash("sha256")
        .update(left)
        .digest("hex")
        .localeCompare(crypto.createHash("sha256").update(right).digest("hex")),
    );
    const blocker = new ComparisonLocks(directory);
    const candidate = new ComparisonLocks(directory);
    let mutationRan = false;
    blocker.run([keys[2]], () => {
      expect(() =>
        candidate.run(keys, () => {
          mutationRan = true;
        }),
      ).toThrow(ComparisonLockBusy);
      expect(mutationRan).toBe(false);
      const independent = new ComparisonLocks(directory);
      expect(independent.run(keys.slice(0, 2), () => "prefix released")).toBe(
        "prefix released",
      );
      expect(() => independent.run([keys[2]], () => undefined)).toThrow(
        ComparisonLockBusy,
      );
    });
    expect(candidate.run(keys, () => "all released")).toBe("all released");
  });

  it("still contends with a lock acquired through the previous per-descriptor command", () => {
    const key = "legacy-review";
    const locks = new ComparisonLocks(directory);
    const filename = path.join(
      directory,
      crypto.createHash("sha256").update(key).digest("hex").slice(0, 2),
    );
    const fd = fs.openSync(filename, "a", 0o600);
    try {
      expect(
        spawnSync("flock", ["-xn", "3"], {
          stdio: ["ignore", "pipe", "pipe", fd],
          timeout: 3000,
        }).status,
      ).toBe(0);
      expect(() => locks.run([key], () => undefined)).toThrow(
        ComparisonLockBusy,
      );
    } finally {
      fs.closeSync(fd);
    }
    expect(locks.run([key], () => "legacy holder released")).toBe(
      "legacy holder released",
    );
  });

  it("distinguishes an unavailable helper from contention and closes its descriptors", () => {
    const locks = new ComparisonLocks(directory);
    expect(locks.available).toBe(true);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "";
      expect(() => locks.run(["review"], () => undefined)).toThrow(
        "Could not acquire the review's publication lock",
      );
    } finally {
      process.env.PATH = savedPath;
    }
    const independent = new ComparisonLocks(directory);
    expect(independent.run(["review"], () => "helper failure released")).toBe(
      "helper failure released",
    );
  });

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
