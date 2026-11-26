import type { SyncState } from "@roughdraft/rfm";
import type { ComparisonReviewData } from "./comparison-types";

/** A negotiated update reuses only the already-known frozen references. */
export function receiveSyncState(
  value: unknown,
  previous: ComparisonReviewData,
): SyncState<ComparisonReviewData> {
  const state = value as SyncState<ComparisonReviewData> & {
    reviewFormat?: string;
    diskTextFromReview?: boolean;
  };
  if (state.reviewFormat !== "compact-v1") return state;
  if (state.review.id !== previous.id)
    throw new Error("A compact update belongs to a different review.");
  if (state.review.referenceVersion !== previous.referenceVersion)
    throw new Error(
      "The frozen review references changed during this request.",
    );
  if (state.diskTextFromReview && typeof state.review.savedText !== "string")
    throw new Error("The compact file snapshot is incomplete.");
  return {
    ...state,
    disk:
      state.diskTextFromReview && state.disk
        ? { ...state.disk, text: state.review.savedText ?? null }
        : state.disk,
    review: {
      ...previous,
      ...state.review,
      draft: state.draft,
      reviewComments: state.draft.reviewComments,
      outdatedSuggestions: state.draft.outdatedSuggestions ?? [],
    },
  };
}

export function receiveSyncResponse<T>(
  value: T,
  previous: ComparisonReviewData,
): T {
  if (!value || typeof value !== "object") return value;
  if ("review" in value && "disk" in value)
    return receiveSyncState(value, previous) as T;
  if ("state" in value && value.state)
    return { ...value, state: receiveSyncState(value.state, previous) };
  return value;
}
