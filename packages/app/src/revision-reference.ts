import {
  type Fragment,
  type Node as ProseMirrorNode,
  Slice,
} from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ReplaceStep, Transform } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { CriticChangeRailItem } from "./DocumentReviewRail";
import { SUGGESTED_PARAGRAPH_SENTINEL } from "./editor-extensions";
import { diffRenderedComparison } from "./rendered-comparison-diff";

export interface ReferenceChange {
  item: CriticChangeRailItem;
  from: number;
  to: number;
  structural: boolean;
  restore: Fragment;
  expected: Fragment;
  /** True if Revert would otherwise remove or alter a pending suggestion. */
  overlapsSuggestion: boolean;
}

const referenceAuthor = {
  authorType: "ai",
  createdAt: "1970-01-01T00:00:00Z",
} as const;
const pendingMark = (node: ProseMirrorNode) =>
  node.marks.find((mark) => mark.type.name === "criticChange");
const isPendingInsertion = (node: ProseMirrorNode) => {
  const kind = pendingMark(node)?.attrs.kind;
  return kind === "addition" || kind === "substitution-new";
};

/** Compare the current accepted result, while retaining a coordinate map into the editable document. */
function project(doc: ProseMirrorNode) {
  const projection = new Transform(doc);
  const insertions: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (
      (node.type.name === "paragraph" &&
        node.textContent.includes(SUGGESTED_PARAGRAPH_SENTINEL) &&
        node.children.every(isPendingInsertion)) ||
      isPendingInsertion(node) ||
      (node.isText &&
        node.text === SUGGESTED_PARAGRAPH_SENTINEL &&
        node.marks.some((mark) => mark.type.name === "commentRef"))
    ) {
      insertions.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
  });
  for (const { from, to } of insertions.reverse()) {
    projection.delete(from, to);
  }
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
  const { criticChange, commentRef } = doc.type.schema.marks;
  for (const mark of [criticChange, commentRef]) {
    if (mark) projection.removeMark(0, projection.doc.content.size, mark);
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
): ReferenceChange[] {
  const before = project(reference).doc;
  const projection = project(current);
  const after = projection.doc;
  if (before.eq(after)) return [];
  const map = projection.mapping.invert();
  const changes: ReferenceChange[] = [];
  diffRenderedComparison(
    before.toJSON().content ?? [],
    after.toJSON().content ?? [],
    { ...referenceAuthor, changeId: "reference", kind: "substitution-old" },
    ({ oldFrom, oldTo, newFrom, newTo, structural, oldText, newText }) => {
      const start = map.map(newFrom, 1);
      const to = map.map(newTo, -1);
      const from = Math.min(start, to);
      const restore = before.slice(oldFrom, oldTo).content;
      const edited = after.slice(newFrom, newTo).content;
      const changeId = changeIdentity(oldFrom, oldTo, restore, edited);
      const kind = !restore.size
        ? "addition"
        : !edited.size
          ? "deletion"
          : "substitution-old";
      // Bias away from adjacent pending insertions. A deletion at the same
      // anchor as a pending insertion has no unambiguous place to be restored.
      let overlapsSuggestion = start > to;
      current.nodesBetween(from, to, (node) => {
        if (pendingMark(node)) overlapsSuggestion = true;
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
  } of visibleChanges) {
    if (overlapsSuggestion || from < 0 || to > doc.content.size) continue;
    const kind =
      item.kind === "substitution-old" ? "substitution-new" : item.kind;
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
    if (item.oldText && (!structural || from === to)) {
      const oldKind = item.kind;
      decorations.push(
        Decoration.widget(
          from,
          () => {
            const element = document.createElement("span");
            for (const [name, value] of Object.entries(attributes(oldKind)))
              element.setAttribute(name, value);
            element.textContent = item.oldText;
            element.contentEditable = "false";
            element.style.userSelect = "text";
            if (structural) element.style.display = "block";
            return element;
          },
          { key: `${item.changeId}:${state}`, side: -1 },
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
