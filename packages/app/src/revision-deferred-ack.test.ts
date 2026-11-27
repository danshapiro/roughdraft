import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncResult,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";
import { RevisionUiDraftStore } from "./revision-ui-drafts";

const listeners = vi.hoisted(() => new Set<(notice: unknown) => void>());
vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: (
    _id: string,
    listener: (notice: unknown) => void,
  ) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
const original = `First.\n\nLast.\n\nKeep {++the original proposal++}{#s1} pending.\n\n---\nsuggestions:\n  s1:\n    by: AI\n    at: "2026-11-22T12:00:00.000Z"\n`;
const local = original.replace("First.", "My first.");
const newer = original.replace("First.", "My first. Newer typing.");
const peer = original.replace("Last.", "Peer last.");
const unfinished = "My unfinished reply stays with the original proposal.";

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
const active: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
});
afterEach(() => {
  for (const controller of active.splice(0)) controller.stop();
  listeners.clear();
  vi.useRealTimers();
});
function draft(markdown: string): RevisionDraft {
  return {
    markdown,
    cleanMarkdown: cleanRoughdraftMarkdown(markdown),
    decisions: {},
    reviewComments: [],
  };
}
function state(
  value = draft(original),
  revision = 1,
): SyncState<ComparisonReviewData> {
  return {
    review: {
      id: "deferred-review",
      revision,
      mode: "document",
      title: "Review a release proposal",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: null,
      beforeText: original,
      afterText: original,
      segments: [],
      comment: "",
      reviewComments: value.reviewComments,
      status: "open",
      completion: null,
      targetChanged: false,
      editor: "unified",
      draft: value,
      destinationPath: null,
      savedPath: null,
      savedText: null,
      autosave: "none",
      handoff: "chat",
    },
    draft: value,
    revision,
    signature: reviewDraftSignature(value),
    disk: null,
    registryGeneration: String(revision),
    operationContext: {
      owner: "test-owner",
      epoch: "test-epoch",
      acceptUntil: Date.now() + 120_000,
    },
  };
}
function merged(
  base: RevisionDraft,
  localDraft: RevisionDraft,
  incoming: RevisionDraft,
) {
  const result = mergeReviewDrafts(base, localDraft, incoming, {
    server: false,
    budgetMs: 1000,
  });
  if (result.status !== "merged")
    throw new Error(`The behavioral fixture must merge: ${result.status}`);
  return result.draft as RevisionDraft;
}
function serverBoundary() {
  let current = state();
  let peerSnapshot = current;
  let initial = true;
  let staleReads = false;
  let heldResult: SyncResult<ComparisonReviewData> | undefined;
  let release = (_value: SyncResult<ComparisonReviewData>) => {};
  const response = new Promise<SyncResult<ComparisonReviewData>>((resolve) => {
    release = resolve;
  });
  const requests: ReconcileRequest[] = [];
  const resolved: string[] = [];
  const checkpoints: object[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(staleReads ? peerSnapshot : current) as T;
    if (path.includes("/operations/") && path.endsWith("/resolve")) {
      const operationId = (body as { operationId: string }).operationId;
      resolved.push(operationId);
      if (
        operationId !==
        requests.find((sent) => sent.reservationToken)?.operationId
      )
        throw new Error(
          "Recovery must resolve the original prepared operation",
        );
      staleReads = false;
      return structuredClone(heldResult) as T;
    }
    if (path.endsWith("/checkpoint")) {
      checkpoints.push(body);
      return { checkpointId: "unexpected-conflict" } as T;
    }
    if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
    const sent = structuredClone(body) as ReconcileRequest;
    requests.push(sent);
    if (initial) {
      initial = false;
      current = state(draft(peer), 2);
      peerSnapshot = structuredClone(current);
      return {
        status: "client-merge-required",
        state: structuredClone(current),
        reservation: {
          token: "turn",
          revision: 2,
          expiresAt: Date.now() + 750,
        },
      } as T;
    }
    const value = merged(
      sent.base as RevisionDraft,
      sent.draft as RevisionDraft,
      current.draft as RevisionDraft,
    );
    current = state(value, current.revision + 1);
    current.review.lastOperation = {
      id: sent.operationId,
      pageInstanceId: sent.pageInstanceId,
      reason: sent.reason,
    };
    const result: SyncResult<ComparisonReviewData> = {
      status: "committed",
      state: structuredClone(current),
    };
    if (sent.reservationToken) {
      heldResult = result;
      return response as Promise<T>;
    }
    return result as T;
  };
  return {
    api,
    requests,
    resolved,
    checkpoints,
    current: () => structuredClone(current),
    candidate: () => heldResult,
    resumeAfterReload: () => {
      staleReads = true;
    },
    acknowledge: () => {
      if (!heldResult) throw new Error("No prepared candidate has committed");
      release(structuredClone(heldResult));
    },
  };
}
function page(
  initial: SyncState<ComparisonReviewData>,
  server: ReturnType<typeof serverBoundary>,
  storage: MemoryStorage,
  tab: MemoryStorage,
  name: string,
) {
  const editor = { draft: structuredClone(initial.draft) as RevisionDraft };
  const ui = new RevisionUiDraftStore();
  const controller = new RevisionSessionController(
    initial.review,
    editor.draft,
    {
      request: server.api,
      storage,
      tabStorage: tab,
      id: () => name,
      merge: async (base, localDraft, incoming, options) =>
        mergeReviewDrafts(base, localDraft, incoming, {
          ...options,
          server: false,
          budgetMs: 1000,
        }),
    },
  );
  active.push(controller);
  controller.setAdapter({
    rebasesBufferedDocument: true,
    prepare: (value) => ({
      ...value,
      cleanMarkdown: cleanRoughdraftMarkdown(value.markdown),
    }),
    apply: (value, options) => {
      editor.draft = options?.localBase
        ? merged(options.localBase, editor.draft, value)
        : { ...value, cleanMarkdown: cleanRoughdraftMarkdown(value.markdown) };
      return editor.draft;
    },
    adopt: () => null,
    readUiDrafts: ui.read,
    restoreUiDrafts: ui.restore,
    subscribeUiDrafts: ui.subscribe,
  });
  controller.start();
  return { controller, editor, ui };
}
function expectComplete(value: RevisionDraft) {
  for (const text of ["My first.", "Newer typing.", "Peer last."])
    expect(value.markdown.split(text)).toHaveLength(2);
  expect(
    extractRoughdraftReviewIndex(value.markdown)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => item.id),
  ).toEqual(["s1"]);
}

