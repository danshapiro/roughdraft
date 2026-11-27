import {
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";

const listeners = vi.hoisted(() => new Map<string, (value: unknown) => void>());
vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: (id: string, listener: (value: unknown) => void) => {
    listeners.set(id, listener);
    return () => listeners.delete(id);
  },
}));
class MemoryStorage {
  private records = new Map<string, string>();
  get length() {
    return this.records.size;
  }
  getItem(key: string) {
    return this.records.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.records.set(key, value);
  }
  removeItem(key: string) {
    this.records.delete(key);
  }
  key(index: number) {
    return [...this.records.keys()][index] ?? null;
  }
}
const controllers: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  });
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  listeners.clear();
  vi.useRealTimers();
});
function state(
  markdown = "Saved text.\n",
  revision = 1,
): SyncState<ComparisonReviewData> {
  const draft: RevisionDraft = {
    markdown,
    cleanMarkdown: markdown,
    decisions: {},
    reviewComments: [],
  };
  return {
    review: {
      id: "review",
      revision,
      mode: "document",
      title: "Compact retries",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: null,
      beforeText: markdown,
      afterText: markdown,
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
    revision,
    signature: reviewDraftSignature(draft),
    disk: null,
    registryGeneration: String(revision),
    operationContext: {
      owner: "test",
      epoch: "old",
      acceptUntil: Date.now() + 120_000,
    },
  };
}
function install(
  request: <T>(route: string, body?: object) => Promise<T | null>,
) {
  const initial = state();
  const controller = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    { request, storage: new MemoryStorage(), tabStorage: new MemoryStorage() },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => ({
      ...value,
      cleanMarkdown: value.cleanMarkdown ?? value.markdown,
    }),
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  return controller;
}

test.each([
  "post",
  "resolve",
])("a state-free retry from %s refreshes save permission before the next operation", async (source) => {
  let server = state();
  const posts: ReconcileRequest[] = [];
  const fresh = {
    owner: "test",
    epoch: "renewed",
    acceptUntil: Date.now() + 120_000,
  };
  const marker = {
    status: "retry-later",
    retryAfter: 25,
    retryRevision: 1,
    operationContext: fresh,
  };
  const controller = install(async <T>(route: string, body?: object) => {
    if (!body) return structuredClone(server) as T;
    if (route.includes("/operations/")) return marker as T;
    if (route.endsWith("/checkpoint")) return { checkpointId: "recovery" } as T;
    const request = body as ReconcileRequest;
    posts.push(request);
    if (posts.length === 1) {
      if (source === "resolve") throw new Error("Lost response");
      return marker as T;
    }
    server = state(request.draft.markdown, 2);
    server.review.lastOperation = {
      id: request.operationId,
      pageInstanceId: request.pageInstanceId,
      reason: request.reason,
    };
    return { status: "committed", state: server } as T;
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft((draft) => ({
    ...draft,
    markdown: "Typed text.\n",
    cleanMarkdown: "Typed text.\n",
  }));
  await controller.flush();
  await controller.flush();
  expect(posts).toHaveLength(2);
  expect(posts[1].operationContext).toEqual(fresh);
  expect(controller.readDraft().markdown).toBe("Typed text.\n");
});

test("a compact retry uses the server retry revision so its existing turn is not released by an older hint", async () => {
  let server = state();
  const posts: number[] = [];
  const controller = install(async <T>(route: string, body?: object) => {
    if (!body) return structuredClone(server) as T;
    if (route.endsWith("/checkpoint")) return { checkpointId: "recovery" } as T;
    const request = body as ReconcileRequest;
    posts.push(performance.now());
    if (posts.length === 1)
      return {
        status: "retry-later",
        retryAfter: 700,
        retryRevision: 2,
        operationContext: server.operationContext,
      } as T;
    server = state(request.draft.markdown, 3);
    server.review.lastOperation = {
      id: request.operationId,
      pageInstanceId: request.pageInstanceId,
      reason: request.reason,
    };
    return { status: "committed", state: server } as T;
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft((draft) => ({
    ...draft,
    markdown: "Typed text.\n",
    cleanMarkdown: "Typed text.\n",
  }));
  await vi.advanceTimersByTimeAsync(320);
  expect(posts).toHaveLength(1);
  server = state("Saved text.\n", 2);
  listeners.get("review")?.({
    reason: "changed",
    state: structuredClone(server),
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(posts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(700);
  expect(posts).toHaveLength(2);
  expect(posts[1] - posts[0]).toBeGreaterThanOrEqual(700);
});
