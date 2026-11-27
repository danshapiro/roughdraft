import { expect, test } from "vitest";
import type { ComparisonReviewComment } from "./comparison-types";
import {
  restoreCommentHistory,
  remapCommentHistory,
} from "./revision-comment-history";
const comment = (id: string, content: string): ComparisonReviewComment => ({
  id,
  content,
  changeId: "document",
  createdAt: "2026-01-01",
});
test("comment Undo and Redo retain unrelated peer comments and fields", () => {
  const before = comment("c1", "Original");
  const after = { ...before, content: "Edited" };
  const peer = comment("c2", "Peer added");
  const current = [{ ...after, parentCommentId: "s1", changeId: "s1" }, peer];
  const entry = { before: [before], after: [after] };
  const undone = restoreCommentHistory(current, entry, "undo");
  expect(undone).toEqual([
    { ...before, parentCommentId: "s1", changeId: "s1" },
    peer,
  ]);
  expect(restoreCommentHistory(undone ?? [], entry, "redo")).toEqual(current);
});
test("an older local comment operation never overwrites newer peer wording", () => {
  const before = comment("c1", "Original");
  const after = { ...before, content: "Edited" };
  expect(
    restoreCommentHistory(
      [{ ...after, content: "Peer updated" }],
      { before: [before], after: [after] },
      "undo",
    ),
  ).toBeNull();
});

test("Undo a local addition accepts the canonical saved shape and retains a peer comment", () => {
  const added = comment("c1", "Added");
  const saved = {
    changeId: "document",
    createdAt: added.createdAt,
    content: added.content,
    id: added.id,
    parentCommentId: null,
  };
  const peer = comment("c2", "Peer");
  expect(
    restoreCommentHistory(
      [saved, peer],
      { before: [], after: [added] },
      "undo",
    ),
  ).toEqual([peer]);
});
test("renamed local comment History never acts on the peer item with its old number", () => {
  const before = comment("c5", "Original");
  const after = { ...before, content: "Edited" };
  const entry = remapCommentHistory(
    { before: [before], after: [after] },
    { c5: "c6" },
  );
  const peer = comment("c5", "Peer");
  expect(
    restoreCommentHistory([peer, { ...after, id: "c6" }], entry, "undo"),
  ).toEqual([peer, { ...before, id: "c6" }]);
});
test("an old comment operation refuses an independently created replacement with identical words", () => {
  const before = comment("c1", "Original");
  const after = { ...before, content: "Edited" };
  expect(
    restoreCommentHistory(
      [{ ...after, createdAt: "2026-02-01" }],
      { before: [before], after: [after] },
      "undo",
    ),
  ).toBeNull();
});
