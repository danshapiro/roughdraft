import { Editor, Extension } from "@tiptap/core";
import { afterEach, expect, test, vi } from "vitest";
import { compositionCommitKey } from "./composition-suggestions";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  createEditorExtensions,
  explicitReviewEdit,
} from "./editor-extensions";
import {
  projectAcceptedDocument,
  suggestionPositions,
} from "./revision-projection";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
import {
  createReviewedChangesPlugin,
  recordReviewedChange,
} from "./revision-history";
import { structuralSuggestionsPlugin } from "./structural-suggestions";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function setup(markdown: string, enabled = () => true, history = false) {
  const parsed = criticMarkdownToEditorState(markdown);
  const onBlocked = vi.fn();
  const onMerged = vi.fn();
  const observed: string[] = [];
  const editor = new Editor({
    extensions: [
      ...createEditorExtensions(""),
      ...(history
        ? [
            Extension.create({
              name: "structuralReviewHistoryTest",
              addGlobalAttributes: () => [
                {
                  types: ["doc"],
                  attributes: {
                    kept: { default: [], rendered: false },
                    reviewed: { default: [], rendered: false },
                  },
                },
              ],
              addProseMirrorPlugins: () => [createReviewedChangesPlugin()],
            }),
          ]
        : []),
    ],
    content: parsed.doc,
    onUpdate: ({ editor: live }) => {
      observed.push(
        editorStateToCriticMarkdown(
          projectAcceptedDocument(live.state.doc).doc.toJSON(),
          new Map(),
        ),
      );
    },
  });
  editors.push(editor);
  editor.registerPlugin(
    structuralSuggestionsPlugin({ enabled, onBlocked, onMerged }),
  );
  return { editor, onBlocked, onMerged, observed, comments: parsed.comments };
}

function resolve(editor: Editor, accept: boolean) {
  for (const id of suggestionPositions(editor.state.doc).keys()) {
    if (accept) editor.commands.acceptCriticChange(id);
    else editor.commands.rejectCriticChange(id);
  }
  return editorStateToCriticMarkdown(editor.getJSON(), new Map());
}

test("native paragraph splitting stays pending, emits only the original save projection, and is one undo event", () => {
  const { editor, onBlocked, observed } = setup("Alpha beta gamma.\n");
  const initial = editor.state.doc;
  editor.commands.setTextSelection(7);
  editor.commands.splitBlock();
  expect(onBlocked).not.toHaveBeenCalled();
  expect(suggestionPositions(editor.state.doc).size).toBe(1);
  expect(observed).toEqual(["Alpha beta gamma.\n"]);
  expect(editor.commands.undo()).toBe(true);
  expect(editor.state.doc.eq(initial)).toBe(true);
  expect(editor.commands.redo()).toBe(true);
  expect(resolve(editor, true)).toBe("Alpha\n\nbeta gamma.\n");
});

test("reverting structural formatting restores exact original content and its comment mark", () => {
  const markdown =
    'Alpha {==beta==}{>>Keep this thread.<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}.\n';
  const { editor, onBlocked, comments } = setup(markdown);
  const initial = editor.state.doc;
  editor.commands.setTextSelection({ from: 7, to: 11 });
  editor.commands.toggleBold();
  expect(onBlocked).not.toHaveBeenCalled();
  expect(suggestionPositions(editor.state.doc).size).toBe(1);
  resolve(editor, false);
  expect(editorStateToCriticMarkdown(editor.getJSON(), comments)).toBe(
    editorStateToCriticMarkdown(initial.toJSON(), comments),
  );
});

test("an empty proposed paragraph survives Markdown reload and Keep leaves no sentinel", () => {
  const { editor, onBlocked } = setup("Alpha.\n");
  editor.commands.setTextSelection(7);
  editor.commands.splitBlock();
  expect(onBlocked).not.toHaveBeenCalled();
  const markdown = editorStateToCriticMarkdown(editor.getJSON(), new Map());
  const reloaded = setup(markdown).editor;
  expect(suggestionPositions(reloaded.state.doc).size).toBe(1);
  expect(resolve(reloaded, true)).not.toContain("\u2060");
  expect(suggestionPositions(reloaded.state.doc).size).toBe(0);
  expect(resolve(editor, true)).not.toContain("\u2060");
  expect(suggestionPositions(editor.state.doc).size).toBe(0);
});

