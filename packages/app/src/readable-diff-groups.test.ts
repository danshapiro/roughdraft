import { Extension, getSchema } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import {
  type CriticChangeAttrs,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { diffRenderedComparison } from "./rendered-comparison-diff";
import {
  projectAcceptedDocument,
  suggestionPositions,
} from "./revision-projection";
import { referenceChanges, revertReferenceChange } from "./revision-reference";

const schema = getSchema([
  ...createEditorExtensions(""),
  Extension.create({
    name: "readableGroupsState",
    addGlobalAttributes: () => [
      {
        types: ["doc"],
        attributes: { kept: { default: [] }, reviewed: { default: [] } },
      },
    ],
  }),
]);
const doc = (markdown: string) =>
  schema.nodeFromJSON(criticMarkdownToEditorState(markdown).doc);
const original = "Use outdated and undersized equipment.";
const final = "Use modernized and appropriately-sized machinery.";
const change: CriticChangeAttrs = {
  changeId: "readable-passage",
  kind: "substitution-old",
  createdAt: "2026-11-21T00:00:00.000Z",
  authorType: "ai",
};

function markedText(nodes: JSONContent[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.type === "text" &&
    node.marks?.some((mark) => mark.type === "criticChange")
      ? [node.text ?? ""]
      : []),
    ...markedText(node.content ?? []),
  ]);
}

