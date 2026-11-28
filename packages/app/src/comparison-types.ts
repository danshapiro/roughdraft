import type {
  OutdatedSuggestion,
  SyncContext,
  SyncDraft,
} from "@roughdraft/rfm";
import type { CriticComment } from "./critic-markup";

export type ComparisonDecision = "pending" | "before" | "after";
export interface ComparisonSegment {
  id: string;
  kind: "equal" | "change";
  before: string;
  after: string;
  oldStart: number;
  newStart: number;
  decision: ComparisonDecision;
  comment: string;
}
export interface ComparisonReviewComment extends CriticComment {
  changeId: string;
  originalQuote?: string;
  detachedReason?: string;
}
export interface EditorDraft {
  markdown: string;
  cleanMarkdown?: string;
  decisions: Record<string, "kept">;
  reviewed?: ReviewedChange[];
  outdatedSuggestions?: OutdatedSuggestion[];
  diskOrigin?: SyncDraft["diskOrigin"];
}
export interface DocumentMetadata {
  frontmatter: string | null;
  endmatter: string | null;
}
export interface ReviewedChange {
  /** Missing on stored records whose positions excluded frontmatter. */
  frontmatterInContent?: boolean;
  id: string;
  decision: "accept" | "reject";
  oldText: string;
  newText: string;
  inverse: Record<string, unknown>[];
  guard: { from: number; to: number; slice: unknown };
  keptId?: string;
  keptIds?: string[];
  stale?: boolean;
  staleReason?: string;
  unmappedSince?: string;
  originSignature?: string;
  metadata?: { before: DocumentMetadata; after: DocumentMetadata };
}
export interface EditorFeedback {
  draft: EditorDraft;
  destinationPath: string | null;
  saved: boolean;
  comment: string;
  sentAt: string;
}
export interface ComparisonReviewData {
  id: string;
  revision: number;
  mode: "proposal" | "applied" | "compare" | "document";
  title: string;
  beforeLabel: string;
  afterLabel: string;
  beforePath?: string | null;
  afterPath?: string | null;
  autosave?: string;
  handoff?: "chat" | "button";
  recoveredReviews?: ComparisonReviewData[];
  targetPath: string | null;
  beforeText: string;
  afterText: string;
  segments: ComparisonSegment[];
  comment: string;
  reviewComments?: ComparisonReviewComment[];
  status: "open" | "completed" | "applied";
  targetChanged: boolean;
  editor?: "unified";
  draft?: EditorDraft | null;
  destinationPath?: string | null;
  savedPath?: string | null;
  savedText?: string | null;
  baseVersion?: "old" | "new" | null;
  baseOptions?: { old: string | null; new: string | null };
  feedback?: EditorFeedback | null;
  lastOperation?: { id: string; pageInstanceId: string; reason: string };
  lastOverwrite?: {
    operationId: string;
    pageInstanceId: string;
    checkpointId: string;
    displacedSignature: string;
    createdAt: string;
  };
  liveSourcePath?: string | null;
  liveSourceVersion?: string | null;
  liveSourceChanged?: boolean;
  fileObservationWarning?: string;
  recoveryStoragePressure?: boolean;
  referenceVersion?: string;
  copyDirectory?: string | null;
  outdatedSuggestions?: OutdatedSuggestion[];
  operationContext?: SyncContext;
  recoveryCheckpoints?: Array<{
    id: string;
    generation?: number;
    pageInstanceId?: string;
    recoveryId?: string;
    resolvedAt?: string;
    reason: string;
    updatedAt: string;
    draft?: SyncDraft;
  }>;
  completion: {
    fileWritten: boolean;
    targetPath: string | null;
    accepted: number;
    reverted: number;
    completedAt: string;
  } | null;
}
