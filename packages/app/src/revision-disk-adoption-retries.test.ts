import {
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  type RevisionRemoteAdapter,
  RevisionSessionController,
} from "./revision-session";

const notifications = vi.hoisted(
  () => new Map<string, (value: unknown) => void>(),
);
vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: (id: string, listener: (value: unknown) => void) => {
    notifications.set(id, listener);
    return () => notifications.delete(id);
  },
}));
const original = "First owner: ready.\n\nLast owner: ready.\n";
const outside = original.replace("Last owner: ready.", "Last owner: outside.");
const active: RevisionSessionController[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const controller of active.splice(0)) controller.stop();
  notifications.clear();
  vi.useRealTimers();
});
const draft = (markdown: string): RevisionDraft => ({
  markdown,
  cleanMarkdown: markdown,
  decisions: {},
  reviewComments: [],
});
async function fixture(evaluate: RevisionRemoteAdapter["adopt"] = () => null) {
  const initial = draft(original);
  let server: SyncState<ComparisonReviewData> = {
    review: {
      id: "review",
      revision: 1,
      mode: "document",
      title: "Review one outside update while typing",
      editor: "unified",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: "/practice.md",
      beforeText: original,
      afterText: original,
      segments: [],
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      targetChanged: false,
      draft: initial,
      autosave: "none",
      destinationPath: null,
      savedPath: null,
      savedText: original,
      handoff: "chat",
    },
    draft: initial,
    revision: 1,
    signature: reviewDraftSignature(initial),
    registryGeneration: "1",
    disk: {
      path: "/practice.md",
      text: original,
      version: "1",
      hash: "1",
      availability: "available",
    },
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120000,
    },
  };
  let holdApply = false;
  const evaluated = vi.fn(evaluate);
  const applied = vi.fn((value: RevisionDraft) =>
    holdApply && value.markdown.includes("outside") ? null : value,
  );
  const posts: ReconcileRequest[] = [];
  const controller = new RevisionSessionController(server.review, initial, {
    request: async <T>(route: string, body?: object) => {
      if (!body) return structuredClone(server) as T;
      if (route.endsWith("/checkpoint"))
        return { checkpointId: "recovery-copy" } as T;
      if (!route.endsWith("/reconcile")) throw new Error(`Unexpected ${route}`);
      const request = body as ReconcileRequest;
      posts.push(structuredClone(request));
      server = {
        ...server,
        draft: request.draft,
        revision: server.revision + 1,
        signature: reviewDraftSignature(request.draft),
        registryGeneration: String(Number(server.registryGeneration) + 1),
        review: {
          ...server.review,
          revision: server.revision + 1,
          draft: request.draft,
          reviewComments: request.draft.reviewComments,
          savedText:
            request.reason === "adopt"
              ? server.disk?.text
              : server.review.savedText,
          lastOperation: {
            id: request.operationId,
            pageInstanceId: request.pageInstanceId,
            reason: request.reason,
          },
        },
      };
      return { status: "committed", state: structuredClone(server) } as T;
    },
    storage: {
      length: 0,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      key: () => null,
    },
    tabStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    merge: async (base, local, incoming, options) =>
      mergeReviewDrafts(base, local, incoming, {
        ...options,
        server: false,
        budgetMs: 1000,
      }),
  });
  active.push(controller);
  const adapter = (): RevisionRemoteAdapter => ({
    apply: applied,
    adopt: evaluated,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.setAdapter(adapter());
  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  evaluated.mockClear();
  applied.mockClear();
  const publish = async (
    change: (current: typeof server) => typeof server,
    notify = true,
  ) => {
    server = change(structuredClone(server));
    if (notify)
      notifications.get("review")?.({
        reason: "changed",
        state: structuredClone(server),
      });
    await vi.advanceTimersByTimeAsync(0);
  };
  const changedDisk = () =>
    publish((current) => ({
      ...current,
      disk: current.disk
        ? { ...current.disk, text: outside, version: "2", hash: "2" }
        : null,
    }));
  const registryNotice = (generation: number) =>
    publish((current) => ({
      ...current,
      registryGeneration: String(generation),
      review: {
        ...current.review,
        recoveryCheckpoints: [
          {
            id: "recovery-copy",
            generation,
            reason: "Unsaved conflict recovery",
            createdAt: "2026-11-27T00:00:00.000Z",
          },
        ],
      },
    }));
  return {
    controller,
    evaluated,
    applied,
    posts,
    publish,
    changedDisk,
    registryNotice,
    adapter,
    blockApply: (value: boolean) => {
      holdApply = value;
    },
  };
}

test.each([
  "null",
  "waiting",
  "conflict",
] as const)("checkpoint notices and continued local typing reuse the same %s disk-adoption evaluation", async (result) => {
  const f = await fixture((base) =>
    result === "null"
      ? null
      : {
          status: result === "waiting" ? "client-merge-required" : "conflict",
          draft: base,
          conflicts: [],
          signature: reviewDraftSignature(base),
        },
  );
  await f.changedDisk();
  for (let generation = 2; generation <= 8; generation++) {
    f.controller.updateDraft((current) => ({
      ...current,
      markdown: current.markdown.replace("First owner:", "First owner: typing"),
      cleanMarkdown: current.cleanMarkdown?.replace(
        "First owner:",
        "First owner: typing",
      ),
    }));
    await f.registryNotice(generation);
  }
  expect(f.evaluated).toHaveBeenCalledTimes(1);
  expect(f.controller.readDraft().markdown.match(/typing/g)).toHaveLength(7);
  expect(f.controller.getSnapshot().writePaused).toBe(true);
});

test("a cached successful adoption still retries editor application after composition ends and preserves local typing", async () => {
  const f = await fixture((_base, text) => draft(text));
  f.blockApply(true);
  await f.changedDisk();
  const before = f.applied.mock.calls.length;
  f.controller.updateDraft((current) => ({
    ...current,
    markdown: current.markdown.replace(
      "First owner: ready.",
      "First owner: my typing.",
    ),
    cleanMarkdown: current.cleanMarkdown?.replace(
      "First owner: ready.",
      "First owner: my typing.",
    ),
  }));
  await f.registryNotice(2);
  f.blockApply(false);
  await f.controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.evaluated).toHaveBeenCalledTimes(1);
  expect(f.applied.mock.calls.length).toBeGreaterThan(before);
  expect(f.controller.getSnapshot().conflict).toBeNull();
  expect(f.controller.readDraft().markdown).toContain(
    "First owner: my typing.",
  );
  expect(f.controller.readDraft().markdown).toContain("Last owner: outside.");
});

