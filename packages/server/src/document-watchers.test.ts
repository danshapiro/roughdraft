import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentWatcherRegistry,
  type DocumentWatchEvent,
} from "./document-watchers";

let directory: string;
const registries: DocumentWatcherRegistry[] = [];
function registry(
  options: ConstructorParameters<typeof DocumentWatcherRegistry>[0] = {},
) {
  const value = new DocumentWatcherRegistry({
    coalesceMs: 15,
    maxWaitMs: 50,
    stabilityMs: 10,
    sweepMs: 5,
    leaseMs: 60,
    consistencyMs: 5000,
    ...options,
  });
  registries.push(value);
  return value;
}
function nextChange(watchers: DocumentWatcherRegistry, filename: string) {
  let stop: () => void;
  const result = new Promise<DocumentWatchEvent>((resolve) => {
    stop = watchers.subscribe([filename], (event) => {
      stop();
      resolve(event);
    });
  });
  return result;
}
beforeEach(() => {
  const root = path.resolve(import.meta.dirname, "../../../.test-tmp");
  fs.mkdirSync(root, { recursive: true });
  directory = fs.mkdtempSync(path.join(root, "roughdraft-watch-"));
});
afterEach(() => {
  for (const r of registries.splice(0)) r.close();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("shared document watchers", () => {
  it("caches exact existing file versions without re-reading on repeated state checks", () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Complete text\n");
    const watchers = registry();
    const first = watchers.get(filename);
    const stat = fs.statSync(filename);
    const hash = crypto
      .createHash("sha256")
      .update("Complete text\n")
      .digest("hex");
    expect(first.version).toBe(
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${hash}`,
    );
    for (let n = 0; n < 100; n++) expect(watchers.get(filename)).toBe(first);
    expect(watchers.diagnostics().reads).toBe(1);
    expect(watchers.diagnostics().hashes).toBe(1);
  });
  it("shares a parent watcher and filters unrelated file events", async () => {
    const first = path.join(directory, "one.md"),
      second = path.join(directory, "two.md");
    fs.writeFileSync(first, "One");
    fs.writeFileSync(second, "Two");
    const watchers = registry();
    const one = vi.fn();
    const two = vi.fn();
    const stopOne = watchers.subscribe([first], one);
    const stopTwo = watchers.subscribe([second], two);
    expect(watchers.diagnostics().watchers).toBe(1);
    fs.writeFileSync(first, "Changed one");
    await vi.waitFor(() => expect(one).toHaveBeenCalledOnce());
    expect(two).not.toHaveBeenCalled();
    stopOne();
    expect(watchers.diagnostics().watchers).toBe(1);
    stopTwo();
    expect(watchers.diagnostics().watchers).toBe(0);
  });
  it("follows an atomic rename replacement and then the replacement's next save", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Original");
    const watchers = registry();
    const first = nextChange(watchers, filename);
    const temporary = path.join(directory, "next.tmp");
    fs.writeFileSync(temporary, "Atomic replacement");
    fs.renameSync(temporary, filename);
    expect((await first).snapshot.text).toBe("Atomic replacement");
    const second = nextChange(watchers, filename);
    fs.writeFileSync(filename, "Next complete save");
    expect((await second).snapshot.text).toBe("Next complete save");
  });
  it("detects changed bytes even when size and modification time are restored", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Before");
    const stat = fs.statSync(filename);
    const watchers = registry();
    const changed = nextChange(watchers, filename);
    fs.writeFileSync(filename, "After!");
    fs.utimesSync(filename, stat.atime, stat.mtime);
    const event = await changed;
    expect(event.snapshot.text).toBe("After!");
    expect(event.snapshot.hash).not.toBe(
      crypto.createHash("sha256").update("Before").digest("hex"),
    );
  });
  it("coalesces a save burst into the latest complete text", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Original");
    const watchers = registry();
    const seen = vi.fn();
    watchers.subscribe([filename], seen);
    const initialReads = watchers.diagnostics().reads;
    for (let n = 0; n < 20; n++)
      fs.writeFileSync(filename, `Complete save ${n}`);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce());
    expect(seen.mock.calls[0][0].snapshot.text).toBe("Complete save 19");
    expect(watchers.diagnostics().reads - initialReads).toBeLessThanOrEqual(3);
  });
  it("keeps the last complete snapshot when an in-place writer changes between stable reads", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Last complete text");
    const watchers = registry();
    const seen = vi.fn();
    watchers.subscribe([filename], seen);
    const originalStat = fs.promises.stat.bind(fs.promises);
    let calls = 0;
    vi.spyOn(fs.promises, "stat").mockImplementation((async (
      ...args: Parameters<typeof fs.promises.stat>
    ) => {
      const stat = await originalStat(...args);
      if (String(args[0]) === filename && ++calls === 2)
        queueMicrotask(() =>
          fs.writeFileSync(filename, "The final complete new text"),
        );
      return stat;
    }) as typeof fs.promises.stat);
    fs.writeFileSync(filename, "Partial");
    await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce());
    expect(seen.mock.calls[0][0].snapshot.text).toBe(
      "The final complete new text",
    );
    expect(watchers.diagnostics().reads).toBeGreaterThanOrEqual(4);
  });
  it("reports deletion and recreation without abandoning the parent watch", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Original");
    const watchers = registry();
    const events: DocumentWatchEvent[] = [];
    watchers.subscribe([filename], (e) => events.push(e));
    fs.unlinkSync(filename);
    await vi.waitFor(() =>
      expect(events.at(-1)?.snapshot.availability).toBe("missing"),
    );
    fs.writeFileSync(filename, "Recreated");
    await vi.waitFor(() =>
      expect(events.at(-1)?.snapshot.text).toBe("Recreated"),
    );
  });
  it("expires fallback leases and releases their cache and OS watchers", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Original");
    const watchers = registry({ leaseMs: 20 });
    watchers.get(filename);
    expect(watchers.diagnostics().paths).toBe(1);
    await vi.waitFor(() => expect(watchers.diagnostics().paths).toBe(0));
    expect(watchers.diagnostics().watchers).toBe(0);
  });
  it("does not publish a known application's intermediate write", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Original");
    const watchers = registry();
    const seen = vi.fn();
    watchers.subscribe([filename], seen);
    const release = watchers.beginPublication([filename], "operation-1");
    fs.writeFileSync(filename, "Intermediate");
    watchers.invalidate(filename);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).not.toHaveBeenCalled();
    fs.writeFileSync(filename, "Complete application write");
    release();
    await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce());
    expect(seen.mock.calls[0][0].snapshot.text).toBe(
      "Complete application write",
    );
  });
  it("labels an unobservable single-file mount instead of claiming freshness", () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Pinned inode");
    const watchers = registry({ unobservablePaths: [filename] });
    const snapshot = watchers.get(filename);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.availability).toBe("unobservable");
    expect(snapshot.error).toMatch(/mounted file/i);
  });
  it("falls back to bounded shared checks after directory watching fails", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Before");
    const watchers = registry({
      watchDirectory: () => {
        throw new Error("unavailable watcher");
      },
      degradedConsistencyMs: 20,
    });
    const seen = vi.fn();
    watchers.subscribe([filename], seen);
    fs.writeFileSync(filename, "After fallback");
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
    expect(seen.mock.calls.at(-1)?.[0].snapshot.text).toBe("After fallback");
    expect(watchers.diagnostics().degraded).toBe(1);
  });
  it("reattaches a parent watch after the watched directory is replaced", async () => {
    const parent = path.join(directory, "folder");
    fs.mkdirSync(parent);
    const filename = path.join(parent, "draft.md");
    fs.writeFileSync(filename, "Original");
    const watchers = registry({ degradedConsistencyMs: 20 });
    const seen = vi.fn();
    watchers.subscribe([filename], seen);
    fs.rmSync(parent, { recursive: true });
    fs.mkdirSync(parent);
    fs.writeFileSync(filename, "Recreated directory");
    await vi.waitFor(() =>
      expect(seen.mock.calls.at(-1)?.[0].snapshot.text).toBe(
        "Recreated directory",
      ),
    );
    await vi.waitFor(() => expect(watchers.diagnostics().degraded).toBe(0));
    fs.writeFileSync(filename, "Later watched save");
    await vi.waitFor(() =>
      expect(seen.mock.calls.at(-1)?.[0].snapshot.text).toBe(
        "Later watched save",
      ),
    );
  });
  it("closes every resource explicitly and ignores later filesystem writes", () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Original");
    const watchers = registry();
    const seen = vi.fn();
    watchers.subscribe([filename], seen);
    watchers.close();
    fs.writeFileSync(filename, "Later");
    expect(watchers.diagnostics()).toMatchObject({
      paths: 0,
      watchers: 0,
      timers: 0,
    });
    expect(seen).not.toHaveBeenCalled();
  });
});
