import type { SyncState } from "@roughdraft/rfm";
import type { Comparison } from "./comparisons.js";

function transferState(
  state: SyncState<Comparison>,
  id: string,
  reference: string | undefined,
  protocol: "compact-v1" | "compact-v2",
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
  const savedTextFromDraft =
    protocol === "compact-v2" &&
    typeof review.savedText === "string" &&
    review.savedText === (state.draft.cleanMarkdown ?? state.draft.markdown);
  const { savedText: _savedText, ...reviewWithoutSavedText } = review;
  return {
    ...state,
    review: savedTextFromDraft ? reviewWithoutSavedText : review,
    reviewFormat: protocol,
    ...(savedTextFromDraft ? { savedTextFromDraft: true } : {}),
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
  protocol: "compact-v1" | "compact-v2" = "compact-v1",
): unknown {
  if (!value || typeof value !== "object") return value;
  if ("review" in value && "disk" in value)
    return transferState(
      value as SyncState<Comparison>,
      id,
      reference,
      protocol,
    );
  if ("state" in value && value.state)
    return {
      ...value,
      state: transferState(
        value.state as SyncState<Comparison>,
        id,
        reference,
        protocol,
      ),
    };
  return value;
}
