import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test, vi } from "vitest";
import { createEditorExtensions } from "./editor-extensions";
import { projectCleanRevisionNode } from "./revision-clean-cache";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import { parseRemoteRevision } from "./revision-remote-source";
import { RevisionSpellingProof } from "./revision-spelling-proof";

vi.mock("./revision-remote-source", { spy: true });
const schema = getSchema(createEditorExtensions(""));
function stateFor(markdown: string) {
  const empty = EditorState.create({ schema });
  return EditorState.create({
    doc: parseRemoteRevision(markdown, empty).doc,
  });
}

test("validated plain-paragraph edits reuse unaffected source/model blocks", () => {
  const before =
    "# Original spelling\n\nAn ordinary paragraph.\n\nA stable ending.\n";
  let state = stateFor(before);
  const proof = new RevisionSpellingProof();
  expect(proof.matches(before, state.doc, state)).toBe(true);
  vi.mocked(parseRemoteRevision).mockClear();
  let text = before;
  for (const addition of [" Alpha", " Beta", " Gamma"]) {
    const target = state.doc.child(1);
    const at = state.doc.child(0).nodeSize + target.nodeSize - 1;
    state = state.apply(state.tr.insertText(addition, at));
    const last = state.doc.child(1).textContent;
    text = text.replace(/An ordinary[^\n]+/, last);
    expect(proof.matches(text, state.doc, state)).toBe(true);
  }
  expect(parseRemoteRevision).not.toHaveBeenCalled();
});

test("a same-word edit in a different repeated paragraph cannot pass the fast proof", () => {
  const before = "Repeated paragraph.\n\nRepeated paragraph.\n";
  const state = stateFor(before);
  const proof = new RevisionSpellingProof();
  expect(proof.matches(before, state.doc, state)).toBe(true);
  const changed = state.apply(state.tr.insertText("New ", 1));
  expect(
    proof.matches(
      "Repeated paragraph.\n\nNew Repeated paragraph.\n",
      changed.doc,
      changed,
    ),
  ).toBe(false);
});

test("Markdown syntax and global definition changes use full parsing", () => {
  for (const after of [
    "An ordinary **paragraph**.\n\nStable.\n",
    "An ordinary paragraph.\n\nStable.\n\n[ref]: target.md\n",
    "---\ntitle: New\n---\n\nAn ordinary paragraph.\n\nStable.\n",
  ]) {
    const before = "An ordinary paragraph.\n\nStable.\n";
    const state = stateFor(before);
    const next = stateFor(after);
    const proof = new RevisionSpellingProof();
    expect(proof.matches(before, state.doc, state)).toBe(true);
    vi.mocked(parseRemoteRevision).mockClear();
    expect(proof.matches(after, next.doc, next)).toBe(true);
    expect(parseRemoteRevision).toHaveBeenCalledTimes(1);
  }
});

test("CRLF source and metadata envelopes retain exact unaffected bytes", () => {
  const before =
    "---\r\ntitle: Exact\r\n---\r\n\r\nPlain paragraph.\r\n\r\nStable.\r\n";
  const state = stateFor(before);
  const proof = new RevisionSpellingProof();
  expect(proof.matches(before, state.doc, state)).toBe(true);
  let paragraphAt = -1;
  state.doc.descendants((node, pos) => {
    if (
      node.type.name === "paragraph" &&
      node.textContent === "Plain paragraph."
    )
      paragraphAt = pos + 1;
  });
  expect(paragraphAt).toBeGreaterThan(0);
  const next = state.apply(state.tr.insertText("New ", paragraphAt));
  vi.mocked(parseRemoteRevision).mockClear();
  expect(
    proof.matches(before.replace("Plain", "New Plain"), next.doc, next),
  ).toBe(true);
  expect(parseRemoteRevision).not.toHaveBeenCalled();
});

