import { Extension, getSchema } from "@tiptap/core";
import { history, undo, redo } from "@tiptap/pm/history";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  createEditorExtensions,
  explicitReviewEdit,
} from "./editor-extensions";
import {
  createReviewIdentityPlugin,
  remapReviewIdentity,
} from "./revision-identity";
import { replaceRevisionSource, RevisionSource } from "./revision-source";
import {
  createReviewedChangesPlugin,
  recordReviewedChange,
  reviewedChanges,
  reopenReviewedChange,
} from "./revision-history";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
const schema = getSchema([
  ...createEditorExtensions(""),
  RevisionSource,
  Extension.create({
    name: "identityTest",
    addGlobalAttributes: () => [
      {
        types: ["doc"],
        attributes: { kept: { default: [] }, reviewed: { default: [] } },
      },
    ],
  }),
]);
function state(markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown);
  return EditorState.create({
    schema,
    doc: schema.nodeFromJSON({
      ...parsed.doc,
      attrs: {
        sourceMetadata: {
          markdown,
          frontmatter: parsed.frontmatter,
          endmatter: parsed.endmatter,
          identityGeneration: 0,
        },
      },
    }),
    plugins: [
      history(),
      createReviewIdentityPlugin(),
      createReviewedChangesPlugin(),
    ],
  });
}
function suggestionText(current: EditorState, id: string) {
  let value = "";
  current.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.attrs.changeId === id))
      value += node.text;
  });
  return value;
}
function locate(current: EditorState, value: string) {
  let position = -1;
  current.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(value))
      position = pos + node.text.indexOf(value);
  });
  if (position < 0) throw new Error(`Missing ${value}`);
  return position;
}
function addIncoming(current: EditorState) {
  const markdown =
    editorStateToCriticMarkdown(current.doc.toJSON(), new Map()) +
    "\nIncoming {++Beta++}{#s13}.\n";
  return current.apply(
    replaceRevisionSource(current, markdown)
      .transaction.setMeta("addToHistory", false)
      .setMeta(explicitReviewEdit, true),
  );
}

test("Undo and Redo after a deletion restore the renamed local ID without touching the incoming ID", () => {
  let current = state("Local {++Alpha++}{#s13}.\n\nLast.\n");
  const start = locate(current, "Alpha");
  current = current.apply(current.tr.delete(start + 2, start + 4));
  current = current.apply(remapReviewIdentity(current, { s13: "s14" }));
  current = addIncoming(current);
  expect(suggestionText(current, "s14")).toBe("Ala");
  expect(suggestionText(current, "s13")).toBe("Beta");
  expect(
    undo(current, (tr) => {
      current = current.apply(tr);
    }),
  ).toBe(true);
  expect(suggestionText(current, "s14")).toBe("Alpha");
  expect(suggestionText(current, "s13")).toBe("Beta");
  expect(
    redo(current, (tr) => {
      current = current.apply(tr);
    }),
  ).toBe(true);
  expect(suggestionText(current, "s14")).toBe("Ala");
  expect(suggestionText(current, "s13")).toBe("Beta");
});

test("source Undo repairs old source IDs and keeps the incoming same-number proposal", () => {
  const original = "Local {++Alpha++}{#s13}.\n\nLast.\n";
  let current = state(original);
  current = current.apply(
    replaceRevisionSource(current, original.replace("Alpha", "Extended"))
      .transaction,
  );
  current = current.apply(remapReviewIdentity(current, { s13: "s14" }));
  current = addIncoming(current);
  expect(
    undo(current, (tr) => {
      current = current.apply(tr);
    }),
  ).toBe(true);
  expect(suggestionText(current, "s14")).toBe("Alpha");
  expect(suggestionText(current, "s13")).toBe("Beta");
  expect(current.doc.attrs.sourceMetadata.markdown).toContain("s14");
});

test("later Undo inside the incoming proposal keeps its committed identity", () => {
  let current = state("Local {++Alpha++}{#s13}.\n\nLast.\n");
  current = current.apply(remapReviewIdentity(current, { s13: "s14" }));
  current = addIncoming(current);
  const at = locate(current, "Beta");
  current = current.apply(current.tr.delete(at + 1, at + 3));
  expect(
    undo(current, (tr) => {
      current = current.apply(tr);
    }),
  ).toBe(true);
  expect(suggestionText(current, "s13")).toBe("Beta");
  expect(suggestionText(current, "s14")).toBe("Alpha");
});

test("Redo restores renamed block-spanning boundaries with their local identity", () => {
  let current = state("Last.\n");
  const boundary = schema.nodes.criticChangeBoundary.create(
    { changeId: "s13", side: "prefix", source: "Leading " },
    schema.nodes.paragraph.create(null, schema.text("Leading ")),
  );
  current = current.apply(current.tr.insert(0, boundary));
  current = current.apply(remapReviewIdentity(current, { s13: "s14" }));
  expect(
    undo(current, (tr) => {
      current = current.apply(tr);
    }),
  ).toBe(true);
  expect(
    redo(current, (tr) => {
      current = current.apply(tr);
    }),
  ).toBe(true);
  expect(current.doc.firstChild?.attrs.changeId).toBe("s14");
});

test("a comment identity remap preserves Reopen guards and inverse references in History", () => {
  let current = state(
    "A {~~{==old==}{>>Comment<<}{#c5}~>{==new==}{>>Comment<<}{#c5}~~}{#s1}.\n",
  );
  const original = current.doc;
  const tr = current.tr;
  applySuggestionDecisions(tr, ["s1"], "accept");
  current = current.apply(
    recordReviewedChange(
      tr,
      { decision: "accept", oldText: "old", newText: "new" },
      suggestionDetail(original, "s1"),
    ),
  );
  const id = reviewedChanges(current.doc)[0].id;
  current = current.apply(remapReviewIdentity(current, { c5: "c6" }));
  const reopened = reopenReviewedChange(current, id);
  expect(reopened).not.toBeNull();
  expect(JSON.stringify(reopened?.doc.toJSON())).not.toContain('"c5"');
  expect(JSON.stringify(reopened?.doc.toJSON())).toContain('"c6"');
});
