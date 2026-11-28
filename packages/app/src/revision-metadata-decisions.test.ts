import { Extension, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { RevisionSource } from "./revision-source";
import { decideReviewChanges } from "./revision-bulk";
import { outcomeDocument } from "./revision-outcomes";
import {
  mapReviewedChanges,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";

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
      ...parsed.doc.attrs,
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
const markdown = (node: ReturnType<typeof doc>) =>
  editorStateToCriticMarkdown(node.toJSON(), new Map());

test("complete outcome previews and bulk decisions choose editable YAML and body from the same side", () => {
  for (const base of ["old", "new"] as const) {
    const current = doc(base === "old" ? before : after);
    const reference = doc(base === "old" ? after : before);
    for (const decision of ["accept", "reject"] as const) {
      const expected = decision === "accept" ? after : before;
      const projected = outcomeDocument(current, reference, base, decision);
      expect(markdown(projected)).toBe(expected);
      expect(projected.firstChild?.type.name).toBe("yamlFrontmatter");
      const chosen = decideReviewChanges(
        EditorState.create({ doc: current }),
        reference,
        base,
        decision,
        true,
      ).doc;
      expect(markdown(chosen)).toBe(expected);
      expect(reviewedChanges(chosen).every((change) => !change.metadata)).toBe(
        true,
      );
    }
  }
});

test("frontmatter decisions reopen after unrelated body edits and become stale after YAML rewrites", () => {
  let state = EditorState.create({ doc: doc(after) });
  state = state.apply(
    decideReviewChanges(
      state,
      doc(before.replace("red", "blue")),
      "new",
      "reject",
      true,
    ),
  );
  const archived = reviewedChanges(state.doc)[0];
  expect(archived.metadata).toBeUndefined();
  expect(markdown(state.doc)).toBe(before.replace("red", "blue"));
  const edit = state.tr.insertText(
    "Please ",
    (state.doc.firstChild?.nodeSize ?? 0) + 1,
  );
  edit.setDocAttribute(
    "reviewed",
    mapReviewedChanges(reviewedChanges(state.doc), edit),
  );
  state = state.apply(edit);
  const reopened = reopenReviewedChange(state, archived.id);
  expect(reopened).not.toBeNull();
  if (!reopened)
    throw new Error(
      "An unrelated body edit must leave the YAML decision reopenable",
    );
  expect(markdown(reopened.doc)).toBe(
    after.replace("Use blue", "Please Use blue"),
  );
  const titleAt = state.doc.firstChild?.textContent.indexOf("Old") ?? -1;
  const changed = state.tr.insertText("Custom", titleAt + 1, titleAt + 4);
  const [stale] = mapReviewedChanges(reviewedChanges(state.doc), changed);
  expect(stale.stale).toBe(true);
});
