import { renumberReviewDraft } from "@roughdraft/rfm";
import type { Editor } from "@tiptap/core";
import { closeHistory, undo } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiBackend } from "./api-backend";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { RichTextEditorSurface } from "./PageCard";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import { prepareRevisionDraft } from "./revision-prepare";
import type { RevisionDraft, RevisionRemoteAdapter } from "./revision-session";
import {
  RevisionUiDraftContext,
  RevisionUiDraftStore,
} from "./revision-ui-drafts";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
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
  await act(async () => root.unmount());
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

test("continuous rich-text typing emits its first coalesced snapshot within 225 ms", async () => {
  const markdown = "Ordinary paragraph.\n";
  const changed = vi.fn();
  const flush = { current: null as (() => void) | null };
  let editor: Editor | null = null;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RichTextEditorSurface
          page={{ id: "cadence", title: "Typing cadence", content: markdown }}
          activeDocumentPath="practice.md"
          selected
          layout="default"
          focusRequestKey={null}
          sourceMarkdown={markdown}
          onMarkdownChange={changed}
          interactionMode="editing"
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
            comments: new Map(),
            onCommentsChange: () => {},
            onAccept: () => true,
            onReject: () => true,
            onBlockedSuggestionEdit: () => {},
            markdownFlushRef: flush,
          }}
        />
      </TooltipProvider>,
    ),
  );
  if (!editor) throw new Error("Expected the real editor");
  const live = editor as Editor;
  changed.mockClear();
  vi.useFakeTimers();
  const type = async (text: string) =>
    act(async () => {
      const at = live.state.doc.content.size - 1;
      live.view.dispatch(live.state.tr.insertText(text, at));
    });
  await type("A");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  await type("B");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  await type("C");
  expect(changed).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(25));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0]).toContain("paragraph.ABC");

  await type("D");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  await type("E");
  await act(async () => vi.advanceTimersByTimeAsync(125));
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed.mock.calls[1][0]).toContain("paragraph.ABCDE");
});

test("remote application rebases buffered native typing with its selection, Undo and exact source intact", async () => {
  const markdown =
    "# Heading\n\nLocal paragraph.\n\nRemote paragraph.\n\nSource spelling with [a local link](./relative%20file.md) and {==anchor==}{>>Saved comment<<}{#c1}.\n";
  const parsed = criticMarkdownToEditorState(markdown);
  const base: RevisionDraft = {
    markdown,
    cleanMarkdown: cleanRevisionSourceMarkdown(markdown),
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: "document",
    })),
  };
  const store = new RevisionUiDraftStore();
  store.setComment("c1", {
    value: "Still private",
    original: "Saved comment",
    editing: true,
  });
  const flush = { current: null as (() => void) | null };
  const remote = { current: null as RevisionRemoteAdapter["apply"] | null };
  const changed = vi.fn();
  let editor: Editor | null = null;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RevisionUiDraftContext.Provider value={store}>
          <RichTextEditorSurface
            page={{
              id: "buffered",
              title: "Buffered typing",
              content: markdown,
            }}
            activeDocumentPath="practice.md"
            selected
            layout="default"
            focusRequestKey={null}
            sourceMarkdown={markdown}
            onMarkdownChange={changed}
            interactionMode="editing"
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
              comments: parsed.comments,
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
    throw new Error("Expected the real editor adapter");
  const live = editor as Editor;
  changed.mockClear();
  vi.useFakeTimers();
  let at = -1;
  live.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === "Local paragraph.")
      at = pos + node.nodeSize - 1;
  });
  expect(at).toBeGreaterThan(0);
  for (const [index, text] of [" BEFORE", " AFTER"].entries()) {
    await act(async () => {
      const tr = live.state.tr.insertText(text, at);
      tr.setSelection(TextSelection.create(tr.doc, at + text.length));
      live.view.dispatch(index ? tr : closeHistory(tr));
    });
    at += text.length;
  }
  expect(changed).not.toHaveBeenCalled();
  const cursor = live.state.selection.from;
  const beforePreparation = live.state;
  const privateDrafts = store.read();
  const candidate = {
    ...base,
    markdown: markdown.replace("Remote paragraph", "Peer paragraph"),
    cleanMarkdown: undefined,
  };
  const prepared = prepareRevisionDraft(candidate, beforePreparation);
  expect(prepared).not.toBeNull();
  expect(prepared?.cleanMarkdown).toContain("Peer paragraph.");
  expect(prepared?.cleanMarkdown).not.toContain("BEFORE");
  expect(live.state).toBe(beforePreparation);
  expect(store.read()).toEqual(privateDrafts);
  expect(changed).not.toHaveBeenCalled();
  let result: RevisionDraft | null = null;
  await act(async () => {
    result =
      remote.current?.(prepared ?? candidate, {
        localBase: base,
        currentCleanMarkdown: base.cleanMarkdown,
      }) ?? null;
  });
  expect(result).not.toBeNull();
  expect(live.state.doc.textContent).toContain("Local paragraph BEFORE AFTER.");
  expect(live.state.doc.textContent).toContain("Peer paragraph.");
  expect(live.state.selection.from).toBe(cursor);
  const applied = result as RevisionDraft | null;
  expect(applied?.markdown).toContain("Local paragraph BEFORE AFTER.");
  expect(applied?.cleanMarkdown).toContain("Local paragraph BEFORE AFTER.");
  expect(applied?.markdown).toContain("[a local link](./relative%20file.md)");
  expect(
    applied?.reviewComments.find((comment) => comment.id === "c1")?.content,
  ).toBe("Saved comment");
  expect(store.getSnapshot().comments.c1.value).toBe("Still private");
  await act(async () => {
    expect(undo(live.state, (tr) => live.view.dispatch(tr))).toBe(true);
  });
  expect(live.state.doc.textContent).toContain("Local paragraph.");
  expect(live.state.doc.textContent).not.toContain("BEFORE");
  expect(live.state.doc.textContent).toContain("Peer paragraph.");
  await act(async () => vi.advanceTimersByTimeAsync(225));
  expect(changed.mock.calls.at(-1)?.[0]).toContain("Peer paragraph.");
});

