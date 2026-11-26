import type { SyncComment, SyncDraft } from "./review-sync.js";

/** Deterministic content encoding; object insertion order is never identity. */
export function canonicalValue(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Portable non-security content fingerprint; actual file guards use SHA-256. */
export function contentSignature(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${text.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

export function normalizedReviewComment(comment: SyncComment) {
  return {
    id: comment.id,
    changeId: comment.changeId,
    content: comment.content,
    createdAt: comment.createdAt,
    authorType: comment.authorType ?? null,
    authorId: comment.authorId ?? null,
    parentCommentId: comment.parentCommentId ?? null,
    scope: comment.scope ?? null,
    originalQuote: comment.originalQuote ?? null,
    detachedReason: comment.detachedReason ?? null,
  };
}

function normalizedDraft(draft: SyncDraft) {
  return {
    markdown: draft.markdown,
    cleanMarkdown: draft.cleanMarkdown ?? draft.markdown,
    decisions: draft.decisions,
    reviewComments: draft.reviewComments.map(normalizedReviewComment),
    reviewed: (draft.reviewed ?? []).map((change) => ({
      ...change,
      keptId: change.keptId ?? null,
      keptIds: change.keptIds ?? [],
      stale: Boolean(change.stale),
      staleReason: change.staleReason ?? null,
      unmappedSince: change.unmappedSince ?? null,
      originSignature: change.originSignature ?? null,
      metadata: change.metadata ?? null,
    })),
    outdatedSuggestions: draft.outdatedSuggestions ?? [],
  };
}

export function reviewDraftSignature(draft: SyncDraft): string {
  return contentSignature(canonicalValue(normalizedDraft(draft)));
}

export function sameReviewDraft(
  left: SyncDraft,
  right: SyncDraft | null | undefined,
): boolean {
  return Boolean(
    right &&
      left.markdown === right.markdown &&
      (left.cleanMarkdown ?? left.markdown) ===
        (right.cleanMarkdown ?? right.markdown) &&
      canonicalValue(normalizedDraft(left)) ===
        canonicalValue(normalizedDraft(right)),
  );
}
