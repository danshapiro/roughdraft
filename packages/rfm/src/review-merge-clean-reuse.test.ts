import { afterEach, expect, test, vi } from "vitest";
import * as rfm from "./index.js";
import type { SyncDraft } from "./review-sync.js";

afterEach(() => vi.restoreAllMocks());
const draft = (markdown: string, cleanMarkdown?: string): SyncDraft => ({
  markdown,
  ...(cleanMarkdown === undefined ? {} : { cleanMarkdown }),
  decisions: {},
  reviewComments: [],
});
function expectMerged(
  result: ReturnType<typeof rfm.mergeReviewDrafts>,
  expected: SyncDraft,
) {
  expect(result).toEqual({
    status: "merged",
    draft: expected,
    conflicts: [],
    signature: rfm.reviewDraftSignature(expected),
  });
}

test.each([
  "chosen input",
  "another input",
])("an exact client result retains explicit clean spelling despite a parity mismatch in %s without reprojecting it", (mismatch) => {
  const base = draft(
    "Before.\n",
    mismatch === "another input" ? "Earlier accepted spelling.\n" : "Before.\n",
  );
  const local = draft(
    "A {++pending++}{#s1} proposal.\n",
    mismatch === "chosen input"
      ? "Browser accepted spelling.\n"
      : "A  proposal.\n",
  );
  const project = vi.spyOn(rfm, "cleanRoughdraftMarkdown");
  const result = rfm.mergeReviewDrafts(base, local, base);
  expectMerged(result, local);
  expect(project).not.toHaveBeenCalled();
});

test("an explicit projected client result does not project unrelated source again", () => {
  const base = draft("Alpha.\n\nBeta.\n", "Earlier accepted spelling.\n");
  const local = draft("Alpha local.\n\nBeta.\n", "Local accepted spelling.\n");
  const incoming = draft(
    "Alpha.\n\nBeta incoming.\n",
    "Incoming accepted spelling.\n",
  );
  const project = vi.spyOn(rfm, "cleanRoughdraftMarkdown");
  const result = rfm.mergeReviewDrafts(base, local, incoming, {
    projectedCleanMarkdown: "Proven browser output.\n",
  });
  expectMerged(
    result,
    draft("Alpha local.\n\nBeta incoming.\n", "Proven browser output.\n"),
  );
  expect(project).not.toHaveBeenCalled();
});

test.each([
  true,
  false,
])("a legacy exact client input without a clean value keeps the original parity/fallback behavior (%s)", (parity) => {
  const base = draft(
    "Before.\n",
    parity ? "Before.\n" : "Earlier accepted spelling.\n",
  );
  const local = draft("Legacy local wording.\n");
  const project = vi.spyOn(rfm, "cleanRoughdraftMarkdown");
  const result = rfm.mergeReviewDrafts(base, local, base);
  expectMerged(result, {
    ...local,
    cleanMarkdown: parity ? local.markdown : undefined,
  });
  expect(Object.hasOwn(result.draft, "cleanMarkdown")).toBe(true);
  expect(project).toHaveBeenCalled();
});

test.each([
  true,
  false,
])("freshly combined client text keeps the original parity/fallback behavior (%s)", (parity) => {
  const before = "Alpha.\n\nBeta.\n";
  const left = "Alpha local.\n\nBeta.\n";
  const right = "Alpha.\n\nBeta incoming.\n";
  const project = vi.spyOn(rfm, "cleanRoughdraftMarkdown");
  const result = rfm.mergeReviewDrafts(
    draft(before, parity ? before : "Earlier accepted spelling.\n"),
    draft(left, left),
    draft(right, right),
  );
  const combined = "Alpha local.\n\nBeta incoming.\n";
  expectMerged(result, draft(combined, parity ? combined : undefined));
  expect(Object.hasOwn(result.draft, "cleanMarkdown")).toBe(parity);
  expect(project).toHaveBeenCalled();
});

test.each([
  0, 1, 2,
])("the server still rejects a parity mismatch in input %i before accepting an exact result or projected override", (mismatch) => {
  const sources = [
    draft("Before.\n", "Before.\n"),
    draft("Local.\n", "Local.\n"),
    draft("Before.\n", "Before.\n"),
  ];
  sources[mismatch].cleanMarkdown = "A different accepted spelling.\n";
  const project = vi.spyOn(rfm, "cleanRoughdraftMarkdown");
  const result = rfm.mergeReviewDrafts(sources[0], sources[1], sources[2], {
    server: true,
    projectedCleanMarkdown: "An override cannot bypass the server guard.\n",
  });
  expect(result).toMatchObject({
    status: "client-merge-required",
    reason:
      "The annotated and clean browser projections require client reconciliation.",
  });
  expect(project).toHaveBeenCalled();
});
