import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Fragment, Node } from "@tiptap/pm/model";
import {
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
} from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import {
  type CompositionCommit,
  compositionCommitKey,
} from "./composition-suggestions";
import { type CriticChangeAttrs, createCriticChange } from "./critic-markup";
import {
  acceptCriticChangeTransaction,
  explicitReviewEdit,
  rejectCriticChangeTransaction,
  SUGGESTED_PARAGRAPH_SENTINEL,
} from "./editor-extensions";
import {
  projectAcceptedDocument,
  suggestionPositions,
} from "./revision-projection";
import { documentMetadata, sameMetadata } from "./revision-metadata";

function sameAcceptedDocument(left: Node, right: Node) {
  if (left.type !== right.type || !left.content.eq(right.content)) return false;
  const leftSource = left.attrs.sourceMetadata?.markdown ?? "";
  const rightSource = right.attrs.sourceMetadata?.markdown ?? "";
  // Review guards and inverse positions move while a proposal is inserted.
  // The invariant concerns the writable body and document-owned YAML instead.
  return (
    leftSource === rightSource ||
    sameMetadata(documentMetadata(leftSource), documentMetadata(rightSource))
  );
}

function changesIn(doc: Node) {
  const changes = new Map<string, CriticChangeAttrs>();
  const read = (node: Node) => {
    if (node.type.name === "criticChangeBlock") {
      const change = node.attrs.change as CriticChangeAttrs;
      changes.set(change.changeId, change);
    }
    for (const mark of node.marks) {
      if (mark.type.name !== "criticChange") continue;
      const change = mark.attrs as CriticChangeAttrs;
      changes.set(change.changeId, change);
    }
  };
  read(doc);
  doc.descendants(read);
  return changes;
}

function resolvedFragment(doc: Node, content: Fragment, accept: boolean) {
  const initial = doc.type.create(doc.attrs, content);
  let state = EditorState.create({ doc: initial });
  const projection = new Transform(initial);
  for (const id of suggestionPositions(initial).keys()) {
    const transaction = accept
      ? acceptCriticChangeTransaction(state, id)
      : rejectCriticChangeTransaction(state, id);
    if (!transaction) continue;
    for (const step of transaction.steps) projection.step(step);
    state = state.apply(transaction);
  }
  return projection;
}

function markedBlocks(
  doc: Node,
  change: CriticChangeAttrs,
  preserveEmpty = false,
) {
  const mark = doc.type.schema.marks.criticChange.create(change);
  const transform = new Transform(doc);
  const empty: number[] = [];
  doc.descendants((node, position) => {
    if (node.isInline)
      transform.addMark(position, position + node.nodeSize, mark);
    if (preserveEmpty && node.isTextblock && !node.content.size)
      empty.push(position + 1);
  });
  // Keep a newly inserted empty paragraph through Markdown serialization.
  for (const position of empty.reverse())
    transform.insert(
      position,
      doc.type.schema.text(SUGGESTED_PARAGRAPH_SENTINEL, [mark]),
    );
  return transform;
}

function positions(doc: Node) {
  const offsets = [0];
  for (const child of doc.children)
    offsets.push((offsets.at(-1) ?? 0) + child.nodeSize);
  return offsets;
}

/** Turn an ordinary native editor command into one reversible block proposal. */
export function structuralSuggestion(before: EditorState, after: EditorState) {
  let start = 0;
  while (
    start < Math.min(before.doc.childCount, after.doc.childCount) &&
    before.doc.child(start).eq(after.doc.child(start))
  )
    start++;
  let oldEnd = before.doc.childCount;
  let newEnd = after.doc.childCount;
  while (
    oldEnd > start &&
    newEnd > start &&
    before.doc.child(oldEnd - 1).eq(after.doc.child(newEnd - 1))
  ) {
    oldEnd--;
    newEnd--;
  }
  const oldOffsets = positions(before.doc);
  const newOffsets = positions(after.doc);
  const merged = new Map<string, CriticChangeAttrs>();
  const includeChanges = (doc: Node, from: number, to: number) => {
    for (const [id, change] of changesIn(doc.cut(from, to)))
      merged.set(id, change);
  };
  // An operation across an existing proposal must include both of its sides.
  // Resolve those proposals into the two snapshots instead of nesting markup.
  let previous = -1;
  while (previous !== merged.size) {
    previous = merged.size;
    includeChanges(before.doc, oldOffsets[start], oldOffsets[oldEnd]);
    includeChanges(after.doc, newOffsets[start], newOffsets[newEnd]);
    for (const doc of [before.doc, after.doc]) {
      doc.children.forEach((child, index) => {
        if (![...changesIn(child).keys()].some((id) => merged.has(id))) return;
        start = Math.min(start, index);
        if (doc === before.doc) oldEnd = Math.max(oldEnd, index + 1);
        else newEnd = Math.max(newEnd, index + 1);
      });
    }
  }
  const from = newOffsets[start];
  const to = newOffsets[newEnd];
  const original = resolvedFragment(
    before.doc,
    before.doc.content.cut(oldOffsets[start], oldOffsets[oldEnd]),
    false,
  );
  const proposed = resolvedFragment(
    after.doc,
    after.doc.content.cut(from, to),
    true,
  );
  const existing = changesIn(before.doc);
  const change =
    merged.values().next().value ??
    createCriticChange("substitution-old", undefined, {
      existingChanges: existing.values(),
    });
  const oldBlocks = markedBlocks(original.doc, {
    ...change,
    kind: "substitution-old",
  });
  const newBlocks = markedBlocks(
    proposed.doc,
    {
      ...change,
      kind: original.doc.content.size ? "substitution-new" : "addition",
    },
    true,
  );
  const block = after.schema.nodes.criticChangeBlock;
  const oldSide = oldBlocks.doc.content.size
    ? block.create(
        { change: { ...change, kind: "substitution-old" } },
        oldBlocks.doc.content,
      )
    : null;
  const newSide = newBlocks.doc.content.size
    ? block.create(
        {
          change: {
            ...change,
            kind: oldSide ? "substitution-new" : "addition",
          },
        },
        newBlocks.doc.content,
      )
    : null;
  const transaction = after.tr.replaceWith(
    from,
    to,
    [oldSide, newSide].filter((side): side is Node => Boolean(side)),
  );
  const mapPosition = (position: number) =>
    from +
    (oldSide?.nodeSize ?? 0) +
    (newSide ? 1 : 0) +
    newBlocks.mapping.map(proposed.mapping.map(position - from, 1), 1);
  const anchor = mapPosition(after.selection.anchor);
  const head = mapPosition(after.selection.head);
  const $anchor = transaction.doc.resolve(
    Math.min(transaction.doc.content.size, Math.max(0, anchor)),
  );
  const $head = transaction.doc.resolve(
    Math.min(transaction.doc.content.size, Math.max(0, head)),
  );
  transaction.setSelection(
    $anchor.parent.inlineContent && $head.parent.inlineContent
      ? TextSelection.create(transaction.doc, $anchor.pos, $head.pos)
      : TextSelection.near($head),
  );
  transaction.setMeta(explicitReviewEdit, true);
  return {
    transaction,
    changeId: change.changeId,
    mergedIds: [...merged.keys()],
  };
}