test("a structural edit groups an existing inline suggestion under its original decision ID", () => {
  const { editor, onBlocked, onMerged } = setup(
    'Alpha {~~old~>new~~}{id="s7" by="AI" at="2026-01-01T00:00:00.000Z"} omega.\n',
  );
  editor.commands.setTextSelection({ from: 1, to: 6 });
  editor.commands.toggleBold();
  expect(onBlocked).not.toHaveBeenCalled();
  expect([...suggestionPositions(editor.state.doc).keys()]).toEqual(["s7"]);
  expect(onMerged).toHaveBeenCalledWith(["s7"], "s7");
  expect(resolve(editor, true)).toBe("**Alpha** new omega.\n");
});

test("programmatic explicit review transactions are never made into proposals", () => {
  const { editor } = setup("Alpha.\n");
  editor.view.dispatch(
    editor.state.tr.insertText("Direct ", 1).setMeta(explicitReviewEdit, true),
  );
  expect(suggestionPositions(editor.state.doc).size).toBe(0);
  expect(editor.getText()).toBe("Direct Alpha.");
});

test("silent setContent hydration does not turn server content into a suggestion", () => {
  const { editor, onBlocked } = setup("Alpha.\n");
  editor.commands.setContent("<p>Loaded content.</p>", { emitUpdate: false });
  expect(suggestionPositions(editor.state.doc).size).toBe(0);
  expect(editor.getText()).toBe("Loaded content.");
  expect(onBlocked).not.toHaveBeenCalled();
});

test("a metadata-only composition commit uses the snapshot before native composition", () => {
  let composing = true;
  const { editor, onBlocked } = setup("Alpha.\n", () => !composing);
  editor.commands.setTextSelection(7);
  const before = editor.state;
  editor.commands.insertContent("你");
  composing = false;
  editor.view.dispatch(
    editor.state.tr.setMeta(compositionCommitKey, { before }),
  );
  expect(onBlocked).not.toHaveBeenCalled();
  expect(projectAcceptedDocument(editor.state.doc).doc.textContent).toBe(
    "Alpha.",
  );
  expect(resolve(editor, true)).toBe("Alpha.你\n");
});

test("paragraph suggestions still work after keeping an earlier change", () => {
  const { editor, onBlocked, observed } = setup(
    'Alpha {++new++}{id="s1" by="user" at="2026-01-01T00:00:00.000Z"} beta.\n',
    () => true,
    true,
  );
  const initial = editor.state.doc;
  const decision = editor.state.tr;
  applySuggestionDecisions(decision, ["s1"], "accept");
  editor.view.dispatch(
    recordReviewedChange(
      decision,
      { decision: "accept", oldText: "", newText: "new" },
      suggestionDetail(initial, "s1"),
    ).setMeta(explicitReviewEdit, true),
  );
  const accepted = projectAcceptedDocument(editor.state.doc).doc;
  const reviewed = editor.state.doc.attrs.reviewed;
  expect(reviewed).toHaveLength(1);
  observed.length = 0;
  editor.commands.setTextSelection(7);
  editor.commands.splitBlock();
  expect(onBlocked).not.toHaveBeenCalled();
  expect(suggestionPositions(editor.state.doc).size).toBe(1);
  expect([...suggestionPositions(editor.state.doc).keys()]).not.toContain("s1");
  expect(
    projectAcceptedDocument(editor.state.doc).doc.content.eq(accepted.content),
  ).toBe(true);
  expect(observed).toEqual(["Alpha new beta.\n"]);
  expect(editor.state.doc.attrs.reviewed).toHaveLength(1);
  expect(editor.commands.undo()).toBe(true);
  expect(editor.state.doc.attrs.reviewed).toEqual(reviewed);
  expect(editor.commands.redo()).toBe(true);
  expect(resolve(editor, true)).toBe("Alpha\n\nnew beta.\n");
});
