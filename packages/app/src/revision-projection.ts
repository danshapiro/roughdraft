import type { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import {
  rejectCriticChangeTransaction,
  SUGGESTED_PARAGRAPH_SENTINEL,
} from "./editor-extensions";

/** Map each suggestion to its first anchor, including suggestions with no text. */
export function suggestionPositions(doc: Node): Map<string, number> {
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => {
    const block = node.type.name === "criticChangeBlock" && node.attrs.change;
    if (block?.changeId && !positions.has(block.changeId)) {
      positions.set(block.changeId, pos);
    }
    for (const mark of node.marks) {
      if (mark.type.name !== "criticChange") continue;
      const id = mark.attrs.changeId;
      if (typeof id === "string" && !positions.has(id)) positions.set(id, pos);
    }
  });
  return positions;
}

/** Strip review annotations with the same boundary rules as the editor's Revert. */
export function projectAcceptedDocument(doc: Node): Transform {
  const projection = new Transform(doc);
  const ids = suggestionPositions(doc);
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
  if (!commentRef) return projection;
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