export const structuralSuggestionsKey = new PluginKey(
  "roughdraftStructuralSuggestions",
);

export interface CommentParentMove {
  from: string | null;
  to: string | null;
}

export type SuggestionCommentParents = Record<string, CommentParentMove>;

export function structuralSuggestionsPlugin(options: {
  enabled: () => boolean;
  onMerged: (
    ids: string[],
    changeId: string,
  ) => SuggestionCommentParents | undefined;
  onBlocked: () => void;
}) {
  const accepted = new WeakMap<Node, Node>();
  const acceptedContent = (doc: Node) => {
    let projection = accepted.get(doc);
    if (!projection) {
      projection = projectAcceptedDocument(doc).doc;
      accepted.set(doc, projection);
    }
    return projection;
  };
  return new Plugin({
    key: structuralSuggestionsKey,
    appendTransaction(transactions, initial, after) {
      const commit = transactions
        .map(
          (transaction) =>
            transaction.getMeta(compositionCommitKey) as
              | CompositionCommit
              | undefined,
        )
        .find(Boolean);
      const before = commit?.before ?? initial;
      if (
        !options.enabled() ||
        (!commit &&
          !transactions.some((transaction) => transaction.docChanged)) ||
        transactions.some(
          (transaction) =>
            transaction.getMeta(explicitReviewEdit) ||
            transaction.getMeta("preventUpdate") ||
            isHistoryTransaction(transaction),
        )
      )
        return null;
      const trailing = after.doc.lastChild;
      if (
        before.doc.lastChild?.type.name !== "paragraph" &&
        after.doc.childCount === before.doc.childCount + 1 &&
        trailing?.type.name === "paragraph" &&
        !trailing.content.size &&
        after.doc.content
          .cut(0, after.doc.content.size - trailing.nodeSize)
          .eq(before.doc.content)
      )
        return null;
      const original = acceptedContent(before.doc);
      if (sameAcceptedDocument(original, acceptedContent(after.doc)))
        return null;
      try {
        const { transaction, mergedIds, changeId } = structuralSuggestion(
          before,
          after,
        );
        if (!sameAcceptedDocument(original, acceptedContent(transaction.doc)))
          throw new Error("The proposal changed the accepted document");
        const moves = options.onMerged(mergedIds, changeId);
        if (moves && Object.keys(moves).length) {
          const parents: SuggestionCommentParents = {
            ...after.doc.attrs.suggestionCommentParents,
          };
          for (const [id, move] of Object.entries(moves))
            parents[id] = { from: parents[id]?.from ?? move.from, to: move.to };
          transaction.setDocAttribute("suggestionCommentParents", parents);
        }
        console.info(
          JSON.stringify({
            severity: "info",
            component: "suggesting",
            event: "structural-proposal-created",
            changeId,
            mergedCount: mergedIds.length,
            steps: transactions.reduce(
              (count, item) => count + item.steps.length,
              0,
            ),
          }),
        );
        return transaction;
      } catch (error) {
        console.error(
          JSON.stringify({
            severity: "error",
            component: "suggesting",
            event: "structural-proposal-failed",
            error: error instanceof Error ? error.message : String(error),
            steps: transactions.reduce(
              (count, item) => count + item.steps.length,
              0,
            ),
          }),
        );
        options.onBlocked();
        const restored = after.tr.replaceWith(
          0,
          after.doc.content.size,
          before.doc.content,
        );
        restored.setSelection(
          TextSelection.near(
            restored.doc.resolve(
              Math.min(before.selection.head, restored.doc.content.size),
            ),
          ),
        );
        return restored.setMeta(explicitReviewEdit, true);
      }
    },
  });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** UTF-16 offsets must never split a visible character during deletion. */
export function graphemeBoundary(
  text: string,
  position: number,
  backwards: boolean,
) {
  let previous = 0;
  for (const segment of graphemes.segment(text)) {
    const end = segment.index + segment.segment.length;
    if (backwards && end >= position) return segment.index;
    if (!backwards && end > position) return end;
    previous = end;
  }
  return previous;
}
