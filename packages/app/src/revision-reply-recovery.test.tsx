import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CommentEditorList } from "./CommentEditorList";
import type { ComparisonReviewData } from "./comparison-types";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";
import {
  RevisionUiDraftContext,
  RevisionUiDraftStore,
} from "./revision-ui-drafts";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let controller: RevisionSessionController | undefined;
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  controller?.stop();
  controller = undefined;
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test.each([
  "unchanged",
  "edited parent",
  "changed quote",
  "reused reply ID",
])("private reply recovery preserves its target: %s", async (scenario) => {
  const parent = {
    id: "c1",
    content: "Saved parent feedback",
    createdAt: "2026-11-26T12:00:00.000Z",
    authorType: "user" as const,
    authorId: "reviewer",
  };
  const reply = {
    id: "c2",
    content: "",
    parentCommentId: parent.id,
    createdAt: "2026-11-26T12:01:00.000Z",
    authorType: "user" as const,
    authorId: "reviewer",
  };
  const originalUi = new RevisionUiDraftStore();
  const onUpdateComment = vi.fn();
  await act(async () =>
    root.render(
      <RevisionUiDraftContext.Provider value={originalUi}>
        <TooltipProvider>
          <CommentEditorList
            comments={[parent, reply]}
            variant="rail"
            newCommentDraftIds={[reply.id]}
            pendingFocusCommentId={reply.id}
            onDeleteComment={() => {}}
            onUpdateComment={onUpdateComment}
          />
        </TooltipProvider>
      </RevisionUiDraftContext.Provider>,
    ),
  );
  const textarea = container.querySelector<HTMLTextAreaElement>(
    `[data-testid="comment-rail-${reply.id}-editor"]`,
  );
  if (!textarea) throw new Error("The private reply editor did not open");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, "Unsubmitted reply content");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onUpdateComment).not.toHaveBeenCalled();
  const captured = originalUi.read();
  expect(originalUi.getSnapshot().comments[reply.id].value).toBe(
    "Unsubmitted reply content",
  );
  const draft: RevisionDraft = {
    markdown: "A {==passage==}{>>Saved parent feedback<<}{#c1}.\n",
    cleanMarkdown: "A passage.\n",
    decisions: {},
    reviewComments: [{ ...parent, changeId: "document" }],
  };
  const activeDraft = structuredClone(draft);
  if (scenario === "edited parent")
    activeDraft.reviewComments[0].content = "Different saved feedback";
  if (scenario === "changed quote")
    activeDraft.markdown = activeDraft.markdown.replace("passage", "new quote");
  if (scenario === "reused reply ID")
    activeDraft.reviewComments.push({
      ...parent,
      id: reply.id,
      changeId: "document",
      content: "Another person's comment",
    });
  const review: ComparisonReviewData = {
    id: "copy-review",
    revision: 1,
    mode: "document",
    editor: "unified",
    title: "Copy",
    beforeLabel: "Original",
    afterLabel: "Working",
    targetPath: null,
    beforeText: draft.markdown,
    afterText: draft.markdown,
    segments: [],
    comment: "",
    status: "open",
    completion: null,
    targetChanged: false,
    autosave: "none",
    draft: activeDraft,
    reviewComments: activeDraft.reviewComments,
    destinationPath: null,
  };
  const restoredUi = new RevisionUiDraftStore();
  const unexpectedRequest = vi.fn(async () => {
    throw new Error(
      "A private feedback restore must not publish a comment or file",
    );
  });
  controller = new RevisionSessionController(review, draft, {
    request: async <T,>(_path: string, body?: object) =>
      body ? ((await unexpectedRequest()) as T) : null,
    storage: memoryStorage(),
    tabStorage: memoryStorage(),
  });
  controller.setAdapter({
    apply: (value) => value,
    adopt: () => null,
    readUiDrafts: restoredUi.read,
    restoreUiDrafts: restoredUi.restore,
  });
  const result = await controller.restoreRecoveryUi({
    entryDraft: draft,
    workingDraft: draft,
    uiDrafts: captured,
  });
  expect(result).toEqual(
    scenario === "unchanged"
      ? { restored: 1, skipped: 0 }
      : { restored: 0, skipped: 1 },
  );
  if (scenario === "unchanged") {
    expect(restoredUi.getSnapshot().comments[reply.id]).toMatchObject({
      value: "Unsubmitted reply content",
      target: reply,
    });
  } else expect(restoredUi.getSnapshot().comments[reply.id]).toBeUndefined();
  expect(controller.readDraft().reviewComments).toEqual(
    activeDraft.reviewComments,
  );
  expect(unexpectedRequest).not.toHaveBeenCalled();
});

