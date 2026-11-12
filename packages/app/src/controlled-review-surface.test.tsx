import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RichTextEditorSurface } from "./PageCard";
import type { ControlledDocumentReview } from "./controlled-review";
import type { StorageBackend } from "./storage";

vi.mock("./EditorContextMenu", () => ({
  EditorContextMenu: ({
    children,
    editor,
  }: {
    children: ReactNode;
    editor: Editor | null;
  }) => (
    <div data-testid="context-menu-wrapper" data-has-editor={Boolean(editor)}>
      {children}
    </div>
  ),
}));
vi.mock("./DocumentReviewRail", () => ({
  DocumentReviewRail: (
    props: ComponentProps<
      typeof import("./DocumentReviewRail").DocumentReviewRail
    >,
  ) => (
    <div
      data-testid="native-rail"
      data-layout={props.layout}
      data-selected-comment={props.selectedCommentId ?? ""}
      data-suggestion-comment-ids={props.suggestions
        .flatMap((item) => item.commentIds)
        .join(",")}
      data-suggestions={props.suggestions
        .map((item) => item.changeId)
        .join(",")}
      data-comment-ids={props.commentGroups
        .flatMap((group) => group.commentIds)
        .join(",")}
    >
      <button
        type="button"
        data-testid="accept"
        onClick={() => props.onAcceptSuggestion("c1")}
      >
        Accept
      </button>
      <button
        type="button"
        data-testid="reject"
        onClick={() => props.onRejectSuggestion("c1")}
      >
        Skip
      </button>
      <button
        type="button"
        data-testid="reply"
        onClick={() => props.onReplySuggestion("c1")}
      >
        Reply
      </button>
      <button
        type="button"
        data-testid="reply-comment"
        onClick={() => props.onReplyComment("note")}
      >
        Reply to comment
      </button>
      <button
        type="button"
        data-testid="update"
        onClick={() => props.onUpdateComment("note", "updated")}
      >
        Update
      </button>
      <button
        type="button"
        data-testid="delete"
        onClick={() => props.onDeleteComment("note")}
      >
        Delete
      </button>
    </div>
  ),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("native controlled review routes choices and comments externally without saving Markdown", async () => {
  const onMarkdownChange = vi.fn();
  const editorRef: { current: Editor | null } = { current: null };
  const onEditorReady = (editor: Editor | null) => {
    editorRef.current = editor;
  };
  const review: ControlledDocumentReview = {
    doc: { type: "doc", content: [{ type: "horizontalRule" }] },
    suggestions: [
      {
        changeId: "c1",
        change: {
          changeId: "c1",
          kind: "addition",
          createdAt: "2026-11-11",
          authorType: "ai",
        },
        kind: "addition",
        oldText: "",
        newText: "Divider",
        commentIds: ["note"],
        anchorTop: 0,
        anchorBottom: 1,
      },
    ],
    comments: new Map([
      [
        "note",
        {
          id: "note",
          content: "Feedback",
          createdAt: "2026-11-11",
          parentCommentId: "c1",
        },
      ],
    ]),
    blockHighlights: [{ from: 0, to: 1, changeId: "c1", kind: "addition" }],
    canDecide: true,
    disabled: false,
    acceptLabel: "Accept",
    rejectLabel: "Skip",
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onCreateComment: vi.fn(() => "new-note"),
    onUpdateComment: vi.fn(),
    onDeleteComment: vi.fn(),
  };
  const renderReview = (controlledReview: ControlledDocumentReview) => (
    <RichTextEditorSurface
      page={{ id: "test", title: "test", content: "" }}
      activeDocumentPath={null}
      selected={false}
      layout="default"
      focusRequestKey={null}
      sourceMarkdown=""
      onMarkdownChange={onMarkdownChange}
      interactionMode="viewing"
      backend={
        {
          info: { projectPath: "/test" },
          resolveFileUrl: (p: string) => p,
        } as StorageBackend
      }
      controlledReview={controlledReview}
      onEditorReady={onEditorReady}
    />
  );
  await act(async () => {
    root.render(renderReview(review));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const editor = editorRef.current;
  if (!editor) throw new Error("Native editor did not initialize");
  expect(editor.isEditable).toBe(false);
  expect(
    container
      .querySelector('[data-testid="context-menu-wrapper"]')
      ?.getAttribute("data-has-editor"),
  ).toBe("false");
  expect(
    container.querySelector(
      '[data-testid="rich-text-editor"] hr[data-critic-change-id="c1"]',
    ),
  ).not.toBeNull();
  for (const action of ["accept", "reject", "reply", "update", "delete"]) {
    await act(async () =>
      (
        container.querySelector(
          `[data-testid="${action}"]`,
        ) as HTMLButtonElement
      ).click(),
    );
  }
  expect(review.onAccept).toHaveBeenCalledWith("c1");
  expect(review.onReject).toHaveBeenCalledWith("c1");
  expect(review.onCreateComment).toHaveBeenCalledWith("c1", "c1");
  expect(review.onUpdateComment).toHaveBeenCalledWith("note", "updated");
  expect(review.onDeleteComment).toHaveBeenCalledWith("note");
  // Persisting comment content must not replace the document or native editor.
  const originalDoc = editor.state.doc;
  const updatedReview = {
    ...review,
    doc: structuredClone(review.doc),
    disabled: true,
    comments: new Map(review.comments),
  };
  updatedReview.comments.set("note", {
    ...(review.comments.get("note") as NonNullable<
      ReturnType<typeof review.comments.get>
    >),
    content: "Persisted comment",
  });
  await act(async () => root.render(renderReview(updatedReview)));
  expect(editorRef.current).toBe(editor);
  expect(editor.state.doc).toBe(originalDoc);
  vi.mocked(review.onAccept).mockClear();
  vi.mocked(review.onReject).mockClear();
  vi.mocked(review.onCreateComment).mockClear();
  vi.mocked(review.onUpdateComment).mockClear();
  vi.mocked(review.onDeleteComment).mockClear();
  for (const action of ["accept", "reject", "reply", "update", "delete"]) {
    await act(async () =>
      (
        container.querySelector(
          `[data-testid="${action}"]`,
        ) as HTMLButtonElement
      ).click(),
    );
  }
  for (const callback of [
    review.onAccept,
    review.onReject,
    review.onCreateComment,
    review.onUpdateComment,
    review.onDeleteComment,
  ])
    expect(callback).not.toHaveBeenCalled();
  // Resolved image/divider/code blocks retain native comment anchors without
  // retaining a pending change card or change coloring.
  await act(async () => {
    root.render(renderReview({ ...updatedReview, suggestions: [] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(
    container
      .querySelector('[data-testid="rich-text-editor"] hr.comment-anchor')
      ?.getAttribute("data-comment-ids"),
  ).toBe('["note"]');
  expect(
    container.querySelector(
      '[data-testid="rich-text-editor"] hr.critic-change',
    ),
  ).toBeNull();
  expect(
    container
      .querySelector('[data-testid="native-rail"]')
      ?.getAttribute("data-comment-ids"),
  ).toContain("note");
  // Even a programmatic editor update cannot serialize the rendered comparison.
  await act(async () => {
    editor.commands.insertContent("accidental editor change");
  });
  expect(onMarkdownChange).not.toHaveBeenCalled();
});

test.each([
  "detached",
  "suggestion",
])("new replies keep a %s native feedback thread selected", async (mode) => {
  const backend = {
    info: { projectPath: "/test" },
    resolveFileUrl: (path: string) => path,
  } as StorageBackend;
  let review: ControlledDocumentReview = {
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Current file" }],
        },
      ],
    },
    suggestions:
      mode === "suggestion"
        ? [
            {
              changeId: "c1",
              change: {
                changeId: "c1",
                kind: "addition",
                createdAt: "2026-11-11",
                authorType: "ai",
              },
              kind: "addition",
              oldText: "",
              newText: "New wording",
              commentIds: ["note"],
              anchorTop: 0,
              anchorBottom: 1,
            },
          ]
        : [],
    blockHighlights: [],
    comments: new Map([
      [
        "note",
        {
          id: "note",
          content: "Detached feedback",
          createdAt: "2026-11-11",
          parentCommentId: mode === "suggestion" ? "c1" : "old-source-change",
        },
      ],
    ]),
    canDecide: true,
    disabled: false,
    acceptLabel: "Accept",
    rejectLabel: "Skip",
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onUpdateComment: vi.fn(),
    onDeleteComment: vi.fn(),
    onCreateComment: (_changeId, parentCommentId) => {
      const comments = new Map(review.comments);
      comments.set("new-reply", {
        id: "new-reply",
        content: "",
        createdAt: "2026-11-11",
        parentCommentId,
      });
      review = {
        ...review,
        comments,
        suggestions: review.suggestions.map((item) => ({
          ...item,
          commentIds: [...item.commentIds, "new-reply"],
        })),
      };
      root.render(renderReview());
      return "new-reply";
    },
  };
  const renderReview = () => (
    <RichTextEditorSurface
      page={{ id: "detached", title: "Detached feedback", content: "" }}
      activeDocumentPath={null}
      selected={false}
      layout="default"
      focusRequestKey={null}
      sourceMarkdown=""
      onMarkdownChange={vi.fn()}
      interactionMode="viewing"
      backend={backend}
      controlledReview={review}
    />
  );
  await act(async () => {
    root.render(renderReview());
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await act(async () =>
    (
      container.querySelector(
        '[data-testid="reply-comment"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(
    container
      .querySelector('[data-testid="native-rail"]')
      ?.getAttribute("data-selected-comment"),
  ).toBe("new-reply");
  const nativeRail = container.querySelector('[data-testid="native-rail"]');
  if (mode === "suggestion") {
    expect(nativeRail?.getAttribute("data-suggestion-comment-ids")).toContain(
      "new-reply",
    );
    expect(nativeRail?.getAttribute("data-comment-ids")).toBe("");
  } else {
    expect(nativeRail?.getAttribute("data-comment-ids")).toContain("new-reply");
  }
});
