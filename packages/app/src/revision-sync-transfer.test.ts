import { expect, test } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import { receiveSyncState } from "./revision-sync-transfer";

const review = {
  id: "review",
  beforeText: "Exact original.\r\n",
  afterText: "Exact revised.\r\n",
  segments: [{ id: "original-change" }],
  revision: 1,
  destinationPath: "/original.md",
} as unknown as ComparisonReviewData;
const draft = {
  markdown: "New working text.\n",
  cleanMarkdown: "New working text.\n",
  decisions: {},
  reviewComments: [{ id: "c1", content: "Saved feedback" }],
};

test("compact updates retain frozen references while replacing mutable feedback and file guards", () => {
  const received = receiveSyncState(
    {
      reviewFormat: "compact-v1",
      review: {
        id: "review",
        revision: 2,
        destinationPath: "/moved.md",
        savedText: "Exact saved file.\r\n",
      },
      draft,
      revision: 2,
      disk: { path: "/moved.md", version: "latest" },
      diskTextFromReview: true,
      signature: "latest",
    },
    review,
  );
  expect(received.review.beforeText).toBe(review.beforeText);
  expect(received.review.afterText).toBe(review.afterText);
  expect(received.review.segments).toBe(review.segments);
  expect(received.review.destinationPath).toBe("/moved.md");
  expect(received.review.revision).toBe(2);
  expect(received.review.reviewComments).toEqual(draft.reviewComments);
  expect(received.review.draft).toEqual(draft);
  expect(received.disk?.version).toBe("latest");
  expect(received.disk?.text).toBe("Exact saved file.\r\n");
});

test("a compact update cannot reuse another review's frozen references", () => {
  expect(() =>
    receiveSyncState(
      {
        reviewFormat: "compact-v1",
        review: { id: "another-review" },
        draft,
      },
      review,
    ),
  ).toThrow(/different review/i);
});

test("full old-server and new-copy states remain self-contained", () => {
  const full = {
    review: { ...review, id: "copy", beforeText: "Copy original" },
    draft,
  };
  expect(receiveSyncState(full, review)).toBe(full);
});

test("a compact update cannot replace changed references with stale ones", () => {
  expect(() =>
    receiveSyncState(
      {
        reviewFormat: "compact-v1",
        review: { id: review.id, referenceVersion: "different-reference" },
        draft,
      },
      { ...review, referenceVersion: "original-reference" },
    ),
  ).toThrow(/references changed/i);
});
