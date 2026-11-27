import { cleanRoughdraftMarkdown, mergeReviewDrafts } from "@roughdraft/rfm";
import { Extension, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { applySuggestionDecisions } from "./review-decisions";
import { decideReviewChanges, suggestionDetail } from "./revision-bulk";
import {
  mapReviewedChanges,
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import { outcomeDocument } from "./revision-outcomes";
import { suggestionPositions } from "./revision-projection";
import { referenceChanges, revertReferenceChange } from "./revision-reference";

const schema = getSchema([
  ...createEditorExtensions(""),
  Extension.create({
    name: "historyTest",
    addGlobalAttributes: () => [
      {
        types: ["doc"],
        attributes: { kept: { default: [] }, reviewed: { default: [] } },
      },
    ],
  }),
]);
const doc = (text: string) =>
  schema.nodeFromJSON(criticMarkdownToEditorState(text).doc);

describe("durable review decisions", () => {
  it.each([
    false,
    true,
  ])("merges two independently produced new decisions without reusing one History identity (server=%s)", (server) => {
    const original = doc(
      "Use {~~red~>blue~~}{#s1}.\n\nChoose {~~small~>large~~}{#s2}.",
    );
    const snapshot = (state: EditorState) => {
      const markdown = editorStateToCriticMarkdown(
        state.doc.toJSON(),
        new Map(),
      );
      return {
        markdown,
        cleanMarkdown: cleanRoughdraftMarkdown(markdown),
        decisions: {},
        reviewComments: [],
        reviewed: reviewedChanges(state.doc),
      };
    };
    const decide = (id: string, oldText: string, newText: string) => {
      const state = EditorState.create({ doc: original });
      const transaction = state.tr;
      applySuggestionDecisions(transaction, [id], "accept");
      return state.apply(
        recordReviewedChange(
          transaction,
          { decision: "accept", oldText, newText },
          suggestionDetail(original, id),
        ),
      );
    };
    const first = decide("s1", "red", "blue");
    const second = decide("s2", "small", "large");
    const merged = mergeReviewDrafts(
      snapshot(EditorState.create({ doc: original })),
      snapshot(first),
      snapshot(second),
      { server, budgetMs: 1000 },
    );

    expect(merged.status).toBe("merged");
    expect(merged.idRemap).toBeUndefined();
    expect(merged.conflicts).toEqual([]);
    expect(merged.draft.cleanMarkdown).toContain("Use blue.");
    expect(merged.draft.cleanMarkdown).toContain("Choose large.");
    expect(merged.draft.reviewed).toHaveLength(2);
    expect(new Set(merged.draft.reviewed?.map((item) => item.id)).size).toBe(2);
    expect(merged.draft.reviewed?.map((item) => item.newText).sort()).toEqual([
      "blue",
      "large",
    ]);
  });

  it.each([
    "single",
    "bulk",
  ] as const)("creates independent History identities without secure-context crypto for %s decisions", (producer) => {
    const original = doc("Use {~~red~>blue~~}{#s1}.");
    vi.stubGlobal("crypto", undefined);
    try {
      const produce = () => {
        const state = EditorState.create({ doc: original });
        if (producer === "bulk")
          return state.apply(
            decideReviewChanges(state, null, "new", "accept", true),
          );
        const transaction = state.tr;
        applySuggestionDecisions(transaction, ["s1"], "accept");
        return state.apply(
          recordReviewedChange(
            transaction,
            { decision: "accept", oldText: "red", newText: "blue" },
            suggestionDetail(original, "s1"),
          ),
        );
      };
      const first = reviewedChanges(produce().doc);
      const second = reviewedChanges(produce().doc);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0].id).not.toBe(second[0].id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves and reopens existing numeric identities alongside a newly recorded decision", () => {
    const original = doc(
      "Use {~~red~>blue~~}{#s1}.\n\nChoose {~~small~>large~~}{#s2}.",
    );
    let state = EditorState.create({ doc: original });
    const decide = (id: string, oldText: string, newText: string) => {
      const transaction = state.tr;
      applySuggestionDecisions(transaction, [id], "accept");
      state = state.apply(
        recordReviewedChange(
          transaction,
          { decision: "accept", oldText, newText },
          suggestionDetail(state.doc, id),
        ),
      );
    };
    decide("s1", "red", "blue");
    const serialized = state.doc.toJSON();
    if (!serialized.attrs) throw new Error("The fixture must persist History");
    serialized.attrs.reviewed[0].id = "decision-7";
    state = EditorState.create({ doc: schema.nodeFromJSON(serialized) });
    decide("s2", "small", "large");
    const [existing, added] = reviewedChanges(state.doc);
    expect(existing.id).toBe("decision-7");
    expect(added.id).not.toBe(existing.id);

    for (const entry of [existing, added]) {
      const reopened = reopenReviewedChange(state, entry.id);
      if (!reopened) throw new Error("A persisted decision must remain usable");
      state = state.apply(reopened);
    }
    expect(state.doc.content.eq(original.content)).toBe(true);
    expect(reviewedChanges(state.doc)).toEqual([]);
  });

  it("reopening a group clears every related reference decision and restores its suggestion", () => {
    const current = doc("Use {~~red and small~>green and huge~~}{#s1}.");
    const reference = doc("Use blue and large.");
    const decided = decideReviewChanges(
      EditorState.create({ doc: current }),
      reference,
      "old",
      "reject",
      true,
    );
    expect(decided.doc.attrs.kept.length).toBeGreaterThan(0);
    let state = EditorState.create({ doc: decided.doc });
    for (const change of reviewedChanges(decided.doc)) {
      const reopened = reopenReviewedChange(state, change.id);
      if (!reopened) throw new Error("Cannot reopen grouped decision");
      state = state.apply(reopened);
    }
    expect(state.doc.attrs.kept).toEqual([]);
    expect(state.doc.content.eq(current.content)).toBe(true);
  });

  it("preserves a suffix edit when reopening a length-changing suggestion", () => {
    const original = doc(
      "Prefix {~~a very lengthy old wording~>x~~}{#s1} suffix.",
    );
    let state = EditorState.create({ doc: original });
    const transaction = state.tr;
    applySuggestionDecisions(transaction, ["s1"], "accept");
    state = state.apply(
      recordReviewedChange(
        transaction,
        {
          decision: "accept",
          oldText: "a very lengthy old wording",
          newText: "x",
        },
        suggestionDetail(original, "s1"),
      ),
    );
    const archived = reviewedChanges(state.doc)[0];
    const edit = state.tr.insertText(" ADDED", archived.guard.to + 2);
    edit.setDocAttribute(
      "reviewed",
      mapReviewedChanges(reviewedChanges(state.doc), edit),
    );
    state = state.apply(edit);
    const reopened = reopenReviewedChange(state, archived.id);
    expect(reopened?.doc.textContent).toBe(
      original.textContent.replace("suffix", "s ADDEDuffix"),
    );
    expect(
      reopened && editorStateToCriticMarkdown(reopened.doc.toJSON(), new Map()),
    ).toContain("{~~a very lengthy old wording~>x~~}");
  });

  it("keeps a stale zero-width passage valid for persistence when new text is typed at its anchor", () => {
    let state = EditorState.create({ doc: doc("A {++new++}{#s1} word.") });
    const transaction = state.tr;
    applySuggestionDecisions(transaction, ["s1"], "reject");
    state = state.apply(
      recordReviewedChange(
        transaction,
        { decision: "reject", oldText: "", newText: "new" },
        suggestionDetail(state.doc, "s1"),
      ),
    );
    const archived = reviewedChanges(state.doc)[0];
    const edit = state.tr.insertText("replacement", archived.guard.from);
    const [mapped] = mapReviewedChanges([archived], edit);
    expect(mapped.stale).toBe(true);
    expect(mapped.guard.from).toBeLessThanOrEqual(mapped.guard.to);
  });

  it("bulk rejection matches its preview and preserves both future previews for overlapping changes", () => {
    const before = doc("Use red markers.");
    const current = doc("Use bl{~~ue~>ack~~}{#s1} markers.");
    const state = EditorState.create({ doc: current });
    const preview = outcomeDocument(current, before, "new", "reject");
    const rejected = decideReviewChanges(
      state,
      before,
      "new",
      "reject",
      true,
    ).doc;
    expect(rejected.textContent).toBe(preview.textContent);
    expect(rejected.textContent).toBe("Use red markers.");
    expect(reviewedChanges(rejected)).toHaveLength(1);
    expect(outcomeDocument(rejected, before, "new", "accept").textContent).toBe(
      "Use black markers.",
    );
    expect(outcomeDocument(rejected, before, "new", "reject").textContent).toBe(
      "Use red markers.",
    );
    const reopened = reopenReviewedChange(
      EditorState.create({ doc: rejected }),
      reviewedChanges(rejected)[0].id,
    );
    expect(reopened?.doc.content.eq(current.content)).toBe(true);
  });

  it("bulk decisions reopen a block-spanning inline suggestion without deleting its prefix or suffix", () => {
    for (const decision of ["accept", "reject"] as const) {
      const original = doc(
        "Lead {~~old\n\npara~>new\n\npara~~}{#s1} tail.\n\nUntouched.",
      );
      const transaction = decideReviewChanges(
        EditorState.create({ doc: original }),
        null,
        "new",
        decision,
        true,
      );
      const state = EditorState.create({ doc: transaction.doc });
      const reopened = reopenReviewedChange(
        state,
        reviewedChanges(state.doc)[0].id,
      );
      expect(reopened?.doc.content.eq(original.content)).toBe(true);
    }
  });

  it("reopens a rejected passage after serialization while retaining a later unrelated insertion", () => {
    const before = doc("Use red.\n\nKeep the door open.");
    let state = EditorState.create({
      doc: doc("Use blue.\n\nKeep the door shut."),
    });
    const change = referenceChanges(before, state.doc)[0];
    const rejected = revertReferenceChange(state, change);
    if (!rejected) throw new Error("Cannot reject fixture passage");
    state = state.apply(
      recordReviewedChange(
        rejected,
        { decision: "reject", oldText: "red", newText: "blue" },
        change,
      ),
    );
    const edit = state.tr.insertText("Please ", 1);
    edit.setDocAttribute(
      "reviewed",
      mapReviewedChanges(reviewedChanges(state.doc), edit),
    );
    state = state.apply(edit);
    state = EditorState.create({
      doc: schema.nodeFromJSON(JSON.parse(JSON.stringify(state.doc.toJSON()))),
    });
    const transaction = reopenReviewedChange(
      state,
      reviewedChanges(state.doc)[0].id,
    );
    expect(transaction?.doc.textContent).toBe(
      "Please Use blue.Keep the door shut.",
    );
  });

  it("refuses to overwrite a passage rewritten after the decision", () => {
    const original = doc("Use red.");
    let state = EditorState.create({ doc: doc("Use blue.") });
    const change = referenceChanges(original, state.doc)[0];
    state = state.apply(
      recordReviewedChange(
        state.tr.setDocAttribute("kept", [change.item.changeId]),
        {
          decision: "accept",
          oldText: "red",
          newText: "blue",
          keptId: change.item.changeId,
        },
        change,
      ),
    );
    const edit = state.tr.insertText("green", change.from, change.to);
    edit.setDocAttribute(
      "reviewed",
      mapReviewedChanges(reviewedChanges(state.doc), edit),
    );
    state = state.apply(edit);
    const archived = reviewedChanges(state.doc)[0];
    expect(archived.stale).toBe(true);
    expect(reopenReviewedChange(state, archived.id)).toBeNull();
    expect(state.doc.textContent).toBe("Use green.");
  });

  it("reopens a native suggestion after either decision", () => {
    for (const decision of ["accept", "reject"] as const) {
      let state = EditorState.create({ doc: doc("Use {~~red~>blue~~}{#s1}.") });
      const transaction = state.tr;
      applySuggestionDecisions(transaction, ["s1"], decision);
      state = state.apply(
        recordReviewedChange(
          transaction,
          { decision, oldText: "red", newText: "blue" },
          { from: 5, to: 12 },
        ),
      );
      state = EditorState.create({
        doc: schema.nodeFromJSON(state.doc.toJSON()),
      });
      const reopened = reopenReviewedChange(
        state,
        reviewedChanges(state.doc)[0].id,
      );
      if (!reopened) throw new Error("Cannot reopen fixture suggestion");
      expect([...suggestionPositions(reopened.doc).keys()]).toEqual(["s1"]);
    }
  });

  it("previews both complete outcomes after decisions without mutating the review", () => {
    const before = doc(
      "Use red.\n\nChoose small.\n\nDisplay {~~old~>new~~}{#s1} sign.",
    );
    let state = EditorState.create({
      doc: doc(
        "Use blue.\n\nChoose large.\n\nDisplay {~~old~>new~~}{#s1} sign.",
      ),
    });
    const change = referenceChanges(before, state.doc)[0];
    const rejected = revertReferenceChange(state, change);
    if (!rejected) throw new Error("Cannot reject fixture passage");
    state = state.apply(
      recordReviewedChange(
        rejected,
        { decision: "reject", oldText: "red", newText: "blue" },
        change,
      ),
    );
    const snapshot = state.doc.toJSON();
    expect(
      outcomeDocument(state.doc, before, "new", "accept").textContent,
    ).toBe("Use blue.Choose large.Display new sign.");
    expect(
      outcomeDocument(state.doc, before, "new", "reject").textContent,
    ).toBe("Use red.Choose small.Display old sign.");
    expect(state.doc.toJSON()).toEqual(snapshot);
  });
});