test.each([
  "disk text",
  "disk version",
  "disk hash",
  "disk binding",
  "review content",
  "review revision",
  "saved source",
  "source aliases",
] as const)("a real change to %s invalidates the disk-adoption result", async (input) => {
  const f = await fixture();
  await f.changedDisk();
  await f.publish((current) => {
    if (!current.disk) throw new Error("Expected a real source binding");
    if (input === "disk text")
      current.disk.text = `${outside}\nAnother disk edit.\n`;
    if (input === "disk version") current.disk.version = "3";
    if (input === "disk hash") current.disk.hash = "3";
    if (input === "disk binding") current.disk.path = "/moved.md";
    if (input === "saved source")
      current.review.savedText = `${original}\nPrevious acknowledged file.\n`;
    if (input === "review revision") {
      current.revision++;
      current.review.revision++;
    }
    if (input === "review content") {
      current.draft.reviewComments.push({
        id: "c1",
        changeId: "document",
        content: "A newly shared comment.",
        createdAt: "2026-11-27T00:00:00.000Z",
      });
      current.signature = reviewDraftSignature(current.draft);
    }
    if (input === "source aliases") {
      current.draft.diskOrigin = {
        path: "/practice.md",
        signature: "source",
        ids: { s1: "s2" },
      };
      current.signature = reviewDraftSignature(current.draft);
    }
    return current;
  });
  expect(f.evaluated).toHaveBeenCalledTimes(2);
});

test("replacing the editor adapter invalidates a waiting evaluation", async () => {
  const f = await fixture();
  await f.changedDisk();
  f.controller.setAdapter(f.adapter());
  await vi.advanceTimersByTimeAsync(0);
  expect(f.evaluated).toHaveBeenCalledTimes(2);
});

test("explicit Retry reevaluates the same waiting source", async () => {
  const f = await fixture();
  await f.changedDisk();
  await f.controller.retry();
  expect(f.evaluated).toHaveBeenCalledTimes(2);
});

test("explicit Reload evaluates its force and incoming choice instead of reusing automatic refusal", async () => {
  const f = await fixture((_base, text, force) => (force ? draft(text) : null));
  await f.changedDisk();
  await f.registryNotice(2);
  expect(await f.controller.reloadFromFile()).toBe(true);
  expect(f.evaluated).toHaveBeenCalledTimes(2);
  expect(f.evaluated.mock.calls[1]?.[2]).toBe(true);
  expect(f.evaluated.mock.calls[1]?.[3]?.resolution).toBe("incoming");
  expect(f.controller.readDraft().markdown).toBe(outside);
});

test("an evaluator error remains visible without rerunning expensive work on every refresh, and Retry reevaluates it", async () => {
  const f = await fixture(() => {
    throw new Error("The source parser is unavailable.");
  });
  await f.publish(
    (current) => ({
      ...current,
      disk: current.disk
        ? { ...current.disk, text: outside, version: "2", hash: "2" }
        : null,
    }),
    false,
  );
  for (let index = 0; index < 4; index++) await f.controller.refresh(true);
  expect(f.evaluated).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot().recoveryError).toContain(
    "The source parser is unavailable.",
  );
  await f.controller.retry();
  expect(f.evaluated).toHaveBeenCalledTimes(2);
});

test.each([
  "local",
  "incoming",
] as const)("the explicit %s conflict choice evaluates that resolution and preserves its chosen text", async (choice) => {
  const peer = original.replace(
    "First owner: ready.",
    "First owner: browser wording.",
  );
  const disk = original.replace(
    "First owner: ready.",
    "First owner: outside wording.",
  );
  const f = await fixture((base, markdown, _force, diskBase) => ({
    ...mergeReviewDrafts(draft(original), base, draft(markdown), {
      server: false,
      budgetMs: 1000,
      resolution: diskBase?.resolution,
    }),
    diskCleanMarkdown: markdown,
  }));
  await f.publish((current) => ({
    ...current,
    draft: draft(peer),
    signature: reviewDraftSignature(draft(peer)),
    disk: current.disk
      ? { ...current.disk, text: disk, version: "2", hash: "2" }
      : null,
  }));
  await f.registryNotice(2);
  expect(f.evaluated).toHaveBeenCalledTimes(1);
  const conflict = f.controller.getSnapshot().conflict;
  if (!conflict || conflict.kind !== "conflict")
    throw new Error("Expected a genuine overlap");
  expect(await f.controller.resolveConflict(choice, conflict.signature)).toBe(
    true,
  );
  expect(
    f.evaluated.mock.calls.some((call) => call[3]?.resolution === choice),
  ).toBe(true);
  expect(f.controller.readDraft().markdown).toBe(
    choice === "local" ? peer : disk,
  );
});
