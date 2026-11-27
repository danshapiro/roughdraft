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

test.each([
  { delay: 589, retryAfter: 228, remaining: 20 },
  { delay: 100, retryAfter: 700, remaining: 600 },
])("a retry response delayed by $delay ms consumes its $retryAfter ms backoff", async ({
  delay,
  retryAfter,
  remaining,
}) => {
  let server = state();
  const posts: number[] = [];
  const controller = install(async <T>(route: string, body?: object) => {
    if (!body) return structuredClone(server) as T;
    if (route.endsWith("/checkpoint")) return { checkpointId: "recovery" } as T;
    const request = body as ReconcileRequest;
    posts.push(performance.now());
    if (posts.length === 1) {
      // This is the saved strict-run case: durable result/response delivery
      // takes longer than the peer's remaining turn, with no fresh notice.
      await new Promise((resolve) => setTimeout(resolve, delay));
      return {
        status: "retry-later",
        retryAfter,
        retryRevision: 1,
        operationContext: server.operationContext,
      } as T;
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
  await vi.advanceTimersByTimeAsync(300);
  expect(posts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(delay);
  expect(posts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(remaining - 1);
  expect(posts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(posts).toHaveLength(2);
  expect(posts[1] - posts[0]).toBe(delay + remaining);
  expect(server.draft.markdown).toBe("Typed text.\n");
  expect(controller.readDraft().markdown).toBe("Typed text.\n");
});

test("an elapsed-aware retry still respects an authoritative turn that remains held", async () => {
  let server = state();
  const posts: number[] = [];
  let turnEnds = 0;
  const controller = install(async <T>(route: string, body?: object) => {
    if (!body) return structuredClone(server) as T;
    if (route.endsWith("/checkpoint")) return { checkpointId: "recovery" } as T;
    const request = body as ReconcileRequest;
    posts.push(performance.now());
    if (posts.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      // This hint was calculated late in request processing. The next request
      // may arrive before expiry, and the server must retain the actual turn.
      turnEnds = performance.now() + 700;
    }
    if (performance.now() < turnEnds)
      return {
        status: "retry-later",
        retryAfter: turnEnds - performance.now(),
        retryRevision: 1,
        operationContext: server.operationContext,
      } as T;
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
  await vi.advanceTimersByTimeAsync(300 + 100 + 599);
  expect(posts).toHaveLength(1);
  expect(server.revision).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(posts).toHaveLength(2);
  expect(server.revision).toBe(1);
  await vi.advanceTimersByTimeAsync(99);
  expect(posts).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(posts).toHaveLength(3);
  expect(posts[2]).toBe(turnEnds);
  expect(server.draft.markdown).toBe("Typed text.\n");
});
