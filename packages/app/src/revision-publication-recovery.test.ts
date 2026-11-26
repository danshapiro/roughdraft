import { reviewDraftSignature, type SyncState } from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
const draft: RevisionDraft = {
  markdown: "The saved document.\n",
  cleanMarkdown: "The saved document.\n",
  decisions: {},
  reviewComments: [],
};
function state(): SyncState<ComparisonReviewData> {
  return {
    review: {
      id: "stopped-save",
      revision: 1,
      mode: "document",
      title: "Recover an unfinished save",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: null,
      beforeText: draft.markdown,
      afterText: draft.markdown,
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
      draft,
    },
    draft,
    revision: 1,
    signature: reviewDraftSignature(draft),
    disk: null,
    registryGeneration: "1",
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120_000,
    },
  };
}
const active: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
});
afterEach(() => {
  for (const controller of active.splice(0)) controller.stop();
  vi.useRealTimers();
});
function install(
  initial: SyncState<ComparisonReviewData>,
  request: <T>(path: string, body?: object) => Promise<T | null>,
) {
  const controller = new RevisionSessionController(initial.review, draft, {
    request,
    storage: new MemoryStorage(),
    tabStorage: new MemoryStorage(),
  });
  active.push(controller);
  controller.setAdapter({
    apply: (value) => ({
      ...value,
      cleanMarkdown: value.cleanMarkdown ?? value.markdown,
    }),
    adopt: () => null,
    readUiDrafts: () => ({
      comments: {
        c1: { value: "Unfinished private reply", original: "", editing: true },
      },
    }),
    restoreUiDrafts: () => {},
  });
  controller.start();
  return controller;
}

test.each([
  false,
  true,
])("the publication wait rechecks at its deadline without a live event and releases its timer when stopped (one failed check=%s)", async (failOnce) => {
  const initial = state();
  const deadline = Date.now() + 1000;
  let reads = 0;
  let failed = false;
  const controller = install(
    initial,
    async <T>(path: string, body?: object) => {
      if (path.endsWith("/checkpoint"))
        return { checkpointId: "local-recovery" } as T;
      if (body) throw new Error(`Unexpected ${path}`);
      reads++;
      if (failOnce && Date.now() >= deadline && !failed) {
        failed = true;
        throw new Error("Temporary state read failure");
      }
      return {
        ...initial,
        publishing: {
          operationId: "foreign-op",
          owner: "foreign",
          startedAt: deadline - 30_000,
          recoverable: Date.now() >= deadline,
          retryAfter: Math.max(0, deadline - Date.now()),
        },
      } as T;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict?.message).toMatch(
    /save is finishing/i,
  );
  const initialReads = reads;
  await vi.advanceTimersByTimeAsync(1100);
  if (failOnce) await vi.advanceTimersByTimeAsync(1100);
  expect(reads).toBeGreaterThan(initialReads);
  expect(controller.getSnapshot().conflict?.message).toMatch(
    /publication did not finish/i,
  );
  expect(controller.getSnapshot().conflict?.state?.publishing).toMatchObject({
    recoverable: true,
  });
  controller.stop();
  const afterStop = reads;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reads).toBe(afterStop);
});

test("explicit publication recovery clears the stopped-publication wait without replacing newer local text or submitting private feedback", async () => {
  const initial = state();
  const mutations: string[] = [];
  let unfinished = true;
  const controller = install(
    initial,
    async <T>(path: string, body?: object) => {
      if (!body)
        return {
          ...initial,
          ...(unfinished
            ? {
                publishing: {
                  operationId: "foreign-op",
                  owner: "foreign",
                  startedAt: Date.now() - 31_000,
                  recoverable: true,
                  retryAfter: 0,
                },
              }
            : {}),
        } as T;
      if (path.endsWith("/checkpoint"))
        return { checkpointId: "local-recovery" } as T;
      mutations.push(path);
      if (!path.endsWith("/recover")) throw new Error(`Unexpected ${path}`);
      unfinished = false;
      return {
        status: "rejected",
        state: initial,
        checkpointId: "foreign-draft",
        message:
          "The unfinished save was preserved without rewriting the file.",
      } as T;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => ({
    ...draft,
    markdown: "My newer local text.\n",
    cleanMarkdown: "My newer local text.\n",
  }));
  expect(await controller.recoverPublication()).toBe(true);
  expect(mutations).toEqual(["/stopped-save/recover"]);
  expect(controller.readDraft().markdown).toBe("My newer local text.\n");
  expect(controller.readDraft().reviewComments).toEqual([]);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(controller.getSnapshot().writePaused).toBe(false);
});
