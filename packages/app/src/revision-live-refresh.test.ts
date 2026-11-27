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
  RevisionSessionController,
} from "./revision-session";

const notices = vi.hoisted(() => new Map<string, (notice: unknown) => void>());
vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: (id: string, listener: (notice: unknown) => void) => {
    notices.set(id, listener);
    return () => notices.delete(id);
  },
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
const text = "First.\n\nLast.\n";
function state(markdown = text, revision = 1): SyncState<ComparisonReviewData> {
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
      title: "Live review",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: null,
      beforeText: markdown,
      afterText: markdown,
      segments: [],
      comment: "",
      status: "open",
      targetChanged: false,
      editor: "unified",
      draft,
      reviewComments: [],
      destinationPath: null,
      savedPath: null,
      savedText: null,
      autosave: "none",
      handoff: "chat",
      completion: null,
    },
    draft,
    revision,
    signature: reviewDraftSignature(draft),
    disk: null,
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120_000,
    },
    registryGeneration: String(revision),
  };
}
function fileState(availability: "available" | "missing" = "available") {
  const value = state();
  value.review = {
    ...value.review,
    targetPath: "/practice.md",
    destinationPath: "/practice.md",
    savedPath: "/practice.md",
    savedText: text,
    autosave: "/practice.md",
    targetChanged: availability === "missing",
  };
  value.disk = {
    path: "/practice.md",
    version: availability === "available" ? "v1" : null,
    hash: availability === "available" ? "hash" : null,
    text: availability === "available" ? text : null,
    availability,
  };
  value.registryGeneration = `1:${value.disk.version}`;
  return value;
}
const active: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
});
afterEach(() => {
  for (const controller of active.splice(0)) controller.stop();
  notices.clear();
  vi.useRealTimers();
});
const settle = () => vi.advanceTimersByTimeAsync(0);
function install(initial = state()) {
  const fixture = {
    server: initial,
    hold: false,
    reads: [] as string[],
    held: [] as Array<() => void>,
    writes: [] as string[],
    reply: null as ((route: string, body: object) => unknown) | null,
  };
  const controller = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    {
      request: async <T>(route: string, body?: object) => {
        if (body) {
          fixture.writes.push(route);
          if (route.endsWith("/checkpoint"))
            return { checkpointId: "recovery" } as T;
          return (fixture.reply?.(route, body) ?? null) as T | null;
        }
        fixture.reads.push(route);
        const captured = structuredClone(fixture.server);
        if (fixture.hold)
          return new Promise<T>((resolve) =>
            fixture.held.push(() => resolve(captured as T)),
          );
        return captured as T;
      },
      merge: async (base, local, incoming, options) =>
        mergeReviewDrafts(base, local, incoming, { ...options, budgetMs: 100 }),
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    },
  );
  active.push(controller);
  controller.setAdapter({
    apply: (draft) => ({
      ...draft,
      cleanMarkdown: draft.cleanMarkdown ?? draft.markdown,
    }),
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  return { fixture, controller };
}
function notice() {
  notices.get("review")?.({ reason: "changed", hint: { reviewId: "review" } });
}
function push(state: SyncState<ComparisonReviewData>) {
  notices.get("review")?.({ reason: "changed", state });
}

test("live hints during an in-flight read coalesce into one trailing read", async () => {
  const { fixture, controller } = install();
  await settle();
  const initialReads = fixture.reads.length;
  fixture.hold = true;
  fixture.server = state(`${text}\nPeer one.\n`, 2);
  notice();
  await settle();
  expect(fixture.held).toHaveLength(1);
  fixture.server = state(`${text}\nPeer one.\n\nPeer two.\n`, 3);
  for (let count = 0; count < 8; count++) notice();
  await settle();
  expect(fixture.held).toHaveLength(1);
  fixture.hold = false;
  fixture.held.shift()?.();
  await settle();
  expect(controller.readDraft().markdown).toContain("Peer two.");
  expect(fixture.reads).toHaveLength(initialReads + 2);
  await settle();
  expect(fixture.reads).toHaveLength(initialReads + 2);
});

test("a restored file identical to the base clears its file pause", async () => {
  const { controller } = install(fileState());
  await settle();
  push(fileState("missing"));
  await settle();
  expect(controller.getSnapshot().conflict?.kind).toBe("file");
  push(fileState());
  await settle();
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(controller.getSnapshot().writePaused).toBe(false);
});

test("a new hint during the trailing read receives its own coalesced follow-up", async () => {
  const { fixture, controller } = install();
  await settle();
  const initialReads = fixture.reads.length;
  fixture.hold = true;
  fixture.server = state("Peer one.\n", 2);
  notice();
  await settle();
  fixture.server = state("Peer two.\n", 3);
  notice();
  fixture.held.shift()?.();
  await settle();
  expect(fixture.held).toHaveLength(1);
  fixture.server = state("Peer three.\n", 4);
  notice();
  notice();
  fixture.hold = false;
  fixture.held.shift()?.();
  await settle();
  expect(controller.readDraft().markdown).toBe("Peer three.\n");
  expect(fixture.reads).toHaveLength(initialReads + 3);
});

test("a forced refresh supersedes an older held read without accepting its late state", async () => {
  const { fixture, controller } = install();
  await settle();
  const initialReads = fixture.reads.length;
  fixture.hold = true;
  fixture.server = state("Older peer.\n", 2);
  notice();
  await settle();
  fixture.server = state("Newest peer.\n", 3);
  const forced = controller.refresh(true);
  await settle();
  expect(fixture.held).toHaveLength(2);
  fixture.held[1]();
  await forced;
  expect(controller.readDraft().markdown).toBe("Newest peer.\n");
  fixture.held[0]();
  await settle();
  expect(controller.readDraft().markdown).toBe("Newest peer.\n");
  expect(fixture.reads).toHaveLength(initialReads + 2);
});

test.each([
  false,
  true,
])("stopping invalidates an old read and its queued hint (restart=%s)", async (restart) => {
  const { fixture, controller } = install();
  await settle();
  fixture.hold = true;
  fixture.server = state("Abandoned read.\n", 2);
  notice();
  await settle();
  notice();
  const beforeStop = fixture.reads.length;
  controller.stop();
  fixture.hold = false;
  if (restart) {
    fixture.server = state("Restarted live review.\n", 3);
    controller.start();
    await settle();
  }
  fixture.held.shift()?.();
  await settle();
  expect(controller.readDraft().markdown).toBe(
    restart ? "Restarted live review.\n" : text,
  );
  expect(fixture.reads).toHaveLength(beforeStop + (restart ? 1 : 0));
});

test("switching to a saved copy supersedes a held read from the original review", async () => {
  const { fixture, controller } = install();
  await settle();
  fixture.hold = true;
  notice();
  await settle();
  notice();
  const copy = state("Separate review.\n");
  copy.review.id = "copy";
  fixture.reply = (route) =>
    route.endsWith("/copy")
      ? {
          status: "committed",
          state: copy,
          savedPath: "/copy.md",
          reviewUrl: "?comparison=copy",
        }
      : null;
  await controller.copy("/copy.md", true);
  fixture.server = copy;
  fixture.hold = false;
  notices.get("copy")?.({ reason: "changed", hint: { reviewId: "copy" } });
  await settle();
  fixture.held.shift()?.();
  await settle();
  expect(controller.getSnapshot().session.id).toBe("copy");
  expect(controller.readDraft().markdown).toBe("Separate review.\n");
  expect(fixture.reads.at(-1)).toBe("/copy/state");
});

test("an unmappable disk wait clears when the file returns to its base", async () => {
  const { controller } = install(fileState());
  await settle();
  const outside = fileState();
  if (!outside.disk) throw new Error("Expected bound file");
  outside.disk = {
    ...outside.disk,
    version: "v2",
    text: "Unmappable outside text.\n",
  };
  outside.review.targetChanged = true;
  push(outside);
  await settle();
  expect(controller.getSnapshot().conflict?.kind).toBe("waiting");
  push(fileState());
  await settle();
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(controller.getSnapshot().writePaused).toBe(false);
});

test("restoring a file preserves newer local typing and resumes its queued save", async () => {
  const { fixture, controller } = install(fileState());
  await settle();
  push(fileState("missing"));
  await settle();
  const local = "My first.\n\nLast.\n";
  controller.updateDraft((draft) => ({
    ...draft,
    markdown: local,
    cleanMarkdown: local,
  }));
  fixture.reply = (route, body) => {
    if (!route.endsWith("/reconcile")) return null;
    const saved = fileState();
    saved.draft = (body as { draft: RevisionDraft }).draft;
    saved.review.draft = saved.draft;
    saved.review.savedText = local;
    if (saved.disk) saved.disk = { ...saved.disk, text: local, version: "v2" };
    saved.revision = saved.review.revision = 2;
    saved.signature = reviewDraftSignature(saved.draft);
    fixture.server = saved;
    return { status: "committed", state: saved };
  };
  push(fileState());
  await settle();
  expect(controller.readDraft().markdown).toBe(local);
  expect(controller.getSnapshot().writePaused).toBe(false);
  expect(
    fixture.writes.filter((route) => route.endsWith("/reconcile")),
  ).toHaveLength(1);
});

test("an equal-base notice retains an actual text conflict", async () => {
  const { controller } = install();
  await settle();
  controller.updateDraft((draft) => ({
    ...draft,
    markdown: "My first.\n\nLast.\n",
    cleanMarkdown: "My first.\n\nLast.\n",
  }));
  push(state("Peer first.\n\nLast.\n", 2));
  await settle();
  expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
  push(state(text, 2));
  await settle();
  expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
  expect(controller.getSnapshot().writePaused).toBe(true);
  expect(controller.readDraft().markdown).toContain("My first.");
});

test.each([
  "dialog",
  "unresolved copy",
  "publication",
] as const)("a restored file cannot release a %s pause", async (kind) => {
  const { fixture, controller } = install(fileState());
  await settle();
  push(fileState("missing"));
  await settle();
  if (kind === "dialog") controller.setCopyLocked(true);
  if (kind === "unresolved copy") {
    fixture.reply = () => ({ status: "indeterminate" });
    await controller.copy("/copy.md", true);
  }
  const restored = fileState();
  if (kind === "publication")
    restored.publishing = {
      operationId: "unfinished",
      owner: "test",
      startedAt: Date.now(),
      recoverable: false,
      retryAfter: 1000,
    };
  push(restored);
  await settle();
  expect(controller.getSnapshot().writePaused).toBe(true);
  expect(controller.getSnapshot().conflict).not.toBeNull();
});

test("a copied review accepts heartbeat permission updates without another read", async () => {
  const { fixture, controller } = install();
  await settle();
  const copy = state("Separate review.\n");
  copy.review.id = "copy";
  let sentContext: unknown;
  fixture.reply = (route, body) => {
    if (route.endsWith("/copy"))
      return {
        status: "committed",
        state: copy,
        savedPath: "/copy.md",
        reviewUrl: "?comparison=copy",
      };
    if (route.endsWith("/reconcile"))
      sentContext = (body as { operationContext: unknown }).operationContext;
    return null;
  };
  await controller.copy("/copy.md", true);
  const beforeHeartbeat = fixture.reads.length;
  const context = {
    owner: "test",
    epoch: "renewed",
    acceptUntil: Date.now() + 240_000,
  };
  notices.get("copy")?.({ reason: "heartbeat", operationContext: context });
  await settle();
  expect(fixture.reads).toHaveLength(beforeHeartbeat);
  controller.updateDraft((draft) => ({
    ...draft,
    markdown: "More copied text.\n",
    cleanMarkdown: "More copied text.\n",
  }));
  await controller.flush();
  expect(sentContext).toEqual(context);
});

for (const advanced of [true, false]) {
  test(
    advanced
      ? "a queued save resumes when a newer peer commit releases its save turn"
      : "an unchanged live notice preserves the peer's remaining save turn",
    async () => {
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
      const { fixture, controller } = install();
      await settle();
      const posts: Array<{ at: number; result: string }> = [];
      fixture.reply = (route, body) => {
        if (!route.endsWith("/reconcile"))
          throw new Error(`Unexpected write: ${route}`);
        const sent = body as ReconcileRequest;
        if (!posts.length) {
          posts.push({ at: performance.now(), result: "retry-later" });
          return {
            status: "retry-later",
            retryAfter: 700,
            state: structuredClone(fixture.server),
          };
        }
        expect(sent.baseRevision).toBe(fixture.server.revision);
        fixture.server = state(
          sent.draft.markdown,
          fixture.server.revision + 1,
        );
        fixture.server.review.lastOperation = {
          id: sent.operationId,
          pageInstanceId: sent.pageInstanceId,
          reason: sent.reason,
        };
        posts.push({ at: performance.now(), result: "committed" });
        return {
          status: "committed",
          operationId: sent.operationId,
          state: structuredClone(fixture.server),
        };
      };
      controller.updateDraft((draft) => ({
        ...draft,
        markdown: "First A.\n\nLast.\n",
        cleanMarkdown: "First A.\n\nLast.\n",
      }));
      await vi.advanceTimersByTimeAsync(320);
      expect(posts.map((post) => post.result)).toEqual(["retry-later"]);
      await vi.advanceTimersByTimeAsync(100);
      if (advanced) fixture.server = state("First.\n\nLast.\n\nPeer.\n", 2);
      const observedAt = performance.now();
      notices.get("review")?.({
        reason: "changed",
        state: structuredClone(fixture.server),
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(posts).toHaveLength(advanced ? 2 : 1);
      await vi.advanceTimersByTimeAsync(700);
      expect(posts).toHaveLength(2);
      expect(posts[1].result).toBe("committed");
      if (advanced) expect(posts[1].at - observedAt).toBeLessThan(150);
      else expect(posts[1].at - posts[0].at).toBeGreaterThanOrEqual(700);
      expect(controller.readDraft().markdown).toBe(
        `First A.\n\nLast.\n${advanced ? "\nPeer.\n" : ""}`,
      );
      expect(controller.getSnapshot().conflict).toBeNull();
    },
  );
}