test("reload resolves an unacknowledged prepared candidate and retains newer coalesced typing and an unfinished reply", async () => {
  const server = serverBoundary();
  const storage = new MemoryStorage();
  const tab = new MemoryStorage();
  const first = page(server.current(), server, storage, tab, "before-reload");
  await vi.advanceTimersByTimeAsync(0);
  first.ui.setComment("c2", {
    value: unfinished,
    original: "",
    editing: true,
    target: {
      id: "c2",
      content: "",
      createdAt: "2026-11-26T12:00:00.000Z",
      authorType: "user",
      authorId: "user",
      parentCommentId: "s1",
    },
  });
  first.editor.draft = draft(local);
  first.controller.updateDraft(() => first.editor.draft);
  // This response disappears with the old page; the server has committed it.
  void first.controller.flush(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(server.candidate()?.status).toBe("committed");
  expect(first.editor.draft.markdown).not.toContain("Peer last.");
  first.editor.draft = draft(newer);
  first.controller.updateDraft(() => first.editor.draft, { readyToSave: true });
  first.controller.stop();

  server.resumeAfterReload();
  const reloaded = page(server.current(), server, storage, tab, "after-reload");
  await vi.advanceTimersByTimeAsync(0);
  expect(server.resolved).toEqual([
    server.requests.find((sent) => sent.reservationToken)?.operationId,
  ]);
  expectComplete(reloaded.editor.draft);
  expectComplete(reloaded.controller.readDraft());
  expectComplete(server.current().draft as RevisionDraft);
  expect(server.requests.filter((sent) => sent.reservationToken)).toHaveLength(
    1,
  );
  expect(reloaded.controller.getSnapshot().conflict).toBeNull();
  expect(reloaded.controller.getSnapshot().writePaused).toBe(false);
  expect(server.checkpoints).toEqual([]);
  const reply = reloaded.ui.getSnapshot().comments.c2;
  expect(reply).toMatchObject({
    value: unfinished,
    editing: true,
    target: { parentCommentId: "s1" },
  });
  expect(server.current().draft.reviewComments).toEqual([]);
  const target = reply?.target;
  if (!target?.parentCommentId)
    throw new Error("The unfinished reply lost its target");
  const postedReply = {
    ...target,
    content: reply.value,
    changeId: target.parentCommentId,
  };
  reloaded.controller.updateDraft((current) => ({
    ...current,
    reviewComments: [...current.reviewComments, postedReply],
  }));
  reloaded.ui.setComment("c2", null);
  await reloaded.controller.flush(false);
  expect(server.current().draft.reviewComments).toMatchObject([
    { id: "c2", content: unfinished, parentCommentId: "s1", changeId: "s1" },
  ]);
});

test.each([
  "event-first",
  "response-first",
] as const)("a prepared candidate integrates the peer exactly once with %s delivery and newer typing", async (order) => {
  const server = serverBoundary();
  const current = page(
    server.current(),
    server,
    new MemoryStorage(),
    new MemoryStorage(),
    "page",
  );
  await vi.advanceTimersByTimeAsync(0);
  current.editor.draft = draft(local);
  current.controller.updateDraft(() => current.editor.draft);
  const pending = current.controller.flush(false);
  await vi.advanceTimersByTimeAsync(0);
  current.editor.draft = draft(newer);
  current.controller.updateDraft(() => current.editor.draft, {
    readyToSave: true,
  });
  const candidate = server.candidate()?.state;
  if (!candidate) throw new Error("The prepared save never committed");
  const notify = () => {
    for (const listener of listeners)
      listener({ reason: "changed", state: structuredClone(candidate) });
  };
  if (order === "event-first") {
    notify();
    await vi.advanceTimersByTimeAsync(0);
  }
  server.acknowledge();
  await pending;
  if (order === "response-first") notify();
  await vi.advanceTimersByTimeAsync(0);
  expectComplete(current.editor.draft);
  expectComplete(current.controller.readDraft());
  expectComplete(server.current().draft as RevisionDraft);
  expect(current.controller.getSnapshot().conflict).toBeNull();
  expect(current.controller.getSnapshot().writePaused).toBe(false);
  expect(server.checkpoints).toEqual([]);
});
