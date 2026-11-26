import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CommentEditorList } from "./CommentEditorList";
import { TooltipProvider } from "./components/ui/tooltip";
import type { CriticComment } from "./critic-markup";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("detached feedback displays its original quote and the reason it moved", async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CommentEditorList
          comments={[
            {
              id: "c1",
              content: "Preserved comment",
              createdAt: "2026-01-01",
              scope: "document",
              originalQuote: "The former passage",
              detachedReason: "The file changed across this comment.",
            },
          ]}
          readOnly
          onDeleteComment={() => {}}
          onUpdateComment={() => {}}
        />
      </TooltipProvider>,
    ),
  );
  expect(
    container.querySelector('[data-testid="comment-banner-c1-original-quote"]')
      ?.textContent,
  ).toBe("The former passage");
  expect(container.textContent).toContain(
    "The file changed across this comment.",
  );
  expect(container.textContent).toContain("Preserved comment");
});

test("collapsed native previews retain reply actions while read-only reviews hide mutations", async () => {
  const onReply = vi.fn();
  const renderList = (readOnly: boolean) => (
    <TooltipProvider>
      <CommentEditorList
        comments={[
          { id: "c1", content: "Needs detail", createdAt: "2026-11-11" },
        ]}
        variant="rail"
        interactive={false}
        readOnly={readOnly}
        onDeleteComment={vi.fn()}
        onUpdateComment={vi.fn()}
        onReplyComment={onReply}
      />
    </TooltipProvider>
  );
  await act(async () => root.render(renderList(false)));
  const reply = container.querySelector(
    '[data-testid="comment-rail-c1-action-reply"]',
  );
  expect(reply).not.toBeNull();
  await act(async () => (reply as HTMLButtonElement).click());
  expect(onReply).toHaveBeenCalledWith("c1");

  await act(async () => root.render(renderList(true)));
  expect(
    container.querySelector('[data-testid="comment-rail-c1-action-reply"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="comment-rail-c1-action-edit"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="comment-rail-c1-action-delete"]'),
  ).toBeNull();
});

test("autosaved comment drafts reach the review before Save and Cancel restores the original", async () => {
  const onUpdate = vi.fn();
  function Review() {
    const [comments, setComments] = useState<CriticComment[]>([
      { id: "c1", content: "Original feedback", createdAt: "2026-11-21" },
    ]);
    return (
      <TooltipProvider>
        <CommentEditorList
          comments={comments}
          variant="rail"
          autosave
          onDeleteComment={vi.fn()}
          onUpdateComment={(id, content) => {
            onUpdate(id, content);
            setComments((current) =>
              current.map((comment) =>
                comment.id === id ? { ...comment, content } : comment,
              ),
            );
          }}
        />
      </TooltipProvider>
    );
  }
  await act(async () => root.render(<Review />));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="comment-rail-c1-action-edit"]',
      )
      ?.click(),
  );
  const editor = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="comment-rail-c1-editor"]',
  );
  if (!editor) throw new Error("The comment editor did not open");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(editor, "Feedback still being typed");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onUpdate).toHaveBeenLastCalledWith("c1", "Feedback still being typed");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="comment-rail-c1-action-cancel"]',
      )
      ?.click(),
  );
  expect(onUpdate).toHaveBeenLastCalledWith("c1", "Original feedback");
  expect(container.textContent).toContain("Original feedback");
  expect(
    container.querySelector<HTMLTextAreaElement>(
      '[data-testid="comment-rail-c1-editor"]',
    ),
  ).toBeNull();
});

test("a comment editor keeps typing private until Save and Cancel leaves the saved feedback untouched", async () => {
  const onUpdate = vi.fn();
  const render = () => (
    <TooltipProvider>
      <CommentEditorList
        comments={[
          { id: "c1", content: "Original feedback", createdAt: "2026-01-01" },
        ]}
        variant="rail"
        onDeleteComment={() => {}}
        onUpdateComment={onUpdate}
      />
    </TooltipProvider>
  );
  await act(async () => root.render(render()));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="comment-rail-c1-action-edit"]',
      )
      ?.click(),
  );
  const input = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="comment-rail-c1-editor"]',
  );
  if (!input) throw new Error("Expected the comment editor");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, "Unfinished text");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onUpdate).not.toHaveBeenCalled();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="comment-rail-c1-action-cancel"]',
      )
      ?.click(),
  );
  expect(onUpdate).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Original feedback");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="comment-rail-c1-action-edit"]',
      )
      ?.click(),
  );
  const again = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="comment-rail-c1-editor"]',
  );
  if (!again) throw new Error("Expected the reopened comment editor");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(again, "Saved text");
    again.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="comment-rail-c1-action-save"]',
      )
      ?.click(),
  );
  expect(onUpdate).toHaveBeenCalledExactlyOnceWith("c1", "Saved text");
});
