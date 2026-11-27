import { EditorView as CodeMirrorView } from "@codemirror/view";
import {
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncResult,
  type SyncState,
  sameReviewDraft,
} from "@roughdraft/rfm";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import editingReview from "../../../docs/spec/fixtures/editing-review.md?raw";
import { ApiBackend } from "./api-backend";
import type { ComparisonReviewData } from "./comparison-types";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  createCriticChange,
  criticMarkdownToEditorState,
} from "./critic-markup";
import { explicitReviewEdit } from "./editor-extensions";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { RichTextEditorSurface } from "./PageCard";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
import { adoptRevisionDisk } from "./revision-disk-adoption";
import {
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import {
  prepareRevisionDraft,
  prepareRevisionEditorDraft,
} from "./revision-prepare";
import { suggestionPositions } from "./revision-projection";
import { documentProposalIdentities } from "./revision-proposal-identities";
import { serializeRevisionNode } from "./revision-review-cache";
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

function privateDrafts() {
  const store = new RevisionUiDraftStore();
  store.setComment("c1", {
    value: privateComment,
    original:
      draft(original).reviewComments.find((comment) => comment.id === "c1")
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
  return store;
}

async function mountEditor(
  store: RevisionUiDraftStore,
  markdown = original,
  withSource = false,
  onSourceCompositionEnd?: () => void,
) {
  const flush = { current: null as (() => void) | null };
  const remote = { current: null as RevisionRemoteAdapter["apply"] | null };
  const source = {
    current: null as ((value: string, previous?: string) => void) | null,
  };
  let reflectSource = (_value: string) => {};
  function SourceEditor() {
    const [value, setValue] = useState(markdown);
    reflectSource = setValue;
    return (
      <MarkdownCodeEditor
        value={value}
        onChange={(next) => {
          setValue(next);
          source.current?.(next, controller?.readDraft().markdown);
        }}
        onCompositionEnd={onSourceCompositionEnd}
      />
    );
  }
  let editor: Editor | null = null;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RevisionUiDraftContext.Provider value={store}>
          <RichTextEditorSurface
            page={{
              id: "mounted-ack",
              title: "Review concurrent changes to the release plan",
              content: markdown,
            }}
            activeDocumentPath="practice.md"
            selected
            layout="default"
            focusRequestKey={null}
            sourceMarkdown={markdown}
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
              comments: criticMarkdownToEditorState(markdown).comments,
              onCommentsChange: () => {},
              onAccept: () => true,
              onReject: () => true,
              onBlockedSuggestionEdit: () => {},
              markdownFlushRef: flush,
              remoteUpdateRef: remote,
              sourceUpdateRef: source,
              uiDraftStore: store,
            }}
          />
          {withSource && <SourceEditor />}
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
  return {
    live,
    flush,
    remote,
    reflectSource: (value: string) => reflectSource(value),
  };
}

test("a source update checks composition against its final rebase across newer preedit", async () => {
  const store = privateDrafts();
  const { live, remote, reflectSource } = await mountEditor(
    store,
    original,
    true,
  );
  const host = container.querySelector<HTMLElement>(".cm-editor");
  const source = host && CodeMirrorView.findFromDOM(host);
  if (!source) throw new Error("Expected the actual source editor");
  const at =
    source.state.doc.toString().indexOf("Live owner B: unchanged.") +
    "Live owner B: unchanged.".length;
  await act(async () => {
    source.focus();
    source.dispatch({ selection: { anchor: at } });
    source.contentDOM.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    source.dispatch({
      changes: { from: at, insert: " 日本語" },
      selection: { anchor: at + 4 },
    });
  });
  const baseline = draft(source.state.sliceDoc());
  const candidate = draft(
    baseline.markdown.replace(
      "Live owner A: unchanged.",
      "Live owner A: Incoming worker text.",
    ),
  );
  // The worker's immutable result predates this newer native composition input.
  await act(async () =>
    source.dispatch({
      changes: { from: source.state.selection.main.head, insert: "続" },
    }),
  );
  let applied: RevisionDraft | null | undefined;
  await act(async () => {
    applied = remote.current?.(candidate, { localBase: baseline });
    if (applied) reflectSource(applied.markdown);
  });
  expect(applied).not.toBeNull();
  expect(live.state.doc.textContent).toContain(
    "Live owner B: unchanged. 日本語続",
  );
  expect(live.state.doc.textContent).toContain(
    "Live owner A: Incoming worker text.",
  );
  expect(source.state.sliceDoc()).toContain(
    "Live owner B: unchanged. 日本語続",
  );
  expect(source.state.sliceDoc()).toContain(
    "Live owner A: Incoming worker text.",
  );
  expect(source.compositionStarted).toBe(true);
}, 15_000);

test.each([
  "other paragraph",
  "same paragraph",
  "comment only",
  "overlap",
] as const)("actual source composition applies independent updates and waits only for protected edits (%s)", async (scenario) => {
  const profile = { entries: [] as Array<{ stage: string }> };
  vi.stubGlobal("roughdraftProfile", profile);
  const store = privateDrafts();
  let compositionEnded = 0;
  let draining: Promise<boolean> | undefined;
  const { live, remote, reflectSource } = await mountEditor(
    store,
    original,
    true,
    () => {
      compositionEnded++;
      if (controller?.getSnapshot().conflict?.kind === "waiting")
        draining = controller.retry();
    },
  );
  const host = container.querySelector<HTMLElement>(".cm-editor");
  const source = host && CodeMirrorView.findFromDOM(host);
  if (!source) throw new Error("Expected the actual Markdown source editor");
  let server = state();
  const api = async <T,>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/checkpoint"))
      return { checkpointId: "composition-recovery" } as T;
    if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
    const sent = body as ReconcileRequest;
    server = state(sent.draft as RevisionDraft, server.revision + 1);
    server.review.lastOperation = {
      id: sent.operationId,
      pageInstanceId: sent.pageInstanceId,
      reason: sent.reason,
    };
    return { status: "committed", state: structuredClone(server) } as T;
  };
  vi.useFakeTimers();
  const active = new RevisionSessionController(
    server.review,
    server.draft as RevisionDraft,
    {
      request: api,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
      merge: async (base, local, incoming, options) =>
        mergeReviewDrafts(base, local, incoming, {
          ...options,
          server: false,
          budgetMs: 1000,
        }),
    },
  );
  controller = active;
  await act(async () => {
    active.setAdapter({
      rebasesBufferedDocument: true,
      prepare: (value, options) =>
        prepareRevisionEditorDraft(value, live, options),
      apply: (value, options) => {
        const result = remote.current?.(value, options) ?? null;
        if (result) reflectSource(result.markdown);
        return result;
      },
      adopt: () => null,
      readUiDrafts: store.read,
      restoreUiDrafts: store.restore,
      subscribeUiDrafts: store.subscribe,
    });
    active.start();
    await vi.advanceTimersByTimeAsync(0);
    source.focus();
    const at =
      source.state.doc.toString().indexOf("Live owner B: unchanged.") +
      "Live owner B: unchanged.".length;
    source.dispatch({ selection: { anchor: at } });
    source.contentDOM.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "日" }),
    );
    source.dispatch({
      changes: { from: at, insert: " 日本語" },
      selection: { anchor: at + 4 },
    });
  });
  expect(source.compositionStarted).toBe(true);
  const localText = source.state.sliceDoc();
  const caret = source.state.selection.main.anchor;
  const compositionNode = source.domAtPos(caret).node;
  if (scenario === "overlap")
    await act(async () => {
      await active.flush(false);
    });
  const peerBase = structuredClone(server);
  const oldComment =
    "This second comment overlaps the birch and continues to the path. Its highlight must stay separate.";
  for (const [index, addition] of [
    " Earlier outside text.",
    " Latest outside text.",
  ].entries()) {
    const peer =
      scenario === "overlap" ? peerBase.draft.markdown : server.draft.markdown;
    const changed =
      scenario === "overlap"
        ? peer.replace(
            "Live owner B: unchanged. 日本語",
            `Live owner B: unchanged. ${index === 0 ? "先の言葉" : "最新の言葉"}`,
          )
        : scenario === "same paragraph"
          ? peer.replace(
              /(?:Peer detail \d+\. )?Live owner B:/,
              `Peer detail ${index + 1}. Live owner B:`,
            )
          : scenario === "comment only"
            ? peer.replaceAll(
                index === 0 ? oldComment : "Peer comment revision 1.",
                `Peer comment revision ${index + 1}.`,
              )
            : peer.replace(
                /Live owner A:[^\n]*/,
                `Live owner A: unchanged.${addition}`,
              );
    expect(changed).not.toBe(peer);
    server = state(draft(changed), server.revision + 1);
    await act(async () => {
      for (const listener of listeners)
        listener({ reason: "changed", state: structuredClone(server) });
      await vi.advanceTimersByTimeAsync(0);
    });
    if (scenario === "overlap") {
      expect(active.getSnapshot().conflict?.kind).toBe("waiting");
      expect(source.state.sliceDoc()).toBe(localText);
      expect(source.state.selection.main.anchor).toBe(caret);
    } else {
      expect(
        active.getSnapshot().conflict,
        JSON.stringify(
          profile.entries.filter((entry) => entry.stage.includes("blocked")),
        ),
      ).toBeNull();
      await act(async () => {
        await active.flush(false);
      });
      expect(server.draft.markdown).toContain(
        "Live owner B: unchanged. 日本語",
      );
      expect(active.getSnapshot().writePaused).toBe(false);
      if (scenario === "other paragraph") {
        expect(live.state.doc.textContent).toContain(addition.trim());
        expect(source.state.sliceDoc()).toContain(addition.trim());
      } else if (scenario === "same paragraph") {
        expect(live.state.doc.textContent).toContain(
          `Peer detail ${index + 1}. Live owner B:`,
        );
        expect(source.state.sliceDoc()).toContain(
          `Peer detail ${index + 1}. Live owner B:`,
        );
      } else {
        expect(
          active
            .readDraft()
            .reviewComments.find((comment) => comment.id === "c2")?.content,
        ).toBe(`Peer comment revision ${index + 1}.`);
        expect(source.state.sliceDoc()).toContain(
          `Peer comment revision ${index + 1}.`,
        );
      }
      expect(source.compositionStarted).toBe(true);
      expect(source.domAtPos(source.state.selection.main.anchor).node).toBe(
        compositionNode,
      );
      expect(
        source.state.doc.sliceString(
          source.state.selection.main.anchor - 3,
          source.state.selection.main.anchor,
        ),
      ).toBe("日本語");
    }
  }
  await act(async () => {
    source.contentDOM.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }),
    );
    await vi.advanceTimersByTimeAsync(60);
    await draining;
  });
  expect(compositionEnded).toBe(1);
  if (scenario === "overlap") {
    expect(source.state.sliceDoc()).toContain(
      "Live owner B: unchanged. 最新の言葉",
    );
    expect(live.state.doc.textContent).toContain(
      "Live owner B: unchanged. 最新の言葉",
    );
  } else if (scenario === "other paragraph") {
    expect(live.state.doc.textContent).toContain("Latest outside text.");
    expect(live.state.doc.textContent).not.toContain("Earlier outside text.");
  }
  expect(active.getSnapshot().conflict).toBeNull();
  if (scenario !== "overlap") {
    await act(async () => {
      live.commands.undo();
    });
    expect(live.state.doc.textContent).not.toContain(
      "Live owner B: unchanged. 日本語",
    );
    if (scenario === "other paragraph")
      expect(live.state.doc.textContent).toContain("Latest outside text.");
    await act(async () => {
      live.commands.redo();
    });
    expect(live.state.doc.textContent).toContain(
      "Live owner B: unchanged. 日本語",
    );
  }
  expect(store.getSnapshot().comments.c1.value).toBe(privateComment);
  expect(store.getSnapshot().comments.c99.value).toBe(privateReply);
}, 20_000);

