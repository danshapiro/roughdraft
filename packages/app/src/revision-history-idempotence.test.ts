import { Extension, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
// Exercise the workspace source while qualified browser artifacts stay frozen.
import {
  cleanRoughdraftMarkdown,
  mergeReviewDrafts,
  reviewDraftSignature,
} from "../../rfm/src/index";
import {
  createCriticChange,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
import {
  mapRemoteReviewedChanges,
  mapReviewedChanges,
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import { remapReviewIdentity } from "./revision-identity";
import { suggestionPositions } from "./revision-projection";
import { referenceChangeIds, referenceChanges } from "./revision-reference";
import { replaceRevisionContent } from "./revision-remote-source";

const schema = getSchema([
  ...createEditorExtensions(""),
  Extension.create({
    name: "historyIdentityFixture",
    addGlobalAttributes: () => [
      {
        types: ["doc"],
        attributes: { kept: { default: [] }, reviewed: { default: [] } },
      },
    ],
  }),
]);
function initial() {
  return EditorState.create({
    doc: schema.nodeFromJSON(
      criticMarkdownToEditorState(
        "First {~~old~>new~~}{#s1}.\n\nSecond {~~old~>new~~}{#s2}.",
      ).doc,
    ),
  });
}
function decide(state: EditorState, id: string) {
  const transaction = state.tr;
  applySuggestionDecisions(transaction, [id], "accept");
  const detail = suggestionDetail(state.doc, id);
  return state.apply(
    recordReviewedChange(
      transaction,
      {
        decision: "accept",
        oldText: detail.oldText,
        newText: detail.newText,
        keptIds: [id],
      },
      detail,
    ),
  );
}
function snapshot(state: EditorState) {
  const markdown = editorStateToCriticMarkdown(state.doc.toJSON(), new Map());
  return {
    markdown,
    cleanMarkdown: cleanRoughdraftMarkdown(markdown),
    decisions: Object.fromEntries(
      (state.doc.attrs.kept ?? []).map((id: string) => [id, "kept" as const]),
    ),
    reviewComments: [],
    reviewed: reviewedChanges(state.doc),
  };
}

function inverseOnlyCollision() {
  const base = EditorState.create({
    doc: schema.nodeFromJSON(
      criticMarkdownToEditorState(
        "First.\n\nSecond.\n\nExisting {++shared++}{#s9}.",
      ).doc,
    ),
  });
  const addAndDecide = (paragraph: number) => {
    let position = 1;
    for (let index = 0; index < paragraph; index++)
      position += base.doc.child(index).nodeSize;
    position += base.doc.child(paragraph).textContent.length - 1;
    const proposal = createCriticChange("addition", undefined, {
      existingChanges: [{ changeId: "s9" }],
    });
    const added = base.apply(
      base.tr
        .insertText(" new", position)
        .addMark(
          position,
          position + " new".length,
          schema.marks.criticChange.create(proposal),
        ),
    );
    return decide(added, proposal.changeId);
  };
  return { base, left: addAndDecide(0), right: addAndDecide(1) };
}

test.each([
  false,
  true,
])("the same new decision arriving twice keeps its inverse identity (newer typing: %s)", (newerTyping) => {
  const { base, left } = inverseOnlyCollision();
  const transaction = left.tr.insertText("Local prefix. ", 1);
  const local = newerTyping
    ? left.apply(
        transaction.setDocAttribute(
          "reviewed",
          mapReviewedChanges(reviewedChanges(left.doc), transaction),
        ),
      )
    : left;
  const submitted = snapshot(local);
  for (const options of [{}, { server: true }]) {
    const merged = mergeReviewDrafts(
      snapshot(base),
      submitted,
      snapshot(left),
      options,
    );
    expect(merged.status).toBe("merged");
    expect(merged.idRemap).toBeUndefined();
    expect(merged.draft.markdown).toBe(submitted.markdown);
    expect(merged.draft.reviewed).toHaveLength(1);
    expect(merged.draft.reviewed?.[0].keptIds).toEqual(
      reviewedChanges(left.doc)[0].keptIds,
    );
  }
});

test("legacy sequential History IDs still preserve independent inverse owners", () => {
  const { base, left, right } = inverseOnlyCollision();
  const legacy = (state: EditorState) => ({
    ...snapshot(state),
    reviewed: reviewedChanges(state.doc).map((entry) => ({
      ...entry,
      id: "decision-1",
    })),
  });
  const merged = mergeReviewDrafts(snapshot(base), legacy(left), legacy(right));
  expect(merged.status).toBe("merged");
  expect(merged.draft.reviewed).toHaveLength(2);
  expect(
    new Set(merged.draft.reviewed?.flatMap((entry) => entry.keptIds ?? []))
      .size,
  ).toBe(2);
});

test.each([
  "accept",
  "reject",
] as const)("inverse-only proposal collisions reopen as distinct targets before %s", (decision) => {
  const { base, left, right } = inverseOnlyCollision();
  const merged = mergeReviewDrafts(
    snapshot(base),
    snapshot(left),
    snapshot(right),
  );
  expect(merged.status).toBe("merged");
  expect(merged.draft.reviewed).toHaveLength(2);
  const normalizedLeft = merged.idRemap
    ? left.apply(remapReviewIdentity(left, merged.idRemap))
    : left;
  const origins = [base, normalizedLeft, right];
  const parsed = schema.nodeFromJSON(
    criticMarkdownToEditorState(merged.draft.markdown).doc,
  );
  const mapped = (merged.draft.reviewed ?? []).map((entry) => {
    const origin = origins.find(
      (state) =>
        reviewDraftSignature(snapshot(state)) === entry.originSignature,
    );
    if (!origin)
      throw new Error("Every shifted decision needs its actual origin");
    return mapRemoteReviewedChanges(
      [entry],
      replaceRevisionContent(origin, parsed),
    )[0];
  });
  let current = EditorState.create({
    doc: parsed.type.create(
      { ...parsed.attrs, reviewed: mapped },
      parsed.content,
    ),
  });
  for (const entry of mapped) {
    const reopened = reopenReviewedChange(current, entry.id);
    if (!reopened) throw new Error("Both actual decision passages must reopen");
    current = current.apply(reopened);
  }
  const restoredCount = suggestionPositions(current.doc).size;
  let target: string | undefined;
  current.doc.child(0).descendants((node) => {
    target ??= node.marks.find((mark) => mark.type.name === "criticChange")
      ?.attrs.changeId;
  });
  if (!target) throw new Error("The first passage needs its restored proposal");
  const transaction = current.tr;
  applySuggestionDecisions(transaction, [target], decision);
  expect(transaction.doc.child(0).textContent).toBe(
    decision === "accept" ? "First new." : "First.",
  );
  expect(transaction.doc.child(1).textContent).toBe("Second new.");
  expect(suggestionPositions(transaction.doc).size).toBe(2);
  expect(suggestionPositions(transaction.doc).has("s9")).toBe(true);
  expect(suggestionPositions(transaction.doc).has(target)).toBe(false);
  expect(restoredCount).toBe(3);
});

test("the server defers inverse-only new proposal collisions to browser-owned renumbering", () => {
  const { base, left, right } = inverseOnlyCollision();
  expect(
    mergeReviewDrafts(snapshot(base), snapshot(left), snapshot(right), {
      server: true,
      budgetMs: 1000,
    }).status,
  ).toBe("client-merge-required");
});

test.each([
  false,
  true,
])("two new decisions for the same existing proposal produce one reopenable History event (server=%s)", (server) => {
  const base = initial();
  const left = decide(base, "s1");
  const right = decide(base, "s1");
  const merged = mergeReviewDrafts(
    snapshot(base),
    snapshot(left),
    snapshot(right),
    {
      server,
      budgetMs: 1000,
    },
  );
  expect(merged.status).toBe("merged");
  expect(merged.draft.reviewed).toHaveLength(1);
  const parsed = criticMarkdownToEditorState(merged.draft.markdown);
  const current = EditorState.create({
    doc: schema.nodeFromJSON({
      ...parsed.doc,
      attrs: { ...parsed.doc.attrs, reviewed: merged.draft.reviewed },
    }),
  });
  const reopened = reopenReviewedChange(
    current,
    reviewedChanges(current.doc)[0].id,
  );
  expect(reopened).not.toBeNull();
  if (!reopened)
    throw new Error("The coalesced decision must remain reversible");
  expect([...suggestionPositions(reopened.doc).keys()].sort()).toEqual([
    "s1",
    "s2",
  ]);
  expect(reviewedChanges(reopened.doc)).toEqual([]);
});

test("identical wording at two different proposal IDs remains two decisions", () => {
  const base = initial();
  const merged = mergeReviewDrafts(
    snapshot(base),
    snapshot(decide(base, "s1")),
    snapshot(decide(base, "s2")),
  );
  expect(merged.status).toBe("merged");
  expect(merged.draft.reviewed).toHaveLength(2);
  expect(
    merged.draft.reviewed?.map((entry) => entry.keptIds?.[0]).sort(),
  ).toEqual(["s1", "s2"]);
});

test("the same real reference passage is kept once and remains reopenable", () => {
  const source = (markdown: string) =>
    schema.nodeFromJSON(criticMarkdownToEditorState(markdown).doc);
  const reference = source("Use old.");
  const base = EditorState.create({ doc: source("Use new.") });
  const change = referenceChanges(reference, base.doc)[0];
  const ids = referenceChangeIds(change);
  const keep = () =>
    base.apply(
      recordReviewedChange(
        base.tr.setDocAttribute("kept", ids),
        {
          decision: "accept",
          oldText: change.item.oldText,
          newText: change.item.newText,
          keptIds: ids,
        },
        change,
      ),
    );
  const merged = mergeReviewDrafts(
    snapshot(base),
    snapshot(keep()),
    snapshot(keep()),
  );
  expect(merged.status).toBe("merged");
  expect(merged.draft.reviewed).toHaveLength(1);
  const current = EditorState.create({
    doc: base.doc.type.create(
      { ...base.doc.attrs, kept: ids, reviewed: merged.draft.reviewed },
      base.doc.content,
    ),
  });
  const reopened = reopenReviewedChange(
    current,
    reviewedChanges(current.doc)[0].id,
  );
  expect(reopened?.doc.attrs.kept).toEqual([]);
  expect(reopened?.doc.textContent).toBe("Use new.");
});

test("reopening and deciding again preserves the later event", () => {
  const base = decide(initial(), "s1");
  const previous = reviewedChanges(base.doc)[0];
  const reopen = reopenReviewedChange(base, previous.id);
  if (!reopen) throw new Error("The original decision must reopen");
  const later = decide(base.apply(reopen), "s1");
  const next = reviewedChanges(later.doc)[0];
  const merged = mergeReviewDrafts(
    snapshot(base),
    snapshot(later),
    snapshot(base),
  );
  expect(merged.status).toBe("merged");
  expect(merged.draft.reviewed?.map((entry) => entry.id)).toEqual([next.id]);
  expect(next.id).not.toBe(previous.id);
});

test("entries without a shared source identity are not combined by wording", () => {
  const base = initial();
  const left = snapshot(decide(base, "s1"));
  const right = snapshot(decide(base, "s1"));
  for (const draft of [left, right])
    draft.reviewed = draft.reviewed.map(
      ({ keptIds: _keptIds, ...entry }) => entry,
    );
  const merged = mergeReviewDrafts(snapshot(base), left, right);
  expect(merged.status).toBe("merged");
  expect(merged.draft.reviewed).toHaveLength(2);
});

test("equal newly allocated proposal IDs at different passages are not mistaken for one existing source", () => {
  const state = (markdown: string) =>
    EditorState.create({
      doc: schema.nodeFromJSON(criticMarkdownToEditorState(markdown).doc),
    });
  const base = state("First.\n\nSecond.");
  const left = decide(state("First{++ new++}{#s1}.\n\nSecond."), "s1");
  const right = decide(state("First.\n\nSecond{++ new++}{#s1}."), "s1");
  const merged = mergeReviewDrafts(
    snapshot(base),
    snapshot(left),
    snapshot(right),
  );
  expect(merged.status).toBe("merged");
  expect(merged.draft.cleanMarkdown).toContain("First new.");
  expect(merged.draft.cleanMarkdown).toContain("Second new.");
  expect(merged.draft.reviewed).toHaveLength(2);
});

test("combining the same new action retains a locally invalidated inverse", () => {
  const base = initial();
  let left = decide(base, "s1");
  const right = decide(base, "s1");
  const range = reviewedChanges(left.doc)[0].guard;
  const replace = (from: number, to: number, text: string) => {
    const transaction = left.tr.insertText(text, from, to);
    transaction.setDocAttribute(
      "reviewed",
      mapReviewedChanges(reviewedChanges(left.doc), transaction),
    );
    left = left.apply(transaction);
  };
  replace(range.from, range.to, "changed");
  replace(range.from, range.from + "changed".length, "new");
  expect(reviewedChanges(left.doc)[0].stale).toBe(true);
  expect(snapshot(left).markdown).toBe(snapshot(right).markdown);
  const merged = mergeReviewDrafts(
    snapshot(base),
    snapshot(left),
    snapshot(right),
  );
  expect(merged.status).toBe("merged");
  expect(merged.draft.reviewed).toHaveLength(1);
  expect(merged.draft.reviewed?.[0].stale).toBe(true);
  expect(merged.draft.reviewed?.[0].staleReason).not.toBe("needs-remap");
});