describe("readable groups of nearby prose changes", () => {
  it("keeps a previously saved word decision as a boundary instead of resetting it", () => {
    // Persisted by the earlier fine-grained comparison engine for this fixture.
    const savedId = "reference-5-13-1mcanwzwel81m";
    const current = EditorState.create({ doc: doc(final) }).tr.setDocAttribute(
      "kept",
      [savedId],
    ).doc;
    const changes = referenceChanges(doc(original), current);
    const approved = changes.find(({ item }) => item.changeId === savedId);
    expect(approved?.item.newText).toBe("modernized");
    expect(
      changes
        .filter(({ item }) => item.changeId !== savedId)
        .every((change) => approved && change.from >= approved.to),
    ).toBe(true);
  });

  it("makes nearby edits around a short unchanged phrase one review decision", () => {
    const changes = referenceChanges(doc(original), doc(final));
    expect(changes).toHaveLength(1);
    expect(changes[0].item.sourceChangeIds).toHaveLength(3);
    expect(changes[0].item.sourceChangeIds).toContain(
      "reference-5-13-1mcanwzwel81m",
    );
    expect([changes[0].item.oldText, changes[0].item.newText]).toEqual([
      "outdated and undersized equipment",
      "modernized and appropriately-sized machinery",
    ]);
  });

  it("renders the grouped before/after phrase without islands of unchanged words", () => {
    const result = diffRenderedComparison(
      doc(original).toJSON().content,
      doc(final).toJSON().content,
      change,
    );
    expect(markedText(result.content)).toEqual([
      "outdated and undersized equipment",
      "modernized and appropriately-sized machinery",
    ]);
  });

  it("Keep and Revert replace the complete group while preserving surrounding text", () => {
    const before = doc(`${original}\n\nAn unrelated paragraph stays.`);
    const after = doc(`${final}\n\nAn unrelated paragraph stays.`);
    const forward = referenceChanges(before, after);
    expect(forward).toHaveLength(1);
    expect(
      revertReferenceChange(
        EditorState.create({ doc: after }),
        forward[0],
      )?.doc.content.eq(before.content),
    ).toBe(true);

    const reverse = referenceChanges(after, before, "old");
    expect(reverse).toHaveLength(1);
    expect(
      revertReferenceChange(
        EditorState.create({ doc: before }),
        reverse[0],
      )?.doc.content.eq(after.content),
    ).toBe(true);
  });

  it("keeps clearly separated edits independently reviewable", () => {
    const context =
      "This complete unchanged sentence deliberately separates the two independent decisions.";
    const before = doc(
      `Use outdated equipment. ${context} Keep undersized parts.`,
    );
    const after = doc(
      `Use modernized machinery. ${context} Keep appropriately-sized components.`,
    );
    const changes = referenceChanges(before, after);
    expect(changes).toHaveLength(2);
    expect(changes.map(({ item }) => item.oldText)).toEqual([
      "outdated equipment",
      "undersized parts",
    ]);
    expect(changes.map(({ item }) => item.newText)).toEqual([
      "modernized machinery",
      "appropriately-sized components",
    ]);
    const first = revertReferenceChange(
      EditorState.create({ doc: after }),
      changes[0],
    );
    expect(first?.doc.textContent).toBe(
      `Use outdated equipment. ${context} Keep appropriately-sized components.`,
    );
  });

  it("keeps formatting and link destinations intact when reverting a grouped phrase", () => {
    const before = doc(
      "Use **outdated** and [undersized equipment](old.md) for the careful review.",
    );
    const after = doc(
      "Use **modernized** and [appropriately-sized machinery](new.md) for the careful review.",
    );
    const changes = referenceChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(
      revertReferenceChange(
        EditorState.create({ doc: after }),
        changes[0],
      )?.doc.content.eq(before.content),
    ).toBe(true);
  });

  it("keeps inline code separate even when the final wording removes its formatting", () => {
    const before = doc("Use `outdated` and undersized equipment.");
    const after = doc(final);
    for (const changes of [
      referenceChanges(before, after),
      referenceChanges(after, before, "old"),
    ]) {
      expect(changes.map(({ item }) => item.oldText)).toEqual([
        "outdated",
        "undersized equipment",
      ]);
      expect(changes.map(({ item }) => item.newText)).toEqual([
        "modernized",
        "appropriately-sized machinery",
      ]);
    }
  });

  it("does not combine changes from different paragraphs", () => {
    const before = doc(
      "Use outdated equipment for careful nightly material checks.\n\nKeep undersized parts for the clearly labeled service station.",
    );
    const after = doc(
      "Use modernized machinery for careful nightly material checks.\n\nKeep appropriately-sized components for the clearly labeled service station.",
    );
    const changes = referenceChanges(before, after);
    expect(changes).toHaveLength(2);
    expect(changes[0].to).toBeLessThan(changes[1].from);
  });

  it("never groups prose across list, table, or code block boundaries", () => {
    const before = doc(
      'Use outdated equipment for careful nightly material checks.\n\n- Keep undersized parts for the clearly labeled service station.\n\n| Setting |\n| --- |\n| Use outdated equipment for careful nightly material checks. |\n\n```js\nconst unchanged = "same";\nconst oldValue = oldCall(oldArg);\nreturn unchanged;\n```',
    );
    const after = doc(
      'Use modernized machinery for careful nightly material checks.\n\n- Keep appropriately-sized components for the clearly labeled service station.\n\n| Setting |\n| --- |\n| Use modernized machinery for careful nightly material checks. |\n\n```js\nconst unchanged = "same";\nconst newValue = newCall(newArg);\nreturn unchanged;\n```',
    );
    const blocks: { from: number; to: number }[] = [];
    after.descendants((node, position) => {
      if (node.isTextblock)
        blocks.push({ from: position + 1, to: position + node.nodeSize - 1 });
    });
    const changes = referenceChanges(before, after);
    const regions = changes.map(({ from, to }) =>
      blocks.findIndex((block) => block.from <= from && to <= block.to),
    );
    expect(regions.every((region) => region >= 0)).toBe(true);
    expect(new Set(regions).size).toBe(4);
  });

  it("keeps an explicit line break between independently reviewable passages", () => {
    const changes = referenceChanges(
      doc("Use outdated  \nequipment."),
      doc("Use modernized  \nmachinery."),
    );
    expect(changes).toHaveLength(2);
    expect(changes[0].to).toBeLessThan(changes[1].from);
  });

  it("keeps a pending native suggestion between groups safe to review separately", () => {
    const before = doc(original);
    let state = EditorState.create({
      doc: doc(
        "Use modernized and {++quiet ++}{#s1}appropriately-sized machinery.",
      ),
    });
    const changes = referenceChanges(before, state.doc);
    expect(changes.length).toBeGreaterThan(1);
    for (const current of changes.sort((a, b) => b.from - a.from)) {
      expect(current.overlapsSuggestion).toBe(false);
      const reverted = revertReferenceChange(state, current);
      expect(reverted).not.toBeNull();
      if (!reverted)
        throw new Error("The native suggestion blocked its neighbor");
      state = state.apply(reverted);
    }
    expect([...suggestionPositions(state.doc).keys()]).toEqual(["s1"]);
    expect(
      projectAcceptedDocument(state.doc).doc.content.eq(before.content),
    ).toBe(true);
  });

  it("keeps inline comments anchored when nearby changes are reverted", () => {
    const parsed = criticMarkdownToEditorState(
      "Use modernized {==and==}{>>Keep this conjunction<<}{#c1} appropriately-sized machinery.",
    );
    let state = EditorState.create({ doc: schema.nodeFromJSON(parsed.doc) });
    const changes = referenceChanges(doc(original), state.doc);
    expect(changes).toHaveLength(2);
    for (const change of [...changes].reverse()) {
      const next = revertReferenceChange(state, change);
      if (!next) throw new Error("Cannot revert comment neighbor");
      state = state.apply(next);
    }
    expect(
      editorStateToCriticMarkdown(state.doc.toJSON(), parsed.comments),
    ).toContain("{>>Keep this conjunction<<}");
  });

  it("does not absorb an earlier rejected passage into a new group", () => {
    const current = doc(final);
    const from = current.textContent.indexOf("and") + 1;
    const protectedDoc = EditorState.create({
      doc: current,
    }).tr.setDocAttribute("reviewed", [
      {
        id: "earlier",
        decision: "reject",
        guard: { from, to: from + 3, slice: null },
      },
    ]).doc;
    const changes = referenceChanges(doc(original), protectedDoc);
    expect(changes).toHaveLength(2);
    expect(
      changes.every((change) => change.to <= from || change.from >= from + 3),
    ).toBe(true);
  });
});