test.each([
  "outside prose",
  "idle disk adoption",
  "shared History reopen",
] as const)("a native outside update retains known archived proposal identities (%s)", async (kind) => {
  const store = privateDrafts();
  const { live, remote } = await mountEditor(store);
  vi.useFakeTimers();
  const comments = criticMarkdownToEditorState(original).comments;
  const snapshot = (doc = live.state.doc): RevisionDraft => {
    const metadata = doc.attrs.sourceMetadata;
    return {
      ...draft(
        serializeRevisionNode(doc, comments, {
          frontmatter: metadata?.frontmatter,
          endmatter: metadata?.endmatter,
        }),
      ),
      reviewed: reviewedChanges(doc),
    };
  };
  await act(async () => {
    for (const [id, decision] of [
      ["s10", "accept"],
      ["s11", "reject"],
    ] as const) {
      const detail = suggestionDetail(live.state.doc, id);
      const transaction = live.state.tr;
      applySuggestionDecisions(transaction, [id], decision);
      live.view.dispatch(
        recordReviewedChange(
          transaction,
          {
            decision,
            oldText: detail.oldText,
            newText: detail.newText,
            keptIds: [id],
          },
          detail,
        ).setMeta(explicitReviewEdit, true),
      );
    }
  });
  const baseline = snapshot();
  // A saved peer/base may retain valid source spelling absent from this
  // page's native snapshot cache. History itself lives in the sidecar.
  const canonical = baseline.markdown;
  baseline.markdown = canonical.replace("**Changes**", "__Changes__");
  expect(baseline.markdown).not.toBe(canonical);
  expect(baseline.reviewed).toHaveLength(2);
  expect(suggestionPositions(live.state.doc).has("s10")).toBe(false);
  expect(suggestionPositions(live.state.doc).has("s11")).toBe(false);
  let incoming: RevisionDraft;
  if (kind === "shared History reopen") {
    const entry = baseline.reviewed?.find((item) =>
      item.keptIds?.includes("s10"),
    );
    if (!entry) throw new Error("Expected the actual Keep History entry");
    const reopened = reopenReviewedChange(live.state, entry.id);
    if (!reopened) throw new Error("Expected the peer's shared History reopen");
    incoming = snapshot(live.state.apply(reopened).doc);
  } else if (kind === "idle disk adoption") {
    const adopted = adoptRevisionDisk(
      baseline,
      baseline.cleanMarkdown?.replace(
        "Live owner A: unchanged.",
        "Live owner A: unchanged. Outside text above History.",
      ) ?? "",
      live.schema,
    );
    if (!adopted) throw new Error("Expected the actual disk adoption result");
    incoming = adopted as RevisionDraft;
  } else {
    incoming = {
      ...baseline,
      ...draft(
        baseline.markdown.replace(
          "Live owner A: unchanged.",
          "Live owner A: unchanged. Outside text above History.",
        ),
      ),
    };
  }
  let applied: RevisionDraft | null | undefined;
  await act(async () => {
    applied = remote.current?.(incoming, { localBase: baseline });
  });
  expect(applied).not.toBeNull();
  expect(reviewedChanges(live.state.doc)).toHaveLength(
    kind === "shared History reopen" ? 1 : 2,
  );
  if (kind !== "shared History reopen")
    expect(live.state.doc.textContent).toContain("Outside text above History.");
  else expect(suggestionPositions(live.state.doc).has("s10")).toBe(true);
  await act(async () => {
    for (const entry of [...reviewedChanges(live.state.doc)]) {
      const reopened = reopenReviewedChange(live.state, entry.id);
      expect(reopened).not.toBeNull();
      if (reopened)
        live.view.dispatch(reopened.setMeta(explicitReviewEdit, true));
    }
  });
  for (const id of ["s10", "s11"])
    expect(suggestionPositions(live.state.doc).has(id)).toBe(true);
  expect(store.getSnapshot().comments.c1.value).toBe(privateComment);
  expect(store.getSnapshot().comments.c99.value).toBe(privateReply);
}, 15_000);

