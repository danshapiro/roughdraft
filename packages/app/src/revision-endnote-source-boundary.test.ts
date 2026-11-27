import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { createEditorExtensions } from "./editor-extensions";
import { parseRemoteRevision } from "./revision-remote-source";
import { RevisionSource } from "./revision-source";

test("an endnote's preserved source excludes the separator consumed by Marked after tokenization", () => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const definition =
    "[^n]: First note paragraph.\n\n    Second note paragraph.\n";
  for (const separators of ["\n", "\n\n"]) {
    const source = `A reference[^n].\n\n${definition}${separators}Following paragraph.\n`;
    const parsed = parseRemoteRevision(source, EditorState.create({ schema }));
    const note = parsed.doc.children.find(
      (node) => node.type.name === "endnoteDefinition",
    );
    expect(note).toBeDefined();
    expect(decodeURIComponent(note?.attrs.source ?? "")).toBe(definition);
    expect(note?.textContent).toBe(
      "First note paragraph.Second note paragraph.",
    );
  }
});
