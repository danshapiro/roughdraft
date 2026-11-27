import {
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncResult,
  type SyncState,
} from "@roughdraft/rfm";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import editingReview from "../../../docs/spec/fixtures/editing-review.md?raw";
import { ApiBackend } from "./api-backend";
import type { ComparisonReviewData } from "./comparison-types";
import { TooltipProvider } from "./components/ui/tooltip";
import { criticMarkdownToEditorState } from "./critic-markup";
import { RichTextEditorSurface } from "./PageCard";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import { prepareRevisionDraft } from "./revision-prepare";
import {
  type RevisionDraft,
  type RevisionRemoteAdapter,
  RevisionSessionController,
} from "./revision-session";
import {
  RevisionUiDraftContext,
  RevisionUiDraftStore,
} from "./revision-ui-drafts";

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

const original = editingReview.replace(
  "# Try Roughdraft's editing and comment fixes",
  "Live owner A: unchanged.\n\nLive owner B: unchanged.\n\n# Try Roughdraft's editing and comment fixes",
);
const peerSuffix = " LocalA-abcdefghijabcdefghijabcd";
const firstSuffix = " LocalB-klmnopqrstklmnopqrstkl";
const newerSuffix = "mnopqrstklmnopqrst";
const bufferedSuffix = "klmnopqrstklmnopqrst";
const privateComment = "Unfinished edit to the existing comment.";
const privateReply = "Unfinished reply to the pending suggestion.";

