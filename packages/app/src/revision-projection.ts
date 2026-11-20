import type { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import {
  rejectCriticChangeTransaction,
  SUGGESTED_PARAGRAPH_SENTINEL,
} from "./editor-extensions";

const reviewCache = new WeakMap<
  Node,
  {
    positions: ReadonlyMap<string, number>;
    hasComments: boolean;
    hasSuggestions: boolean;
  }
>();

function reviewAnnotations(doc: Node) {
  const cached = reviewCache.get(doc);
  if (cached) return cached;
  const positions = new Map<string, number>();
  let hasComments = false;
  let hasSuggestions = false;
  doc.descendants((node, pos) => {
    if (node.type.name === "criticChangeBlock") {
      hasSuggestions = true;
      const id = node.attrs.change?.changeId;
      if (id && !positions.has(id)) positions.set(id, pos);
    }
    for (const mark of node.marks) {
      if (mark.type.name === "commentRef") hasComments = true;
      if (mark.type.name !== "criticChange") continue;
      hasSuggestions = true;
      const id = mark.attrs.changeId;
      if (typeof id === "string" && !positions.has(id)) positions.set(id, pos);
    }
  });
  const annotations = { positions, hasComments, hasSuggestions };
  reviewCache.set(doc, annotations);
  return annotations;
}

/** Map each suggestion to its first anchor, including suggestions with no text. */
export function suggestionPositions(doc: Node): ReadonlyMap<string, number> {
  return reviewAnnotations(doc).positions;
}

export function hasPendingSuggestions(doc: Node): boolean {
  return reviewAnnotations(doc).hasSuggestions;
}

/** Strip review annotations with the same boundary rules as the editor's Revert. */
export function projectAcceptedDocument(doc: Node): Transform {
  const projection = new Transform(doc);
  const { positions: ids, hasComments } = reviewAnnotations(doc);
  if (ids.size) {
    let state = EditorState.create({ doc });
    for (const id of ids.keys()) {
      const rejected = rejectCriticChangeTransaction(state, id);
      if (!rejected) continue;
      for (const step of rejected.steps) projection.step(step);
      state = state.apply(rejected);
    }
  }
  const { commentRef } = doc.type.schema.marks;
  // Rejecting a block suggestion may restore comments from its old side.
  // Only skip the comment pass when there were no annotations to project.
  if (!commentRef || (!ids.size && !hasComments)) return projection;
  const sentinels: { from: number; to: number }[] = [];
  const anchorless = (node: Node) =>
    node.isText &&
    node.text === SUGGESTED_PARAGRAPH_SENTINEL &&
    node.marks.some((mark) => mark.type === commentRef);
  projection.doc.descendants((node, pos) => {
    if (
      anchorless(node) ||
      (node.type.name === "paragraph" &&
        node.childCount > 0 &&
        node.children.every(anchorless))
    ) {
      sentinels.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
  });
  for (const { from, to } of sentinels.reverse()) projection.delete(from, to);
  projection.removeMark(0, projection.doc.content.size, commentRef);
  return projection;
}