test("renumbering a private reply preserves its text and follows its own parent's identity", () => {
  const store = new RevisionUiDraftStore();
  store.setComment("c2", {
    value: "Still private",
    original: "",
    editing: true,
    target: {
      id: "c2",
      content: "",
      parentCommentId: "c1",
      createdAt: "2026-11-26T12:01:00.000Z",
    },
  });
  store.remap({ c1: "c3", c2: "c4" });
  const restored = new RevisionUiDraftStore();
  restored.restore(store.read());
  expect(restored.getSnapshot().comments.c2).toBeUndefined();
  expect(restored.getSnapshot().comments.c4).toMatchObject({
    value: "Still private",
    target: { id: "c4", parentCommentId: "c3" },
  });
});

test("a restored private reply never opens on a foreign saved comment that reused its ID", async () => {
  const captured = new RevisionUiDraftStore();
  captured.setComment("c2", {
    value: "My unsubmitted private reply",
    original: "",
    editing: true,
    target: {
      id: "c2",
      content: "",
      parentCommentId: "c1",
      createdAt: "2026-11-26T12:01:00.000Z",
    },
  });
  const restored = new RevisionUiDraftStore();
  restored.restore(captured.read());
  const onUpdateComment = vi.fn();
  await act(async () =>
    root.render(
      <RevisionUiDraftContext.Provider value={restored}>
        <TooltipProvider>
          <CommentEditorList
            comments={[
              {
                id: "c3",
                content: "Another saved parent",
                createdAt: "2026-11-26T12:02:00.000Z",
              },
              {
                id: "c2",
                content: "Someone else's saved feedback",
                parentCommentId: "c3",
                createdAt: "2026-11-26T12:03:00.000Z",
              },
            ]}
            variant="rail"
            onDeleteComment={() => {}}
            onUpdateComment={onUpdateComment}
          />
        </TooltipProvider>
      </RevisionUiDraftContext.Provider>,
    ),
  );

  expect(
    container.querySelector<HTMLTextAreaElement>(
      '[data-testid="comment-rail-c2-editor"]',
    ),
  ).toBeNull();
  expect(container.textContent).toContain("Someone else's saved feedback");
  expect(container.textContent).not.toContain("My unsubmitted private reply");
  expect(restored.getSnapshot().comments.c2.value).toBe(
    "My unsubmitted private reply",
  );
  expect(onUpdateComment).not.toHaveBeenCalled();
});

test("an incoming reused ID clears only the visible private editor while retaining its recovery text", async () => {
  const privateReply = {
    id: "c2",
    content: "",
    parentCommentId: "c1",
    createdAt: "2026-11-26T12:01:00.000Z",
  };
  const captured = new RevisionUiDraftStore();
  captured.setComment(privateReply.id, {
    value: "My unsubmitted private reply",
    original: "",
    editing: true,
    target: privateReply,
  });
  const restored = new RevisionUiDraftStore();
  restored.restore(captured.read());
  const onUpdateComment = vi.fn();
  const render = (reply: typeof privateReply) =>
    root.render(
      <RevisionUiDraftContext.Provider value={restored}>
        <TooltipProvider>
          <CommentEditorList
            comments={[
              {
                id: "c1",
                content: "Original saved parent",
                createdAt: "2026-11-26T12:00:00.000Z",
              },
              {
                id: "c3",
                content: "Another saved parent",
                createdAt: "2026-11-26T12:02:00.000Z",
              },
              reply,
            ]}
            variant="rail"
            onDeleteComment={() => {}}
            onUpdateComment={onUpdateComment}
          />
        </TooltipProvider>
      </RevisionUiDraftContext.Provider>,
    );
  await act(async () => render(privateReply));
  expect(
    container.querySelector<HTMLTextAreaElement>(
      '[data-testid="comment-rail-c2-editor"]',
    )?.value,
  ).toBe("My unsubmitted private reply");

  await act(async () =>
    render({
      id: "c2",
      content: "Someone else's saved feedback",
      parentCommentId: "c3",
      createdAt: "2026-11-26T12:03:00.000Z",
    }),
  );

  expect(
    container.querySelector<HTMLTextAreaElement>(
      '[data-testid="comment-rail-c2-editor"]',
    ),
  ).toBeNull();
  expect(container.textContent).toContain("Someone else's saved feedback");
  expect(container.textContent).not.toContain("My unsubmitted private reply");
  expect(restored.getSnapshot().comments.c2.value).toBe(
    "My unsubmitted private reply",
  );
  expect(onUpdateComment).not.toHaveBeenCalled();
});
