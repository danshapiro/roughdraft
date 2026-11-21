import { Extension, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { RevisionSource } from "./revision-source";
import { decideReviewChanges } from "./revision-bulk";
import { outcomeDocument } from "./revision-outcomes";
import {
  mapReviewedChanges,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import { documentMetadata } from "./revision-metadata";

const schema = getSchema([
  ...createEditorExtensions(""),
  RevisionSource,
  Extension.create({
    name: "metadataReviewTest",
    addGlobalAttributes: () => [
      {
        types: ["doc"],
        attributes: { kept: { default: [] }, reviewed: { default: [] } },
      },
    ],
  }),
]);
const doc = (markdown: string) => {
  const parsed = criticMarkdownToEditorState(markdown);
  return schema.nodeFromJSON({
    ...parsed.doc,
    attrs: {
      sourceMetadata: {
        markdown,
        frontmatter: parsed.frontmatter,
        endmatter: parsed.endmatter,
      },
    },
  });
};
const before = "---\ntitle: Old\n---\n\nUse red.\n";
const after = "---\ntitle: New\n---\n\nUse blue.\n";

test("complete outcome previews choose YAML and body from the same comparison side", () => {
  for (const base of ["old", "new"] as const) {
    const current = doc(base === "old" ? before : after);
    const reference = doc(base === "old" ? after : before);
    for (const decision of ["accept", "reject"] as const) {
      const projected = outcomeDocument(current, reference, base, decision);
      expect(projected.textContent).toBe(
        decision === "accept" ? "Use blue." : "Use red.",
      );
      expect(projected.attrs.sourceMetadata.frontmatter).toContain(
        decision === "accept" ? "New" : "Old",
      );
      const chosen = decideReviewChanges(
        EditorState.create({ doc: current }),
        reference,
        base,
        decision,
        true,
      ).doc;
      expect(chosen.attrs.sourceMetadata.frontmatter).toBe(
        projected.attrs.sourceMetadata.frontmatter,
      );
    }
  }
});

test("metadata decisions reopen after unrelated body edits and become stale after YAML rewrites", () => {
  let state = EditorState.create({ doc: doc(after) });
  state = state.apply(
    decideReviewChanges(state, doc(before), "new", "reject", true, "metadata"),
  );
  const archived = reviewedChanges(state.doc)[0];
  const edit = state.tr.insertText("Please ", 1);
  edit.setDocAttribute("sourceMetadata", {
    ...state.doc.attrs.sourceMetadata,
    markdown: state.doc.attrs.sourceMetadata.markdown.replace(
      "Use blue",
      "Please Use blue",
    ),
  });
  edit.setDocAttribute(
    "reviewed",
    mapReviewedChanges(reviewedChanges(state.doc), edit),
  );
  state = state.apply(edit);
  const reopened = reopenReviewedChange(state, archived.id);
  expect(reopened?.doc.textContent).toBe("Please Use blue.");
  expect(
    documentMetadata(reopened?.doc.attrs.sourceMetadata.markdown ?? "")
      .frontmatter,
  ).toContain("New");
  const changed = state.tr.setDocAttribute("sourceMetadata", {
    ...state.doc.attrs.sourceMetadata,
    markdown: state.doc.attrs.sourceMetadata.markdown.replace(
      "title: Old",
      "title: Custom",
    ),
  });
  const [stale] = mapReviewedChanges(reviewedChanges(state.doc), changed);
  expect(stale.stale).toBe(true);
});
