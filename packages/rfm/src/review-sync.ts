export interface SyncComment {
  id: string;
  changeId: string;
  content: string;
  createdAt: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  parentCommentId?: string | null;
  scope?: "document";
  originalQuote?: string;
  detachedReason?: string;
}
export interface SyncMetadata {
  frontmatter: string | null;
  endmatter: string | null;
}
export interface SyncHistory {
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
  metadata?: { before: SyncMetadata; after: SyncMetadata };
}
export interface OutdatedSuggestion {
  id: string;
  originalText: string;
  proposedText: string;
  reason: string;
  parentId?: string | null;
  createdAt?: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
}
export interface SyncDraft {
  markdown: string;
  cleanMarkdown?: string;
  decisions: Record<string, "kept">;
  reviewed?: SyncHistory[];
  reviewComments: SyncComment[];
  outdatedSuggestions?: OutdatedSuggestion[];
}
export interface SyncContext {
  owner: string;
  epoch: string;
  acceptUntil: number;
}
export interface SyncOperation {
  operationId: string;
  operationSequence: number;
  pageInstanceId: string;
  operationContext: SyncContext;
  acknowledgedOperationIds?: string[];
}
export interface SyncDisk {
  path: string;
  version: string | null;
  hash: string | null;
  text: string | null;
  availability:
    | "available"
    | "missing"
    | "unreadable"
    | "retargeted"
    | "unobservable";
  message?: string;
}
export interface SyncState<Review = unknown> {
  review: Review;
  draft: SyncDraft;
  revision: number;
  signature: string;
  disk: SyncDisk | null;
  operationContext: SyncContext;
  registryGeneration: string;
  originDrafts?: Record<string, SyncDraft>;
  publishing?: { operationId: string; owner: string; startedAt: number };
}
export interface SyncConflict {
  id: string;
  kind: "text" | "metadata" | "comment" | "suggestion" | "decision" | "history";
  base: unknown;
  local: unknown;
  incoming: unknown;
  label: string;
}
export interface SyncMerge {
  status: "merged" | "conflict" | "client-merge-required";
  draft: SyncDraft;
  conflicts: SyncConflict[];
  signature: string;
  idRemap?: Record<string, string>;
  reason?: string;
}
export interface SyncReservation {
  token: string;
  revision: number;
  expiresAt: number;
}
export interface ReconcileRequest extends SyncOperation {
  expectedRevision: number;
  baseRevision: number;
  baseSignature: string;
  base: SyncDraft;
  draft: SyncDraft;
  expectedDisk: {
    path: string;
    version: string | null;
    hash?: string | null;
  } | null;
  writeFile: boolean;
  localGeneration: number;
  reason: "sync" | "adopt" | "resolve" | "send";
  resolution?: { signature: string; choice: "local" | "incoming" };
  reservationToken?: string;
  comment?: string;
}
export type SyncStatus =
  | "committed"
  | "conflict"
  | "client-merge-required"
  | "retry-later"
  | "incoming-changed"
  | "binding-changed"
  | "base-unavailable"
  | "publishing"
  | "operation-expired"
  | "indeterminate"
  | "not-received"
  | "rejected";
export interface SyncResult<Review = unknown> {
  status: SyncStatus;
  state?: SyncState<Review>;
  merge?: SyncMerge;
  reservation?: SyncReservation;
  retryAfter?: number;
  message?: string;
  operationId?: string;
  savedPath?: string;
  canonicalPath?: string;
  reviewUrl?: string;
  checkpointId?: string;
  uiDrafts?: Record<string, unknown>;
}
export interface CopyDestination {
  path: string;
  displayPath: string;
  installationName: string;
  exists: boolean;
  allowed: boolean;
  message?: string;
  relativeLinks: string[];
}
export interface CopyRequest extends SyncOperation {
  generation: number;
  workingDraft: SyncDraft;
  uiDrafts?: Record<string, unknown>;
  path: string;
  relativeLinksAcknowledged: boolean;
  conflictCheckpointId?: string;
}