test.each([
  true,
  false,
])("a private restored reply appears only under its existing model suggestion: %s", async (present) => {
  const markdown = present
    ? "A {~~pending~>proposed~~}{#s2} replacement.\n"
    : "A pending replacement.\n";
  const parsed = criticMarkdownToEditorState(markdown);
  const store = new RevisionUiDraftStore();
  store.restore({
    comments: {
      c9: {
        value: "Unsubmitted suggestion reply",
        original: "",
        editing: true,
        target: {
          id: "c9",
          content: "",
          createdAt: "2026-11-26T12:00:00.000Z",
          parentCommentId: "s2",
        },
      },
    },
  });
  const submitted = vi.fn();
  const changed = vi.fn();
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RevisionUiDraftContext.Provider value={store}>
          <RichTextEditorSurface
            page={{
              id: "private-proposal-reply",
              title: "Restore a proposal reply",
              content: markdown,
            }}
            activeDocumentPath="practice.md"
            selected
            layout="default"
            focusRequestKey={null}
            sourceMarkdown={markdown}
            onMarkdownChange={changed}
            interactionMode="editing"
            backend={
              new ApiBackend({
                kind: "local-files",
                label: "Files",
                detail: "/practice.md",
                projectPath: "/",
              })
            }
            editableReview={{
              suggestions: [],
              decisions: [],
              comments: parsed.comments,
              onCommentsChange: submitted,
              onAccept: () => true,
              onReject: () => true,
              onBlockedSuggestionEdit: () => {},
              uiDraftStore: store,
            }}
          />
        </RevisionUiDraftContext.Provider>
      </TooltipProvider>,
    ),
  );
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const input = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="comment-rail-c9-editor"]',
  );
  if (present) expect(input?.value).toBe("Unsubmitted suggestion reply");
  else expect(input).toBeNull();
  expect(submitted).not.toHaveBeenCalled();
  expect(
    changed.mock.calls.every(
      ([text]) => !text.includes("Unsubmitted suggestion reply"),
    ),
  ).toBe(true);
  expect(store.getSnapshot().comments.c9.value).toBe(
    "Unsubmitted suggestion reply",
  );
});
test.each([
  "overlap",
  "composition",
  "success",
] as const)("real editor remote identity preparation is atomic for %s", async (mode) => {
  const markdown =
    "Local {++Alpha++}{#s13}.\n\nStable ending.\n\nComment {==anchor==}{>>Original<<}{#c5}.\n";
  const parsed = criticMarkdownToEditorState(markdown);
  const base: RevisionDraft = {
    markdown,
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: "document",
    })),
  };
  const store = new RevisionUiDraftStore();
  store.setComment("c5", {
    value: "Unfinished draft",
    original: "Original",
    editing: true,
  });
  const remote: { current: RevisionRemoteAdapter["apply"] | null } = {
    current: null,
  };
  let editor: Editor | null = null;
  const backend = new ApiBackend({
    kind: "local-files",
    label: "Files",
    detail: "/practice.md",
    projectPath: "/",
  });
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RevisionUiDraftContext.Provider value={store}>
          <RichTextEditorSurface
            page={{ id: "atomic", title: "Atomic review", content: markdown }}
            activeDocumentPath="practice.md"
            selected
            layout="default"
            focusRequestKey={null}
            sourceMarkdown={markdown}
            onMarkdownChange={() => {}}
            interactionMode="editing"
            backend={backend}
            onEditorReady={(value) => {
              editor = value;
            }}
            editableReview={{
              suggestions: [],
              decisions: [],
              comments: parsed.comments,
              onCommentsChange: () => {},
              onAccept: () => true,
              onReject: () => true,
              onBlockedSuggestionEdit: () => {},
              remoteUpdateRef: remote,
              uiDraftStore: store,
            }}
          />
        </RevisionUiDraftContext.Provider>
      </TooltipProvider>,
    ),
  );
  if (!editor || !remote.current)
    throw new Error("Expected the real editor adapter");
  const live = editor as Editor;
  let at = -1;
  live.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes("Stable")) at = pos;
  });
  if (at < 0) throw new Error("Missing local editing target");
  if (mode === "overlap")
    await act(async () =>
      live.view.dispatch(live.state.tr.insertText("LOCAL", at, at + 6)),
    );
  if (mode === "composition") {
    await act(async () => {
      live.view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "Al" }),
      );
    });
    expect(live.view.composing).toBe(true);
  }
  const before = live.state.doc.toJSON();
  const uiBefore = store.read();
  const ids = { s13: "s14", c5: "c6" };
  const incoming = renumberReviewDraft(base, ids);
  incoming.markdown = incoming.markdown.replace("Stable", "REMOTE");
  let result: RevisionDraft | null = null;
  await act(async () => {
    result =
      remote.current?.(incoming, { idRemap: ids, localBase: base }) ?? null;
  });
  if (mode === "success") {
    expect(result).not.toBeNull();
    expect(store.getSnapshot().comments.c6.value).toBe("Unfinished draft");
    expect(store.getSnapshot().comments.c5).toBeUndefined();
    expect(
      editorStateToCriticMarkdown(
        live.getJSON(),
        new Map(
          (result as RevisionDraft | null)?.reviewComments.map((comment) => [
            comment.id,
            comment,
          ]) ?? [],
        ),
      ),
    ).toContain("s14");
  } else {
    expect(result).toBeNull();
    expect(live.state.doc.toJSON()).toEqual(before);
    expect(store.read()).toEqual(uiBefore);
    expect(
      editorStateToCriticMarkdown(live.getJSON(), parsed.comments),
    ).toContain("s13");
  }
});

