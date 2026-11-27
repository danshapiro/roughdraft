import {
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncResult,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import { decodeBrowserRecovery } from "./revision-browser-recovery";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import {
  type RevisionDraft,
  type RevisionRemoteAdapter,
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
  records = new Map<string, string>();
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
const source = "A first.\n\nKeep {++pending proposal++}{#s1}.\n\nB last.\n";
const local = source.replace("A first.", "A local first.");
const peer = source.replace("B last.", "B peer last.");
function draft(markdown: string): RevisionDraft {
  return {
    markdown,
    cleanMarkdown: cleanRevisionSourceMarkdown(markdown),
    decisions: {},
    reviewComments: [],
  };
}
function state(
  markdown = source,
  revision = 1,
): SyncState<ComparisonReviewData> {
  const current = draft(markdown);
  return {
    review: {
      id: "observed-candidate",
      revision,
      mode: "document",
      editor: "unified",
      title: "Save independent peer updates before reflecting them",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: null,
      beforeText: source,
      afterText: source,
      segments: [],
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      targetChanged: false,
      autosave: "none",
      handoff: "chat",
      draft: current,
      destinationPath: null,
      savedPath: null,
      savedText: null,
    },
    draft: current,
    revision,
    signature: reviewDraftSignature(current),
    disk: null,
    registryGeneration: String(revision),
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
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
});
afterEach(() => {
  for (const controller of active.splice(0)) controller.stop();
  notices.clear();
  vi.useRealTimers();
});

function install(options: { rejectFirst?: boolean } = {}) {
  let server = state();
  let editor = source;
  let ui: Record<string, unknown> = {
    comments: {
      private: {
        value: "Unfinished private reply",
        editing: true,
        original: "",
      },
    },
  };
  const storage = new MemoryStorage();
  const tabStorage = new MemoryStorage();
  const events: string[] = [];
  const sent: ReconcileRequest[] = [];
  let saved: SyncState<ComparisonReviewData> | undefined;
  let release:
    | ((result: SyncResult<ComparisonReviewData> | null) => void)
    | undefined;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.includes("/operations/"))
      return { status: "committed", state: structuredClone(saved) } as T;
    if (path.endsWith("/checkpoint")) return { checkpointId: "preserved" } as T;
    if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
    const request = body as ReconcileRequest;
    events.push("post");
    sent.push(structuredClone(request));
    if (options.rejectFirst && sent.length === 1)
      return {
        status: "retry-later",
        state: structuredClone(server),
        retryAfter: 750,
      } as T;
    const merged = mergeReviewDrafts(
      request.base,
      request.draft,
      server.draft,
      { server: false, budgetMs: 1000 },
    );
    if (merged.status !== "merged")
      throw new Error("Expected independent edits");
    const next = state(merged.draft.markdown, server.revision + 1);
    next.review.lastOperation = {
      id: request.operationId,
      pageInstanceId: request.pageInstanceId,
      reason: request.reason,
    };
    server = next;
    if (!release) {
      saved = structuredClone(server);
      return await new Promise<T | null>((resolve) => {
        release = (result) => resolve(result as T | null);
      });
    }
    return { status: "committed", state: structuredClone(server) } as T;
  };
  const adapter: RevisionRemoteAdapter = {
    rebasesBufferedDocument: true,
    prepare: (value) => {
      events.push("prepare");
      return {
        ...value,
        cleanMarkdown: cleanRevisionSourceMarkdown(value.markdown),
      };
    },
    apply: (value, options) => {
      if (
        value.markdown.includes("B peer") ||
        value.markdown.includes("B latest")
      )
        events.push("reflect");
      const result = options?.localBase
        ? mergeReviewDrafts(options.localBase, draft(editor), value, {
            server: false,
            budgetMs: 1000,
          })
        : { status: "merged", draft: value };
      if (result.status !== "merged") return null;
      editor = result.draft.markdown;
      return draft(editor);
    },
    adopt: () => null,
    readUiDrafts: () => ui,
    restoreUiDrafts: (value) => {
      ui = value;
    },
  };
  const create = () => {
    const controller = new RevisionSessionController(
      server.review,
      server.draft as RevisionDraft,
      {
        request: api,
        storage,
        tabStorage,
        merge: async (base, working, incoming, options) =>
          mergeReviewDrafts(base, working, incoming, {
            ...options,
            budgetMs: 1000,
          }),
      },
    );
    active.push(controller);
    controller.setAdapter(adapter);
    controller.start();
    return controller;
  };
  const controller = create();
  return {
    controller,
    adapter,
    create,
    storage,
    events,
    sent,
    read: () => ({ server, editor, ui, saved }),
    type: (markdown: string) => {
      editor = markdown;
      controller.updateDraft(() => draft(markdown));
    },
    native: (markdown: string) => {
      editor = markdown;
    },
    private: (value: string) => {
      ui = { comments: { private: { value, editing: true, original: "" } } };
    },
    incoming: (markdown: string, revision: number) => {
      server = state(markdown, revision);
      notices.get(server.review.id)?.({
        reason: "changed",
        state: structuredClone(server),
      });
    },
    server: (markdown: string, revision: number) => {
      server = state(markdown, revision);
    },
    echo: () =>
      notices.get(server.review.id)?.({
        reason: "changed",
        state: structuredClone(saved),
      }),
    finish: (lost = false) =>
      release?.(
        lost ? null : { status: "committed", state: structuredClone(saved) },
      ),
  };
}

