import type { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { ReviewDecision } from "./review-decisions";
import { decideReviewChanges } from "./revision-bulk";
import { undecidedDocument } from "./revision-history";
import { projectAcceptedDocument } from "./revision-projection";
import type { BaseSide } from "./revision-reference";

/** Detached state never touches the live editor, history or save queue. */
export function outcomeDocument(
  doc: Node,
  reference: Node | null,
  base: BaseSide,
  decision: ReviewDecision,
): Node {
  const state = EditorState.create({ doc: undecidedDocument(doc) });
  return projectAcceptedDocument(
    decideReviewChanges(state, reference, base, decision, false).doc,
  ).doc;
}
