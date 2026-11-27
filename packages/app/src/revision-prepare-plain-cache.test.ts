import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { expect, test, vi } from "vitest";
import {
  criticMarkdownBodyToEditorState,
  criticMarkdownToEditorState,
  createCriticChange,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { cleanRevisionNode } from "./revision-clean-cache";
import {
  cleanRevisionSourceMarkdown,
  editableMarkdownOptions,
} from "./revision-markdown";
import { prepareRevisionDraft } from "./revision-prepare";
import { parseRemoteRevision } from "./revision-remote-source";
import { RevisionSource, sameSourceContent } from "./revision-source";

vi.mock("./critic-markup", { spy: true });

test.each([
  "plain",
  "buffered typing",
  "private anchor",
  "pending suggestion",
] as const)("a cold candidate reuses unchanged plain blocks without importing %s live state", (mode) => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const endmatter = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 750 },
    (_, index) =>
      `Unchanged section ${index + 1}. This paragraph supplies reading distance while independent reviewers retain exact source and private feedback.`,
  ).join("\n\n");
  const markdown = `${fixture.slice(0, endmatter)}\n\n${padding}\n\nOwner A: unchanged.\n\nOwner B: unchanged.\n${fixture.slice(endmatter)}`;
  expect(Buffer.byteLength(markdown)).toBeGreaterThan(100 * 1024);
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  const doc = schema.nodeFromJSON({
    ...parsed.doc,
    attrs: {
      sourceMetadata: {
        markdown,
        frontmatter: parsed.frontmatter,
        endmatter: parsed.endmatter,
      },
    },
  });
  let live = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 2),
  });
  let target = -1;
  live.doc.descendants((node, position) => {
    if (
      node.isText &&
      node.text ===
        (["private anchor", "pending suggestion"].includes(mode)
          ? "Unchanged section 1. This paragraph supplies reading distance while independent reviewers retain exact source and private feedback."
          : "Owner A: unchanged.")
    )
      target = position;
  });
  expect(target).toBeGreaterThan(0);
  if (mode === "buffered typing")
    live = live.apply(live.tr.insertText("Unsent private typing ", target));
  if (mode === "private anchor")
    live = live.apply(
      live.tr.addMark(
        target,
        target + 9,
        schema.marks.commentRef.create({ commentIds: ["c-private"] }),
      ),
    );
  if (mode === "pending suggestion")
    live = live.apply(
      live.tr.addMark(
        target,
        target + 9,
        schema.marks.criticChange.create(
          createCriticChange("addition", { changeId: "s-private" }),
        ),
      ),
    );
  // The initialized editor has projected its live blocks, but its source parser
  // need not have seen the candidate's cold framing/context cache keys yet.
  cleanRevisionNode(live.doc);
  const liveBefore = live.doc.toJSON();
  const selectionBefore = live.selection.toJSON();
  const candidate = {
    markdown: markdown.replace(
      "Owner B: unchanged.",
      "Owner B: incoming edit 🦋.",
    ),
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: "document",
    })),
  };
  vi.mocked(criticMarkdownBodyToEditorState).mockClear();
  const began = performance.now();
  const prepared = prepareRevisionDraft(candidate, live);
  const durationMs = performance.now() - began;
  const plainParsedCharacters = vi
    .mocked(criticMarkdownBodyToEditorState)
    .mock.calls.filter(([body]) => body.startsWith("Unchanged section "))
    .reduce((total, [body]) => total + body.length, 0);
  console.info(
    JSON.stringify({
      severity: "info",
      event: "prepare-cold-plain-blocks",
      mode,
      durationMs,
      plainParsedCharacters,
    }),
  );
  expect(plainParsedCharacters).toBeLessThan(512);
  expect(prepared?.cleanMarkdown).toBe(
    cleanRevisionSourceMarkdown(candidate.markdown),
  );
  expect(prepared?.cleanMarkdown).not.toContain("Unsent private typing");
  expect(prepared?.markdown).toBe(candidate.markdown);
  expect(prepared?.reviewComments).toEqual(candidate.reviewComments);
  const projected = parseRemoteRevision(candidate.markdown, live);
  const authoritative = schema.nodeFromJSON(
    criticMarkdownToEditorState(candidate.markdown, editableMarkdownOptions)
      .doc,
  );
  expect(sameSourceContent(projected.doc, authoritative)).toBe(true);
  expect(JSON.stringify(projected.doc.toJSON())).not.toContain("c-private");
  expect(JSON.stringify(projected.doc.toJSON())).not.toContain("s-private");
  expect(live.doc.toJSON()).toEqual(liveBefore);
  expect(live.selection.toJSON()).toEqual(selectionBefore);
}, 15_000);

test.each([
  "Visit www.example.com",
  "A [linked word][ref].",
  "An endnote[^note].",
  "An &amp; entity.",
  "<b>HTML</b>",
  "A **bold** word.",
  "A `code` word.",
  "a | b",
  "# Heading",
  "- List item",
  "1. Numbered item",
  "Setext heading\n---",
  "Two  spaces.",
  "Hard break  \nnext line.",
])("native literal syntax is parsed rather than trusted as plain source: %j", (text) => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const live = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(null, schema.text(text)),
    ),
  });
  const markdown = `${text}\n\n[ref]: ./guide.md\n\n[^note]: Endnote text.\n`;
  const parsed = parseRemoteRevision(markdown, live);
  const expected = schema.nodeFromJSON(
    criticMarkdownToEditorState(markdown, editableMarkdownOptions).doc,
  );
  expect(sameSourceContent(parsed.doc, expected)).toBe(true);
});

test("plain-block reuse preserves exact CRLF source and Unicode while projecting a separate incoming edit", () => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const markdown = "Café stays exact.\r\n\r\nPeer paragraph.\r\n";
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  const live = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(parsed.doc),
  });
  const candidate = {
    markdown: markdown.replace("Peer paragraph.", "Peer paragraph changed. 🦋"),
    decisions: {},
    reviewComments: [],
  };
  const prepared = prepareRevisionDraft(candidate, live);
  expect(prepared?.markdown).toBe(candidate.markdown);
  expect(prepared?.cleanMarkdown).toBe(candidate.markdown);
  expect(live.doc.textContent).toBe("Café stays exact.Peer paragraph.");
});