test("a native outside update still waits for a different proposal newly archived in the local buffer", async () => {
  const store = privateDrafts();
  const { live, remote } = await mountEditor(store);
  vi.useFakeTimers();
  const baseline = draft(original);
  const change = createCriticChange("addition", undefined, {
    existingChanges: documentProposalIdentities(live.state.doc),
  });
  await act(async () => {
    let at = -1;
    live.state.doc.descendants((node, position) => {
      if (node.isText && node.text?.startsWith("Live owner B:"))
        at = position + node.nodeSize;
    });
    if (at < 0) throw new Error("Expected the actual local proposal target");
    const text = " Local archived proposal";
    live.view.dispatch(
      live.state.tr
        .insertText(text, at)
        .addMark(
          at,
          at + text.length,
          live.schema.marks.criticChange.create(change),
        ),
    );
    const detail = suggestionDetail(live.state.doc, change.changeId);
    const transaction = live.state.tr;
    applySuggestionDecisions(transaction, [change.changeId], "accept");
    live.view.dispatch(
      recordReviewedChange(
        transaction,
        {
          decision: "accept",
          oldText: detail.oldText,
          newText: detail.newText,
          keptIds: [change.changeId],
        },
        detail,
      ).setMeta(explicitReviewEdit, true),
    );
  });
  const incoming = draft(
    original.replace(
      "Live owner A: unchanged.",
      `Live owner A: unchanged. {++Different peer proposal++}{#${change.changeId}}`,
    ),
  );
  const before = live.state;
  let applied: RevisionDraft | null | undefined;
  await act(async () => {
    applied = remote.current?.(incoming, { localBase: baseline });
  });
  expect(applied).toBeNull();
  expect(live.state).toBe(before);
  expect(reviewedChanges(live.state.doc)).toHaveLength(1);
  const comments = criticMarkdownToEditorState(original).comments;
  const local = {
    ...draft(
      serializeRevisionNode(live.state.doc, comments, {
        frontmatter: live.state.doc.attrs.sourceMetadata?.frontmatter,
        endmatter: live.state.doc.attrs.sourceMetadata?.endmatter,
      }).replace("**Changes**", "__Changes__"),
    ),
    reviewed: reviewedChanges(live.state.doc),
  };
  const merged = merge(baseline, local, incoming);
  const localId = merged.idRemap?.[change.changeId];
  expect(localId).toBeDefined();
  expect(localId).not.toBe(change.changeId);
  await act(async () => {
    applied = remote.current?.(merged.draft as RevisionDraft, {
      localBase: local,
      idRemap: merged.idRemap,
    });
  });
  expect(applied).not.toBeNull();
  expect(suggestionPositions(live.state.doc).has(change.changeId)).toBe(true);
  expect(live.state.doc.textContent).toContain("Different peer proposal");
  const reopened = reopenReviewedChange(
    live.state,
    reviewedChanges(live.state.doc)[0].id,
  );
  expect(reopened).not.toBeNull();
  if (reopened) {
    await act(async () => live.view.dispatch(reopened));
    expect(suggestionDetail(live.state.doc, localId ?? "").newText).toContain(
      "Local archived proposal",
    );
    expect(suggestionPositions(live.state.doc).has(change.changeId)).toBe(true);
    expect(live.state.doc.textContent).toContain("Different peer proposal");
  }
}, 15_000);

