import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CommentEditorList } from "./CommentEditorList";
import { TooltipProvider } from "./components/ui/tooltip";

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
