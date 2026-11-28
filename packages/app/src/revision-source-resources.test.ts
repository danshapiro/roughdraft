import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { Marked, marked } from "marked";
import { afterEach, expect, test, vi } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { endnoteExtension } from "./endnotes";
import { editableMarkdownOptions } from "./revision-markdown";
import { parseRemoteRevision } from "./revision-remote-source";
import { sameSourceContent } from "./revision-source";
import { RevisionSpellingProof } from "./revision-spelling-proof";

afterEach(() => vi.restoreAllMocks());
const schema = getSchema(createEditorExtensions(""));

test.each([
  "\n",
  "\r\n",
])("endnote hints search candidates without rescanning plain suffixes (%j)", (newline) => {
  const markdown = [
    ...Array.from(
      { length: 100 },
      (_, index) => `Reading paragraph ${index}. Ordinary prose.`,
    ).flatMap((paragraph) => [paragraph, ""]),
    "Inline [^missing]: is not a definition.",
    "",
    "    [^code]: is indented code.",
    "",
    "Read[^café].",
    "",
    "   [^café]: A real note.",
    "",
  ].join(newline);
  let searchedCharacters = 0;
  const search = String.prototype.search;
  const spy = vi.spyOn(String.prototype, "search").mockImplementation(function (
    this: string,
    pattern,
  ) {
    searchedCharacters += this.length;
    return search.call(this, pattern);
  });
  const lexer = new Marked(endnoteExtension());
  const tokens = lexer.lexer(markdown);
  spy.mockRestore();
  const definitions = tokens.filter(
    (token) => token.type === "endnoteDefinition",
  );
  expect(definitions).toHaveLength(1);
  expect(definitions[0]).toMatchObject({ label: "café" });
  expect(tokens.some((token) => token.type === "code")).toBe(true);
  expect(
    searchedCharacters,
    "ordinary paragraphs should not each trigger a regex search through all remaining prose",
  ).toBeLessThanOrEqual(markdown.length * 2);
});

test.each([
  "\n",
  "\r\n",
])("source layout skips plain runs while preserving multiline feedback and literals (%j)", (newline) => {
  const markdown = [
    ...Array.from(
      { length: 100 },
      (_, index) => `Resource paragraph ${index}. Ordinary prose.`,
    ).flatMap((paragraph) => [paragraph, ""]),
    "A {~~first paragraph.",
    "",
    "Second paragraph.~>replacement paragraph.",
    "",
    'Replacement ending.~~}{id="s1" by="AI" at="2026-11-22T12:00:00.000Z"}',
    "",
    "Escaped \\{++literal++\\} and `{++inline literal++}`.",
    "",
    "~~~markdown",
    "{++fenced literal++}",
    "~~~",
    "",
  ].join(newline);
  const expected = criticMarkdownToEditorState(
    markdown,
    editableMarkdownOptions,
  );
  let delimiterSlices = 0;
  const slice = String.prototype.slice;
  const spy = vi.spyOn(String.prototype, "slice").mockImplementation(function (
    this: string,
    start,
    end,
  ) {
    if (this === markdown && end === (start ?? 0) + 3) delimiterSlices++;
    return slice.call(this, start, end);
  });
  const actual = parseRemoteRevision(markdown, EditorState.create({ schema }));
  spy.mockRestore();
  expect(sameSourceContent(actual.doc, schema.nodeFromJSON(expected.doc))).toBe(
    true,
  );
  expect(actual.comments).toEqual(expected.comments);
  expect(
    delimiterSlices,
    "ordinary prose should bypass repeated review-delimiter inspection",
  ).toBeLessThan(50);
});

test("literal-code proofs visit nested tokens without accumulating unused return values", () => {
  const markdown = [
    "# Literal proof",
    "",
    "| Value |",
    "| --- |",
    "| `two  spaces` |",
    "",
    "- Nested `list  literal`.",
    "",
    "  ```text",
    "  fenced  literal",
    "  ```",
    "",
    ...Array.from({ length: 100 }, (_, index) => `Plain paragraph ${index}.\n`),
  ].join("\n");
  const state = EditorState.create({
    doc: parseRemoteRevision(markdown, EditorState.create({ schema })).doc,
  });
  const walk = vi.spyOn(marked, "walkTokens");
  expect(
    new RevisionSpellingProof().matchesFile(
      markdown,
      markdown,
      state.doc,
      state,
    ),
  ).toBe(true);
  const values = walk.mock.results
    .filter((_, index) => walk.mock.calls[index][0].length > 100)
    .map((result) => result.value);
  expect(values).toHaveLength(2);
  expect(values.every((value) => Array.isArray(value) && !value.length)).toBe(
    true,
  );
  for (const literal of ["two  spaces", "list  literal", "fenced  literal"])
    expect(
      new RevisionSpellingProof().matchesFile(
        markdown,
        markdown.replace(literal, literal.replace("  ", " ")),
        state.doc,
        state,
      ),
    ).toBe(false);
});