test.each([
  "native",
  "source",
  "private reply",
] as const)("preparing an observed candidate waits for document composition while keeping %s drafts private", async (where) => {
  const store = privateDrafts();
  const { live } = await mountEditor(store, original, where === "source");
  if (where === "native") {
    live.view.focus();
    await act(async () =>
      live.view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "あ" }),
      ),
    );
    expect(live.view.composing).toBe(true);
  } else if (where === "source") {
    const element = container.querySelector<HTMLElement>(".cm-editor");
    const source = element && CodeMirrorView.findFromDOM(element);
    if (!source) throw new Error("Expected the actual source editor");
    source.focus();
    await act(async () =>
      source.contentDOM.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "あ" }),
      ),
    );
    expect(source.compositionStarted).toBe(true);
  } else {
    const reply = container.querySelector<HTMLTextAreaElement>(
      '[data-testid$="-c99-editor"]',
    );
    if (!reply) throw new Error("Expected the private reply editor");
    reply.focus();
    reply.dataset.composing = "true";
    await act(async () =>
      reply.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "あ" }),
      ),
    );
  }
  const candidate = draft(
    original.replace(
      "Live owner A: unchanged.",
      `Live owner A: unchanged.${peerSuffix}`,
    ),
  );
  const before = live.state;
  const publicCandidate = prepareRevisionEditorDraft(candidate, live, {
    beforeReflection: true,
  });
  if (where === "private reply")
    expect(publicCandidate?.markdown).toBe(candidate.markdown);
  else expect(publicCandidate).toBeNull();
  expect(live.state).toBe(before);
  expect(store.getSnapshot().comments.c99.value).toBe(privateReply);
  expect(prepareRevisionEditorDraft(candidate, live)?.markdown).toBe(
    candidate.markdown,
  );
}, 15_000);

