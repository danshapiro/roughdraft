import { afterEach, expect, test, vi } from "vitest";
import * as rfm from "./index.js";
import type { SyncDraft } from "./review-sync.js";
import * as values from "./review-values.js";
import * as yaml from "./review-yaml.js";

afterEach(() => vi.restoreAllMocks());
const markdown = [
  "---",
  "title: Source reuse",
  "---",
  "",
  "A {==shared passage==}{>>Keep this discussion.<<}{#c1}.",
  "",
  "---",
  "comments:",
  "  c1:",
  "    by: AI",
  '    at: "2026-11-22T12:00:00.000Z"',
  "",
].join("\n");
function draft(): SyncDraft {
  return {
    markdown,
    cleanMarkdown: rfm.cleanRoughdraftMarkdown(markdown),
    decisions: {},
    reviewComments: [],
  };
}

test("one merge reuses exact source work while keeping each draft's decisions", () => {
  const base = draft();
  const local = { ...draft(), decisions: { s1: "kept" as const } };
  const incoming = { ...draft(), decisions: { s2: "kept" as const } };
  const scan = vi.spyOn(rfm, "scanRoughdraftReview");
  const split = vi.spyOn(yaml, "splitReviewSource");
  const clean = vi.spyOn(rfm, "cleanRoughdraftMarkdown");
  const signature = vi.spyOn(values, "reviewDraftSignature");
  const result = rfm.mergeReviewDrafts(base, local, incoming, {
    server: true,
    budgetMs: 100,
  });
  expect(result.status).toBe("merged");
  expect(result.draft).toEqual({
    ...base,
    decisions: { s1: "kept", s2: "kept" },
  });
  expect(scan).toHaveBeenCalledTimes(1);
  expect(split).toHaveBeenCalledTimes(1);
  expect(clean).toHaveBeenCalledTimes(1);
  expect(signature).toHaveBeenCalledTimes(1);

  // Reuse belongs to this invocation; later work must inspect its own inputs.
  scan.mockClear();
  split.mockClear();
  clean.mockClear();
  expect(rfm.mergeReviewDrafts(base, local, incoming).status).toBe("merged");
  expect(scan).toHaveBeenCalledTimes(1);
  expect(split).toHaveBeenCalledTimes(1);
});

test.each([
  0, 1, 2,
])("identical source reuse never skips a differing clean projection on side %i", (side) => {
  const drafts = [draft(), draft(), draft()];
  drafts[side].cleanMarkdown = "Different accepted text.\n";
  const scan = vi.spyOn(rfm, "scanRoughdraftReview");
  const clean = vi.spyOn(rfm, "cleanRoughdraftMarkdown");
  const result = rfm.mergeReviewDrafts(drafts[0], drafts[1], drafts[2], {
    server: true,
    budgetMs: 100,
  });
  expect(result).toMatchObject({
    status: "client-merge-required",
    reason:
      "The annotated and clean browser projections require client reconciliation.",
  });
  expect(scan).toHaveBeenCalledTimes(1);
  expect(clean).toHaveBeenCalledTimes(1);
});
