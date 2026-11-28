import type {
  ComparisonReviewComment,
  EditorDraft,
  ReviewedChange,
} from "./comparison-types";

interface ReviewDraft extends EditorDraft {
  reviewComments: ComparisonReviewComment[];
}

function commentValues(comments: ComparisonReviewComment[]) {
  // The API validates and rebuilds objects. Key order and omitted nullable
  // fields carry no meaning when acknowledging the same saved feedback.
  return comments.map((comment) => [
    comment.id,
    comment.changeId,
    comment.content,
    comment.createdAt,
    comment.authorType ?? null,
    comment.authorId ?? null,
    comment.parentCommentId ?? null,
    comment.scope ?? null,
  ]);
}

function reviewValues(changes: ReviewedChange[] = []) {
  return changes.map((change) => [
    change.id,
    Boolean(change.frontmatterInContent),
    change.decision,
    change.oldText,
    change.newText,
    change.inverse,
    change.guard.from,
    change.guard.to,
    change.guard.slice,
    change.keptId ?? null,
    change.keptIds ?? [],
    change.metadata
      ? [
          change.metadata.before.frontmatter,
          change.metadata.before.endmatter,
          change.metadata.after.frontmatter,
          change.metadata.after.endmatter,
        ]
      : null,
    Boolean(change.stale),
  ]);
}

export function equalRevisionDraft(
  a: ReviewDraft,
  b: ReviewDraft | null | undefined,
): boolean {
  return Boolean(
    b &&
      a.markdown === b.markdown &&
      (a.cleanMarkdown ?? a.markdown) === (b.cleanMarkdown ?? b.markdown) &&
      Object.keys(a.decisions).length === Object.keys(b.decisions).length &&
      Object.entries(a.decisions).every(
        ([id, value]) => b.decisions[id] === value,
      ) &&
      JSON.stringify(reviewValues(a.reviewed)) ===
        JSON.stringify(reviewValues(b.reviewed)) &&
      JSON.stringify(commentValues(a.reviewComments)) ===
        JSON.stringify(commentValues(b.reviewComments)),
  );
}
