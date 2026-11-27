import { getSchema } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { editableMarkdownOptions } from "./revision-markdown";
import { parseRemoteRevision } from "./revision-remote-source";
import { RevisionSource } from "./revision-source";

function parser() {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  let state = EditorState.create({ schema });
  return (markdown: string) => {
    const parsed = parseRemoteRevision(markdown, state);
    const expected = criticMarkdownToEditorState(
      markdown,
      editableMarkdownOptions,
    );
    const expectedDoc = schema.nodeFromJSON(expected.doc);
    expect(parsed.doc.content.toJSON()).toEqual(expectedDoc.content.toJSON());
    state = EditorState.create({ schema, doc: parsed.doc });
    return parsed.doc;
  };
}
function links(doc: Node) {
  const values: Array<{ href: string; title: string | null }> = [];
  doc.descendants((node) => {
    for (const mark of node.marks)
      if (mark.type.name === "link")
        values.push({ href: mark.attrs.href, title: mark.attrs.title ?? null });
  });
  return values;
}
function notes(doc: Node) {
  const references: string[] = [];
  const definitions: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "endnoteReference")
      references.push(String(node.attrs.label));
    if (node.type.name === "endnoteDefinition")
      definitions.push(node.textContent);
  });
  return { references, definitions };
}

test("a warmed remote block cache updates unchanged reference text when only its destination and title change", () => {
  const parse = parser();
  const body = "Unchanged introduction.\n\nRead [the guide][guide].\n\n";
  const original = `${body}[guide]: ./original.md "Original guide"\n`;
  const updated = `${body}[guide]: ./updated.md "Updated guide"\n`;
  expect(links(parse(original))).toEqual([
    { href: "./original.md", title: "Original guide" },
  ]);
  expect(links(parse(updated))).toEqual([
    { href: "./updated.md", title: "Updated guide" },
  ]);
  expect(links(parse(original))).toEqual([
    { href: "./original.md", title: "Original guide" },
  ]);
});

test("a warmed remote block cache resolves and unresolves unchanged footnote references when only a definition is added or removed", () => {
  const parse = parser();
  const body =
    "Unchanged introduction.\n\nA note[^evidence] and the same note[^evidence].\n";
  expect(notes(parse(body))).toEqual({ references: [], definitions: [] });
  const defined = `${body}\n[^evidence]: The **supporting** evidence.\n`;
  expect(notes(parse(defined))).toEqual({
    references: ["evidence", "evidence"],
    definitions: ["The supporting evidence."],
  });
  const updated = defined.replace("supporting", "updated");
  expect(notes(parse(updated))).toEqual({
    references: ["evidence", "evidence"],
    definitions: ["The updated evidence."],
  });
  expect(notes(parse(body))).toEqual({ references: [], definitions: [] });
});