test.each([
  "response-first",
  "echo-first",
] as const)("a dirty observed candidate is guarded and durable before visual reflection in %s order", async (order) => {
  const testbed = install();
  await vi.advanceTimersByTimeAsync(0);
  testbed.events.length = 0;
  testbed.type(local);
  testbed.incoming(peer, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(testbed.events).toEqual(["prepare", "post"]);
  expect(testbed.controller.readDraft().markdown).toBe(local);
  expect(testbed.read().editor).toBe(local);
  expect(testbed.sent[0]).toMatchObject({
    expectedRevision: 2,
    baseRevision: 2,
    baseSignature: reviewDraftSignature(draft(peer)),
    base: draft(peer),
    localGeneration: 1,
  });
  const records = [...testbed.storage.records.values()].map((raw) =>
    decodeBrowserRecovery(raw),
  );
  expect(
    records.some(
      (value) =>
        value?.operation?.editorBase?.markdown === local &&
        value.operation.draft.markdown.includes("B peer last."),
    ),
  ).toBe(true);
  testbed.type(local.replace("A local first.", "A local first. Newer."));
  testbed.native(
    local.replace("A local first.", "A local first. Newer. Buffered."),
  );
  testbed.private("Newer unfinished private reply");
  if (order === "echo-first") {
    testbed.echo();
    await vi.advanceTimersByTimeAsync(0);
    expect(testbed.read().editor).toContain("B peer last.");
  }
  testbed.finish();
  if (order === "response-first") testbed.echo();
  await vi.advanceTimersByTimeAsync(1);
  expect(testbed.controller.readDraft().markdown).toContain("Newer. Buffered.");
  expect(testbed.read().editor).toContain("B peer last.");
  expect(testbed.read().server.draft.markdown).toContain("Newer. Buffered.");
  expect(testbed.read().ui).toEqual({
    comments: {
      private: {
        value: "Newer unfinished private reply",
        editing: true,
        original: "",
      },
    },
  });
  expect(JSON.stringify(testbed.sent)).not.toContain(
    "unfinished private reply",
  );
  expect(testbed.read().server.draft.markdown).toContain(
    "{++pending proposal++}{#s1}",
  );
  expect(testbed.controller.getSnapshot().conflict).toBeNull();
});

test("a lost observed-candidate acknowledgment reloads its unreflected base, newer typing and private reply", async () => {
  const testbed = install();
  await vi.advanceTimersByTimeAsync(0);
  testbed.type(local);
  testbed.incoming(peer, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(testbed.controller.readDraft().markdown).toBe(local);
  testbed.type(local.replace("A local first.", "A recovered newer first."));
  testbed.private("Recover this private reply");
  testbed.finish(true);
  await vi.advanceTimersByTimeAsync(0);
  testbed.controller.stop();
  const saved = testbed.read().saved;
  if (!saved) throw new Error("Expected the actual candidate commit");
  testbed.server(
    saved.draft.markdown.replace("B peer last.", "B latest peer last."),
    saved.revision + 1,
  );
  const restored = testbed.create();
  await vi.advanceTimersByTimeAsync(1000);
  expect(restored.readDraft().markdown).toContain("A recovered newer first.");
  expect(restored.readDraft().markdown).toContain("B latest peer last.");
  expect(testbed.read().server.draft.markdown).toContain(
    "A recovered newer first.",
  );
  expect(testbed.read().ui).toEqual({
    comments: {
      private: {
        value: "Recover this private reply",
        editing: true,
        original: "",
      },
    },
  });
  expect(restored.getSnapshot().writePaused).toBe(false);
});

test("an idle peer update reflects normally without preparing or publishing a candidate", async () => {
  const testbed = install();
  await vi.advanceTimersByTimeAsync(0);
  testbed.events.length = 0;
  testbed.incoming(peer, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(testbed.events).toEqual(["reflect"]);
  expect(testbed.sent).toHaveLength(0);
  expect(testbed.controller.readDraft().markdown).toBe(peer);
});

test("an active peer wait keeps its deadline on an unchanged saved state", async () => {
  const testbed = install({ rejectFirst: true });
  await vi.advanceTimersByTimeAsync(0);
  testbed.type(local);
  expect(await testbed.controller.flush(false)).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  testbed.events.length = 0;
  testbed.incoming(source, 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(testbed.events).toEqual([]);
  expect(testbed.sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(649);
  expect(testbed.sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(testbed.sent).toHaveLength(2);
});

test("a prepared observation meeting a peer turn reflects safely and respects the next retry deadline", async () => {
  const testbed = install({ rejectFirst: true });
  await vi.advanceTimersByTimeAsync(0);
  testbed.events.length = 0;
  testbed.type(local);
  testbed.incoming(peer, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(testbed.events).toEqual(["prepare", "post", "reflect"]);
  expect(testbed.sent).toHaveLength(1);
  expect(testbed.controller.readDraft().markdown).toContain("B peer last.");
  await vi.advanceTimersByTimeAsync(749);
  expect(testbed.sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(testbed.sent).toHaveLength(2);
  expect(testbed.sent[1].operationId).not.toBe(testbed.sent[0].operationId);
});

test.each([
  "projection unavailable",
  "unsafe composition",
] as const)("a dirty peer update retains the existing visual fallback when %s", async (scenario) => {
  const testbed = install();
  await vi.advanceTimersByTimeAsync(0);
  testbed.events.length = 0;
  testbed.adapter.prepare = (value) => {
    testbed.events.push("prepare");
    return scenario === "projection unavailable"
      ? { ...value, cleanMarkdown: undefined }
      : null;
  };
  if (scenario === "unsafe composition") {
    const original = testbed.adapter.apply;
    testbed.adapter.apply = (value, options) => {
      if (value.markdown.includes("B peer")) {
        testbed.events.push("reflect");
        return null;
      }
      return original(value, options);
    };
  }
  testbed.type(local);
  testbed.incoming(peer, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(testbed.events.slice(0, 2)).toEqual(["prepare", "reflect"]);
  if (scenario === "projection unavailable") {
    expect(testbed.events).toEqual(["prepare", "reflect", "post"]);
    expect(testbed.controller.readDraft().markdown).toContain("B peer last.");
  } else {
    expect(testbed.sent).toHaveLength(0);
    expect(testbed.controller.readDraft().markdown).toBe(local);
    expect(testbed.controller.getSnapshot().conflict?.kind).toBe("waiting");
  }
});

test("a peer ID collision remaps and persists the visible proposals before any save", async () => {
  const testbed = install();
  await vi.advanceTimersByTimeAsync(0);
  testbed.events.length = 0;
  testbed.type(
    local.replace("A local first.", "A local first. {++local proposal++}{#s2}"),
  );
  testbed.incoming(
    peer.replace("B peer last.", "B peer last. {++peer proposal++}{#s2}"),
    2,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(testbed.events).toEqual(["reflect", "post"]);
  expect(testbed.read().editor).toBe(testbed.controller.readDraft().markdown);
  expect(testbed.sent[0].draft.markdown).toBe(testbed.read().editor);
  expect(
    extractRoughdraftReviewIndex(testbed.read().editor)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => item.id)
      .sort(),
  ).toEqual(["s1", "s2", "s3"]);
});

test("overlapping unsaved text retains its conflict without preparing or publishing", async () => {
  const testbed = install();
  await vi.advanceTimersByTimeAsync(0);
  testbed.events.length = 0;
  testbed.type(local);
  testbed.incoming(source.replace("A first.", "A incoming first."), 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(testbed.events).toEqual([]);
  expect(testbed.sent).toHaveLength(0);
  expect(testbed.controller.readDraft().markdown).toBe(local);
  expect(testbed.controller.getSnapshot().conflict?.kind).toBe("conflict");
});
