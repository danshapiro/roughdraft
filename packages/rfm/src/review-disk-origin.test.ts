import { expect, test } from "vitest";
import {
  mergeReviewDrafts,
  renumberReviewDraft,
  reviewDraftSignature,
} from "./review-merge.js";
import type { SyncDraft } from "./review-sync.js";

const origin = {
  path: "/practice.md",
  signature: "acknowledged-disk",
  ids: { c1: "c2", s1: "s2" },
};
const draft = (markdown: string): SyncDraft => ({
  markdown,
  cleanMarkdown: markdown,
  decisions: {},
  reviewComments: [],
});

test("a stale page that omits optional disk ancestry preserves the authoritative aliases through a merge", () => {
  const base = draft("Alpha.\n\nBeta.\n");
  const incoming = { ...draft("Alpha.\n\nPeer Beta.\n"), diskOrigin: origin };
  const local = draft("Local Alpha.\n\nBeta.\n");
  const merged = mergeReviewDrafts(base, local, incoming);
  expect(merged.status).toBe("merged");
  expect(merged.draft.diskOrigin).toEqual(origin);
  expect(merged.draft.markdown).toBe("Local Alpha.\n\nPeer Beta.\n");
});

test("renumbering review identities updates only the review side of acknowledged disk aliases", () => {
  const value = { ...draft("A note.\n"), diskOrigin: origin };
  const renumbered = renumberReviewDraft(value, { c2: "c5", s2: "s7" });
  expect(renumbered.diskOrigin).toEqual({
    ...origin,
    ids: { c1: "c5", s1: "s7" },
  });
  expect(value.diskOrigin).toEqual(origin);
  expect(reviewDraftSignature(value)).not.toBe(
    reviewDraftSignature(renumbered),
  );
});
