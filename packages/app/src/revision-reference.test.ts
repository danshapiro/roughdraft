import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { referenceChanges, revertReferenceChange } from "./revision-reference";

const schema = getSchema(createEditorExtensions(""));
const doc = (markdown: string) =>
  schema.nodeFromJSON(criticMarkdownToEditorState(markdown).doc);
const state = (markdown: string) => EditorState.create({ doc: doc(markdown) });

describe("reference review in the editable document", () => {
  it("keeps the same before and after words and changes one passage on the old file", () => {
    const old = state("Use red.\n\nUse small.");
    const next = doc("Use blue.\n\nUse large.");
    const [reverse] = referenceChanges(next, old.doc, "old");
    const [forward] = referenceChanges(old.doc, next);
    expect(reverse.pairId).toBe(forward.pairId);
    expect([reverse.item.oldText, reverse.item.newText]).toEqual([
      "red",
      "blue",
    ]);
    expect(revertReferenceChange(old, reverse)?.doc.textContent).toBe(
      "Use blue.Use small.",
    );
  });
  it("compares source links when the input files are in different folders", () => {
    const create = (markdown: string, root: string) =>
      schema.nodeFromJSON(
        criticMarkdownToEditorState(markdown, {
          resolveFileUrl: (file) => `${root}${file}`,
        }).doc,
      );
    const markdown = "Read [the notes](notes.md).\n\n![Overview](overview.png)";
    const reference = create(markdown, "/reference/");
    const current = create(markdown, "/current/");
    expect(referenceChanges(reference, current)).toEqual([]);
    expect(
      referenceChanges(
        reference,
        create(markdown.replace("notes.md", "other.md"), "/current/"),
      ),
    ).toHaveLength(1);
  });

  it("does not review the empty editor line after a final non-paragraph block", () => {
    const reference = doc("# A heading");
    const end = reference.content.size;
    const current = EditorState.create({ doc: reference }).tr.insert(
      end,
      schema.nodes.paragraph.create(),
    ).doc;
    expect(referenceChanges(reference, current)).toEqual([]);
  });

  it("cannot revert a change through a still-pending suggestion", () => {
    const reference = doc("The older wording stays.");
    const current = state("The new{++ly++}er wording stays.");
    const [change] = referenceChanges(reference, current.doc);
    expect(change.item.newText).toBe("newer");
    expect(change.overlapsSuggestion).toBe(true);
    expect(revertReferenceChange(current, change)).toBeNull();
  });

  it("reverts one changed phrase without touching unchanged wording or other changes", () => {
    const reference = doc("The first orange is sweet. The last peach is ripe.");
    const current = state("The first lime is sweet. The last pear is ripe.");
    const changes = referenceChanges(reference, current.doc);
    expect(changes.map(({ item }) => [item.oldText, item.newText])).toEqual([
      ["orange", "lime"],
      ["peach", "pear"],
    ]);
    const next = revertReferenceChange(current, changes[0]);
    expect(next?.doc.textContent).toBe(
      "The first orange is sweet. The last pear is ripe.",
    );
  });

  it("preserves review identity when unrelated text is moved or typed", () => {
    const reference = doc(
      "Introduction stays put.\n\nWe write old guidance here.",
    );
    const original = doc(
      "Introduction stays put.\n\nWe write new guidance here.",
    );
    const unrelated = doc(
      "Added a note.\n\nIntroduction stays put.\n\nWe write new guidance here today.",
    );
    const rewritten = doc(
      "Introduction stays put.\n\nWe write revised guidance here.",
    );
    const [kept] = referenceChanges(reference, original);
    expect(
      referenceChanges(reference, unrelated).map(({ item }) => item.changeId),
    ).toContain(kept.item.changeId);
    expect(
      referenceChanges(reference, rewritten).map(({ item }) => item.changeId),
    ).not.toContain(kept.item.changeId);
  });

  it("restores a deleted list item at the original position without changing its neighbors", () => {
    const reference = doc("- Keep first\n- Remove middle\n- Keep last");
    const current = state("- Keep first\n- Keep last");
    const [change] = referenceChanges(reference, current.doc);
    expect(change.item.oldText).toBe("Remove middle");
    expect(change.item.kind).toBe("deletion");
    const next = revertReferenceChange(current, change);
    expect(next?.doc.eq(reference)).toBe(true);
  });

  it("restores the prior formatting of a phrase", () => {
    const reference = doc("Keep the **bold** name in the sentence.");
    const current = state("Keep the *bold* name in the sentence.");
    const [change] = referenceChanges(reference, current.doc);
    expect(change.item.oldText).toContain("bold");
    expect(revertReferenceChange(current, change)?.doc.eq(reference)).toBe(
      true,
    );
  });

  it("ignores unkept suggestions and preserves suggestions adjacent to a reverted difference", () => {
    const reference = doc("Use old wording and keep this suffix.");
    const current = state(
      "Use new{++er++} wording and {--keep--} this suffix.",
    );
    const changes = referenceChanges(reference, current.doc);
    expect(changes.map(({ item }) => [item.oldText, item.newText])).toEqual([
      ["old", "new"],
    ]);
    const next = revertReferenceChange(current, changes[0]);
    expect(next?.doc.textContent).toBe(
      "Use older wording and keep this suffix.",
    );
    const pending = (value: typeof reference) => {
      const marks = [];
      value.descendants((node) => {
        for (const mark of node.marks) {
          if (mark.type.name === "criticChange")
            marks.push([node.text, mark.attrs]);
        }
      });
      return marks;
    };
    expect(next && pending(next.doc)).toEqual(pending(current.doc));
  });
});
