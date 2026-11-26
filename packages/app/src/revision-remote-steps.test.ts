import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { replaceRevisionContent } from "./revision-remote-source";
import {
  outsideComposition,
  rebaseRemoteTransaction,
} from "./revision-remote-steps";
import { RevisionSource } from "./revision-source";

const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
function state(markdown: string) {
  return EditorState.create({
    schema,
    doc: schema.nodeFromJSON(criticMarkdownToEditorState(markdown).doc),
  });
}
test("independent remote patches use base coordinates despite earlier remote length changes", () => {
  const base = state("Aaaaa.\n\nBbbbb.\n\nCcccc.\n");
  const local = state("Aaaaa.\n\nBbbbb.\n\nLLLLL.\n");
  const remote = state("12345678Aaaaa.\n\nZzzzz.\n\nCcccc.\n");
  const transaction = rebaseRemoteTransaction(base, local, remote.doc);
  expect(transaction).not.toBeNull();
  expect(transaction?.doc.textContent).toBe("12345678Aaaaa.Zzzzz.LLLLL.");
});
test("outside composition patches stay mapped after a skipped composing-block change", () => {
  const current = state("First.\n\nComposing.\n\nLast.\n");
  const remote = state(
    "Remote prefix First.\n\nReplaced composing.\n\nRemote last.\n",
  );
  const incoming = replaceRevisionContent(current, remote.doc);
  const from = current.doc.firstChild?.nodeSize ?? 0;
  const to = from + current.doc.child(1).nodeSize;
  const transaction = outsideComposition(current, incoming, { from, to });
  expect(transaction).not.toBeNull();
  expect(transaction?.doc.textContent).toBe(
    "Remote prefix First.Composing.Remote last.",
  );
});

test("independent comment and proposal marks commute over the same source-normalized space", () => {
  const plain = state("Alpha.\n");
  const proposal = plain.schema.marks.criticChange.create({
    kind: "addition",
    changeId: "s2",
    authorType: "user",
    authorId: "user",
    createdAt: "2026-11-26T12:00:00.000Z",
  });
  const base = plain.apply(plain.tr.addMark(1, 6, proposal));
  const privateComment = base.schema.marks.commentRef.create({
    commentIds: ["c-private"],
  });
  const local = base.apply(base.tr.addMark(1, 4, privateComment));
  const incoming = base.apply(base.tr.removeMark(1, 2, proposal));
  const transaction = rebaseRemoteTransaction(base, local, incoming.doc);
  expect(transaction).not.toBeNull();
  expect(transaction?.doc.textContent).toBe("Alpha.");
  const marks = transaction?.doc.resolve(1).nodeAfter?.marks ?? [];
  expect(marks.some((mark) => mark.type.name === "commentRef")).toBe(true);
  expect(marks.some((mark) => mark.type.name === "criticChange")).toBe(false);
  expect(
    rebaseRemoteTransaction(base, local, state("Changed.\n").doc),
  ).toBeNull();
});

test("different mark types that exclude each other keep their overlap protected", () => {
  const base = state("Alpha.\n");
  const local = base.apply(
    base.tr.addMark(1, 6, base.schema.marks.bold.create()),
  );
  const incoming = base.apply(
    base.tr.addMark(1, 6, base.schema.marks.code.create()),
  );
  expect(rebaseRemoteTransaction(base, local, incoming.doc) === null).toBe(
    true,
  );
  expect(
    local.doc.firstChild?.firstChild?.marks.some(
      (mark) => mark.type.name === "bold",
    ),
  ).toBe(true);
});

test.each([
  ["Alpha.", "Alha."],
  ["Alpha.", "New Alpha."],
  ["Alpha.", "Alpha"],
  ["Alpha.", ""],
  ["Alpha.", "AlXXpha."],
])("text fragment patches retain exact insertion and deletion semantics: %s → %s", (before, after) => {
  const previous = state(`${before}\n`),
    next = state(`${after}\n`);
  expect(
    replaceRevisionContent(previous, next.doc).doc.content.eq(next.doc.content),
  ).toBe(true);
});
