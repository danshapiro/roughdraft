import type { ComparisonReviewComment } from "./comparison-types";
import { renumberReviewDraft, sameReviewDraft } from "@roughdraft/rfm";
export interface CommentHistoryEntry {
  before: ComparisonReviewComment[];
  after: ComparisonReviewComment[];
}
export function restoreCommentHistory(
  current: ComparisonReviewComment[],
  entry: CommentHistoryEntry,
  direction: "undo" | "redo",
): ComparisonReviewComment[] | null {
  const [expected, target] =
    direction === "undo"
      ? [entry.after, entry.before]
      : [entry.before, entry.after];
  const maps = [expected, target, current].map(
    (items) => new Map(items.map((item) => [item.id, item])),
  );
  const [previous, wanted, result] = maps;
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const sameComment = (
    a: ComparisonReviewComment | undefined,
    b: ComparisonReviewComment | undefined,
  ) =>
    a && b
      ? sameReviewDraft(
          { markdown: "", decisions: {}, reviewComments: [a] },
          { markdown: "", decisions: {}, reviewComments: [b] },
        )
      : a === b;
  for (const id of new Set([...previous.keys(), ...wanted.keys()])) {
    const before = previous.get(id);
    const after = wanted.get(id);
    const live = result.get(id);
    if (!before || !after) {
      if (sameComment(before, after)) continue;
      if (!sameComment(before, live)) return null;
      if (after) result.set(id, after);
      else result.delete(id);
      continue;
    }
    if (live && live.createdAt !== before.createdAt) return null;
    const next = { ...live };
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      const field = key as keyof ComparisonReviewComment;
      if (same(before[field], after[field])) continue;
      if (!live || !same(live[field], before[field])) return null;
      if (after[field] === undefined) delete next[field];
      else Object.assign(next, { [field]: after[field] });
    }
    if (live) result.set(id, next as ComparisonReviewComment);
  }
  const children = new Set(
    [...result.values()]
      .filter(
        (comment) =>
          comment.parentCommentId &&
          !result.has(comment.parentCommentId) &&
          previous.has(comment.parentCommentId),
      )
      .map((comment) => comment.id),
  );
  if (children.size) return null;
  return [...result.values()];
}
export function remapCommentHistory(
  entry: CommentHistoryEntry,
  ids: Record<string, string>,
): CommentHistoryEntry {
  const remap = (comments: ComparisonReviewComment[]) =>
    renumberReviewDraft(
      { markdown: "", decisions: {}, reviewComments: comments },
      ids,
    ).reviewComments;
  return { before: remap(entry.before), after: remap(entry.after) };
}
