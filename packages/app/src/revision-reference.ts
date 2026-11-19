import {
  type Fragment,
  type Node as ProseMirrorNode,
  Slice,
} from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { CriticChangeRailItem } from "./DocumentReviewRail";
import { diffRenderedComparison } from "./rendered-comparison-diff";
import { projectAcceptedDocument } from "./revision-projection";

export interface ReferenceChange {
  item: CriticChangeRailItem;
  /** Identifies a frozen comparison passage in either projection. */
  pairId: string;
  baseSide: BaseSide;
  from: number;
  to: number;
  structural: boolean;
  restore: Fragment;
  expected: Fragment;
  /** True if Revert would otherwise remove or alter a pending suggestion. */
  overlapsSuggestion: boolean;
}

export type BaseSide = "old" | "new";

const referenceAuthor = {
  authorType: "ai",
  createdAt: "1970-01-01T00:00:00Z",
} as const;
const pendingMark = (node: ProseMirrorNode) =>
  node.marks.find((mark) => mark.type.name === "criticChange");
/** Compare accepted content while retaining positions in the editable document. */
function project(doc: ProseMirrorNode) {
  const projection = projectAcceptedDocument(doc);
  // TipTap anchors the cursor after a final non-paragraph block by appending
  // an empty paragraph. It is editor furniture, not a Markdown change.
  const { lastChild, childCount } = projection.doc;
  if (
    childCount > 1 &&
    lastChild?.type.name === "paragraph" &&
    lastChild.content.size === 0 &&
    projection.doc.child(childCount - 2).type.name !== "paragraph"
  ) {
    projection.delete(
      projection.doc.content.size - lastChild.nodeSize,
      projection.doc.content.size,
    );
  }
  return projection;
}

/** A decision belongs to one reference position and the exact content of both sides. */
function changeIdentity(
  oldFrom: number,
  oldTo: number,
  before: Fragment,
  after: Fragment,
) {
  const json = JSON.stringify([before.toJSON(), after.toJSON()]);
  // FNV-1a with a 64 bit result keeps persisted IDs short even for whole blocks.
  let hash = 14695981039346656037n;
  for (let index = 0; index < json.length; index++) {
    hash = BigInt.asUintN(
      64,
      (hash ^ BigInt(json.charCodeAt(index))) * 1099511628211n,
    );
  }
  return `reference-${oldFrom}-${oldTo}-${hash.toString(36)}`;
}

export function referenceChanges(
  reference: ProseMirrorNode,
  current: ProseMirrorNode,
  baseSide: BaseSide = "new",
): ReferenceChange[] {
  const opposite = project(reference).doc;
  const projection = project(current);
  const edited = projection.doc;
  if (opposite.eq(edited)) return [];
  const [before, after] =
    baseSide === "old" ? [edited, opposite] : [opposite, edited];
  const map = projection.mapping.invert();
  const changes: ReferenceChange[] = [];
  diffRenderedComparison(
    before.toJSON().content ?? [],
    after.toJSON().content ?? [],
    { ...referenceAuthor, changeId: "reference", kind: "substitution-old" },
    ({ oldFrom, oldTo, newFrom, newTo, structural, oldText, newText }) => {
      const oldPart = before.slice(oldFrom, oldTo).content;
      const newPart = after.slice(newFrom, newTo).content;
      const isOld = baseSide === "old";
      const start = map.map(isOld ? oldFrom : newFrom, 1);
      const to = map.map(isOld ? oldTo : newTo, -1);
      const from = Math.min(start, to);
      const restore = isOld ? newPart : oldPart;
      const pairId = changeIdentity(oldFrom, oldTo, oldPart, newPart);
      const changeId = isOld
        ? changeIdentity(newFrom, newTo, oldPart, newPart)
        : pairId;
      const kind = !oldPart.size
        ? "addition"
        : !newPart.size
          ? "deletion"
          : "substitution-old";
      // Bias away from adjacent pending insertions. A deletion at the same
      // anchor as a pending insertion has no unambiguous place to be restored.
      let overlapsSuggestion = start > to;
      current.nodesBetween(from, to, (node) => {
        if (pendingMark(node) || node.type.name === "criticChangeBlock")
          overlapsSuggestion = true;
      });
      changes.push({
        item: {
          changeId,
          change: { ...referenceAuthor, changeId, kind },
          kind,
          oldText,
          newText,
          anchorTop: 0,
          anchorBottom: 0,
          commentIds: [],
        },
        pairId,
        baseSide,
        from,
        to,
        structural,
        restore,
        expected: current.slice(from, to).content,
        overlapsSuggestion,
      });
    },
  );
  return changes;
}

export function revertReferenceChange(
  state: EditorState,
  change: ReferenceChange,
): Transaction | null {
  const { from, to, restore, expected, overlapsSuggestion } = change;
  if (
    overlapsSuggestion ||
    to > state.doc.content.size ||
    !state.doc.slice(from, to).content.eq(expected)
  )
    return null;
  const transaction = state.tr;
  const result = transaction.maybeStep(
    new ReplaceStep(from, to, new Slice(restore, 0, 0)),
  );
  return result.failed ? null : transaction;
}

export function referenceDecorations(
  doc: ProseMirrorNode,
  visibleChanges: ReferenceChange[],
  options?: { activeId?: string | null; hoveredId?: string | null },
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const {
    item,
    from,
    to,
    structural,
    overlapsSuggestion,
    baseSide,
  } of visibleChanges) {
    if (overlapsSuggestion || from < 0 || to > doc.content.size) continue;
    const isOld = baseSide === "old";
    const kind =
      item.kind === "substitution-old" && !isOld
        ? "substitution-new"
        : item.kind;
    const state =
      options?.activeId === item.changeId
        ? "active"
        : options?.hoveredId === item.changeId
          ? "hovered"
          : null;
    function attributes(renderedKind: string) {
      return {
        class: [
          "critic-change",
          `critic-change-${renderedKind}`,
          ...(state
            ? [
                `critic-change-decoration-${state}`,
                `critic-change-decoration-${renderedKind}`,
              ]
            : []),
        ].join(" "),
        "data-critic-change-id": item.changeId,
        "data-critic-change-kind": renderedKind,
      };
    }
    const otherText = isOld ? item.newText : item.oldText;
    if (otherText && (!structural || from === to)) {
      const otherKind =
        item.kind === "substitution-old" && isOld
          ? "substitution-new"
          : item.kind;
      decorations.push(
        Decoration.widget(
          isOld ? to : from,
          () => {
            const element = document.createElement("span");
            for (const [name, value] of Object.entries(attributes(otherKind)))
              element.setAttribute(name, value);
            element.textContent = otherText;
            element.contentEditable = "false";
            element.style.userSelect = "text";
            if (structural) element.style.display = "block";
            return element;
          },
          { key: `${item.changeId}:${state}`, side: isOld ? 1 : -1 },
        ),
      );
    }
    if (from === to) continue;
    if (structural) {
      doc.nodesBetween(from, to, (node, pos) => {
        if (pos < from || pos + node.nodeSize > to) return true;
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, attributes(kind)),
        );
        return false;
      });
    } else {
      decorations.push(Decoration.inline(from, to, attributes(kind)));
    }
  }
  return DecorationSet.create(doc, decorations);
}
