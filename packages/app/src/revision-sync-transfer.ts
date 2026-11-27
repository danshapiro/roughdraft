import {
  reviewDraftSignature,
  type SyncDraft,
  type SyncState,
} from "@roughdraft/rfm";
import type { ComparisonReviewData } from "./comparison-types";

export interface SentDraftReference {
  readonly signature: string;
  readonly draft: SyncDraft;
}

/** A negotiated update reuses only the already-known frozen references. */
export function receiveSyncState(
  value: unknown,
  previous: ComparisonReviewData,
  sent?: SentDraftReference,
): SyncState<ComparisonReviewData> {
  let state = value as SyncState<ComparisonReviewData> & {
    reviewFormat?: string;
    diskTextFromReview?: boolean;
    savedTextFromDraft?: boolean;
    draftTextFromRequest?: boolean;
  };
  const v2 = state.reviewFormat === "compact-v2";
  if (state.draftTextFromRequest && !v2)
    throw new Error("The request text reference requires compact-v2 format.");
  if (state.reviewFormat !== "compact-v1" && !v2) return state;
  if (!state.review || !state.draft)
    throw new Error("The compact review snapshot is incomplete.");
  if (state.review.id !== previous.id)
    throw new Error("A compact update belongs to a different review.");
  if (state.review.referenceVersion !== previous.referenceVersion)
    throw new Error(
      "The frozen review references changed during this request.",
    );
  if (state.draftTextFromRequest) {
    if (
      !sent ||
      typeof sent.draft.markdown !== "string" ||
      typeof sent.draft.cleanMarkdown !== "string" ||
      !Array.isArray(sent.draft.reviewComments) ||
      !Array.isArray(state.draft.reviewComments)
    )
      throw new Error("The compact request draft reference is incomplete.");
    if (
      state.signature !== sent.signature ||
      reviewDraftSignature(sent.draft) !== sent.signature
    )
      throw new Error("The compact request draft signature is inconsistent.");
    if (
      (state.draft.markdown !== undefined &&
        state.draft.markdown !== sent.draft.markdown) ||
      (state.draft.cleanMarkdown !== undefined &&
        state.draft.cleanMarkdown !== sent.draft.cleanMarkdown)
    )
      throw new Error("The compact request text is inconsistent.");
    const draft = {
      ...state.draft,
      markdown: sent.draft.markdown,
      cleanMarkdown: sent.draft.cleanMarkdown,
    };
    if (reviewDraftSignature(draft) !== state.signature)
      throw new Error("The compact saved draft signature is inconsistent.");
    state = { ...state, draft };
  }
  if (
    v2 &&
    (typeof state.draft.markdown !== "string" ||
      !Array.isArray(state.draft.reviewComments))
  )
    throw new Error("The compact review snapshot is incomplete.");
  let savedText = state.review.savedText;
  if (v2 && state.savedTextFromDraft) {
    const source = state.draft.cleanMarkdown ?? state.draft.markdown;
    if (typeof source !== "string")
      throw new Error("The compact saved snapshot is incomplete.");
    if (savedText !== undefined && savedText !== source)
      throw new Error("The compact saved snapshot is inconsistent.");
    savedText = source;
  }
  if (
    state.diskTextFromReview &&
    (!state.disk || typeof savedText !== "string")
  )
    throw new Error("The compact file snapshot is incomplete.");
  if (
    v2 &&
    state.diskTextFromReview &&
    state.disk?.text !== undefined &&
    state.disk?.text !== savedText
  )
    throw new Error("The compact file snapshot is inconsistent.");
  return {
    ...state,
    disk:
      state.diskTextFromReview && state.disk
        ? { ...state.disk, text: savedText ?? null }
        : state.disk,
    review: {
      ...previous,
      ...state.review,
      ...(v2 ? { savedText } : {}),
      draft: state.draft,
      reviewComments: state.draft.reviewComments,
      outdatedSuggestions: state.draft.outdatedSuggestions ?? [],
    },
  };
}

export function receiveSyncResponse<T>(
  value: T,
  previous: ComparisonReviewData,
  sent?: SentDraftReference,
): T {
  if (!value || typeof value !== "object") return value;
  if ("review" in value && "disk" in value)
    return receiveSyncState(value, previous, sent) as T;
  if ("state" in value && value.state)
    return { ...value, state: receiveSyncState(value.state, previous, sent) };
  return value;
}
