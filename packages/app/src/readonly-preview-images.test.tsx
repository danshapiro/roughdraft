import { type Editor, getSchema } from "@tiptap/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiBackend } from "./api-backend";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { RichTextEditorSurface } from "./PageCard";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import { outcomeDocument } from "./revision-outcomes";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let baseElement: HTMLBaseElement;
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
  baseElement = document.createElement("base");
  baseElement.href = "/roughdraft/testindividual/signed-review/";
  document.head.append(baseElement);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  baseElement.remove();
  vi.unstubAllGlobals();
});

test.each([
  ["Original", "reject", "Old wording"],
  ["Final", "accept", "New wording"],
] as const)("%s resolves a sibling image through the source backend without modifying its readonly document or export", async (_view, decision, wording) => {
  const markdown =
    "# Release review\n\n![Test image](./pixel.svg)\n\n{~~Old wording~>New wording~~}{#s1}.\n";
  const parsed = criticMarkdownToEditorState(markdown);
  const schema = getSchema(createEditorExtensions(""));
  const live = schema.nodeFromJSON(parsed.doc);
  const liveBefore = live.toJSON();
  const cleanBefore = cleanRevisionSourceMarkdown(markdown);
  const outcome = outcomeDocument(live, null, "new", decision);
  const outcomeBefore = outcome.toJSON();
  const exportBefore = editorStateToCriticMarkdown(outcomeBefore, new Map());
  const projectPath = "/documents/glowfer-testindividual/release review";
  const backend = new ApiBackend({
    kind: "local-files",
    label: "Files",
    detail: `${projectPath}/Draft.md`,
    projectPath,
  });
  const changed = vi.fn();
  let editor: Editor | null = null;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RichTextEditorSurface
          page={{
            id: `preview-${decision}`,
            title: "Release review",
            content: markdown,
          }}
          activeDocumentPath="Draft.md"
          selected
          layout="default"
          focusRequestKey={null}
          sourceMarkdown={exportBefore}
          onMarkdownChange={changed}
          interactionMode="viewing"
          backend={backend}
          onEditorReady={(value) => {
            editor = value;
          }}
          controlledReview={{
            doc: outcomeBefore,
            suggestions: [],
            comments: new Map(),
            blockHighlights: [],
            canDecide: false,
            disabled: true,
            acceptLabel: "Keep",
            rejectLabel: "Revert",
            onAccept: () => {},
            onReject: () => {},
            onCreateComment: () => null,
            onUpdateComment: () => {},
            onDeleteComment: () => {},
          }}
        />
      </TooltipProvider>,
    ),
  );
  if (!editor) throw new Error("Expected the real readonly preview editor");
  const previewEditor = editor as Editor;
  expect(previewEditor.isEditable).toBe(false);
  expect(container.textContent).toContain(wording);
  const image = container.querySelector<HTMLImageElement>(
    'img[alt="Test image"]',
  ); // selector-check-ignore: rendered source image is the behavior under test.
  expect(image).not.toBeNull();
  expect(image?.getAttribute("src")).toBe(
    backend.resolveFileUrl("./pixel.svg"),
  );
  const url = new URL(image?.getAttribute("src") ?? "", window.location.origin);
  expect(url.pathname).toBe(
    "/roughdraft/testindividual/signed-review/api/files",
  );
  expect(url.searchParams.get("projectPath")).toBe(projectPath);
  expect(url.searchParams.get("path")).toBe("pixel.svg");
  expect(previewEditor.state.doc.toJSON()).toEqual(outcomeBefore);
  expect(
    editorStateToCriticMarkdown(previewEditor.state.doc.toJSON(), new Map()),
  ).toBe(exportBefore);
  expect(exportBefore).toContain("![Test image](./pixel.svg)");
  expect(live.toJSON()).toEqual(liveBefore);
  expect(cleanRevisionSourceMarkdown(markdown)).toBe(cleanBefore);
  expect(changed).not.toHaveBeenCalled();
});
