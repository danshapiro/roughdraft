import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { RevisionSource } from "./revision-source";
import { replaceRevisionContent } from "./revision-remote-source";
import {
  outsideComposition,
  rebaseRemoteTransaction,
} from "./revision-remote-steps";
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
