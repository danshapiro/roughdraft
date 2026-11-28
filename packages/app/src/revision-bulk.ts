import type { Node } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { ReviewedChange } from "./comparison-types";
import { criticMarkdownToEditorState } from "./critic-markup";
import {
  applySuggestionDecisions,
  type ReviewDecision,
} from "./review-decisions";
import {
  createReviewedChangeId,
  mapReviewedChanges,
  reviewedChanges,
} from "./revision-history";
import {
  documentMetadata,
  sameMetadata,
  withDocumentMetadata,
} from "./revision-metadata";
import { suggestionPositions } from "./revision-projection";
import {
  type BaseSide,
  referenceChangeIds,
  referenceChanges,
  revertReferenceChange,
} from "./revision-reference";

export function suggestionDetail(doc: Node, id: string) {
  let from = doc.content.size;
  let to = 0;
  let oldText = "";
  let newText = "";
  doc.descendants((node, position) => {
    if (
      node.type.name === "criticChangeBoundary" &&
      node.attrs.changeId === id
    ) {
      from = Math.min(from, position);
      to = Math.max(to, position + node.nodeSize);
      return false;
    }
    const change =
      node.type.name === "criticChangeBlock"
        ? node.attrs.change
        : node.marks.find((mark) => mark.type.name === "criticChange")?.attrs;
    if (change?.changeId !== id) return;
    from = Math.min(from, position);
    to = Math.max(to, position + node.nodeSize);
    if (change.kind === "addition" || change.kind === "substitution-new")
      newText += node.textContent;
    else oldText += node.textContent;
    return false;
  });
  return { from, to, oldText, newText };
}

