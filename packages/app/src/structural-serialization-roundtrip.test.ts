import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, expect, test } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import {
  projectAcceptedDocument,
  suggestionPositions,
} from "./revision-projection";
import { structuralSuggestionsPlugin } from "./structural-suggestions";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});
function editorFor(markdown: string | JSONContent) {
  const editor = new Editor({
    extensions: createEditorExtensions(""),
    content:
      typeof markdown === "string"
        ? criticMarkdownToEditorState(markdown).doc
        : markdown,
  });
  editors.push(editor);
  return editor;
}
function cleanOriginal(editor: Editor) {
  return editorStateToCriticMarkdown(
    projectAcceptedDocument(editor.state.doc).doc.toJSON(),
    new Map(),
  );
}
function keep(editor: Editor) {
  for (const id of suggestionPositions(editor.state.doc).keys())
    editor.commands.acceptCriticChange(id);
  return editorStateToCriticMarkdown(editor.getJSON(), new Map());
}

for (const markdown of [
  "> A quoted line.\n\nTail.\n",
  "- A single item.\n\nTail.\n",
  "1. A single item.\n\nTail.\n",
  "# A heading.\n\nTail.\n",
  "A plain paragraph.\n\nTail.\n",
]) {
  test(`a one-line block proposal retains Original and Final after refresh: ${markdown}`, () => {
    const editor = editorFor(markdown);
    const original = cleanOriginal(editor);
    editor.registerPlugin(
      structuralSuggestionsPlugin({
        enabled: () => true,
        onBlocked: () => {
          throw new Error("Unexpected blocked formatting");
        },
        onMerged: () => {},
      }),
    );
    let first = 0;
    editor.state.doc.descendants((node, pos) => {
      if (!first && node.isText) first = pos;
    });
    editor.commands.setTextSelection({ from: first, to: first + 3 });
    editor.commands.toggleBold();
    expect(suggestionPositions(editor.state.doc).size).toBe(1);
    const serialized = editorStateToCriticMarkdown(editor.getJSON(), new Map());
    expect(cleanRevisionSourceMarkdown(serialized)).toBe(original);
    const reloaded = editorFor(serialized);
    expect(cleanOriginal(reloaded)).toBe(original);
    expect(keep(reloaded)).toBe(keep(editor));
  });
}

for (const kind of ["addition", "deletion"] as const) {
  test(`one-line block ${kind} preserves heading shape after reload`, () => {
    const content = criticMarkdownToEditorState("## Proposed heading\n").doc
      .content;
    const change = {
      kind,
      changeId: "s1",
      authorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "criticChangeBlock", attrs: { change }, content },
        ...(criticMarkdownToEditorState("Tail.\n").doc.content ?? []),
      ],
    };
    const editor = editorFor(doc);
    const original = cleanOriginal(editor);
    const serialized = editorStateToCriticMarkdown(editor.getJSON(), new Map());
    expect(cleanRevisionSourceMarkdown(serialized)).toBe(original);
    const reloaded = editorFor(serialized);
    expect(cleanOriginal(reloaded)).toBe(original);
    expect(keep(reloaded)).toBe(keep(editor));
  });
}

for (const suggesting of [false, true]) {
  test(`intraword italic formatting survives Markdown reload in ${suggesting ? "Suggest" : "Edit"}`, () => {
    const editor = editorFor("Alpha beta.\n");
    if (suggesting)
      editor.registerPlugin(
        structuralSuggestionsPlugin({
          enabled: () => true,
          onBlocked: () => {
            throw new Error("Unexpected blocked formatting");
          },
          onMerged: () => {},
        }),
      );
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.commands.toggleItalic();
    const reloaded = editorFor(
      editorStateToCriticMarkdown(editor.getJSON(), new Map()),
    );
    if (suggesting) expect(cleanOriginal(reloaded)).toBe("Alpha beta.\n");
    keep(editor);
    keep(reloaded);
    expect(reloaded.getJSON().content).toEqual(editor.getJSON().content);
    expect(reloaded.getJSON().content?.[0].content?.[0]).toMatchObject({
      text: "Alph",
      marks: expect.arrayContaining([
        expect.objectContaining({ type: "italic" }),
      ]),
    });
  });
}

const literalMarkers = "{~~old~>new~~} {++added++} {--deleted--}";
for (const before of [
  `Use \`${literalMarkers}\` exactly.`,
  `\`\`\`md\n${literalMarkers}\n\`\`\``,
  `~~~~md\n${literalMarkers}\n~~~\n~~~~`,
  `> \`\`\`md\n> ${literalMarkers}\n> \`\`\``,
  `- \`\`\`md\n  ${literalMarkers}\n  \`\`\``,
]) {
  for (const kind of ["addition", "deletion", "substitution"] as const) {
    test(`a block ${kind} preserves literal review delimiters in code: ${JSON.stringify(before)}`, () => {
      const after = before.replace("old", "older");
      const side = (markdown: string, sideKind: string): JSONContent => ({
        type: "criticChangeBlock",
        attrs: {
          change: {
            kind: sideKind,
            changeId: "s1",
            authorType: "user",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
        content: criticMarkdownToEditorState(markdown).doc.content,
      });
      const blocks =
        kind === "substitution"
          ? [side(before, "substitution-old"), side(after, "substitution-new")]
          : [side(before, kind)];
      const tail = criticMarkdownToEditorState("Tail.\n").doc.content ?? [];
      const doc: JSONContent = { type: "doc", content: [...blocks, ...tail] };
      const live = editorFor(doc);
      const original = cleanOriginal(live);
      const serialized = editorStateToCriticMarkdown(live.getJSON(), new Map());
      const reloaded = editorFor(serialized);
      expect(cleanOriginal(reloaded)).toBe(original);
      expect(cleanRevisionSourceMarkdown(serialized)).toBe(original);
      expect(keep(reloaded)).toBe(keep(live));
    });
  }
}
