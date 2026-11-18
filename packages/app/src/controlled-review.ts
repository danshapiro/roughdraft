import type { JSONContent } from "@tiptap/core";
import type { CriticChangeKind, CriticComment } from "./critic-markup";
import type { CriticChangeRailItem } from "./DocumentReviewRail";

export interface ControlledReviewBlockHighlight {
  from: number;
  to: number;
  changeId: string;
  kind: CriticChangeKind;
}
/** Display-only adapter. Decisions/comments never serialize the editor to a file. */
export interface ControlledDocumentReview {
  doc: JSONContent;
  suggestions: CriticChangeRailItem[];
  comments: Map<string, CriticComment>;
  blockHighlights: ControlledReviewBlockHighlight[];
  canDecide: boolean;
  disabled: boolean;
  acceptLabel: string;
  rejectLabel: string;
  onAccept: (changeId: string) => void;
  onReject: (changeId: string) => void;
  onCreateComment: (
    changeId: string | null,
    parentCommentId: string,
  ) => string | null;
  onUpdateComment: (commentId: string, content: string) => void;
  onDeleteComment: (commentId: string) => void;
}