test("the complete long annotated fixture validates repeated ordinary typing without a full parse", () => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const endmatter = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 750 },
    (_, index) =>
      `Unchanged paragraph ${index + 1}. Stable wording for review.`,
  ).join("\n\n");
  let markdown = `${fixture.slice(0, endmatter)}\n\n${padding}\n\nLive owner A: unchanged.\n${fixture.slice(endmatter)}`;
  let state = stateFor(markdown);
  const proof = new RevisionSpellingProof();
  expect(proof.matches(markdown, state.doc, state)).toBe(true);
  vi.mocked(parseRemoteRevision).mockClear();
  for (const suffix of [" LocalA-a", "bcdef", "ghij"]) {
    let at = -1;
    state.doc.descendants((node, position) => {
      if (
        node.type.name === "paragraph" &&
        node.textContent.startsWith("Live owner A:")
      )
        at = position + node.nodeSize - 1;
    });
    expect(at).toBeGreaterThan(0);
    state = state.apply(state.tr.insertText(suffix, at));
    markdown = markdown.replace(/Live owner A:[^\n]+/, (text) => text + suffix);
    expect(proof.matches(markdown, state.doc, state)).toBe(true);
  }
  expect(parseRemoteRevision).not.toHaveBeenCalled();
});

test("a newly typed autolink is fully parsed instead of trusted as plain text", () => {
  const before = "Visit a website.\n";
  const state = stateFor(before);
  const proof = new RevisionSpellingProof();
  expect(proof.matches(before, state.doc, state)).toBe(true);
  const next = state.apply(state.tr.insertText("www.example.com ", 1));
  vi.mocked(parseRemoteRevision).mockClear();
  expect(
    proof.matches("www.example.com Visit a website.\n", next.doc, next),
  ).toBe(false);
  expect(parseRemoteRevision).toHaveBeenCalledTimes(1);
});

test("an unchanged accepted-model whitespace discrepancy avoids repeated parsing while typing elsewhere", () => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const endmatter = fixture.lastIndexOf("\n---\n");
  const markdown = `${fixture.slice(0, endmatter)}\n\nLive owner A: unchanged.\n${fixture.slice(endmatter)}`;
  const state = stateFor(markdown);
  const projected = projectCleanRevisionNode(state.doc);
  const clean = cleanRevisionSourceMarkdown(markdown);
  const proof = new RevisionSpellingProof();
  // Rejecting the fixture's insertion leaves a double space in one unrelated
  // paragraph; Markdown reparsing collapses it. Retain the strict rejection.
  expect(proof.matches(clean, projected, state)).toBe(false);
  let at = -1;
  state.doc.descendants((node, position) => {
    if (
      node.type.name === "paragraph" &&
      node.textContent.startsWith("Live owner A:")
    )
      at = position + node.nodeSize - 1;
  });
  expect(at).toBeGreaterThan(0);
  const next = state.apply(state.tr.insertText(" LocalA-typing", at));
  vi.mocked(parseRemoteRevision).mockClear();
  expect(
    proof.matches(
      clean.replace(
        "Live owner A: unchanged.",
        "Live owner A: unchanged. LocalA-typing",
      ),
      projectCleanRevisionNode(next.doc),
      next,
    ),
  ).toBe(false);
  expect(parseRemoteRevision).not.toHaveBeenCalled();
});

test("editing the only mismatched block revalidates instead of retaining a stale rejection", () => {
  const markdown = "An ordinary paragraph.\n\nStable ending.\n";
  const source = stateFor(markdown);
  const different = stateFor("An ordinary paragraph.\n\n**Stable ending.**\n");
  const proof = new RevisionSpellingProof();
  expect(proof.matches(markdown, different.doc, different)).toBe(false);
  vi.mocked(parseRemoteRevision).mockClear();
  expect(proof.matches(markdown, source.doc, source)).toBe(true);
  expect(parseRemoteRevision).toHaveBeenCalledTimes(1);
});

test.each([
  "  ",
  "  more wording",
  " ",
])("whitespace that Markdown can reinterpret is fully parsed: %j", (addition) => {
  const before = "Plain paragraph.\n\nStable ending.\n";
  const state = stateFor(before);
  const proof = new RevisionSpellingProof();
  expect(proof.matches(before, state.doc, state)).toBe(true);
  const at = state.doc.child(0).nodeSize - 1;
  const next = state.apply(state.tr.insertText(addition, at));
  vi.mocked(parseRemoteRevision).mockClear();
  expect(
    proof.matches(
      before.replace("Plain paragraph.", `Plain paragraph.${addition}`),
      next.doc,
      next,
    ),
  ).toBe(false);
  expect(parseRemoteRevision).toHaveBeenCalledTimes(1);
});
