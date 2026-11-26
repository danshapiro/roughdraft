import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { editableMarkdownOptions } from "./revision-markdown";
import { parseRemoteRevision } from "./revision-remote-source";
import { RevisionSource, sameSourceContent } from "./revision-source";

test("large unchanged sections retain the complete review and global Markdown context", () => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const footer = fixture.lastIndexOf("\n---\n");
  const paragraphs = Array.from(
    { length: 750 },
    (_, index) =>
      `Unchanged section ${index}. Global comments, proposals, links and endnotes must keep their meaning while these ordinary paragraphs are parsed.`,
  ).join("\n\n");
  const markdown = `${fixture.slice(0, footer)}\n\n${paragraphs}\n${fixture.slice(footer)}`;
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const expected = criticMarkdownToEditorState(
    markdown,
    editableMarkdownOptions,
  );
  const state = EditorState.create({ schema });
  const began = performance.now();
  const actual = parseRemoteRevision(markdown, state);
  console.info(
    JSON.stringify({
      severity: "info",
      event: "large-review-first-parse",
      bytes: markdown.length,
      durationMs: performance.now() - began,
    }),
  );
  expect(sameSourceContent(actual.doc, schema.nodeFromJSON(expected.doc))).toBe(
    true,
  );
  expect(actual.frontmatter).toBe(expected.frontmatter);
  expect(actual.endmatter).toBe(expected.endmatter);
  expect(actual.comments).toEqual(expected.comments);
}, 15_000);

test.each([
  '# Context\n\n---\n\nUnchanged before.\n\nA {++proposal++}{#s1}.\n\nUnchanged after.\n\n---\nsuggestions:\n  s1:\n    by: AI\n    at: "2026-11-22T12:00:00.000Z"\n',
  'Unchanged before.\n\nAn {==anchor==}{>>A comment<<}{#c1}.\n\nUnchanged after.\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-11-22T12:00:00.000Z"\n',
])("review metadata stays outside ordinary blocks and thematic breaks", (markdown) => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const expected = criticMarkdownToEditorState(
    markdown,
    editableMarkdownOptions,
  );
  const actual = parseRemoteRevision(markdown, EditorState.create({ schema }));
  expect(sameSourceContent(actual.doc, schema.nodeFromJSON(expected.doc))).toBe(
    true,
  );
  expect(actual.comments).toEqual(expected.comments);
});