test.each([
  "response-first",
  "event-first",
] as const)("a mounted editor integrates one server-merged acknowledgment once when %s paths overlap during a worker merge", async (order) => {
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
  const serverAddition = " Server added detail.";
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
    if (sent.reservationToken)
      current = state(
        draft(
          current.draft.markdown.replace(
            `Live owner A: unchanged.${peerSuffix}`,
            `Live owner A: unchanged.${peerSuffix}${serverAddition}`,
          ),
        ),
        current.revision,
      );
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
  const store = privateDrafts();
  const { live, flush, remote } = await mountEditor(store);
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
  const expectedA = `Live owner A: unchanged.${peerSuffix}${serverAddition}`;
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

test.each([
  "own echo",
  "reload before acknowledgment",
] as const)("dirty incoming work reaches the server before native reflection and survives %s", async (delivery) => {
  let current = state();
  const initial = current;
  const storage = new MemoryStorage();
  const tabStorage = new MemoryStorage();
  const steps: string[] = [];
  const requests: ReconcileRequest[] = [];
  let capture = false;
  let committed: SyncResult<ComparisonReviewData> | undefined;
  let releaseResponse = (_result: SyncResult<ComparisonReviewData>) => {};
  const response = new Promise<SyncResult<ComparisonReviewData>>((resolve) => {
    releaseResponse = resolve;
  });
  const api = async <T,>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(current) as T;
    if (path.endsWith("/resolve")) return structuredClone(committed) as T;
    if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
    if (capture) steps.push("post");
    const sent = structuredClone(body) as ReconcileRequest;
    if (capture) requests.push(sent);
    const value = merge(
      sent.base as RevisionDraft,
      sent.draft as RevisionDraft,
      current.draft as RevisionDraft,
    ).draft as RevisionDraft;
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
    if (capture && requests.length === 1) {
      committed = result;
      return response as Promise<T>;
    }
    return result as T;
  };
  let store = privateDrafts();
  let mounted = await mountEditor(store);
  vi.useFakeTimers();
  const start = async (seed: SyncState<ComparisonReviewData>, name: string) => {
    const active = new RevisionSessionController(
      seed.review,
      seed.draft as RevisionDraft,
      {
        request: api,
        storage,
        tabStorage,
        id: () => name,
        merge: async (base, local, incoming, options) =>
          mergeReviewDrafts(base, local, incoming, {
            ...options,
            server: false,
            budgetMs: 1000,
          }),
      },
    );
    controller = active;
    await act(async () => {
      active.setAdapter({
        rebasesBufferedDocument: true,
        prepare: (value, options) => {
          steps.push("prepare");
          return prepareRevisionEditorDraft(value, mounted.live, options);
        },
        apply: (value, options) => {
          steps.push("reflect");
          return mounted.remote.current?.(value, options) ?? null;
        },
        adopt: () => null,
        flush: () => mounted.flush.current?.(),
        readUiDrafts: store.read,
        restoreUiDrafts: store.restore,
        subscribeUiDrafts: store.subscribe,
      });
      active.start();
      await vi.advanceTimersByTimeAsync(0);
    });
    return active;
  };
  let active = await start(initial, "before-incoming");
  const type = async (text: string, serialize = false) =>
    act(async () => {
      let at = -1;
      mounted.live.state.doc.descendants((node, pos) => {
        if (node.isText && node.text?.startsWith("Live owner B:"))
          at = pos + node.nodeSize;
      });
      if (at < 0) throw new Error("Missing owner paragraph");
      mounted.live.view.dispatch(mounted.live.state.tr.insertText(text, at));
      if (serialize) mounted.flush.current?.();
    });
  await type(firstSuffix, true);
  steps.length = 0;
  capture = true;
  const incomingRevision = current.revision + 1;
  current = state(
    draft(
      current.draft.markdown.replace(
        "Live owner A: unchanged.",
        `Live owner A: unchanged.${peerSuffix}`,
      ),
    ),
    incomingRevision,
  );
  const observing = active.refresh(true);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(requests).toHaveLength(1);
  expect(steps).toEqual(["prepare", "post"]);
  expect(requests[0]).toMatchObject({
    expectedRevision: incomingRevision,
    baseRevision: incomingRevision,
  });
  expect(mounted.live.state.doc.textContent).not.toContain(peerSuffix);
  const candidate = committed?.state;
  if (!candidate)
    throw new Error("The prepared observed candidate did not commit");
  await type(newerSuffix, true);
  await type(bufferedSuffix);
  if (delivery === "own echo") {
    await act(async () => {
      for (const listener of listeners)
        listener({ reason: "changed", state: structuredClone(candidate) });
      await vi.advanceTimersByTimeAsync(0);
      releaseResponse(
        structuredClone(committed as SyncResult<ComparisonReviewData>),
      );
      await observing;
      await vi.advanceTimersByTimeAsync(32);
    });
  } else {
    await act(async () => mounted.flush.current?.());
    active.stop();
    const recovered = active.readDraft();
    controller = null;
    await act(async () => root.unmount());
    root = createRoot(container);
    vi.useRealTimers();
    store = new RevisionUiDraftStore();
    mounted = await mountEditor(store, recovered.markdown);
    vi.useFakeTimers();
    active = await start(current, "after-reload");
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="comment-thread-c1"]')
        ?.click();
      await vi.advanceTimersByTimeAsync(32);
    });
  }
  const text = mounted.live.state.doc.textBetween(
    0,
    mounted.live.state.doc.content.size,
    "\n",
  );
  const expectedA = `Live owner A: unchanged.${peerSuffix}`;
  const expectedB = `Live owner B: unchanged.${firstSuffix}${newerSuffix}${bufferedSuffix}`;
  expect(text.match(/Live owner A:[^\n]*/)?.[0]).toBe(expectedA);
  expect(text.match(/Live owner B:[^\n]*/)?.[0]).toBe(expectedB);
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
  expect(active.getSnapshot().conflict).toBeNull();
  expect(active.getSnapshot().writePaused).toBe(false);
  await act(async () => {
    await active.flush();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(current.draft.markdown.match(/Live owner A:[^\n]*/)?.[0]).toBe(
    expectedA,
  );
  expect(current.draft.markdown.match(/Live owner B:[^\n]*/)?.[0]).toBe(
    expectedB,
  );
  expect(current.draft.markdown).not.toContain(privateComment);
  expect(current.draft.markdown).not.toContain(privateReply);
  expect(requests[0].draft.markdown).not.toContain(privateReply);
}, 20_000);

