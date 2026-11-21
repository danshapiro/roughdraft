import type { ComparisonReviewComment, EditorDraft } from "./comparison-types";

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
      JSON.stringify(commentValues(a.reviewComments)) ===
        JSON.stringify(commentValues(b.reviewComments)),
  );
}
