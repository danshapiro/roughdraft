import {
  reviewDraftSignature,
  type SyncDraft,
  type SyncState,
} from "@roughdraft/rfm";
import type { Comparison } from "./comparisons.js";

export interface DraftTextReference {
  signature: string;
  draft: SyncDraft;
}

function matchesDraftText(
  state: SyncState<Comparison>,
  reference: DraftTextReference | undefined,
): boolean {
  if (
    !reference ||
    reference.signature !== state.signature ||
    typeof state.draft.markdown !== "string" ||
    typeof state.draft.cleanMarkdown !== "string" ||
    typeof reference.draft.markdown !== "string" ||
    typeof reference.draft.cleanMarkdown !== "string" ||
    state.draft.markdown !== reference.draft.markdown ||
    state.draft.cleanMarkdown !== reference.draft.cleanMarkdown
  )
    return false;
  try {
    return reviewDraftSignature(reference.draft) === reference.signature;
  } catch {
    // A rejected malformed input must still receive its complete saved state.
    return false;
  }
}

function transferState(
  state: SyncState<Comparison>,
  id: string,
  reference: string | undefined,
  protocol: "compact-v1" | "compact-v2",
  draftReference?: DraftTextReference,
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
  const draftTextFromRequest =
    protocol === "compact-v2" && matchesDraftText(state, draftReference);
  const {
    markdown: _markdown,
    cleanMarkdown: _cleanMarkdown,
    ...draftMetadata
  } = state.draft;
  return {
    ...state,
    review: savedTextFromDraft ? reviewWithoutSavedText : review,
    reviewFormat: protocol,
    ...(draftTextFromRequest
      ? { draft: draftMetadata, draftTextFromRequest: true }
      : {}),
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
  draftReference?: DraftTextReference,
): unknown {
  if (!value || typeof value !== "object") return value;
  if ("review" in value && "disk" in value)
    return transferState(
      value as SyncState<Comparison>,
      id,
      reference,
      protocol,
      draftReference,
    );
  if ("state" in value && value.state)
    return {
      ...value,
      state: transferState(
        value.state as SyncState<Comparison>,
        id,
        reference,
        protocol,
        draftReference,
      ),
    };
  return value;
}
