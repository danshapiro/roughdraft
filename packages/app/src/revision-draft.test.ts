import { expect, test } from "vitest";
import type { ComparisonReviewComment } from "./comparison-types";
import { equalRevisionDraft } from "./revision-draft";

const comment: ComparisonReviewComment = {
  id: "c1",
  content: "Clarify this",
  createdAt: "2026-11-21T00:00:00.000Z",
  authorType: "user",
  changeId: "document",
};
const draft = {
  markdown: "A draft\n",
  decisions: { a: "kept", b: "kept" } as const,
  reviewComments: [comment],
};

test("the saved review acknowledges normalized comment fields and reordered JSON keys", () => {
  const savedComment: ComparisonReviewComment = {
    changeId: "document",
    createdAt: comment.createdAt,
    content: comment.content,
    id: "c1",
    authorType: "user",
    authorId: null,
    parentCommentId: null,
  };
  expect(
    equalRevisionDraft(draft, {
      ...draft,
      cleanMarkdown: draft.markdown,
      decisions: { b: "kept", a: "kept" },
      reviewComments: [savedComment],
    }),
  ).toBe(true);
});

test("different text, decisions or feedback still require saving and cannot acknowledge another browser", () => {
  expect(
    equalRevisionDraft(draft, { ...draft, markdown: "Another draft\n" }),
  ).toBe(false);
  expect(
    equalRevisionDraft(draft, { ...draft, decisions: { a: "kept" } }),
  ).toBe(false);
  expect(
    equalRevisionDraft(draft, {
      ...draft,
      reviewComments: [{ ...comment, content: "Another comment" }],
    }),
  ).toBe(false);
  expect(equalRevisionDraft(draft, { ...draft, reviewComments: [] })).toBe(
    false,
  );
});

test("saved reviewed decisions acknowledge the API's field order without hiding changed decisions", () => {
  const reviewed = {
    id: "decision-1",
    decision: "accept" as const,
    oldText: "old",
    newText: "new",
    keptId: "ref-1",
    inverse: [],
    guard: { from: 1, to: 4, slice: null },
  };
  const saved = {
    id: reviewed.id,
    decision: reviewed.decision,
    oldText: reviewed.oldText,
    newText: reviewed.newText,
    inverse: reviewed.inverse,
    guard: reviewed.guard,
    keptId: reviewed.keptId,
    stale: false,
  };
  expect(
    equalRevisionDraft(
      { ...draft, reviewed: [reviewed] },
      { ...draft, reviewed: [saved] },
    ),
  ).toBe(true);
  expect(
    equalRevisionDraft(
      { ...draft, reviewed: [reviewed] },
      { ...draft, reviewed: [{ ...saved, decision: "reject" }] },
    ),
  ).toBe(false);
});
