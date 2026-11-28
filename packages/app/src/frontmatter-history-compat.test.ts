import { Extension, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { RevisionSource } from "./revision-source";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
import {
  hydrateReviewedChanges,
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import type { ReviewedChange } from "./comparison-types";
import { referenceChanges } from "./revision-reference";

const schema = getSchema([
  ...createEditorExtensions(""),
  RevisionSource,
  Extension.create({
    name: "frontmatterHistory",
    addGlobalAttributes: () => [
      {
        types: ["doc"],
        attributes: { kept: { default: [] }, reviewed: { default: [] } },
      },
    ],
  }),
]);
function parse(markdown: string, reviewed: ReviewedChange[] = []) {
  const parsed = criticMarkdownToEditorState(markdown);
  return schema.nodeFromJSON({
    ...parsed.doc,
    attrs: {
      ...parsed.doc.attrs,
      reviewed,
      sourceMetadata: {
        markdown,
        frontmatter: parsed.frontmatter,
        endmatter: parsed.endmatter,
      },
    },
  });
}

test("body-only History positions migrate once, preserve repeated passages and reopen the exact archived text", () => {
  const original = "title: {++repeated++}{#s1}.\n\nrepeated.\n\nrepeated.\n";
  const before = EditorState.create({ doc: parse(original) });
  const tr = before.tr;
  applySuggestionDecisions(tr, ["s1"], "accept");
  const saved = before.apply(
    recordReviewedChange(
      tr,
      { decision: "accept", oldText: "", newText: "repeated" },
      suggestionDetail(before.doc, "s1"),
    ),
  );
  const [modern] = reviewedChanges(saved.doc);
  const { frontmatterInContent: _model, ...legacy } = modern;
  const body = editorStateToCriticMarkdown(saved.doc.toJSON(), new Map());
  const source = `---\ntitle: repeated\n---\n\n${body}`;
  const current = parse(source);
  const records = hydrateReviewedChanges(current, [legacy]);
  expect(records[0].frontmatterInContent).toBe(true);
  expect(records[0].guard.from).toBe(
    legacy.guard.from + (current.firstChild?.nodeSize ?? 0),
  );
  expect(records[0].stale).toBe(false);
  expect(hydrateReviewedChanges(current, records)).toBe(records);
  const hydrated = EditorState.create({ doc: parse(source, records) });
  const reopened = reopenReviewedChange(hydrated, modern.id);
  expect(reopened).not.toBeNull();
  if (!reopened) throw new Error("A matching old History guard must reopen");
  expect(
    editorStateToCriticMarkdown(reopened.doc.toJSON(), new Map()),
  ).toContain("title: {++repeated++}");
  expect(JSON.stringify(reopened.doc.toJSON())).toContain('"changeId":"s1"');
  expect(reopened.doc.firstChild?.textContent).toBe("title: repeated");
  expect(reopened.doc.lastChild?.textContent).toBe("repeated.");
});

test("a legacy History mismatch becomes stale instead of selecting a matching passage elsewhere", () => {
  const legacy: ReviewedChange = {
    id: "legacy",
    decision: "accept",
    oldText: "old",
    newText: "repeated",
    inverse: [],
    guard: {
      from: 1,
      to: 9,
      slice: { content: [{ type: "text", text: "repeated" }] },
    },
  };
  const current = parse(
    "---\ntitle: repeated\n---\n\nDifferent first passage.\n\nrepeated.\n",
  );
  const [stale] = hydrateReviewedChanges(current, [legacy]);
  expect(stale.stale).toBe(true);
});

test("an older metadata History entry restores the editable frontmatter without replacing body text", () => {
  const source = "---\ntitle: New\n---\n\nKeep this body.\n";
  const legacy: ReviewedChange = {
    id: "metadata",
    decision: "accept",
    oldText: "Old",
    newText: "New",
    inverse: [],
    guard: { from: 0, to: 0, slice: null },
    metadata: {
      before: { frontmatter: "---\ntitle: Old\n---\n\n", endmatter: null },
      after: { frontmatter: "---\ntitle: New\n---\n\n", endmatter: null },
    },
  };
  const current = parse(source);
  const state = EditorState.create({
    doc: parse(source, hydrateReviewedChanges(current, [legacy])),
  });
  const reopened = reopenReviewedChange(state, legacy.id);
  expect(reopened).not.toBeNull();
  if (!reopened)
    throw new Error("A legacy metadata decision must restore its fields");
  expect(editorStateToCriticMarkdown(reopened.doc.toJSON(), new Map())).toBe(
    source.replace("New", "Old"),
  );
});

test.each([
  "accept",
  "reject",
] as const)("a legacy %s metadata decision stays resolved and reopens normally", (decision) => {
  const before = "---\ntitle: Old\n---\n\nSame body.\n";
  const after = before.replace("Old", "New");
  const source = decision === "accept" ? after : before;
  const entry: ReviewedChange = {
    id: "legacy-metadata",
    decision,
    oldText: "---\ntitle: Old\n---\n\n",
    newText: "---\ntitle: New\n---\n\n",
    inverse: [],
    guard: { from: 0, to: 0, slice: null },
    keptId: "document-metadata",
    metadata: {
      before: { frontmatter: "---\ntitle: New\n---\n\n", endmatter: null },
      after: {
        frontmatter:
          decision === "accept"
            ? "---\ntitle: New\n---\n\n"
            : "---\ntitle: Old\n---\n\n",
        endmatter: null,
      },
    },
  };
  // Keep archives an identical before/after envelope; its oldText still names
  // the original comparison fields, just as older clients persisted them.
  const initial = parse(source, hydrateReviewedChanges(parse(source), [entry]));
  const current = initial.type.create(
    { ...initial.attrs, kept: ["document-metadata"] },
    initial.content,
  );
  expect(referenceChanges(parse(before), current, "new")).toHaveLength(0);
  const reopened = reopenReviewedChange(
    EditorState.create({ doc: current }),
    entry.id,
  );
  expect(reopened).not.toBeNull();
  if (!reopened)
    throw new Error("Saved metadata choices must remain reopenable");
  expect(referenceChanges(parse(before), reopened.doc, "new")).toHaveLength(1);
});

test("existing body Keep identities remain stable when frontmatter becomes editable", () => {
  const before = "Use old wording.\n\nUnchanged.\n";
  const after = before.replace("old", "new");
  const legacy = referenceChanges(parse(before), parse(after), "new");
  const withHeader = referenceChanges(
    parse(`---\ntitle: Old\n---\n\n${before}`),
    parse(`---\ntitle: New title\n---\n\n${after}`),
    "new",
  );
  const body = withHeader.find((change) => change.item.oldText === "old");
  expect(body?.item.changeId).toBe(legacy[0].item.changeId);
  expect(withHeader.find((change) => change !== body)?.item.changeId).toMatch(
    /^reference-yaml-/,
  );
});

test("a legacy metadata decision cannot replace newer YAML while the source snapshot is still old", () => {
  const source = "---\ntitle: New\n---\n\nBody.\n";
  const entry: ReviewedChange = {
    id: "legacy",
    decision: "accept",
    oldText: "---\ntitle: Old\n---\n\n",
    newText: "---\ntitle: New\n---\n\n",
    inverse: [],
    guard: { from: 0, to: 0, slice: null },
    metadata: {
      before: { frontmatter: "---\ntitle: New\n---\n\n", endmatter: null },
      after: { frontmatter: "---\ntitle: New\n---\n\n", endmatter: null },
    },
  };
  const initial = parse(source, hydrateReviewedChanges(parse(source), [entry]));
  let state = EditorState.create({ doc: initial });
  const at = state.doc.firstChild?.textContent.indexOf("New") ?? -1;
  state = state.apply(state.tr.insertText("Custom", at + 1, at + 4));
  expect(reopenReviewedChange(state, entry.id)).toBeNull();
  expect(editorStateToCriticMarkdown(state.doc.toJSON(), new Map())).toBe(
    source.replace("New", "Custom"),
  );
});

test("reopening an endmatter-only choice preserves newer in-document YAML fields", async () => {
  const { decideReviewChanges } = await import("./revision-bulk");
  const source =
    "---\ntitle: Original\n---\n\nBody.\n\n---\nsource: New metadata\ncomments:\n  c1:\n    body: Document feedback\n    by: user\n    at: 2026-11-28T01:00:00.000Z\n";
  let state = EditorState.create({ doc: parse(source) });
  state = state.apply(
    decideReviewChanges(
      state,
      parse(source.replace("New metadata", "Old metadata")),
      "new",
      "accept",
      true,
      "metadata",
    ),
  );
  const [archived] = reviewedChanges(state.doc);
  expect(archived.metadata).toBeDefined();
  const at = state.doc.firstChild?.textContent.indexOf("Original") ?? -1;
  state = state.apply(state.tr.insertText("Custom", at + 1, at + 9));
  const reopened = reopenReviewedChange(state, archived.id);
  expect(reopened).not.toBeNull();
  expect(reopened?.doc.firstChild?.textContent).toBe("title: Custom");
});