function draft(markdown: string): RevisionDraft {
  return {
    markdown,
    cleanMarkdown: cleanRevisionSourceMarkdown(markdown),
    decisions: {},
    reviewComments: [
      ...criticMarkdownToEditorState(markdown).comments.values(),
    ].map((comment) => ({ ...comment, changeId: "document" })),
  };
}
function state(
  value = draft(original),
  revision = 1,
): SyncState<ComparisonReviewData> {
  return {
    review: {
      id: "mounted-ack",
      revision,
      mode: "document",
      title: "Review the release plan with concurrent edits",
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
      owner: "mounted-owner",
      epoch: "mounted-epoch",
      acceptUntil: Date.now() + 120_000,
    },
  };
}
function merge(
  base: RevisionDraft,
  local: RevisionDraft,
  incoming: RevisionDraft,
) {
  const result = mergeReviewDrafts(base, local, incoming, {
    server: false,
    budgetMs: 1000,
  });
  if (result.status !== "merged")
    throw new Error(`Expected independent edits: ${result.status}`);
  return result;
}

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let controller: RevisionSessionController | null;
beforeEach(() => {
  controller = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  controller?.stop();
  await act(async () => root.unmount());
  listeners.clear();
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

test.each([
  "response-first",
  "event-first",
] as const)("a mounted editor integrates one reserved acknowledgment once when %s paths overlap during a worker merge", async (order) => {
  let current = state();
  const initial = current;
  let initialWrite = true;
  let heldResult: SyncResult<ComparisonReviewData> | undefined;
  let releaseResponse = (_value: SyncResult<ComparisonReviewData>) => {};
  const response = new Promise<SyncResult<ComparisonReviewData>>((resolve) => {
    releaseResponse = resolve;
  });
  const checkpoints: object[] = [];
  const requests: ReconcileRequest[] = [];
  let releaseMerge = () => {};
  const mergeBarrier = new Promise<void>((resolve) => {
    releaseMerge = resolve;
  });
  let holdAcknowledgment = false;
  let heldMerges = 0;
  const api = async <T,>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(current) as T;
    if (path.endsWith("/checkpoint")) {
      checkpoints.push(body);
      return { checkpointId: "unexpected-conflict" } as T;
    }
    if (!path.endsWith("/reconcile"))
      throw new Error(`Unexpected request: ${path}`);
    const sent = structuredClone(body) as ReconcileRequest;
    requests.push(sent);
    if (initialWrite) {
      initialWrite = false;
      current = state(
        draft(
          original.replace(
            "Live owner A: unchanged.",
            `Live owner A: unchanged.${peerSuffix}`,
          ),
        ),
        2,
      );
      return {
        status: "client-merge-required",
        state: structuredClone(current),
        reservation: {
          token: "mounted-turn",
          revision: 2,
          expiresAt: Date.now() + 750,
        },
      } as T;
    }
    current = state(
      merge(
        sent.base as RevisionDraft,
        sent.draft as RevisionDraft,
        current.draft as RevisionDraft,
      ).draft as RevisionDraft,
      current.revision + 1,
    );
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
  const store = new RevisionUiDraftStore();
  store.setComment("c1", {
    value: privateComment,
    original:
      initial.draft.reviewComments.find((comment) => comment.id === "c1")
        ?.content ?? "",
    editing: true,
  });
  store.setComment("c99", {
    value: privateReply,
    original: "",
    editing: true,
    target: {
      id: "c99",
      content: "",
      createdAt: "2026-11-26T12:00:00.000Z",
      authorType: "user",
      parentCommentId: "s1",
    },
  });
  const flush = { current: null as (() => void) | null };
  const remote = { current: null as RevisionRemoteAdapter["apply"] | null };
  let editor: Editor | null = null;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RevisionUiDraftContext.Provider value={store}>
          <RichTextEditorSurface
            page={{
              id: "mounted-ack",
              title: initial.review.title,
              content: original,
            }}
            activeDocumentPath="practice.md"
            selected
            layout="default"
            focusRequestKey={null}
            sourceMarkdown={original}
            interactionMode="editing"
            onMarkdownChange={(markdown) =>
              controller?.updateDraft(
                (value) => ({
                  ...value,
                  markdown,
                  cleanMarkdown: cleanRevisionSourceMarkdown(markdown),
                }),
                { readyToSave: true },
              )
            }
            backend={
              new ApiBackend({
                kind: "local-files",
                label: "Files",
                detail: "/practice.md",
                projectPath: "/",
              })
            }
            onEditorReady={(value) => {
              editor = value;
            }}
            editableReview={{
              suggestions: [],
              decisions: [],
              comments: criticMarkdownToEditorState(original).comments,
              onCommentsChange: () => {},
              onAccept: () => true,
              onReject: () => true,
              onBlockedSuggestionEdit: () => {},
              markdownFlushRef: flush,
              remoteUpdateRef: remote,
              uiDraftStore: store,
            }}
          />
        </RevisionUiDraftContext.Provider>
      </TooltipProvider>,
    ),
  );
  if (!editor || !remote.current)
    throw new Error("Expected the mounted editor adapter");
  const live = editor as Editor;
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await act(async () =>
    container
      .querySelector<HTMLElement>('[data-testid="comment-thread-c1"]')
      ?.click(),
  );
  expect(
    container.querySelector<HTMLTextAreaElement>('[data-testid$="-c1-editor"]')
      ?.value,
  ).toBe(privateComment);
  expect(
    container.querySelector<HTMLTextAreaElement>('[data-testid$="-c99-editor"]')
      ?.value,
  ).toBe(privateReply);
  vi.useFakeTimers();
  const active = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    {
      request: api,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
      id: () => "mounted-page",
      merge: async (base, local, incoming, options) => {
        const result = mergeReviewDrafts(base, local, incoming, {
          ...options,
          server: false,
          budgetMs: 1000,
        });
        if (holdAcknowledgment) {
          heldMerges++;
          await mergeBarrier;
        }
        return result;
      },
    },
  );
  controller = active;
  await act(async () => {
    active.setAdapter({
      rebasesBufferedDocument: true,
      prepare: (value) => prepareRevisionDraft(value, live.state),
      apply: (value, options) => remote.current?.(value, options) ?? null,
      adopt: () => null,
      flush: () => flush.current?.(),
      readUiDrafts: store.read,
      restoreUiDrafts: store.restore,
      subscribeUiDrafts: store.subscribe,
    });
    active.start();
    await vi.advanceTimersByTimeAsync(0);
  });
  const type = async (text: string, serialize = false) =>
    act(async () => {
      let at = -1;
      live.state.doc.descendants((node, pos) => {
        if (node.isText && node.text?.startsWith("Live owner B:"))
          at = pos + node.nodeSize;
      });
      if (at < 0) throw new Error("Missing native typing target");
      const tr = live.state.tr.insertText(text, at);
      tr.setSelection(TextSelection.create(tr.doc, at + text.length));
      live.view.dispatch(tr);
      if (serialize) flush.current?.();
    });
  await type(firstSuffix, true);
  let pending: Promise<boolean> | undefined;
  await act(async () => {
    pending = active.flush(false);
    await vi.advanceTimersByTimeAsync(0);
  });
  const candidate = heldResult?.state;
  if (!candidate) throw new Error("The reserved candidate was never committed");
  expect(requests.filter((request) => request.reservationToken)).toHaveLength(
    1,
  );
  expect(live.state.doc.textContent).not.toContain(peerSuffix);
  await type(newerSuffix, true);
  await type(bufferedSuffix);
  const notify = () => {
    for (const listener of listeners)
      listener({ reason: "changed", state: structuredClone(candidate) });
  };
  holdAcknowledgment = true;
  await act(async () => {
    if (order === "response-first")
      releaseResponse(
        structuredClone(heldResult as SyncResult<ComparisonReviewData>),
      );
    else notify();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(heldMerges).toBe(1);
  await act(async () => {
    if (order === "response-first") notify();
    else
      releaseResponse(
        structuredClone(heldResult as SyncResult<ComparisonReviewData>),
      );
    await vi.advanceTimersByTimeAsync(0);
  });
  holdAcknowledgment = false;
  await act(async () => {
    releaseMerge();
    await pending;
    await vi.advanceTimersByTimeAsync(32);
  });
  const expectedA = `Live owner A: unchanged.${peerSuffix}`;
  const expectedB = `Live owner B: unchanged.${firstSuffix}${newerSuffix}${bufferedSuffix}`;
  const editorText = live.state.doc.textBetween(
    0,
    live.state.doc.content.size,
    "\n",
  );
  expect(editorText.match(/Live owner A:[^\n]*/)?.[0]).toBe(expectedA);
  expect(editorText.match(/Live owner B:[^\n]*/)?.[0]).toBe(expectedB);
  expect(active.getSnapshot().conflict).toBeNull();
  expect(active.getSnapshot().writePaused).toBe(false);
  expect(checkpoints).toEqual([]);
  expect(store.getSnapshot().comments.c1.value).toBe(privateComment);
  expect(store.getSnapshot().comments.c99).toMatchObject({
    value: privateReply,
    target: { parentCommentId: "s1" },
  });
  expect(
    container.querySelector<HTMLTextAreaElement>('[data-testid$="-c1-editor"]')
      ?.value,
  ).toBe(privateComment);
  expect(
    container.querySelector<HTMLTextAreaElement>('[data-testid$="-c99-editor"]')
      ?.value,
  ).toBe(privateReply);
  await act(async () => {
    await active.flush();
    await vi.advanceTimersByTimeAsync(0);
  });
  const saved = current.draft as RevisionDraft;
  expect(saved.markdown.match(/Live owner A:[^\n]*/)?.[0]).toBe(expectedA);
  expect(saved.markdown.match(/Live owner B:[^\n]*/)?.[0]).toBe(expectedB);
  expect(saved.markdown).not.toContain(privateComment);
  expect(saved.markdown).not.toContain(privateReply);
  expect(
    saved.reviewComments.some((comment) =>
      [privateComment, privateReply].includes(comment.content),
    ),
  ).toBe(false);
}, 15_000);