test.each([
  "unchanged",
  "moved",
  "changed quote",
  "ambiguous quote",
  "reused ID",
])("a new anchored comment remains private and safely reopens after reload: %s", async (scenario) => {
  const markdown =
    "One stable beginning.\n\nA unique anchor for the new comment.\n\nA stable ending.\n";
  const store = new RevisionUiDraftStore();
  const submitted = vi.fn();
  const changed = vi.fn();
  let editor: Editor | null = null;
  const remote = { current: null as RevisionRemoteAdapter["apply"] | null };
  const render = (id: string, source: string, ui: RevisionUiDraftStore) => {
    const parsed = criticMarkdownToEditorState(source);
    return (
      <TooltipProvider>
        <RevisionUiDraftContext.Provider value={ui}>
          <RichTextEditorSurface
            page={{ id, title: "Private anchored comment", content: source }}
            activeDocumentPath="practice.md"
            selected
            layout="default"
            focusRequestKey={null}
            sourceMarkdown={source}
            onMarkdownChange={changed}
            interactionMode="editing"
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
              comments: parsed.comments,
              onCommentsChange: submitted,
              onAccept: () => true,
              onReject: () => true,
              onBlockedSuggestionEdit: () => {},
              uiDraftStore: ui,
              remoteUpdateRef: remote,
            }}
          />
        </RevisionUiDraftContext.Provider>
      </TooltipProvider>
    );
  };
  await act(async () => root.render(render("new-root", markdown, store)));
  if (!editor) throw new Error("Expected the real editor");
  const live = editor as Editor;
  let from = -1;
  live.state.doc.descendants((node, pos) => {
    const at = node.isText ? (node.text?.indexOf("unique anchor") ?? -1) : -1;
    if (at >= 0) from = pos + at;
  });
  expect(from).toBeGreaterThan(0);
  await act(async () => {
    live.view.dispatch(
      live.state.tr.setSelection(
        TextSelection.create(
          live.state.doc,
          from,
          from + "unique anchor".length,
        ),
      ),
    );
    live.view.dom.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "m",
        code: "KeyM",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const privateId = Object.keys(store.getSnapshot().comments)[0];
  expect(privateId).toMatch(/^c-/);
  const input = container.querySelector<HTMLTextAreaElement>(
    `[data-testid="comment-rail-${privateId}-editor"]`,
  );
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, "My unsaved anchored feedback");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(store.getSnapshot().comments[privateId].value).toBe(
    "My unsaved anchored feedback",
  );
  await act(async () =>
    live.view.dispatch(live.state.tr.insertText("My body edit. ", 1)),
  );
  let reviewSource = changed.mock.calls.at(-1)?.[0] as string;
  expect(reviewSource).toContain("My body edit.");
  expect(reviewSource).not.toContain(privateId);
  if (scenario === "unchanged") {
    const peerMarkdown = reviewSource.replace(
      "A stable ending.",
      "A {==stable ending==}{>>Peer saved feedback<<}{#c1}.",
    );
    const parsedPeer = criticMarkdownToEditorState(peerMarkdown);
    const localBase: RevisionDraft = {
      markdown: reviewSource,
      cleanMarkdown: reviewSource,
      decisions: {},
      reviewComments: [],
    };
    let incoming: RevisionDraft | null = null;
    await act(async () => {
      incoming =
        remote.current?.(
          {
            ...localBase,
            markdown: peerMarkdown,
            cleanMarkdown: reviewSource,
            reviewComments: [...parsedPeer.comments.values()].map(
              (comment) => ({ ...comment, changeId: "document" }),
            ),
          },
          { localBase, currentCleanMarkdown: reviewSource },
        ) ?? null;
    });
    expect(incoming).not.toBeNull();
    const applied = incoming as RevisionDraft | null;
    expect(applied?.markdown).toContain("Peer saved feedback");
    expect(applied?.markdown).not.toContain(privateId);
    let quote = "";
    live.state.doc.descendants((node) => {
      if (
        node.isText &&
        node.marks.some((mark) => mark.attrs.commentIds?.includes(privateId))
      )
        quote += node.text;
    });
    expect(quote).toBe("unique anchor");
    expect(store.getSnapshot().comments[privateId].value).toBe(
      "My unsaved anchored feedback",
    );
    reviewSource = applied?.markdown ?? reviewSource;
  }
  const captured = store.read();
  expect(submitted).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  const restored = new RevisionUiDraftStore();
  restored.restore(captured);
  const source =
    scenario === "moved"
      ? `New outside paragraph.\n\n${reviewSource}`
      : scenario === "changed quote"
        ? reviewSource.replace("unique anchor", "edited anchor")
        : scenario === "ambiguous quote"
          ? reviewSource.replace(
              "A stable ending.",
              "A unique anchor for the new comment.\n\nA stable ending.",
            )
          : scenario === "reused ID"
            ? reviewSource.replace(
                "unique anchor",
                `{==unique anchor==}{>>Someone else's submitted comment<<}{#${privateId}}`,
              )
            : reviewSource;
  await act(async () => root.render(render("restored-root", source, restored)));
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const reopened = container.querySelector<HTMLTextAreaElement>(
    `[data-testid="comment-rail-${privateId}-editor"]`,
  );
  if (scenario === "unchanged" || scenario === "moved")
    expect(reopened?.value).toBe("My unsaved anchored feedback");
  else expect(reopened).toBeNull();
  expect(restored.getSnapshot().comments[privateId].value).toBe(
    "My unsaved anchored feedback",
  );
  expect(submitted).not.toHaveBeenCalled();
  expect(
    changed.mock.calls.every(
      ([text]) => !text.includes("My unsaved anchored feedback"),
    ),
  ).toBe(true);
  if (scenario === "unchanged") {
    await act(async () =>
      reopened?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(submitted.mock.calls[0][0].get(privateId)?.content).toBe(
      "My unsaved anchored feedback",
    );
    const sent = changed.mock.calls.at(-1)?.[0] as string;
    expect(sent.match(/My unsaved anchored feedback/g)).toHaveLength(1);
    expect(sent).toContain(privateId);
    expect(sent).toContain("Peer saved feedback");
    expect(restored.privateCommentIds().has(privateId)).toBe(false);
  }
});
