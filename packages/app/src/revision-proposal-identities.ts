import { reviewHistoryProposalIds } from "@roughdraft/rfm";
import type { Node } from "@tiptap/pm/model";
import type { CriticChangeAttrs } from "./critic-markup";

/** Reopening History must never restore a proposal ID reused by later typing. */
export function documentProposalIdentities(
  doc: Node,
): Array<Pick<CriticChangeAttrs, "changeId">> {
  const ids = reviewHistoryProposalIds(doc.attrs.reviewed ?? []);
  doc.descendants((node) => {
    const owned =
      node.type.name === "criticChangeBlock"
        ? node.attrs.change?.changeId
        : node.type.name === "criticChangeBoundary"
          ? node.attrs.changeId
          : null;
    if (typeof owned === "string") ids.add(owned);
    for (const mark of node.marks)
      if (
        mark.type.name === "criticChange" &&
        typeof mark.attrs.changeId === "string"
      )
        ids.add(mark.attrs.changeId);
  });
  return [...ids].map((changeId) => ({ changeId }));
}