/** Shared semantics for real bulk decisions and detached outcome previews. */
export function decideReviewChanges(
  state: EditorState,
  reference: Node | null,
  base: BaseSide,
  decision: ReviewDecision,
  record: boolean,
  scope: "all" | "metadata" = "all",
): Transaction {
  const tr = state.tr;
  const ignored = new Set<string>(record ? (state.doc.attrs.kept ?? []) : []);
  const natives =
    scope === "metadata" ? [] : [...suggestionPositions(state.doc).keys()];
  const initialReferences =
    reference && scope !== "metadata"
      ? referenceChanges(reference, state.doc, base).filter(
          (change) => !ignored.has(change.item.changeId),
        )
      : [];
  const passages = [
    ...initialReferences.map((change) => ({
      ...change,
      oldText: change.item.oldText,
      newText: change.item.newText,
      keptIds: referenceChangeIds(change),
    })),
    ...natives.map((id) => ({
      ...suggestionDetail(state.doc, id),
      keptIds: [id],
    })),
  ].sort((a, b) => a.from - b.from || a.to - b.to);
  const append = (next: Transaction) => {
    for (const step of next.steps) tr.step(step);
  };
  const nativeDecisions = () => {
    if (!applySuggestionDecisions(tr, natives, decision))
      throw new Error("A suggestion moved. Review it before deciding.");
  };
  if (decision === "reject") nativeDecisions();
  const refs =
    reference && scope !== "metadata"
      ? referenceChanges(reference, tr.doc, base)
          .filter(
            (change) =>
              !change.overlapsSuggestion && !ignored.has(change.item.changeId),
          )
          .sort((a, b) => b.from - a.from || b.to - a.to)
      : [];
  for (const change of refs) {
    if ((decision === "accept") === (base === "new")) {
      if (record)
        tr.setDocAttribute("kept", [
          ...new Set([
            ...(tr.doc.attrs.kept ?? []),
            ...referenceChangeIds(change),
          ]),
        ]);
    } else {
      const next = revertReferenceChange(
        EditorState.create({ doc: tr.doc }),
        change,
      );
      if (!next) throw new Error("A passage moved. Review it before deciding.");
      append(next);
    }
  }
  if (decision === "accept") nativeDecisions();
  const source = state.doc.attrs.sourceMetadata?.markdown;
  const otherSource = reference?.attrs.sourceMetadata?.markdown;
  const beforeMetadata = documentMetadata(source ?? "");
  const otherMetadata = documentMetadata(otherSource ?? "");
  const frontmatterInContent = Boolean(
    state.doc.attrs.frontmatterInContent ||
      state.doc.firstChild?.type.name === "yamlFrontmatter" ||
      reference?.firstChild?.type.name === "yamlFrontmatter",
  );
  const metadataPending =
    source !== undefined &&
    otherSource !== undefined &&
    (frontmatterInContent
      ? beforeMetadata.endmatter !== otherMetadata.endmatter
      : !sameMetadata(beforeMetadata, otherMetadata)) &&
    !ignored.has("document-metadata");
  const selectedMetadata =
    (decision === "accept") === (base === "new")
      ? beforeMetadata
      : otherMetadata;
  const afterMetadata = frontmatterInContent
    ? { ...selectedMetadata, frontmatter: beforeMetadata.frontmatter }
    : selectedMetadata;
  if (metadataPending) {
    const markdown = withDocumentMetadata(source, afterMetadata);
    const parsed = criticMarkdownToEditorState(markdown);
    tr.setDocAttribute("sourceMetadata", {
      ...tr.doc.attrs.sourceMetadata,
      sourceSpelling: undefined,
      markdown,
      frontmatter: parsed.frontmatter,
      endmatter: parsed.endmatter,
    });
    if (record && sameMetadata(beforeMetadata, afterMetadata))
      tr.setDocAttribute("kept", [
        ...new Set([...(tr.doc.attrs.kept ?? []), "document-metadata"]),
      ]);
  }
  if (!record) return tr;

  // Overlapping suggestions and reference changes form one reversible passage.
  // Separate archives would invalidate each other during the same bulk choice.
  const groups: (typeof passages)[] = [];
  for (const passage of passages) {
    const previous = groups[groups.length - 1];
    if (
      previous &&
      (passage.from < Math.max(...previous.map((item) => item.to)) ||
        (passage.from === passage.to &&
          previous.some(
            (item) => item.from === passage.from && item.to === passage.to,
          )))
    )
      previous.push(passage);
    else groups.push([passage]);
  }
  const previous = mapReviewedChanges(reviewedChanges(state.doc), tr);
  const reviewed: ReviewedChange[] = groups.map((group) => {
    const start = Math.min(...group.map((item) => item.from));
    const end = Math.max(...group.map((item) => item.to));
    const from = tr.mapping.map(start, -1);
    const to = tr.mapping.map(end, 1);
    const restore = state.doc.slice(start, end);
    const current = tr.doc.slice(from, to);
    return {
      id: createReviewedChangeId(),
      frontmatterInContent: true,
      decision,
      oldText: group
        .map((item) => item.oldText)
        .filter(Boolean)
        .join("\n"),
      newText: group
        .map((item) => item.newText)
        .filter(Boolean)
        .join("\n"),
      inverse: current.eq(restore)
        ? []
        : [new ReplaceStep(from, to, restore).toJSON()],
      guard: { from, to, slice: current.toJSON() },
      keptIds: group.flatMap((item) => item.keptIds),
    };
  });
  if (metadataPending)
    reviewed.push({
      id: createReviewedChangeId(),
      frontmatterInContent: true,
      decision,
      oldText:
        [
          (base === "new" ? otherMetadata : beforeMetadata).frontmatter,
          (base === "new" ? otherMetadata : beforeMetadata).endmatter,
        ]
          .filter(Boolean)
          .join("\n") || "No metadata",
      newText:
        [
          (base === "new" ? beforeMetadata : otherMetadata).frontmatter,
          (base === "new" ? beforeMetadata : otherMetadata).endmatter,
        ]
          .filter(Boolean)
          .join("\n") || "No metadata",
      inverse: [],
      guard: { from: 0, to: 0, slice: null },
      keptId: "document-metadata",
      metadata: { before: beforeMetadata, after: afterMetadata },
    });
  return tr.setDocAttribute("reviewed", [...previous, ...reviewed]);
}
