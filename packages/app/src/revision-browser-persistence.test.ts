import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import { RevisionSessionController } from "./revision-session";
import type {
  BrowserRecovery,
  PendingOperation,
  RevisionDraft,
} from "./revision-session";
import {
  decodeBrowserRecovery,
  encodeBrowserRecovery,
} from "./revision-browser-recovery";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));
class CountedStorage {
  limit = Number.POSITIVE_INFINITY;
  readonly values = new Map<string, string>();
  readonly writes: Array<{ key: string; value: string }> = [];
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (
      [...this.values.values()].reduce(
        (total, stored) => total + stored.length,
        0,
      ) -
        (this.values.get(key)?.length ?? 0) +
        value.length >
      this.limit
    )
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    this.writes.push({ key, value });
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  get recoveryWrites() {
    return this.writes.filter(({ key }) => key.startsWith("roughdraft-draft:"));
  }
}
const saved = {
  markdown: "Saved body.\n",
  cleanMarkdown: "Saved body.\n",
  decisions: {},
  reviewComments: [],
};
const initial: ComparisonReviewData = {
  id: "browser-persistence",
  revision: 1,
  mode: "document",
  title: "Recover browser edits without blocking typing",
  beforeLabel: "Original",
  afterLabel: "Working",
  beforeText: saved.markdown,
  afterText: saved.markdown,
  segments: [],
  comment: "",
  reviewComments: [],
  status: "open",
  completion: null,
  targetChanged: false,
  editor: "unified",
  autosave: "none",
  handoff: "chat",
  destinationPath: null,
  savedPath: null,
  savedText: null,
  draft: saved,
};
const controllers: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
});
function open(
  shared: CountedStorage,
  privateStorage: CountedStorage,
  id: string,
) {
  const controller = new RevisionSessionController(initial, saved, {
    id: () => id,
    storage: shared,
    tabStorage: privateStorage,
    request: async () => null,
  });
  controllers.push(controller);
  return controller;
}

test("private recovery stays current while shared full-document writes are coalesced, then stop forces the latest copy", async () => {
  const shared = new CountedStorage();
  const privateStorage = new CountedStorage();
  const controller = open(shared, privateStorage, "typing");
  const key = "roughdraft-draft:browser-persistence:typing";
  for (let index = 0; index < 20; index++) {
    const markdown = `Current body ${index}.\n`;
    controller.updateDraft((draft) => ({
      ...draft,
      markdown,
      cleanMarkdown: markdown,
    }));
    expect(
      JSON.parse(privateStorage.getItem(key) ?? "null").draft.markdown,
    ).toBe(markdown);
    await vi.advanceTimersByTimeAsync(25);
  }
  expect(shared.recoveryWrites.length).toBeLessThanOrEqual(1);
  controller.stop();
  expect(JSON.parse(shared.getItem(key) ?? "null").draft.markdown).toBe(
    "Current body 19.\n",
  );
  const reloaded = open(shared, privateStorage, "reloaded");
  expect(reloaded.readDraft().markdown).toBe("Current body 19.\n");
});

test("heartbeats keep a quiet editor live without rewriting its full recovery document", async () => {
  const shared = new CountedStorage();
  const controller = open(shared, new CountedStorage(), "quiet");
  controller.updateDraft((draft) => ({
    ...draft,
    markdown: "Private quiet-tab body.\n",
  }));
  controller.start();
  await vi.advanceTimersByTimeAsync(1_000);
  const writes = shared.recoveryWrites.length;
  await vi.advanceTimersByTimeAsync(12_000);
  expect(shared.recoveryWrites).toHaveLength(writes);
});

test("one quota-sized record restores shared operation snapshots, exact source and both operation identities", () => {
  const before: RevisionDraft = {
    ...saved,
    markdown: `Before ${"a".repeat(64_000)}\n`,
    cleanMarkdown: undefined,
  };
  before.cleanMarkdown = before.markdown;
  const current: RevisionDraft = {
    ...before,
    markdown: before.markdown.replace("Before", "Edited"),
    cleanMarkdown: undefined,
  };
  current.cleanMarkdown = current.markdown;
  const pending: PendingOperation = {
    operation: {
      operationId: "ordinary",
      pageInstanceId: "page",
      operationSequence: 1,
      operationContext: { owner: "server", epoch: "run", acceptUntil: 1 },
    },
    reviewId: initial.id,
    draft: current,
    base: before,
    editorBase: before,
    generation: 1,
    kind: "reconcile",
  };
  const record: BrowserRecovery = {
    version: 2,
    pageInstanceId: "page",
    aliveAt: 1,
    revision: 1,
    draft: current,
    base: before,
    operation: pending,
    copyOperation: {
      ...pending,
      kind: "copy",
      operation: { ...pending.operation, operationId: "copy" },
    },
    uiDrafts: {
      comments: {
        c1: { value: "Exact private draft", original: "", editing: true },
      },
    },
  };
  const storage = new CountedStorage();
  storage.limit = 180_000;
  storage.setItem("recovery", encodeBrowserRecovery(record));
  expect(decodeBrowserRecovery(storage.getItem("recovery"))).toEqual(record);
  expect(decodeBrowserRecovery(JSON.stringify(record))).toEqual(record);
});

test("shared storage failure preserves private work and another page's owned record, then force-flush retries the latest text", async () => {
  const shared = new CountedStorage();
  const other = open(shared, new CountedStorage(), "other");
  other.updateDraft((draft) => ({
    ...draft,
    markdown: "Other page's unique work.\n",
  }));
  other.stop();
  const otherKey = "roughdraft-draft:browser-persistence:other";
  const otherRecord = shared.getItem(otherKey);
  shared.limit = [...shared.values.values()].reduce(
    (total, value) => total + value.length,
    0,
  );
  const privateStorage = new CountedStorage();
  const current = open(shared, privateStorage, "current");
  current.updateDraft((draft) => ({
    ...draft,
    markdown: "Current unique work.\n",
  }));
  expect(current.getSnapshot().browserRecoveryWarning).toBeTruthy();
  expect(shared.getItem(otherKey)).toBe(otherRecord);
  current.stop();
  const reloaded = open(shared, privateStorage, "reloaded");
  expect(reloaded.readDraft().markdown).toBe("Current unique work.\n");
  reloaded.updateDraft((draft) => ({
    ...draft,
    markdown: "Latest unique work.\n",
  }));
  shared.limit = Number.POSITIVE_INFINITY;
  await reloaded.flush();
  const key = "roughdraft-draft:browser-persistence:reloaded";
  expect(decodeBrowserRecovery(shared.getItem(key))?.draft.markdown).toBe(
    "Latest unique work.\n",
  );
  expect(shared.getItem(otherKey)).toBe(otherRecord);
  expect(reloaded.getSnapshot().browserRecoveryWarning).toBe("");
});
