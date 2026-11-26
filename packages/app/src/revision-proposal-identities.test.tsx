import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiBackend } from "./api-backend";
import { TooltipProvider } from "./components/ui/tooltip";
import { explicitReviewEdit } from "./editor-extensions";
import { RichTextEditorSurface } from "./PageCard";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
import {
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import { suggestionPositions } from "./revision-projection";

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
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

test("new native typing cannot reuse an ID kept only in an earlier History inverse", async () => {
  const markdown = "First {++archived++}{#s1}.\n\nSecond paragraph.\n";
  let editor: Editor | null = null;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RichTextEditorSurface
          page={{
            id: "inverse-identities",
            title: "History identities",
            content: markdown,
          }}
          activeDocumentPath="practice.md"
          selected
          layout="default"
          focusRequestKey={null}
          sourceMarkdown={markdown}
          onMarkdownChange={() => {}}
          interactionMode="suggesting"
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
          }}
        />
      </TooltipProvider>,
    ),
  );
  if (!editor) throw new Error("Expected the real native editor");
  const live = editor as Editor;
  await act(async () => {
    const detail = suggestionDetail(live.state.doc, "s1");
    const transaction = live.state.tr;
    applySuggestionDecisions(transaction, ["s1"], "accept");
    live.view.dispatch(
      recordReviewedChange(
        transaction,
        {
          decision: "accept",
          oldText: detail.oldText,
          newText: detail.newText,
          keptIds: ["s1"],
        },
        detail,
      ).setMeta(explicitReviewEdit, true),
    );
  });
  const history = reviewedChanges(live.state.doc);
  expect(history).toHaveLength(1);
  expect(suggestionPositions(live.state.doc).size).toBe(0);
  await act(async () => {
    const at = live.state.doc.content.size - 1;
    live.commands.setTextSelection(at);
    const input = live.view.someProp("handleTextInput", (handler) =>
      handler(live.view, at, at, "new", () =>
        live.state.tr.insertText("new", at),
      ),
    );
    expect(input).toBe(true);
  });
  const [newId] = [...suggestionPositions(live.state.doc).keys()];
  expect(newId).toBeTruthy();
  expect(newId).not.toBe("s1");
  await act(async () => {
    const reopen = reopenReviewedChange(live.state, history[0].id);
    if (!reopen) throw new Error("The earlier decision must remain reopenable");
    live.view.dispatch(reopen);
    live.commands.rejectCriticChange(newId);
  });
  expect([...suggestionPositions(live.state.doc).keys()]).toEqual(["s1"]);
  expect(live.state.doc.lastChild?.textContent).toBe("Second paragraph.");
});
