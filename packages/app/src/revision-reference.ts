import type { JSONContent } from "@tiptap/core";
import {
  type Fragment,
  type Node as ProseMirrorNode,
  Slice,
} from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { CriticChangeRailItem } from "./DocumentReviewRail";
import {
  createRenderedComparisonObserver,
  type RenderedSourceDifference,
  summarizeComparisonContent,
} from "./rendered-comparison-diff";
import { shouldMergeDiffGap } from "./semantic-diff";
import {
  hasPendingSuggestions,
  projectAcceptedDocument,
} from "./revision-projection";

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

/** Atomic IDs stay durable even when their presentation is grouped. */
export function referenceChangeIds(change: ReferenceChange): string[] {
  return change.item.sourceChangeIds ?? [change.item.changeId];
}

function groupReferenceChanges(
  doc: ProseMirrorNode,
  changes: ReferenceChange[],
): ReferenceChange[] {
  const groups: ReferenceChange[] = [];
  const decided = new Set<string>(doc.attrs.kept ?? []);
  const reviewed = doc.attrs.reviewed ?? [];
  const canMerge = (left: ReferenceChange, right: ReferenceChange) => {
    if (
      left.structural ||
      right.structural ||
      left.overlapsSuggestion ||
      right.overlapsSuggestion ||
      left.to > right.from
    )
      return false;
    if (
      [...referenceChangeIds(left), ...referenceChangeIds(right)].some((id) =>
        decided.has(id),
      )
    )
      return false;
    const parent = doc.resolve(left.from).parent;
    if (
      parent.type.name !== "paragraph" ||
      doc.resolve(left.to).parent !== parent ||
      doc.resolve(right.from).parent !== parent ||
      doc.resolve(right.to).parent !== parent
    )
      return false;
    if (
      reviewed.some(
        (entry: {
          metadata?: unknown;
          stale?: boolean;
          guard: { from: number; to: number };
        }) =>
          !entry.metadata &&
          !entry.stale &&
          (entry.guard.from === entry.guard.to
            ? left.from <= entry.guard.from && entry.guard.from <= right.to
            : left.from < entry.guard.to && entry.guard.from < right.to),
      )
    )
      return false;
    let blocked = false;
    const checkBoundary = (node: ProseMirrorNode) => {
      if (
        (node.isInline && !node.isText) ||
        node.type.name === "criticChangeBlock" ||
        node.type.name === "criticChangeBoundary" ||
        node.marks.some((mark) =>
          ["criticChange", "commentRef", "code"].includes(mark.type.name),
        )
      )
        blocked = true;
    };
    doc.nodesBetween(left.from, right.to, checkBoundary);
    left.restore.descendants(checkBoundary);
    right.restore.descendants(checkBoundary);
    if (blocked) return false;
    const gap = doc.textBetween(left.to, right.from, "");
    return shouldMergeDiffGap(
      gap,
      Math.max(left.restore.size, left.to - left.from),
      Math.max(right.restore.size, right.to - right.from),
    );
  };
  for (const change of changes) {
    const previous = groups.at(-1);
    if (!previous || !canMerge(previous, change)) {
      groups.push(change);
      continue;
    }
    const restore = previous.restore
      .append(doc.slice(previous.to, change.from).content)
      .append(change.restore);
    const expected = doc.slice(previous.from, change.to).content;
    const old = previous.baseSide === "new" ? restore : expected;
    const next = previous.baseSide === "new" ? expected : restore;
    const formatting =
      old.textBetween(0, old.size, "") === next.textBetween(0, next.size, "");
    const kind = !old.size
      ? "addition"
      : !next.size
        ? "deletion"
        : "substitution-old";
    groups[groups.length - 1] = {
      ...previous,
      to: change.to,
      restore,
      expected,
      item: {
        ...previous.item,
        kind,
        change: { ...previous.item.change, kind },
        oldText: summarizeComparisonContent(
          old.content.map((node) => node.toJSON()),
          formatting,
        ),
        newText: summarizeComparisonContent(
          next.content.map((node) => node.toJSON()),
          formatting,
        ),
        sourceChangeIds: [
          ...referenceChangeIds(previous),
          ...referenceChangeIds(change),
        ],
      },
    };
  }
  return groups;
}

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

/** FNV-1a over the existing UTF-16 representation, preserving saved IDs. */
function hashIdentity(json: string) {
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < json.length; index++) {
    low = (low ^ json.charCodeAt(index)) >>> 0;
    // The 64-bit prime is 2^40 + 435. Use two 32-bit limbs to avoid
    // allocating several BigInts for each character of a large change.
    const product = low * 435;
    high =
      (Math.imul(high, 435) + (low << 8) + Math.floor(product / 2 ** 32)) >>> 0;
    low = product >>> 0;
  }
  return ((BigInt(high) << 32n) | BigInt(low)).toString(36);
}

