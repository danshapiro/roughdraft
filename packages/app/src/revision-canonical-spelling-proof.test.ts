import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test, vi } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import {
  cleanRevisionNode,
  cleanSourceFromNode,
  projectCleanRevisionNode,
} from "./revision-clean-cache";
import {
  cleanRevisionSourceMarkdown,
  editableMarkdownOptions,
} from "./revision-markdown";
import { parseRemoteRevision } from "./revision-remote-source";
import { RevisionSource } from "./revision-source";
import {
  RevisionCanonicalSpellingProof,
  RevisionSpellingProof,
} from "./revision-spelling-proof";

vi.mock("./revision-remote-source", { spy: true });
const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
function stateFor(markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  return {
    parsed,
    state: EditorState.create({
      doc: schema.nodeFromJSON({
        ...parsed.doc,
        attrs: {
          sourceMetadata: {
            markdown,
            frontmatter: parsed.frontmatter,
            endmatter: parsed.endmatter,
          },
        },
      }),
    }),
  };
}

test.each([
  "* Exact list.\r\n\r\nA {++pending++}{#s1} word.\r\n",
  "```text\r\nLiteral {++pending++} syntax.\r\n\r\n```\r\n",
  "---\r\ntitle: Exact\r\n---\r\n\r\nA {==comment==}{>>Saved feedback<<}{#c1}.\r\n",
])("source-backed clean projection matches the existing source projection: %j", (markdown) => {
  const { parsed, state } = stateFor(markdown);
  expect(cleanSourceFromNode(markdown, state.doc, parsed.comments)).toBe(
    cleanRevisionSourceMarkdown(markdown),
  );
});

test("a changed canonical literal cannot reuse an earlier successful normalized-model proof", () => {
  const before = "Keep `two  spaces` exact.\n";
  const canonical = "Keep `two spaces` exact.\n";
  const { state } = stateFor(before);
  const proof = new RevisionCanonicalSpellingProof();
  expect(proof.matches(before, before, state.doc, state)).toBe(true);
  expect(proof.matches(before, canonical, state.doc, state)).toBe(false);
});

test("canonical validation retains a strict rejection of different live whitespace while proving equivalent file spelling", () => {
  const markdown =
    "# Original\r\n\r\n* Keep this marker.\r\n\r\nLeave {++pending++}{#s1} undecided.\r\n\r\nOrdinary paragraph.\r\n";
  const { state } = stateFor(markdown);
  const live = projectCleanRevisionNode(state.doc);
  const preserved = cleanRevisionSourceMarkdown(markdown);
  const canonical = cleanRevisionNode(state.doc);
  expect(new RevisionSpellingProof().matches(preserved, live, state)).toBe(
    false,
  );
  const proof = new RevisionCanonicalSpellingProof();
  expect(proof.matches(preserved, canonical, live, state)).toBe(true);
  expect(
    proof.matches(
      preserved.replace("undecided", "decided"),
      canonical,
      live,
      state,
    ),
  ).toBe(false);
  expect(proof.matches(preserved, canonical, live, state)).toBe(true);
});

test.each([
  ["Keep `two  spaces` exact.\n", "Keep `two spaces` exact.\n"],
  ["```text\ncode\n\n\nend\n```\n", "```text\ncode\n\nend\n```\n"],
  ["A hard break.  \nSecond line.\n", "A hard break.\nSecond line.\n"],
  ["A **bold** word.\n", "A bold word.\n"],
  [
    "A note[^n].\n\n[^n]: Exact meaning.\n",
    "A note[^n].\n\n[^n]: Different meaning.\n",
  ],
  ["---\ntitle: Exact\n---\n\nBody.\n", "---\ntitle: Wrong\n---\n\nBody.\n"],
])("canonical file proof rejects changes in literal syntax, formatting and global metadata: %j", (canonical, wrong) => {
  const { state } = stateFor(canonical);
  const proof = new RevisionCanonicalSpellingProof();
  expect(proof.matches(canonical, canonical, state.doc, state)).toBe(true);
  expect(proof.matches(wrong, canonical, state.doc, state)).toBe(false);
});

test("the large review's accepted-spelling fallback does not parse the complete document for subsequent plain keys", () => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const endmatter = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 750 },
    (_, index) =>
      `Exact plain reading section ${index + 1}. The unchanged review keeps pending proposals and private feedback separate from accepted file spelling.`,
  ).join("\n\n");
  const markdown =
    `${fixture.slice(0, endmatter)}\n\n* Preserve this original marker.\n\n${padding}\n\nSpelling owner: unchanged.\n${fixture.slice(endmatter)}`.replace(
      /\n/g,
      "\r\n",
    );
  const { state: initial } = stateFor(markdown);
  let state = initial;
  let preserved = cleanRevisionSourceMarkdown(markdown)
    .replace(
      "- Preserve this original marker.",
      "* Preserve this original marker.",
    )
    .replace(/\r?\n/g, "\r\n");
  const proof = new RevisionCanonicalSpellingProof();
  expect(
    proof.matches(
      preserved,
      cleanRevisionNode(state.doc),
      projectCleanRevisionNode(state.doc),
      state,
    ),
  ).toBe(true);
  vi.mocked(parseRemoteRevision).mockClear();
  for (const suffix of [" A", "B", "C"]) {
    let at = -1;
    state.doc.descendants((node, pos) => {
      if (
        node.type.name === "paragraph" &&
        node.textContent.startsWith("Spelling owner:")
      )
        at = pos + node.nodeSize - 1;
    });
    expect(at).toBeGreaterThan(0);
    state = state.apply(state.tr.insertText(suffix, at));
    preserved = preserved.replace(
      /Spelling owner:[^\r\n]*/,
      (line) => line + suffix,
    );
    expect(
      proof.matches(
        preserved,
        cleanRevisionNode(state.doc),
        projectCleanRevisionNode(state.doc),
        state,
      ),
    ).toBe(true);
  }
  expect(parseRemoteRevision).not.toHaveBeenCalled();
  expect(preserved).toContain("* Preserve this original marker.\r\n");
}, 15_000);