for (const kind of [
  "exact",
  "server changed",
  "non-native",
  "identity serialized",
  "identity buffered",
] as const) {
  test.each([
    "response-first",
    "event-first",
  ] as const)(`a prepared acknowledgment preserves the maintained document and only uses necessary full merges (${kind}, %s)`, async (order) => {
    const store = privateDrafts();
    const { live, flush, remote } = await mountEditor(store);
    const publicComments = criticMarkdownToEditorState(original).comments;
    const snapshot = (): RevisionDraft => {
      const metadata = live.state.doc.attrs.sourceMetadata;
      const markdown = serializeRevisionNode(
        live.state.doc,
        publicComments,
        {
          frontmatter: metadata?.frontmatter,
          endmatter: metadata?.endmatter,
        },
        store.privateCommentIds(publicComments),
      );
      return { ...draft(markdown), reviewed: reviewedChanges(live.state.doc) };
    };
    const decide = async (id: string, decision: "accept" | "reject") =>
      act(async () => {
        const detail = suggestionDetail(live.state.doc, id);
        const transaction = live.state.tr;
        applySuggestionDecisions(transaction, [id], decision);
        live.view.dispatch(
          recordReviewedChange(
            transaction,
            {
              decision,
              oldText: detail.oldText,
              newText: detail.newText,
              keptIds: [id],
            },
            detail,
          ).setMeta(explicitReviewEdit, true),
        );
      });
    await decide("s10", "accept");
    await decide("s11", "reject");
    const collision = kind.startsWith("identity");
    const peerId = createCriticChange("addition", undefined, {
      existingChanges: documentProposalIdentities(live.state.doc),
    }).changeId;
    const initial = state(snapshot());
    let current = initial;
    const baselineSignature = reviewDraftSignature(initial.draft);
    let prepared: SyncState<ComparisonReviewData> | undefined;
    let response:
      | ((value: SyncResult<ComparisonReviewData>) => void)
      | undefined;
    let initialWrite = true;
    let acknowledging = false;
    let acknowledgmentMerges = 0;
    let releaseMerge = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    const submitted: ReconcileRequest[] = [];
    const api = async <T,>(path: string, body?: object): Promise<T | null> => {
      if (!body) return structuredClone(current) as T;
      if (path.endsWith("/checkpoint"))
        return { checkpointId: "preserved" } as T;
      if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
      const sent = body as ReconcileRequest;
      submitted.push(structuredClone(sent));
      if (initialWrite) {
        initialWrite = false;
        const peer = {
          ...initial.draft,
          ...draft(
            initial.draft.markdown.replace(
              "Live owner A: unchanged.",
              `Live owner A: unchanged.${peerSuffix}${collision ? ` {++Peer pending proposal++}{#${peerId}}` : ""}`,
            ),
          ),
          reviewed: initial.draft.reviewed,
        };
        current = state(peer, 2);
        current.originDrafts = { [baselineSignature]: initial.draft };
        return {
          status: "client-merge-required",
          state: structuredClone(current),
          reservation: {
            token: "exact-turn",
            revision: 2,
            expiresAt: Date.now() + 750,
          },
        } as T;
      }
      let saved = sent.draft as RevisionDraft;
      if (!response && kind === "server changed")
        saved = {
          ...saved,
          ...draft(
            saved.markdown.replace(
              `Live owner A: unchanged.${peerSuffix}`,
              `Live owner A: unchanged.${peerSuffix} Additional server text.`,
            ),
          ),
          reviewed: saved.reviewed,
        };
      current = state(saved, current.revision + 1);
      current.review.lastOperation = {
        id: sent.operationId,
        pageInstanceId: sent.pageInstanceId,
        reason: sent.reason,
      };
      current.originDrafts = { [baselineSignature]: initial.draft };
      if (!response) {
        prepared = structuredClone(current);
        expect(sameReviewDraft(prepared.draft, sent.draft)).toBe(
          kind !== "server changed",
        );
        return await new Promise<T>((resolve) => {
          response = (value) => resolve(value as T);
        });
      }
      return { status: "committed", state: structuredClone(current) } as T;
    };
    vi.useFakeTimers();
    const active = new RevisionSessionController(
      initial.review,
      initial.draft as RevisionDraft,
      {
        request: api,
        storage: new MemoryStorage(),
        tabStorage: new MemoryStorage(),
        merge: async (base, working, incoming, options) => {
          const result = mergeReviewDrafts(base, working, incoming, {
            ...options,
            server: false,
            budgetMs: 1000,
          });
          if (acknowledging) {
            acknowledgmentMerges++;
            await barrier;
          }
          return result;
        },
      },
    );
    controller = active;
    await act(async () => {
      active.setAdapter({
        rebasesBufferedDocument: kind !== "non-native",
        prepare: (value, options) =>
          prepareRevisionEditorDraft(value, live, options),
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
    const type = async (value: string, serialize: boolean) =>
      act(async () => {
        let at = -1;
        live.state.doc.descendants((node, position) => {
          if (
            node.isTextblock &&
            node.textContent.startsWith("Live owner B:")
          ) {
            at = position + node.nodeSize - 1;
            return false;
          }
        });
        if (at < 0) throw new Error("Missing native owner paragraph");
        live.view.dispatch(live.state.tr.insertText(value, at));
        if (serialize) flush.current?.();
      });
    await type(firstSuffix, true);
    let saving: Promise<boolean> | undefined;
    await act(async () => {
      saving = active.flush(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    if (!prepared || !response)
      throw new Error("Expected an actual prepared commit");
    await type(newerSuffix, true);
    await decide("s2", "reject");
    await act(async () => {
      flush.current?.();
      active.updateDraft((value) => ({
        ...value,
        reviewed: reviewedChanges(live.state.doc),
        reviewComments: [
          ...value.reviewComments,
          {
            id: "c-published-after-prepare",
            changeId: "document",
            parentCommentId: "c2",
            content: "A submitted reply after preparing the candidate.",
            createdAt: "2026-11-26T12:01:00.000Z",
            authorType: "user",
          },
        ],
      }));
    });
    if (collision)
      await act(async () => {
        let at = -1;
        live.state.doc.descendants((node, position) => {
          if (node.isText && node.text?.startsWith("Live owner B:"))
            at = position + node.nodeSize;
        });
        if (at < 0) throw new Error("Missing local proposal target");
        const change = createCriticChange("addition", undefined, {
          existingChanges: documentProposalIdentities(live.state.doc),
        });
        expect(change.changeId).toBe(peerId);
        const text = " Local pending proposal";
        live.view.dispatch(
          live.state.tr
            .insertText(text, at)
            .addMark(
              at,
              at + text.length,
              live.schema.marks.criticChange.create(change),
            ),
        );
        store.setComment("c-new-proposal-reply", {
          value: "Private reply follows the local proposal",
          original: "",
          editing: true,
          target: {
            id: "c-new-proposal-reply",
            parentCommentId: peerId,
            content: "",
            createdAt: "2026-11-26T12:02:00.000Z",
            authorType: "user",
          },
        });
        if (kind === "identity serialized") flush.current?.();
      });
    await type(bufferedSuffix, false);
    const expectedA = `Live owner A: unchanged.${peerSuffix}${kind === "server changed" ? " Additional server text." : collision ? " Peer pending proposal" : ""}`;
    const expectedB = `Live owner B: unchanged.${firstSuffix}${newerSuffix}${collision ? " Local pending proposal" : ""}${bufferedSuffix}`;
    const notify = () => {
      for (const listener of listeners)
        listener({ reason: "changed", state: structuredClone(prepared) });
    };
    acknowledging = true;
    await act(async () => {
      if (order === "response-first")
        response?.({ status: "committed", state: prepared });
      else notify();
      await vi.advanceTimersByTimeAsync(0);
      if (order === "response-first") notify();
      else response?.({ status: "committed", state: prepared });
      await vi.advanceTimersByTimeAsync(0);
    });
    const initialAcknowledgmentMerges = acknowledgmentMerges;
    try {
      if (!collision)
        expect(acknowledgmentMerges).toBe(kind === "exact" ? 0 : 1);
    } finally {
      acknowledging = false;
      await act(async () => {
        releaseMerge();
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    await act(async () => {
      await saving;
      await vi.advanceTimersByTimeAsync(
        kind === "identity buffered" ? 500 : 32,
      );
    });
    const text = live.state.doc.textBetween(
      0,
      live.state.doc.content.size,
      "\n",
    );
    expect(text.match(/Live owner A:[^\n]*/)?.[0]).toBe(expectedA);
    expect(text.match(/Live owner B:[^\n]*/)?.[0]).toBe(expectedB);
    expect(active.readDraft().reviewComments).toContainEqual(
      expect.objectContaining({
        id: "c-published-after-prepare",
        content: "A submitted reply after preparing the candidate.",
      }),
    );
    expect(store.getSnapshot().comments.c1.value).toBe(privateComment);
    expect(store.getSnapshot().comments.c99.value).toBe(privateReply);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid$="-c1-editor"]',
      )?.value,
    ).toBe(privateComment);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid$="-c99-editor"]',
      )?.value,
    ).toBe(privateReply);
    expect(active.getSnapshot().conflict).toBeNull();
    if (collision) {
      const ids: string[][] = [];
      live.state.doc.descendants((node) => {
        if (
          node.type.name !== "paragraph" ||
          !/^Live owner [AB]:/.test(node.textContent)
        )
          return;
        const owned = new Set<string>();
        node.descendants((child) => {
          for (const mark of child.marks)
            if (mark.type.name === "criticChange")
              owned.add(mark.attrs.changeId);
        });
        ids.push([...owned]);
      });
      expect(ids).toHaveLength(2);
      expect(ids[0]).toEqual([peerId]);
      expect(ids[1]).toHaveLength(1);
      expect(ids[1][0]).not.toBe(peerId);
      expect(
        store.getSnapshot().comments["c-new-proposal-reply"].target
          ?.parentCommentId,
      ).toBe(ids[1][0]);
      expect(store.getSnapshot().comments["c-new-proposal-reply"].value).toBe(
        "Private reply follows the local proposal",
      );
      expect(initialAcknowledgmentMerges).toBe(
        kind === "identity buffered" ? 0 : 1,
      );
      await act(async () => live.commands.rejectCriticChange(ids[1][0]));
      expect(suggestionPositions(live.state.doc).has(peerId)).toBe(true);
    }
    const history = reviewedChanges(live.state.doc);
    expect(history).toHaveLength(3);
    await act(async () => {
      for (const entry of history) {
        const reopened = reopenReviewedChange(live.state, entry.id);
        expect(reopened).not.toBeNull();
        if (!reopened)
          throw new Error("Every maintained History example must reopen");
        live.view.dispatch(reopened.setMeta(explicitReviewEdit, true));
      }
    });
    for (const id of ["s10", "s11", "s2"])
      expect(suggestionPositions(live.state.doc).has(id)).toBe(true);
    expect(JSON.stringify(submitted)).not.toContain(privateReply);
    expect(JSON.stringify(submitted)).not.toContain(privateComment);
  }, 25_000);
}