export function createReferenceComparison(
  reference: ProseMirrorNode,
  baseSide: BaseSide = "new",
) {
  const opposite = project(reference).doc;
  // ProseMirror shares unchanged nodes between transactions. Keep their JSON
  // stable so the matcher can reuse text, semantic keys and alignment scores.
  const json = new WeakMap<ProseMirrorNode, JSONContent>();
  const toJson = (node: ProseMirrorNode): JSONContent => {
    const cached = json.get(node);
    if (cached) return cached;
    const value: JSONContent = { type: node.type.name };
    if (Object.keys(node.attrs).length) value.attrs = node.attrs;
    if (node.text !== undefined) value.text = node.text;
    if (node.marks.length)
      value.marks = node.marks.map((mark) => mark.toJSON());
    if (node.childCount) value.content = node.children.map(toJson);
    json.set(node, value);
    return value;
  };
  const comparison = createRenderedComparisonObserver();
  type LocalChange = {
    digest: string;
    kind: CriticChangeRailItem["kind"];
    restore: Fragment;
  };
  const localChanges = new WeakMap<RenderedSourceDifference, LocalChange>();
  const identity = (fragment: Fragment) =>
    comparison.identity(fragment.content.map(toJson));

  type ProjectedChange = Omit<
    ReferenceChange,
    "expected" | "overlapsSuggestion"
  >;
  let previousAccepted: ProseMirrorNode | undefined;
  let projectedChanges: ProjectedChange[] = [];
  const isOld = baseSide === "old";
  return (current: ProseMirrorNode): ReferenceChange[] => {
    const projection = project(current);
    const edited = projection.doc;
    // Suggesting can change the editable positions without changing the
    // accepted content. Keep the comparison and remap only its positions.
    if (!previousAccepted?.content.eq(edited.content)) {
      previousAccepted = edited;
      projectedChanges = [];
      if (!opposite.eq(edited)) {
        const [before, after] = isOld ? [edited, opposite] : [opposite, edited];
        comparison.observe(
          toJson(before).content ?? [],
          toJson(after).content ?? [],
          (
            { oldFrom, oldTo, newFrom, newTo, structural, oldText, newText },
            local,
          ) => {
            let detail = local && localChanges.get(local);
            if (!detail) {
              const oldPart = before.slice(oldFrom, oldTo).content;
              const newPart = after.slice(newFrom, newTo).content;
              detail = {
                digest: hashIdentity(
                  JSON.stringify([identity(oldPart), identity(newPart)]),
                ),
                kind: !oldPart.size
                  ? "addition"
                  : !newPart.size
                    ? "deletion"
                    : "substitution-old",
                restore: isOld ? newPart : oldPart,
              };
              if (local) localChanges.set(local, detail);
            }
            const { digest, kind, restore } = detail;
            const pairId = `reference-${oldFrom}-${oldTo}-${digest}`;
            const changeId = isOld
              ? `reference-${newFrom}-${newTo}-${digest}`
              : pairId;
            projectedChanges.push({
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
              from: isOld ? oldFrom : newFrom,
              to: isOld ? oldTo : newTo,
              structural,
              restore,
            });
          },
          !isOld,
        );
      }
    }
    const map = projection.mapping.maps.length
      ? projection.mapping.invert()
      : null;
    const hasSuggestions = hasPendingSuggestions(current);
    const mapped = projectedChanges.map((change) => {
      const start = map?.map(change.from, 1) ?? change.from;
      const to = map?.map(change.to, -1) ?? change.to;
      const from = Math.min(start, to);
      // Bias away from adjacent pending insertions. A deletion at the same
      // anchor as a pending insertion has no unambiguous place to be restored.
      let overlapsSuggestion = start > to;
      if (hasSuggestions && !overlapsSuggestion) {
        current.nodesBetween(from, to, (node) => {
          if (pendingMark(node) || node.type.name === "criticChangeBlock")
            overlapsSuggestion = true;
        });
      }
      return {
        ...change,
        from,
        to,
        // A decision compares this immutable snapshot against the live doc.
        // Avoid slicing every changed passage when no decision was made.
        get expected() {
          return current.slice(from, to).content;
        },
        overlapsSuggestion,
      };
    });
    return groupReferenceChanges(current, mapped);
  };
}

export function referenceChanges(
  reference: ProseMirrorNode,
  current: ProseMirrorNode,
  baseSide: BaseSide = "new",
): ReferenceChange[] {
  return createReferenceComparison(reference, baseSide)(current);
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
