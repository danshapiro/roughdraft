import {
  reviewHistoryProposalIds,
  type SyncDraft,
  scanRoughdraftReview,
} from "@roughdraft/rfm";

function draftIdentities(draft: SyncDraft) {
  const ids = reviewHistoryProposalIds(draft.reviewed);
  for (const item of scanRoughdraftReview(draft.markdown).items)
    ids.add(item.id);
  for (const comment of draft.reviewComments) ids.add(comment.id);
  for (const entry of draft.reviewed ?? []) ids.add(entry.id);
  for (const entry of draft.outdatedSuggestions ?? []) ids.add(entry.id);
  return ids;
}

/** A new identity on both sides still needs the full browser renumbering path. */
export function hasPreparedIdentityClash(
  origin: SyncDraft,
  current: SyncDraft,
  incoming: SyncDraft,
) {
  const before = draftIdentities(origin);
  const added = [...draftIdentities(incoming)].filter((id) => !before.has(id));
  if (!added.length) return false;
  const local = draftIdentities(current);
  return added.some((id) => local.has(id));
}
