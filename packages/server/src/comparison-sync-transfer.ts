import type { SyncState } from "@roughdraft/rfm";
import type { Comparison } from "./comparisons.js";

function transferState(
  state: SyncState<Comparison>,
  id: string,
  reference: string | undefined,
) {
  if (
    state.review.id !== id ||
    state.review.editor !== "unified" ||
    !reference ||
    state.review.referenceVersion !== reference
  )
    return state;
  const {
    beforeText: _beforeText,
    afterText: _afterText,
    segments: _segments,
    draft: _draft,
    reviewComments: _comments,
    outdatedSuggestions: _outdated,
    ...review
  } = state.review;
  const diskTextFromReview =
    typeof state.disk?.text === "string" &&
    state.disk.text === state.review.savedText;
  return {
    ...state,
    review,
    reviewFormat: "compact-v1",
    ...(diskTextFromReview && state.disk
      ? { disk: { ...state.disk, text: undefined }, diskTextFromReview: true }
      : {}),
  };
}

/** Older callers and newly-created copies retain their self-contained state. */
export function transferSyncResponse(
  value: unknown,
  id: string,
  reference: string | undefined,
): unknown {
  if (!value || typeof value !== "object") return value;
  if ("review" in value && "disk" in value)
    return transferState(value as SyncState<Comparison>, id, reference);
  if ("state" in value && value.state)
    return {
      ...value,
      state: transferState(value.state as SyncState<Comparison>, id, reference),
    };
  return value;
}
