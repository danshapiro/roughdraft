import { getSchema } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { replaceRevisionSource, RevisionSource } from "./revision-source";

test("distant incoming edits keep local Undo in an unchanged middle paragraph", () => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const original = "First paragraph.\n\nMiddle paragraph.\n\nLast paragraph.\n";
  let state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(criticMarkdownToEditorState(original).doc),
    plugins: [history()],
  });
  const middle = state.doc.child(0).nodeSize + 1;
  const local = state.tr.insertText("Local ", middle);
  local.setSelection(TextSelection.create(local.doc, middle + 6));
  state = state.apply(local);
  const merged = original
    .replace("First", "Incoming first")
    .replace("Middle", "Local Middle")
    .replace("Last", "Incoming last");
  state = state.apply(
    replaceRevisionSource(state, merged).transaction.setMeta(
      "addToHistory",
      false,
    ),
  );
  expect(state.doc.textContent).toContain("Local Middle paragraph.");
  expect(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  ).toBe(true);
  expect(state.doc.textContent).toBe(
    "Incoming first paragraph.Middle paragraph.Incoming last paragraph.",
  );
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRemoteRevision } from "./revision-remote-source";
import { editableMarkdownOptions } from "./revision-markdown";

test("cached remote parsing matches the maintained annotated document", () => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const markdown = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const current = EditorState.create({ schema });
  const expected = schema.nodeFromJSON(
    criticMarkdownToEditorState(markdown, editableMarkdownOptions).doc,
  );
  const cached = parseRemoteRevision(markdown, current);
  expect(cached.doc.content.eq(expected.content)).toBe(true);
  expect([...cached.comments.keys()].sort()).toEqual(
    [
      ...criticMarkdownToEditorState(
        markdown,
        editableMarkdownOptions,
      ).comments.keys(),
    ].sort(),
  );
});

test("remote comment-registry updates add and remove replies without leaving cached feedback", () => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const current = EditorState.create({ schema });
  const base =
    "{==Anchor==}{>>A comment.<<}{#c1}\n\n---\ncomments:\n  c1:\n    by: user\n    at: 2026-01-01T00:00:00.000Z\n";
  const replied = `${base}  c2:\n    by: user\n    at: 2026-01-01T00:00:00.000Z\n    body: A reply.\n    re: c1\n`;
  expect(parseRemoteRevision(base, current).comments.has("c2")).toBe(false);
  expect(
    parseRemoteRevision(replied, current).comments.get("c2")?.parentCommentId,
  ).toBe("c1");
  expect(parseRemoteRevision(base, current).comments.has("c2")).toBe(false);
});
