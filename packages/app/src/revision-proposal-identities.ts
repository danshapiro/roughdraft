import { reviewHistoryProposalIds } from "@roughdraft/rfm";
import type { Node } from "@tiptap/pm/model";
import type { CriticChangeAttrs } from "./critic-markup";

const literalIds = new WeakMap<Node, string[]>();

/** Literal YAML examples must not acquire meaning when a new item uses their ID. */
export function literalFrontmatterReviewIds(doc: Node): string[] {
  const yaml =
    doc.firstChild?.type.name === "yamlFrontmatter" ? doc.firstChild : null;
  if (!yaml) return [];
  const cached = literalIds.get(yaml);
  if (cached) return cached;
  const ids = [
    ...new Set(
      [
        ...yaml.textContent.matchAll(
          /\{#([A-Za-z][A-Za-z0-9_-]*)\}|\bid="([A-Za-z][A-Za-z0-9_-]*)"/g,
        ),
      ].map((match) => match[1] ?? match[2]),
    ),
  ];
  literalIds.set(yaml, ids);
  return ids;
}

/** Reopening History must never restore a proposal ID reused by later typing. */
export function documentProposalIdentities(
  doc: Node,
  reserveLiteralFrontmatter = false,
): Array<Pick<CriticChangeAttrs, "changeId">> {
  const ids = reviewHistoryProposalIds(doc.attrs.reviewed ?? []);
  if (reserveLiteralFrontmatter)
    for (const id of literalFrontmatterReviewIds(doc)) ids.add(id);
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
