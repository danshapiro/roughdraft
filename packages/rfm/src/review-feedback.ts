import type { SyncComment } from "./review-sync.js";

/** Opening an editor is UI state; changed, unposted wording is recoverable work. */
export function hasUnsubmittedReviewFeedback(
  value: unknown,
  submitted: readonly SyncComment[] = [],
): boolean {
  if (!value || typeof value !== "object") return Boolean(value);
  const drafts = value as Record<string, unknown>;
  if (drafts.comments && typeof drafts.comments === "object") {
    for (const [id, raw] of Object.entries(drafts.comments)) {
      if (!raw || typeof raw !== "object") {
        if (raw) return true;
        continue;
      }
      const draft = raw as Record<string, unknown>;
      if (typeof draft.value !== "string" || typeof draft.original !== "string")
        return true;
      if (draft.value === draft.original) continue;
      const posted = submitted.find((comment) => comment.id === id);
      const target = draft.target as Record<string, unknown> | undefined;
      if (
        posted?.content === draft.value &&
        (!target ||
          (posted.createdAt === target.createdAt &&
            (posted.parentCommentId ?? null) ===
              (target.parentCommentId ?? null)))
      )
        continue;
      return true;
    }
  } else if (drafts.comments) return true;
  const suggestion = drafts.suggestion;
  if (suggestion != null) {
    if (!suggestion || typeof suggestion !== "object")
      return Boolean(suggestion);
    const draft = suggestion as Record<string, unknown>;
    if (typeof draft.text !== "string") return true;
    if (
      draft.text !== draft.sourceText &&
      (draft.text !== "" || draft.type !== "insertion")
    )
      return true;
  }
  return Object.entries(drafts).some(
    ([key, entry]) =>
      key !== "comments" && key !== "suggestion" && Boolean(entry),
  );
}
