import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type CopyDestination,
  cleanRoughdraftMarkdown,
  contentSignature,
  extractRoughdraftReviewIndex,
  hasUnsubmittedReviewFeedback,
  mergeReviewDrafts,
  type OutdatedSuggestion,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncDisk,
  type SyncDraft,
  type SyncOperation,
  type SyncResult,
  type SyncState,
  sameReviewDraft,
} from "@roughdraft/rfm";
import { diffLines } from "diff";
import { type Request, type Response, Router } from "express";
import {
  atomicWrite,
  FileChangedError,
  type PreparedFileIdentity,
  syncDirectory,
  syncExistingFile,
} from "./atomic-write.js";
import { ComparisonEventStream } from "./comparison-event-stream.js";
import { ComparisonLockBusy, ComparisonLocks } from "./comparison-locks.js";
import {
  ComparisonOperations,
  type OperationRecord,
  readOperation,
} from "./comparison-operations.js";
import {
  ReviewBaseCache,
  ReviewReservations,
} from "./comparison-sync-cache.js";
import { transferSyncResponse } from "./comparison-sync-transfer.js";
import { logServerEvent } from "./diagnostics.js";
import { DocumentWatcherRegistry } from "./document-watchers.js";

export type ComparisonMode = "proposal" | "applied" | "compare" | "document";
export type ComparisonDecision = "pending" | "before" | "after";
type BaseVersion = "old" | "new";
type BaseOptions = Record<BaseVersion, string | null>;
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
export interface ComparisonCompletion {
  fileWritten: boolean;
  targetPath: string | null;
  accepted: number;
  reverted: number;
  completedAt: string;
}
export interface ComparisonReviewComment {
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
export interface DocumentMetadata {
  frontmatter: string | null;
  endmatter: string | null;
}
export interface ReviewedChange {
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
export interface EditorDraft {
  markdown: string;
  cleanMarkdown?: string;
  decisions: Record<string, "kept">;
  reviewed?: ReviewedChange[];
  diskOrigin?: SyncDraft["diskOrigin"];
}
export interface EditorFeedback {
  draft: EditorDraft;
  reference: { label: string; markdown: string } | null;
  destinationPath: string | null;
  saved: boolean;
  comment: string;
  reviewComments: ComparisonReviewComment[];
  sentAt: string;
}
export interface ComparisonOverwriteNotice {
  operationId: string;
  pageInstanceId: string;
  checkpointId: string;
  displacedSignature: string;
  createdAt: string;
}
export interface Comparison {
  id: string;
  revision: number;
  mode: ComparisonMode;
  title: string;
  beforeLabel: string;
  afterLabel: string;
  beforePath?: string | null;
  afterPath?: string | null;
  targetPath: string | null;
  beforeText: string;
  afterText: string;
  segments: ComparisonSegment[];
  comment: string;
  reviewComments: ComparisonReviewComment[];
  status: "open" | "completed" | "applied";
  completion: ComparisonCompletion | null;
  targetChanged: boolean;
  editor?: "unified";
  handoff?: "chat" | "button";
  autosave?: string;
  autosaveBase?: BaseVersion;
  recoveredFrom?: string;
  recoveredReviews?: Comparison[];
  draft?: EditorDraft | null;
  destinationPath?: string | null;
  savedPath?: string | null;
  savedText?: string | null;
  baseVersion?: BaseVersion | null;
  baseOptions?: BaseOptions;
  feedback?: EditorFeedback | null;
  lastOperation?: { id: string; pageInstanceId: string; reason: string };
  lastOverwrite?: ComparisonOverwriteNotice;
  liveSourcePath?: string | null;
  liveSourceVersion?: string | null;
  liveSourceChanged?: boolean;
  fileObservationWarning?: string;
  recoveryStoragePressure?: boolean;
  referenceVersion?: string;
  outdatedSuggestions?: OutdatedSuggestion[];
  copyDirectory?: string;
  recoveryCheckpoints?: Array<{
    id: string;
    generation: number;
    pageInstanceId?: string;
    recoveryId?: string;
    reason: string;
    kind?: "copy-feedback" | "automatic";
    bytes?: number;
    uiDrafts?: Record<string, unknown>;
    entryUiDrafts?: Record<string, unknown>;
    createdAt: string;
    resolvedAt?: string;
    // A covering save can commit before the snapshot of its newer generation.
    resolvedThroughGeneration?: number;
    savedCopyId?: string;
  }>;
}
interface StoredComparison
  extends Omit<Comparison, "targetChanged" | "recoveredReviews"> {
  targetVersion: string | null;
  abandonedCopy?: { checkpointId: string };
  lastOperation?: { id: string; pageInstanceId: string; reason: string };
  operationOutcomes?: Record<
    string,
    {
      id: string;
      sequence: number;
      revision: number;
      signature: string;
      createdAt: number;
    }
  >;
  pendingPublication?: {
    owner: string;
    processInstance: string;
    operation: SyncOperation;
    startedAt: number;
    draft: SyncDraft;
    path: string | null;
    expectedDisk: SyncDisk | null;
    writeFile: boolean;
    reason: string;
    overwriteNotice?: ComparisonOverwriteNotice;
    uiDrafts?: Record<string, unknown>;
    generation?: number;
    publishedIdentity?: {
      device: number;
      inode: number;
      inPlace: boolean;
      witnessPath?: string;
    };
    baseVersion?: BaseVersion;
  };
  pendingApply?: { outputHash: string; completion: ComparisonCompletion };
  destinationVersion?: string | null;
  baseInputVersions?: Record<BaseVersion, string | null>;
  pendingSave?: {
    path: string;
    draft: EditorDraft;
    reviewComments: ComparisonReviewComment[];
    baseVersion?: BaseVersion;
  };
}
interface FileSnapshot {
  path: string;
  text: string;
  version: string;
  mode: number;
}
class ComparisonError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
function preparedVersion(
  identity: PreparedFileIdentity,
  text: string,
): string | undefined {
  // In-place writes have no immutable staged version to identify later echoes.
  if (identity.inPlace) return undefined;
  const stat = fs.statSync(identity.stagedPath);
  if (stat.dev !== identity.device || stat.ino !== identity.inode)
    throw new FileChangedError();
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${hash(text)}`;
}
function log(event: string, fields: Record<string, unknown> = {}): void {
  const severity =
    event === "error" ? "error" : event === "conflict" ? "warn" : "info";
  logServerEvent("server/comparisons", event, fields, severity);
  console.info(
    JSON.stringify({
      severity,
      component: "comparisons",
      event,
      ...fields,
    }),
  );
}
function stringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ComparisonError(400, `${key} must be a string`);
  return value;
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ComparisonError(400, "A JSON object is required");
  return value as Record<string, unknown>;
}
function launchPolicy(body: Record<string, unknown>): {
  handoff: "chat" | "button" | undefined;
  autosave: string | undefined;
  autosaveBase: BaseVersion | undefined;
} {
  const handoff = stringField(body, "handoff");
  if (handoff !== undefined && handoff !== "chat" && handoff !== "button")
    throw new ComparisonError(400, "handoff must be chat or button");
  const autosave = stringField(body, "autosave");
  if (
    autosave !== undefined &&
    autosave !== "none" &&
    (!path.isAbsolute(autosave) ||
      path.extname(autosave).toLowerCase() !== ".md")
  )
    throw new ComparisonError(
      400,
      "autosave must be an absolute .md path or none",
    );
  const autosaveBase = stringField(body, "autosaveBase");
  if (
    autosaveBase !== undefined &&
    autosaveBase !== "old" &&
    autosaveBase !== "new"
  )
    throw new ComparisonError(400, "autosaveBase must be old or new");
  return { handoff, autosave, autosaveBase };
}
function reviewCommentsField(
  value: unknown,
  review: StoredComparison,
  allowDraftAnchors = false,
): ComparisonReviewComment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new ComparisonError(400, "reviewComments must be an array");
  const anchors = new Set([
    ...review.segments
      .filter((segment) => segment.kind === "change")
      .map((segment) => segment.id),
    ...review.reviewComments.map((comment) => comment.changeId),
  ]);
  const ids = new Set<string>();
  return value.map((raw) => {
    const input = objectBody(raw);
    const id = stringField(input, "id");
    const changeId = stringField(input, "changeId");
    const content = stringField(input, "content");
    const createdAt = stringField(input, "createdAt");
    if (
      !id ||
      ids.has(id) ||
      !changeId ||
      (!allowDraftAnchors && !anchors.has(changeId)) ||
      content === undefined ||
      !createdAt ||
      !Number.isFinite(Date.parse(createdAt))
    )
      throw new ComparisonError(
        400,
        "Review comments need unique IDs, an existing change, content and a valid timestamp",
      );
    ids.add(id);
    const { authorType, authorId, parentCommentId, scope } = input;
    if (
      authorType !== undefined &&
      authorType !== "user" &&
      authorType !== "ai"
    )
      throw new ComparisonError(400, "Comment authorType must be user or ai");
    for (const key of ["authorId", "parentCommentId"])
      if (
        input[key] !== undefined &&
        input[key] !== null &&
        typeof input[key] !== "string"
      )
        throw new ComparisonError(
          400,
          `Comment ${key} must be a string or null`,
        );
    if (scope !== undefined && scope !== "document")
      throw new ComparisonError(400, "Comment scope must be document");
    return {
      id,
      changeId,
      content,
      createdAt,
      ...(authorType !== undefined ? { authorType } : {}),
      ...(authorId !== undefined
        ? { authorId: authorId as string | null }
        : {}),
      ...(parentCommentId !== undefined
        ? { parentCommentId: parentCommentId as string | null }
        : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...Object.fromEntries(
        ["originalQuote", "detachedReason"].flatMap((key) => {
          const value =
            input[key] ??
            review.reviewComments.find((item) => item.id === id)?.[
              key as "originalQuote" | "detachedReason"
            ];
          if (value !== undefined && typeof value !== "string")
            throw new ComparisonError(400, `Comment ${key} must be a string`);
          return value === undefined ? [] : [[key, value]];
        }),
      ),
    };
  });
}
function snapshot(filename: string, root?: string): FileSnapshot {
  try {
    const realPath = fs.realpathSync(path.resolve(filename));
    enforceDocumentRoot(root, filename, realPath);
    if (root && path.extname(realPath).toLowerCase() !== ".md")
      throw new ComparisonError(400, "The destination must be a Markdown file");
    const stat = fs.statSync(realPath);
    if (!stat.isFile())
      throw new ComparisonError(400, `Not a regular file: ${filename}`);
    const bytes = fs.readFileSync(realPath);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new ComparisonError(
        400,
        `File must contain UTF-8 text: ${filename}`,
      );
    return {
      path: realPath,
      text,
      mode: stat.mode & 0o7777,
      version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${hash(text)}`,
    };
  } catch (error) {
    if (error instanceof ComparisonError) throw error;
    throw new ComparisonError(
      400,
      `Cannot read file ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function documentMetadataField(value: unknown): DocumentMetadata {
  const input = objectBody(value);
  if (
    (input.frontmatter !== null && typeof input.frontmatter !== "string") ||
    (input.endmatter !== null && typeof input.endmatter !== "string")
  )
    throw new ComparisonError(
      400,
      "Document metadata needs frontmatter and endmatter strings or null",
    );
  return { frontmatter: input.frontmatter, endmatter: input.endmatter };
}
function reviewedField(value: unknown): ReviewedChange[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new ComparisonError(400, "reviewed must be an array of changes");
  const ids = new Set<string>();
  return value.map((entry) => {
    const input = objectBody(entry);
    const id = stringField(input, "id");
    const decision = stringField(input, "decision");
    const oldText = stringField(input, "oldText");
    const newText = stringField(input, "newText");
    if (
      !id ||
      ids.has(id) ||
      (decision !== "accept" && decision !== "reject") ||
      oldText === undefined ||
      newText === undefined ||
      !Array.isArray(input.inverse)
    )
      throw new ComparisonError(
        400,
        "Reviewed changes need unique IDs, accept/reject decisions, text and inverse steps",
      );
    ids.add(id);
    const guard = objectBody(input.guard);
    if (
      !Number.isSafeInteger(guard.from) ||
      !Number.isSafeInteger(guard.to) ||
      (guard.from as number) < 0 ||
      (guard.to as number) < (guard.from as number) ||
      !Object.hasOwn(guard, "slice") ||
      (guard.slice !== null &&
        (typeof guard.slice !== "object" || Array.isArray(guard.slice)))
    )
      throw new ComparisonError(
        400,
        "Reviewed change guards need ordered positions and a serialized slice",
      );
    const keptId = stringField(input, "keptId");
    if (
      input.keptIds !== undefined &&
      (!Array.isArray(input.keptIds) ||
        input.keptIds.some((id) => typeof id !== "string" || !id))
    )
      throw new ComparisonError(
        400,
        "Reviewed change keptIds must be change IDs",
      );
    if (input.stale !== undefined && typeof input.stale !== "boolean")
      throw new ComparisonError(400, "Reviewed change stale must be boolean");
    const metadata =
      input.metadata === undefined ? undefined : objectBody(input.metadata);
    return {
      id,
      decision,
      oldText,
      newText,
      inverse: input.inverse.map(objectBody),
      guard: {
        from: guard.from as number,
        to: guard.to as number,
        slice: guard.slice,
      },
      ...(keptId !== undefined ? { keptId } : {}),
      ...(input.keptIds !== undefined
        ? { keptIds: [...(input.keptIds as string[])] }
        : {}),
      ...(input.stale !== undefined ? { stale: input.stale } : {}),
      ...Object.fromEntries(
        ["staleReason", "unmappedSince", "originSignature"].flatMap((key) => {
          const value = stringField(input, key);
          return value === undefined ? [] : [[key, value]];
        }),
      ),
      ...(metadata
        ? {
            metadata: {
              before: documentMetadataField(metadata.before),
              after: documentMetadataField(metadata.after),
            },
          }
        : {}),
    };
  });
}
function draftField(body: Record<string, unknown>): EditorDraft {
  const markdown = stringField(body, "markdown");
  if (markdown === undefined)
    throw new ComparisonError(400, "markdown is required");
  const cleanMarkdown = stringField(body, "cleanMarkdown");
  const entries = Object.entries(objectBody(body.decisions));
  if (entries.some(([key, value]) => !key || value !== "kept"))
    throw new ComparisonError(400, "decisions must map change IDs to kept");
  const reviewed = reviewedField(body.reviewed);
  let diskOrigin: SyncDraft["diskOrigin"];
  if (body.diskOrigin !== undefined) {
    const origin = objectBody(body.diskOrigin);
    const originPath = stringField(origin, "path");
    const signature = stringField(origin, "signature");
    const ids = objectBody(origin.ids);
    if (
      !originPath ||
      !signature ||
      Object.entries(ids).some(
        ([id, value]) => !id || typeof value !== "string" || !value,
      )
    )
      throw new ComparisonError(
        400,
        "Disk origin needs a path, source signature and identity map",
      );
    diskOrigin = {
      path: originPath,
      signature,
      ids: ids as Record<string, string>,
    };
  }
  return {
    markdown,
    ...(cleanMarkdown !== undefined ? { cleanMarkdown } : {}),
    decisions: Object.fromEntries(entries.map(([id]) => [id, "kept"] as const)),
    ...(reviewed !== undefined ? { reviewed } : {}),
    ...(diskOrigin ? { diskOrigin } : {}),
  };
}
function cleanDraft(draft: EditorDraft): string {
  return draft.cleanMarkdown ?? draft.markdown;
}
function containsReviewMarkup(markdown: string): boolean {
  // Code snippets that show CriticMarkup syntax are ordinary Markdown. Use
  // the same scanner as the review index to distinguish them from annotations.
  return Boolean(
    /\{(?:[+\-~=]{2}|>>)|^(?:comments|suggestions):/m.test(markdown) &&
      extractRoughdraftReviewIndex(markdown).items.length,
  );
}
function assertPlainMarkdown(markdown: string): void {
  if (containsReviewMarkup(markdown))
    throw new ComparisonError(
      400,
      "The file text must exclude pending suggestions and review comments",
    );
}
function outsideRoot(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}
function enforceDocumentRoot(
  root: string | undefined,
  filename: string,
  resolved?: string,
): void {
  if (!root) return;
  const requested = path.resolve(filename);
  const actualRoot = fs.realpathSync(root);
  // Stored paths are canonical. Accept both root spellings when a hosted
  // installation configured an alias for its document directory.
  if (
    (outsideRoot(path.resolve(root), requested) &&
      outsideRoot(actualRoot, requested)) ||
    (resolved && outsideRoot(actualRoot, resolved))
  )
    throw new ComparisonError(
      403,
      "Choose a Markdown file inside the document directory",
    );
}
function createFile(
  filename: string,
  text: string,
  validate: () => void,
  onPrepared?: (identity: PreparedFileIdentity) => void,
): void {
  // Publish a new file without replacing anything that raced the last check.
  // Stage in the same directory, fsync the data, then link it into place.
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const staged = fs.statSync(temporary);
    onPrepared?.({
      device: staged.dev,
      inode: staged.ino,
      inPlace: false,
      stagedPath: temporary,
    });
    validate();
    try {
      fs.linkSync(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ComparisonError(
          409,
          "The destination changed on disk. Choose a different file.",
        );
      throw error;
    }
  } finally {
    fs.unlinkSync(temporary);
  }
  syncDirectory(directory);
}
function inspectDestination(
  filename: string,
  root?: string,
): {
  path: string;
  current: FileSnapshot | null;
} {
  if (
    !path.isAbsolute(filename) ||
    path.extname(filename).toLowerCase() !== ".md"
  )
    throw new ComparisonError(400, "Choose an absolute path ending in .md");
  enforceDocumentRoot(root, filename);
  let candidate: string;
  try {
    candidate = path.join(
      fs.realpathSync(path.dirname(filename)),
      path.basename(filename),
    );
    if (!fs.statSync(path.dirname(candidate)).isDirectory())
      throw new Error("The parent is not a directory");
  } catch (error) {
    throw new ComparisonError(
      400,
      `Choose a Markdown file in an existing directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  enforceDocumentRoot(root, filename, candidate);
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: candidate, current: null };
    throw error;
  }
  const current = snapshot(candidate, root);
  if (path.extname(current.path).toLowerCase() !== ".md")
    throw new ComparisonError(400, "The destination must be a Markdown file");
  return { path: current.path, current };
}
export function comparisonSegments(
  before: string,
  after: string,
): ComparisonSegment[] {
  const parts = diffLines(before, after);
  const segments: ComparisonSegment[] = [];
  const occurrences = new Map<string, number>();
  let oldStart = 1;
  let newStart = 1;
  const add = (
    kind: ComparisonSegment["kind"],
    previous: string,
    next: string,
  ) => {
    const signature = hash(JSON.stringify([kind, previous, next]));
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    segments.push({
      id: `${signature.slice(0, 24)}-${occurrence}`,
      kind,
      before: previous,
      after: next,
      oldStart,
      newStart,
      decision: kind === "equal" ? "after" : "pending",
      comment: "",
    });
    oldStart += (previous.match(/\n/g) ?? []).length;
    newStart += (next.match(/\n/g) ?? []).length;
  };
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      add("equal", part.value, part.value);
      continue;
    }
    let previous = "";
    let next = "";
    while (
      index < parts.length &&
      (parts[index].added || parts[index].removed)
    ) {
      if (parts[index].removed) previous += parts[index].value;
      else next += parts[index].value;
      index++;
    }
    index--;
    add("change", previous, next);
  }
  return segments;
}

export interface ComparisonStoreOptions {
  allowFileBindMountWrites?: boolean;
  documentRoot?: string;
  projectDir?: string;
  homeDir?: string;
  processStateDir?: string;
  displayName?: string;
  browserBasePath?: string | ((request: Request) => string);
  watchers?: DocumentWatcherRegistry;
}
export class ComparisonStore {
  private lastFeedbackTime = 0;
  private recoveryChecked = false;
  private lastMaintenance = Number.NEGATIVE_INFINITY;
  readonly watchers: DocumentWatcherRegistry;
  private locks: ComparisonLocks;
  private operations: ComparisonOperations<Comparison>;
  private reservations: ReviewReservations;
  private bases = new ReviewBaseCache();
  private ownDisk = new Map<string, { observedAt: number; disk: SyncDisk }>();
  private checkpointLists = new Map<
    string,
    {
      observedAt: number;
      entries: NonNullable<Comparison["recoveryCheckpoints"]>;
    }
  >();
  private ownRecords = new Map<
    string,
    { observedAt: number; review: StoredComparison; version?: string }
  >();

  constructor(
    private directory: string,
    private options: ComparisonStoreOptions = {},
  ) {
    this.watchers = options.watchers ?? new DocumentWatcherRegistry();
    this.locks = new ComparisonLocks(path.join(directory, ".locks"));
    const processState =
      options.processStateDir ??
      (options.homeDir
        ? path.join(options.homeDir, ".roughdraft")
        : (process.env.ROUGHDRAFT_STATE_DIR ??
          (process.env.ROUGHDRAFT_STATE_FILE
            ? path.dirname(process.env.ROUGHDRAFT_STATE_FILE)
            : path.join(
                path.dirname(directory),
                `.roughdraft-process-${hash(path.resolve(directory)).slice(0, 12)}`,
              ))));
    this.operations = new ComparisonOperations(
      directory,
      processState,
      (record) => this.pruneOperationMarker(record),
    );
    this.reservations = new ReviewReservations(this.operations.now);
  }
  private syncDraft(review: StoredComparison): SyncDraft {
    const draft = review.draft ?? { markdown: review.afterText, decisions: {} };
    return {
      ...draft,
      reviewComments: review.reviewComments,
      ...(review.outdatedSuggestions
        ? { outdatedSuggestions: review.outdatedSuggestions }
        : {}),
    };
  }
  private parseSyncDraft(value: unknown, review: StoredComparison): SyncDraft {
    const input = objectBody(value);
    const draft = draftField(input);
    if (!draft.diskOrigin && review.draft?.diskOrigin)
      draft.diskOrigin = review.draft.diskOrigin;
    const comments =
      reviewCommentsField(input.reviewComments, review, true) ??
      review.reviewComments;
    let outdated = review.outdatedSuggestions;
    if (input.outdatedSuggestions !== undefined) {
      if (!Array.isArray(input.outdatedSuggestions))
        throw new ComparisonError(400, "Outdated suggestions must be an array");
      outdated = input.outdatedSuggestions.map((raw) => {
        const item = objectBody(raw);
        const id = stringField(item, "id");
        const originalText = stringField(item, "originalText");
        const proposedText = stringField(item, "proposedText");
        const reason = stringField(item, "reason");
        if (
          !id ||
          originalText === undefined ||
          proposedText === undefined ||
          !reason
        )
          throw new ComparisonError(
            400,
            "Outdated suggestions need an ID, texts and reason",
          );
        if (
          (item.createdAt !== undefined &&
            typeof item.createdAt !== "string") ||
          (item.authorType !== undefined &&
            item.authorType !== "user" &&
            item.authorType !== "ai") ||
          (item.authorId !== undefined &&
            item.authorId !== null &&
            typeof item.authorId !== "string")
        )
          throw new ComparisonError(
            400,
            "Outdated suggestion attribution is invalid",
          );
        return {
          id,
          originalText,
          proposedText,
          reason,
          ...(typeof item.createdAt === "string"
            ? { createdAt: item.createdAt }
            : {}),
          ...(item.authorType === "user" || item.authorType === "ai"
            ? { authorType: item.authorType }
            : {}),
          ...(item.authorId === null || typeof item.authorId === "string"
            ? { authorId: item.authorId }
            : {}),
          ...(item.parentId === null || typeof item.parentId === "string"
            ? { parentId: item.parentId }
            : {}),
        };
      });
    }
    return {
      ...draft,
      reviewComments: comments,
      ...(outdated ? { outdatedSuggestions: outdated } : {}),
    };
  }
  private editorDraft(draft: SyncDraft): EditorDraft {
    const {
      reviewComments: _comments,
      outdatedSuggestions: _outdated,
      ...editor
    } = draft;
    return editor;
  }
  private installDraft(review: StoredComparison, draft: SyncDraft): void {
    const { reviewComments, outdatedSuggestions, ...editor } = draft;
    review.draft = editor;
    review.reviewComments = reviewComments;
    review.outdatedSuggestions = outdatedSuggestions;
  }
  private diskAt(filename: string): SyncDisk {
    try {
      const inspected = this.inspectDestination(filename);
      const current = inspected.current;
      return {
        path: inspected.path,
        version: current?.version ?? null,
        hash: current ? hash(current.text) : null,
        text: current?.text ?? null,
        availability:
          inspected.path !== filename
            ? "retargeted"
            : current
              ? "available"
              : "missing",
      };
    } catch (error) {
      return {
        path: filename,
        version: null,
        hash: null,
        text: null,
        availability: "unreadable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  private preparedPublication(
    review: StoredComparison,
    identity: PreparedFileIdentity,
    record: OperationRecord<Comparison>,
  ): void {
    if (!review.pendingPublication)
      throw new Error(
        "A durable publication intent is required before staging",
      );
    if (identity.inPlace) {
      // A file bind mount may not support a hardlink from its mounted inode.
      // Normal completion still verifies its bytes. After a crash this weaker
      // identity cannot prove ownership, so recovery preserves a checkpoint.
      review.pendingPublication.publishedIdentity = {
        device: identity.device,
        inode: identity.inode,
        inPlace: true,
      };
      this.save(review);
      return;
    }
    const witnessPath = this.publicationWitness(
      review.pendingPublication.path!,
      review.pendingPublication.operation.operationId,
    );
    fs.linkSync(identity.stagedPath, witnessPath);
    const held = fs.statSync(witnessPath);
    if (held.dev !== identity.device || held.ino !== identity.inode) {
      fs.unlinkSync(witnessPath);
      throw new FileChangedError();
    }
    syncDirectory(path.dirname(witnessPath));
    this.operations.holdPublication(record, {
      path: witnessPath,
      device: held.dev,
      inode: held.ino,
    });
    review.pendingPublication.publishedIdentity = {
      device: identity.device,
      inode: identity.inode,
      inPlace: identity.inPlace,
      witnessPath,
    };
    // The operation already durably pins this identity. Recovery reads it
    // there, avoiding another full pending-review rewrite before publication.
  }
  private publicationWitness(filename: string, operationId: string): string {
    return path.join(
      path.dirname(filename),
      `.roughdraft-${operationId}.publication`,
    );
  }
  private currentDisk(
    review: StoredComparison,
    fresh = false,
  ): SyncDisk | null {
    const filename =
      review.editor === "unified"
        ? (review.destinationPath ?? review.liveSourcePath)
        : review.targetPath;
    if (!filename) return null;
    const snapshot = this.watchers.get(filename);
    const observation =
      snapshot.availability === "unobservable"
        ? {
            observation: "unobservable" as const,
            message: snapshot.error,
          }
        : {};
    if (fresh) {
      try {
        const inspected = this.inspectDestination(filename);
        const current = inspected.current;
        return {
          ...observation,
          path: inspected.path,
          version: current?.version ?? null,
          hash: current ? hash(current.text) : null,
          text: current?.text ?? null,
          availability:
            inspected.path !== filename
              ? "retargeted"
              : current
                ? "available"
                : "missing",
        };
      } catch (error) {
        return {
          path: filename,
          version: null,
          hash: null,
          text: null,
          availability: "unreadable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const own = this.ownDisk.get(filename);
    if (own && snapshot.observedAt <= own.observedAt)
      return { ...own.disk, ...observation };
    if (own) this.ownDisk.delete(filename);
    return {
      path: snapshot.resolvedPath ?? filename,
      version: snapshot.version,
      hash: snapshot.hash,
      text: snapshot.text,
      availability:
        snapshot.resolvedPath && snapshot.resolvedPath !== filename
          ? "retargeted"
          : snapshot.availability === "unobservable"
            ? "available"
            : snapshot.availability,
      ...observation,
      ...(snapshot.error ? { message: snapshot.error } : {}),
    };
  }
  statePaths(id: string): string[] {
    let review: StoredComparison;
    try {
      review = this.stateReview(id);
    } catch {
      return [this.filename(id), this.checkpointIndex(id)];
    }
    return [
      this.filename(id),
      this.checkpointIndex(id),
      review.destinationPath ?? review.liveSourcePath,
    ].filter((value): value is string => Boolean(value));
  }
  private canRecreateFile(
    review: StoredComparison,
    disk: SyncDisk | null,
  ): boolean {
    const destination = review.destinationPath;
    if (
      !destination ||
      review.autosave === "none" ||
      disk?.availability !== "missing" ||
      disk.path !== destination ||
      disk.version !== null
    )
      return false;
    try {
      const parent = fs.realpathSync(path.dirname(destination));
      if (path.join(parent, path.basename(destination)) !== destination)
        return false;
      enforceDocumentRoot(this.options.documentRoot, destination);
      fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
      return !fs.lstatSync(destination, { throwIfNoEntry: false });
    } catch {
      return false;
    }
  }
  context() {
    return this.operations.context();
  }
  private stateReview(id: string): StoredComparison {
    const snapshot = this.watchers.get(this.filename(id));
    const own = this.ownRecords.get(id);
    if (own && snapshot.observedAt <= own.observedAt)
      return structuredClone(own.review);
    if (own) this.ownRecords.delete(id);
    if (!snapshot.text) throw new ComparisonError(404, "Comparison not found");
    const review = JSON.parse(snapshot.text) as StoredComparison;
    review.reviewComments ??= [];
    if (review.editor === "unified") {
      review.handoff ??= "button";
      review.autosave ??= review.destinationPath ?? "none";
    }
    return review;
  }
  private registryGeneration(
    review: StoredComparison,
    disk: SyncDisk | null,
    checkpoints: Comparison["recoveryCheckpoints"] = [],
  ): string {
    return `${review.revision}:${disk?.version ?? "none"}:${review.pendingPublication?.operation.operationId ?? ""}:${review.lastOperation?.id ?? ""}:${hash(JSON.stringify(checkpoints))}`;
  }
  state(
    id: string,
    current?: StoredComparison,
    diskOverride?: SyncDisk | null,
  ): SyncState<Comparison> {
    const review = current ?? this.stateReview(id);
    const draft = this.syncDraft(review);
    let disk =
      diskOverride === undefined ? this.currentDisk(review) : diskOverride;
    if (disk && !disk.observation) {
      const observed = this.watchers.get(disk.path);
      if (observed.availability === "unobservable")
        disk = {
          ...disk,
          observation: "unobservable",
          message: observed.error,
        };
    }
    const publicReview = this.view(review, false, true);
    publicReview.targetChanged = Boolean(
      disk &&
        (disk.availability !== "available" ||
          disk.version !==
            (review.destinationPath
              ? review.destinationVersion
              : review.liveSourceVersion)),
    );
    publicReview.liveSourceChanged =
      !review.destinationPath && publicReview.targetChanged;
    if (disk?.observation === "unobservable")
      publicReview.fileObservationWarning = disk.message;
    publicReview.recoveryCheckpoints = this.checkpoints(id);
    publicReview.recoveryStoragePressure =
      publicReview.recoveryCheckpoints.length > 20 ||
      publicReview.recoveryCheckpoints.reduce(
        (total, entry) => total + (entry.bytes ?? 0),
        0,
      ) >
        20 * 1024 * 1024;
    const state: SyncState<Comparison> = {
      review: publicReview,
      draft,
      revision: review.revision,
      signature: reviewDraftSignature(draft),
      disk,
      operationContext: this.operations.context(),
      baseReferences: true,
      registryGeneration: this.registryGeneration(
        review,
        disk,
        publicReview.recoveryCheckpoints,
      ),
    };
    if (review.pendingPublication)
      state.publishing = {
        operationId: review.pendingPublication.operation.operationId,
        owner: review.pendingPublication.owner,
        startedAt: review.pendingPublication.startedAt,
      };
    else if (review.pendingSave || review.pendingApply)
      state.publishing = {
        operationId: `legacy-${id}`,
        owner: "legacy",
        startedAt: fs.statSync(this.filename(id)).mtimeMs,
      };
    if (state.publishing) {
      const remaining = Math.max(
        0,
        Math.ceil(
          30_000 - (this.operations.now() - state.publishing.startedAt),
        ),
      );
      state.publishing.recoverable = remaining === 0;
      state.publishing.retryAfter = Math.min(30_000, remaining);
    }
    if (this.canRecreateFile(review, disk)) state.canRecreateFile = true;
    this.bases.remember(id, review.revision, draft, state.signature);
    state.originDrafts = this.bases.origins(
      id,
      new Set(
        (draft.reviewed ?? [])
          .map((entry) => entry.originSignature)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    return state;
  }
  mutation<T>(
    id: string | null,
    body: Record<string, unknown>,
    action: () => T,
  ): T {
    const now = this.operations.now();
    if (now - this.lastMaintenance >= 60_000) {
      try {
        this.locks.run([`maintenance:${this.directory}`], () => {
          this.operations.maintenance();
          this.lastMaintenance = now;
        });
      } catch (error) {
        if (!(error instanceof ComparisonLockBusy)) throw error;
      }
    }
    if (!this.recoveryChecked) {
      this.recoveryChecked = true;
      this.recoverOwnedPublications();
    }
    const keys: string[] = [];
    if (id) keys.push(`review:${id}`);
    if (typeof body.operationId === "string")
      keys.push(`operation:${body.operationId}`);
    const record = id ? this.readReview(id) : null;
    for (const filename of [
      record?.destinationPath,
      record?.liveSourcePath,
      body.path,
      body.targetPath,
      (body.expectedDisk as { path?: string } | null)?.path,
    ]) {
      if (typeof filename !== "string" || filename === "none") continue;
      const requested = path.isAbsolute(filename)
        ? filename
        : path.resolve(
            this.options.documentRoot ??
              this.options.projectDir ??
              process.cwd(),
            filename,
          );
      let canonical = requested;
      try {
        canonical = fs.realpathSync(requested);
      } catch {
        try {
          canonical = path.join(
            fs.realpathSync(path.dirname(requested)),
            path.basename(requested),
          );
        } catch {
          /* Validation reports the unusable parent. */
        }
      }
      keys.push(`file:${canonical}`);
    }
    if (!id) keys.push(`create:${this.directory}`);
    return this.locks.run(keys, action);
  }
  private pruneOperationMarker(record: OperationRecord<Comparison>): boolean {
    if (
      !this.operations.wasPruned(
        record.operation.pageInstanceId,
        record.operation.operationSequence,
      )
    )
      return false;
    try {
      return this.locks.run([`review:${record.reviewId}`], () => {
        let review: StoredComparison;
        try {
          review = this.readReview(record.reviewId);
        } catch (error) {
          if (error instanceof ComparisonError && error.status === 404)
            return true;
          throw error;
        }
        if (review.abandonedCopy) return this.pruneAbandonedCopy(review);
        const outcomes = review.operationOutcomes;
        const marker = outcomes?.[record.operation.pageInstanceId];
        if (
          outcomes &&
          marker?.id === record.operation.operationId &&
          marker.sequence === record.operation.operationSequence
        ) {
          delete outcomes[record.operation.pageInstanceId];
          this.save(review);
        }
        return true;
      });
    } catch (error) {
      if (!(error instanceof ComparisonLockBusy))
        log("operation-marker-cleanup-deferred", {
          id: record.reviewId,
          operationId: record.operation.operationId,
          message: error instanceof Error ? error.message : String(error),
        });
      return false;
    }
  }
  private pruneAbandonedCopy(review: StoredComparison): boolean {
    const parent = review.recoveredFrom;
    const checkpointId = review.abandonedCopy?.checkpointId;
    if (
      !parent ||
      !checkpointId ||
      review.pendingPublication ||
      review.pendingSave ||
      review.pendingApply ||
      review.feedback
    )
      return false;
    const preserved = this.readCheckpoint(parent, checkpointId) as {
      workingDraft: SyncDraft;
      uiDrafts?: Record<string, unknown>;
    };
    if (!sameReviewDraft(this.syncDraft(review), preserved.workingDraft))
      return false;
    const privateFeedback = JSON.stringify(preserved.uiDrafts ?? {});
    for (const entry of this.checkpoints(review.id)) {
      const owned = this.readCheckpoint(review.id, entry.id) as {
        entryDraft: SyncDraft;
        workingDraft: SyncDraft;
        uiDrafts?: Record<string, unknown>;
        entryUiDrafts?: Record<string, unknown>;
      };
      if (
        !sameReviewDraft(owned.entryDraft, preserved.workingDraft) ||
        !sameReviewDraft(owned.workingDraft, preserved.workingDraft) ||
        JSON.stringify(owned.uiDrafts ?? {}) !== privateFeedback ||
        JSON.stringify(owned.entryUiDrafts ?? {}) !== privateFeedback
      )
        return false;
    }
    // Exact prune coverage is already durable. The original review's existing
    // recovery system retains every candidate byte and private draft first.
    fs.rmSync(path.join(this.watchChildren(parent), review.id), {
      force: true,
    });
    syncDirectory(this.watchChildren(parent));
    fs.rmSync(path.join(this.directory, "checkpoints", review.id), {
      recursive: true,
      force: true,
    });
    syncDirectory(path.join(this.directory, "checkpoints"));
    fs.rmSync(this.checkpointIndex(review.id), { force: true });
    fs.rmSync(this.filename(review.id), { force: true });
    this.ownRecords.delete(review.id);
    this.checkpointLists.delete(review.id);
    this.watchers.invalidate(this.filename(review.id));
    syncDirectory(this.directory);
    log("abandoned-copy-pruned", { id: review.id, parent, checkpointId });
    return true;
  }
  private outcome(
    review: StoredComparison,
    operation: SyncOperation,
    reason: string,
    result: SyncResult<Comparison>,
    record: OperationRecord<Comparison>,
  ): SyncResult<Comparison> {
    result.operationId = operation.operationId;
    review.lastOperation = {
      id: operation.operationId,
      pageInstanceId: operation.pageInstanceId,
      reason,
    };
    if (result.state?.review.id === review.id) {
      result.state.review.lastOperation = { ...review.lastOperation };
      result.state.registryGeneration = this.registryGeneration(
        review,
        result.state.disk,
        result.state.review.recoveryCheckpoints,
      );
    }
    this.operations.prepare(record, result);
    review.operationOutcomes ??= {};
    review.operationOutcomes[operation.pageInstanceId] = {
      id: operation.operationId,
      sequence: operation.operationSequence,
      revision: review.revision,
      signature:
        result.state?.signature ?? reviewDraftSignature(this.syncDraft(review)),
      createdAt: this.operations.now(),
    };
    for (const [page, marker] of Object.entries(review.operationOutcomes))
      if ((operation.acknowledgedOperationIds ?? []).includes(marker.id))
        delete review.operationOutcomes[page];
    this.save(review);
    this.watchers.invalidate(this.filename(review.id));
    this.reservations.release(review.id, operation.pageInstanceId);
    return this.operations.finish(record);
  }
  private liveOperationResult(
    result: SyncResult<Comparison>,
  ): SyncResult<Comparison> {
    const context = this.operations.context();
    return {
      ...result,
      ...(result.state
        ? { state: { ...result.state, operationContext: context } }
        : {}),
      ...(result.status === "retry-later" && result.operationContext
        ? { operationContext: context }
        : {}),
    };
  }
  operationStatus(id: string): SyncResult<Comparison> {
    try {
      const record = this.operations.read(id);
      if (record?.resultUnavailable)
        return {
          status: "indeterminate",
          operationId: id,
          message:
            "The retained save result is unavailable. Preserve your recovery copy before retrying.",
        };
      if (!record)
        return {
          status: "indeterminate",
          operationId: id,
          message:
            "Operation is unrecorded. Resolve its saved identity before retrying.",
        };
      if (record.phase === "done" && record.result)
        return this.liveOperationResult(record.result);
      const review = this.readReview(record.reviewId);
      const marker =
        review.operationOutcomes?.[record.operation.pageInstanceId];
      if (marker?.id === id && record.result)
        return this.liveOperationResult(record.result);
      return {
        status: "publishing",
        operationId: id,
        state: this.state(review.id, review),
        message: "The previous publication has not finished.",
      };
    } catch (error) {
      return {
        status: "indeterminate",
        operationId: id,
        message: `Save status could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  resolveOperation(
    id: string,
    body: Record<string, unknown>,
  ): SyncResult<Comparison> {
    const operation = readOperation({ ...body, operationId: id });
    const old = this.operations.read(id);
    const reviewId = old?.reviewId ?? stringField(body, "reviewId");
    if (!reviewId)
      throw new ComparisonError(
        400,
        "The original review ID is required to resolve an unrecorded save",
      );
    return this.mutation(
      reviewId,
      operation as unknown as Record<string, unknown>,
      () => {
        const existing = this.operations.read(id);
        if (existing) {
          if (existing.resultUnavailable)
            return {
              status: "indeterminate",
              operationId: id,
              message:
                "The retained save result is unavailable. Preserve your recovery copy before retrying.",
            };
          let ownerReview: StoredComparison | null = null;
          try {
            ownerReview = this.readReview(existing.reviewId);
          } catch (error) {
            if (!(error instanceof ComparisonError) || error.status !== 404)
              throw error;
          }
          if (
            existing.phase !== "done" &&
            ownerReview?.pendingPublication?.operation.operationId === id &&
            ownerReview.pendingPublication.owner === this.operations.owner
          )
            return this.recoverPublication(ownerReview);
          const status = this.operationStatus(id);
          if (
            status.status === "committed" &&
            existing.phase === "prepared" &&
            existing.result
          )
            this.operations.finish(existing);
          if (
            existing.phase !== "done" &&
            (!ownerReview ||
              (!ownerReview.pendingPublication &&
                !ownerReview.pendingSave &&
                ownerReview.operationOutcomes?.[
                  existing.operation.pageInstanceId
                ]?.id !== id))
          ) {
            this.operations.prepare(existing, {
              status: "rejected",
              ...(ownerReview
                ? { state: this.state(ownerReview.id, ownerReview) }
                : {}),
              message:
                "The prior request stopped before committing. Your recovered changes can resume.",
            });
            return this.operations.finish(existing);
          }
          return status;
        }
        const review = this.readReview(reviewId);
        if (review.pendingPublication?.operation.operationId === id)
          return {
            status: "publishing",
            operationId: id,
            state: this.state(reviewId, review),
          };
        if (
          this.operations.foreign(operation) ||
          this.operations.lost(operation) ||
          this.hasOperationOutcome(review, operation)
        )
          return {
            status: "indeterminate",
            operationId: id,
            state: this.state(reviewId, review),
            message:
              "This save's retained result is unavailable. Compare latest or save separately.",
          };
        // A valid-window tombstone fences a delayed original. An old context is
        // already ineligible at execution; retaining this terminal result makes
        // both cases identical to the caller and survives a restart.
        return this.operations.reject(operation, reviewId, {
          status: "not-received",
          operationId: id,
          state: this.state(reviewId, review),
        });
      },
    );
  }
  private hasOperationOutcome(
    review: StoredComparison,
    operation: SyncOperation,
  ): boolean {
    const pending = [review.id];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const current = id === review.id ? review : this.readReview(id);
      if (
        current.operationOutcomes?.[operation.pageInstanceId]?.id ===
          operation.operationId ||
        current.pendingPublication?.operation.operationId ===
          operation.operationId
      )
        return true;
      try {
        pending.push(...fs.readdirSync(this.watchChildren(id)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }
  private fallback(
    review: StoredComparison,
    operation: SyncOperation,
    status: "base-unavailable" | "client-merge-required",
    message?: string,
  ): SyncResult<Comparison> {
    const state = this.state(review.id, review);
    const reservation = this.reservations.request(
      review.id,
      operation.pageInstanceId,
      review.revision,
    );
    return reservation
      ? { status, state, reservation, message }
      : {
          status: "retry-later",
          state,
          retryAfter: this.reservations.remaining(review.id) || 25,
          message: "Another page has the next merge turn.",
        };
  }
  reconcile(
    id: string,
    body: Record<string, unknown>,
    capabilities: { compactRetry?: boolean } = {},
  ): SyncResult<Comparison> {
    const operation = readOperation(body);
    return this.mutation(id, body, () => {
      const previous = this.operations.read(operation.operationId);
      if (previous) return this.operationStatus(operation.operationId);
      let review = this.readReview(id);
      this.requireEditor(review);
      if (this.operations.foreign(operation))
        return {
          status: "indeterminate",
          state: this.state(id, review),
          message: "This save belongs to a different server installation.",
        };
      if (this.operations.lost(operation))
        return {
          status: "indeterminate",
          state: this.state(id, review),
          message:
            "This operation's retained outcome was pruned or lost. Check recovery before retrying.",
        };
      // Deadline/epoch validation is deliberately inside the held mutation locks.
      if (!this.operations.valid(operation))
        return this.operations.reject(operation, id, {
          status: "operation-expired",
          state: this.state(id, review),
          message: "Refresh the save context and retry your queued changes.",
        });
      const request = body as unknown as ReconcileRequest;
      const admission = () => {
        const blocked = this.reservations.blocked(
          id,
          operation.pageInstanceId,
          request.reservationToken,
        );
        return {
          revision: review.revision,
          blocked,
          recoverToken:
            blocked &&
            !request.reservationToken &&
            this.reservations.ownedBy(id, operation.pageInstanceId),
          reserved: this.reservations.valid(
            id,
            operation.pageInstanceId,
            request.reservationToken,
            review.revision,
          ),
        };
      };
      // These locks already exclude another review/file mutation. Journal I/O
      // must not turn an admitted holder into a late request, or a denied peer
      // into a writer, merely because the same request's flushes take time.
      const admitted =
        !review.pendingPublication &&
        !review.pendingSave &&
        !review.pendingApply
          ? admission()
          : null;
      const record = this.operations.begin(operation, id);
      const reject = (
        result: SyncResult<Comparison>,
        allowCompactRetry = true,
      ) => {
        if (
          capabilities.compactRetry &&
          allowCompactRetry &&
          result.status === "retry-later"
        )
          result = {
            status: "retry-later",
            retryAfter: result.retryAfter,
            message: result.message,
            retryRevision: review.revision,
            operationContext: this.operations.context(),
          };
        log("sync-deferred", {
          id,
          operationId: operation.operationId,
          revision: review.revision,
          result: result.status,
          retryAfter: result.retryAfter,
          reservationExpiresAt: result.reservation?.expiresAt,
          reason: typeof body.reason === "string" ? body.reason : "sync",
        });
        this.operations.prepare(record, result, { terminal: true });
        return this.operations.finish(record);
      };
      if (review.pendingPublication?.owner === this.operations.owner) {
        this.recoverPublication(review);
        review = this.readReview(id);
      }
      if (
        review.pendingPublication ||
        review.pendingSave ||
        review.pendingApply
      )
        return reject(
          {
            status: "retry-later",
            retryAfter: 100,
            state: this.state(id, review),
            message: "Another publication is finishing.",
          },
          false,
        );
      const turn =
        admitted?.revision === review.revision ? admitted : admission();
      const resolutionCheckpoints = new Map<string, number>();
      if (Array.isArray(request.resolution?.checkpointIds))
        for (const checkpointId of request.resolution.checkpointIds) {
          if (typeof checkpointId !== "string") continue;
          const generation =
            request.resolution.checkpointGenerations?.[checkpointId];
          resolutionCheckpoints.set(
            checkpointId,
            Number.isSafeInteger(generation)
              ? (generation as number)
              : request.localGeneration,
          );
        }
      const latest = this.syncDraft(review);
      // The selected page may already have merged this exact base while its
      // peer was saving. Keep its turn and use the ordinary guarded save path.
      const currentHandoff =
        turn.recoverToken &&
        request.expectedRevision === review.revision &&
        request.baseRevision === review.revision &&
        request.baseSignature === reviewDraftSignature(latest);
      if (turn.blocked && !currentHandoff) {
        // A page selected from the waiting queue has not received its token
        // yet. Stale candidates receive the same token without renewing the turn.
        if (turn.recoverToken)
          return reject(
            this.fallback(review, operation, "client-merge-required"),
          );
        return reject({
          status: "retry-later",
          retryAfter: this.reservations.remaining(id) || 25,
          ...(capabilities.compactRetry
            ? {}
            : { state: this.state(id, review) }),
        });
      }
      let submitted: SyncDraft;
      let base: SyncDraft;
      const baseInput =
        body.base ??
        (request.baseRevision === review.revision
          ? latest
          : this.bases.get(id, request.baseRevision));
      if (!baseInput)
        return reject(this.fallback(review, operation, "base-unavailable"));
      try {
        submitted = this.parseSyncDraft(body.draft, review);
        base = this.parseSyncDraft(baseInput, {
          ...review,
          reviewComments: [],
          draft: null,
          outdatedSuggestions: undefined,
        });
      } catch (error) {
        if (error instanceof ComparisonError)
          return reject({
            status: "rejected",
            state: this.state(id, review),
            message: error.message,
          });
        throw error;
      }
      if (reviewDraftSignature(base) !== body.baseSignature)
        return reject(
          this.fallback(
            review,
            operation,
            "base-unavailable",
            "The supplied base signature did not match.",
          ),
        );
      const freshDisk = this.currentDisk(review, true);
      const expected = request.expectedDisk;
      const bound = review.destinationPath ?? review.liveSourcePath ?? null;
      if ((expected?.path ?? null) !== bound)
        return reject({
          status: "binding-changed",
          state: this.state(id, review, freshDisk),
        });
      const recreate = request.reason === "recreate";
      if (
        recreate &&
        (!review.destinationPath ||
          review.autosave === "none" ||
          request.writeFile !== true ||
          expected?.version !== null)
      )
        return reject({
          status: "rejected",
          state: this.state(id, review, freshDisk),
          message:
            "Only an explicitly confirmed missing autosave file can be recreated.",
        });
      if (recreate && !this.canRecreateFile(review, freshDisk))
        return reject({
          status: "incoming-changed",
          state: this.state(id, review, freshDisk),
          message:
            "The file appeared or its destination is no longer available for recreation.",
        });
      if (freshDisk && freshDisk.availability !== "available" && !recreate)
        return reject({
          status: "incoming-changed",
          state: this.state(id, review, freshDisk),
          message:
            freshDisk.message ??
            "The bound file is unavailable or points elsewhere.",
        });
      const acknowledgedVersion = review.destinationPath
        ? review.destinationVersion
        : review.liveSourceVersion;
      const diskMoved = freshDisk && freshDisk.version !== acknowledgedVersion;
      const acceptsDisk =
        request.reason === "adopt" ||
        request.reason === "resolve" ||
        recreate ||
        (request.reason === "send" && body.adoptDisk === true);
      const observedCurrentDisk =
        !freshDisk || expected?.version === freshDisk.version;
      if (
        freshDisk &&
        !observedCurrentDisk &&
        freshDisk.version !== acknowledgedVersion
      )
        return reject({
          status: "incoming-changed",
          state: this.state(id, review, freshDisk),
        });
      if (
        diskMoved &&
        !acceptsDisk &&
        submitted.cleanMarkdown !== freshDisk.text
      )
        return reject({
          status: "incoming-changed",
          state: this.state(id, review, freshDisk),
        });
      let candidate = submitted;
      const reserved = turn.reserved;
      if (
        request.baseRevision !== review.revision ||
        body.baseSignature !== reviewDraftSignature(latest)
      ) {
        if (!reserved) {
          const knownBase = this.bases.get(id, request.baseRevision);
          if (
            !knownBase ||
            reviewDraftSignature(knownBase) !== body.baseSignature
          )
            return reject(this.fallback(review, operation, "base-unavailable"));
          let merge = mergeReviewDrafts(base, submitted, latest, {
            server: true,
            budgetMs: 16,
          });
          if (merge.status === "client-merge-required")
            return reject(
              this.fallback(
                review,
                operation,
                "client-merge-required",
                merge.reason,
              ),
            );
          if (merge.status === "conflict") {
            if (request.resolution?.signature !== merge.signature)
              return reject({
                status: "conflict",
                state: this.state(id, review, freshDisk),
                merge,
              });
            const localCheckpoint = this.checkpoint(id, {
              pageInstanceId: operation.pageInstanceId,
              generation: request.localGeneration,
              conflictId: merge.signature,
              workingDraft: submitted,
              reason: "Before resolving overlapping changes",
            });
            resolutionCheckpoints.set(
              localCheckpoint.checkpointId,
              request.localGeneration,
            );
            const incomingCheckpoint = this.checkpoint(id, {
              pageInstanceId: "incoming",
              generation: review.revision,
              conflictId: merge.signature,
              workingDraft: latest,
              reason: "Incoming state before conflict resolution",
            });
            resolutionCheckpoints.set(
              incomingCheckpoint.checkpointId,
              review.revision,
            );
            merge = mergeReviewDrafts(base, submitted, latest, {
              server: true,
              budgetMs: 16,
              resolution: request.resolution.choice,
            });
            if (merge.status !== "merged")
              return reject(
                this.fallback(review, operation, "client-merge-required"),
              );
          }
          candidate = merge.draft;
          this.bases.remember(
            id,
            `origin-${reviewDraftSignature(submitted)}`,
            submitted,
          );
          if (
            candidate.markdown !== submitted.markdown ||
            candidate.markdown !== latest.markdown
          ) {
            candidate.reviewed = candidate.reviewed?.map((entry) =>
              entry.stale && entry.staleReason !== "needs-remap"
                ? entry
                : {
                    ...entry,
                    stale: true,
                    staleReason: "needs-remap",
                    unmappedSince: `${id}:${review.revision}`,
                    originSignature:
                      entry.originSignature ??
                      reviewDraftSignature(
                        submitted.reviewed?.some(
                          (local) => local.id === entry.id,
                        )
                          ? submitted
                          : latest,
                      ),
                  },
            );
          }
        } else if (request.expectedRevision !== review.revision)
          return reject(this.fallback(review, operation, "base-unavailable"));
      }
      if (request.reason === "resolve" && !request.resolution)
        throw new ComparisonError(
          400,
          "Conflict resolution requires the inspected conflict choice",
        );
      // A browser's aliases describe exactly the disk snapshot it accepted.
      // A stale/older page may retain the committed map, but cannot replace it
      // with aliases for another destination or an unacknowledged source.
      if (
        candidate.diskOrigin &&
        JSON.stringify(candidate.diskOrigin) !==
          JSON.stringify(latest.diskOrigin) &&
        (!acceptsDisk ||
          !freshDisk ||
          candidate.diskOrigin.path !== freshDisk.path ||
          candidate.diskOrigin.signature !==
            contentSignature(freshDisk.text ?? ""))
      ) {
        candidate = { ...candidate, diskOrigin: latest.diskOrigin };
      }
      const changed = !sameReviewDraft(candidate, latest);
      const overwriteNotice: ComparisonOverwriteNotice | undefined =
        request.reason === "resolve" &&
        request.resolution?.choice === "local" &&
        changed
          ? {
              operationId: operation.operationId,
              pageInstanceId: operation.pageInstanceId,
              displacedSignature: reviewDraftSignature(latest),
              checkpointId: this.checkpoint(id, {
                pageInstanceId: "displaced-overwrite",
                generation: review.revision,
                conflictId: operation.operationId,
                workingDraft: latest,
                reason:
                  "Saved review before another tab overwrote conflicting changes",
              }).checkpointId,
              createdAt: new Date().toISOString(),
            }
          : undefined;
      const writeFile =
        request.writeFile === true &&
        Boolean(review.destinationPath) &&
        request.reason !== "send";
      if (
        writeFile &&
        (candidate.cleanMarkdown ?? candidate.markdown) !== freshDisk?.text
      ) {
        try {
          assertPlainMarkdown(candidate.cleanMarkdown ?? candidate.markdown);
        } catch (error) {
          if (!(error instanceof ComparisonError)) throw error;
          return reject({
            status: "rejected",
            state: this.state(id, review, freshDisk),
            message: error.message,
          });
        }
      }
      const release = this.watchers.beginPublication(
        this.statePaths(id),
        operation.operationId,
      );
      const publishedVersions: Record<string, string | null> = {};
      try {
        if (
          writeFile &&
          freshDisk &&
          candidate.cleanMarkdown !== freshDisk.text &&
          (candidate.cleanMarkdown ?? candidate.markdown) !== freshDisk.text
        ) {
          review.pendingPublication = {
            owner: this.operations.owner,
            processInstance: this.operations.epoch,
            operation,
            startedAt: this.operations.now(),
            draft: candidate,
            path: bound,
            expectedDisk: freshDisk,
            writeFile: true,
            reason: request.reason,
            ...(overwriteNotice ? { overwriteNotice } : {}),
          };
          this.save(review);
          const verify = () => {
            const current = this.currentDisk(review, true);
            if (
              !current ||
              current.path !== freshDisk.path ||
              current.availability !== freshDisk.availability ||
              current.version !== freshDisk.version
            )
              throw new FileChangedError();
          };
          const prepared = (identity: PreparedFileIdentity) => {
            this.preparedPublication(review, identity, record);
            const version = preparedVersion(
              identity,
              candidate.cleanMarkdown ?? candidate.markdown,
            );
            if (version) publishedVersions[freshDisk.path] = version;
            else delete publishedVersions[freshDisk.path];
          };
          if (recreate)
            createFile(
              freshDisk.path,
              candidate.cleanMarkdown ?? candidate.markdown,
              verify,
              prepared,
            );
          else
            atomicWrite(
              freshDisk.path,
              candidate.cleanMarkdown ?? candidate.markdown,
              {
                beforePublish: verify,
                allowBusyFallback: this.options.allowFileBindMountWrites,
                onPrepared: prepared,
              },
            );
        }
        const finalDisk = this.currentDisk(review, true);
        const candidateClean = candidate.cleanMarkdown ?? candidate.markdown;
        const wroteMarkdown = Boolean(
          writeFile && freshDisk && candidateClean !== freshDisk.text,
        );
        if (
          freshDisk &&
          (!finalDisk ||
            finalDisk.availability !== "available" ||
            finalDisk.path !== freshDisk.path ||
            (wroteMarkdown
              ? finalDisk.text !== candidateClean
              : finalDisk.version !== freshDisk.version))
        ) {
          const checkpoint = this.checkpoint(id, {
            pageInstanceId: operation.pageInstanceId,
            generation: request.localGeneration,
            conflictId: "source-changed",
            workingDraft: candidate,
            reason: "The file changed during publication",
          });
          if (review.pendingPublication) {
            delete review.pendingPublication;
            this.save(review);
          }
          return reject({
            status: "incoming-changed",
            state: this.state(id, review, finalDisk),
            checkpointId: checkpoint.checkpointId,
            message:
              "A newer file version arrived during this save. Both versions are preserved.",
          });
        }
        this.installDraft(review, candidate);
        if (overwriteNotice) review.lastOverwrite = overwriteNotice;
        if (
          finalDisk &&
          finalDisk.availability === "available" &&
          (writeFile ||
            acceptsDisk ||
            finalDisk.text === (candidate.cleanMarkdown ?? candidate.markdown))
        ) {
          review.savedPath = finalDisk.path;
          review.savedText = finalDisk.text;
          if (review.destinationPath)
            review.destinationVersion = finalDisk.version;
          if (review.liveSourcePath)
            review.liveSourceVersion = finalDisk.version;
          this.ownDisk.set(finalDisk.path, {
            observedAt: Date.now(),
            disk: finalDisk,
          });
        }
        delete review.pendingPublication;
        if (changed || diskMoved) review.revision++;
        if (request.reason === "send") {
          const stamp = new Date(
            Math.max(Date.now(), this.lastFeedbackTime + 1),
          ).toISOString();
          this.lastFeedbackTime = Date.parse(stamp);
          review.comment =
            typeof body.comment === "string" ? body.comment : review.comment;
          review.feedback = {
            draft: this.editorDraft(candidate),
            reference:
              review.mode === "document"
                ? null
                : review.baseVersion === "old"
                  ? { label: review.afterLabel, markdown: review.afterText }
                  : { label: review.beforeLabel, markdown: review.beforeText },
            destinationPath: review.destinationPath ?? null,
            saved: Boolean(
              finalDisk &&
                finalDisk.text ===
                  (candidate.cleanMarkdown ?? candidate.markdown),
            ),
            comment: review.comment,
            reviewComments: review.reviewComments,
            sentAt: stamp,
          };
          review.status = "completed";
          review.completion = {
            fileWritten: false,
            targetPath: review.destinationPath ?? null,
            accepted: Object.keys(candidate.decisions).length,
            reverted: 0,
            completedAt: stamp,
          };
          if (!changed && !diskMoved) review.revision++;
        }
        const result = {
          status: "committed" as const,
          state: this.state(id, review, finalDisk),
        };
        const completed = this.outcome(
          review,
          operation,
          request.reason,
          result,
          record,
        );
        if (request.reason === "resolve") {
          if (overwriteNotice)
            resolutionCheckpoints.set(
              overwriteNotice.checkpointId,
              review.revision,
            );
          for (const [checkpointId, generation] of resolutionCheckpoints)
            try {
              this.resolveCheckpoint(id, checkpointId, generation);
            } catch (error) {
              log("checkpoint-resolution-deferred", {
                id,
                checkpointId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
        }
        const covered =
          body.coveredCheckpoint &&
          typeof body.coveredCheckpoint === "object" &&
          !Array.isArray(body.coveredCheckpoint)
            ? (body.coveredCheckpoint as Record<string, unknown>)
            : {};
        if (
          typeof covered.recoveryId === "string" &&
          typeof covered.pageInstanceId === "string" &&
          typeof covered.generation === "number" &&
          Number.isSafeInteger(covered.generation) &&
          covered.generation >= 0 &&
          covered.generation <= request.localGeneration
        ) {
          const checkpointId = hash(
            `${id}:${covered.pageInstanceId}:${covered.recoveryId}`,
          );
          try {
            const checkpoint = this.readCheckpoint(id, checkpointId) as {
              automaticWait?: boolean;
              pageInstanceId?: string;
              conflictId?: string;
            };
            if (
              (checkpoint.automaticWait === true ||
                covered.reconciledSignature ===
                  reviewDraftSignature(submitted)) &&
              checkpoint.pageInstanceId === covered.pageInstanceId &&
              checkpoint.conflictId === covered.recoveryId
            )
              this.resolveCheckpoint(id, checkpointId, covered.generation);
          } catch (error) {
            if (!(error instanceof ComparisonError && error.status === 404))
              log("checkpoint-resolution-deferred", {
                id,
                checkpointId,
                message: error instanceof Error ? error.message : String(error),
              });
          }
        }
        log("sync-committed", {
          id,
          operationId: operation.operationId,
          revision: review.revision,
          fileWritten: writeFile,
          reason: request.reason,
        });
        if (overwriteNotice)
          log("sync-overwrite", {
            id,
            operationId: operation.operationId,
            checkpointId: overwriteNotice.checkpointId,
            displacedSignature: overwriteNotice.displacedSignature,
          });
        return completed;
      } catch (error) {
        if (
          error instanceof FileChangedError ||
          (recreate && error instanceof ComparisonError && error.status === 409)
        ) {
          const checkpoint = recreate
            ? this.checkpoint(id, {
                pageInstanceId: operation.pageInstanceId,
                conflictId: operation.operationId,
                generation: request.localGeneration,
                workingDraft: candidate,
                reason: "The file appeared before recreation finished",
              })
            : undefined;
          delete review.pendingPublication;
          this.save(review);
          return reject({
            status: "incoming-changed",
            state: this.state(id, review, this.currentDisk(review, true)),
            ...(checkpoint ? { checkpointId: checkpoint.checkpointId } : {}),
          });
        }
        // The durable intent remains discoverable after an I/O error; never
        // report an uncertain publication as a definite rejection.
        if (review.pendingPublication)
          return {
            status: "publishing",
            operationId: operation.operationId,
            state: this.state(id, review),
            message: error instanceof Error ? error.message : String(error),
          };
        throw error;
      } finally {
        const recordVersion = this.ownRecords.get(id)?.version;
        if (recordVersion) publishedVersions[this.filename(id)] = recordVersion;
        release(publishedVersions);
        if (bound) this.watchers.invalidate(bound);
      }
    });
  }
  private checkpointIndex(id: string): string {
    return path.join(this.directory, `recovery-${id}.json`);
  }
  private checkpoints(
    id: string,
  ): NonNullable<Comparison["recoveryCheckpoints"]> {
    const snapshot = this.watchers.get(this.checkpointIndex(id));
    const own = this.checkpointLists.get(id);
    if (own && snapshot.observedAt <= own.observedAt)
      return structuredClone(own.entries);
    if (own) this.checkpointLists.delete(id);
    return snapshot.text ? JSON.parse(snapshot.text) : [];
  }
  checkpoint(
    id: string,
    body: Record<string, unknown>,
  ): {
    checkpointId: string;
    generation: number;
    storagePressure?: boolean;
  } {
    return this.mutation(id, body, () => {
      const review = this.readReview(id);
      const draft = this.parseSyncDraft(body.workingDraft, review);
      const page = stringField(body, "pageInstanceId") ?? "recovery";
      const recoveryId = stringField(body, "recoveryId");
      const conflict =
        recoveryId ?? stringField(body, "conflictId") ?? "working";
      const generation =
        typeof body.generation === "number" &&
        Number.isSafeInteger(body.generation)
          ? body.generation
          : 0;
      const checkpointId = hash(`${id}:${page}:${conflict}`);
      const completed = this.checkpoints(id).find(
        (entry) =>
          entry.id === checkpointId &&
          entry.resolvedAt &&
          (entry.resolvedThroughGeneration ?? entry.generation) >= generation,
      );
      // A delayed snapshot cannot reopen work a durable covering save retired.
      // A higher generation still represents new work and follows the normal path.
      if (completed) {
        log("checkpoint-snapshot-covered", {
          id,
          checkpointId,
          generation,
          coveredGeneration:
            completed.resolvedThroughGeneration ?? completed.generation,
        });
        return { checkpointId, generation: completed.generation };
      }
      const directory = path.join(this.directory, "checkpoints", id);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const filename = path.join(directory, `${checkpointId}.json`);
      let previous: Record<string, unknown> | null = null;
      try {
        previous = JSON.parse(fs.readFileSync(filename, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        previous &&
        typeof previous.generation === "number" &&
        previous.generation > generation
      )
        return { checkpointId, generation: previous.generation };
      const now = new Date().toISOString();
      const snapshot = {
        id: checkpointId,
        origin: id,
        pageInstanceId: page,
        conflictId: conflict,
        generation,
        automaticWait:
          body.automaticWait === true &&
          (!previous || previous.automaticWait === true),
        reason: stringField(body, "reason") ?? "Unsaved conflict recovery",
        kind:
          body.kind === "copy-feedback"
            ? ("copy-feedback" as const)
            : recoveryId
              ? ("automatic" as const)
              : undefined,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        entryDraft: previous?.entryDraft ?? draft,
        ...(!previous
          ? { entryUiDrafts: body.uiDrafts ?? {} }
          : previous.entryUiDrafts !== undefined
            ? { entryUiDrafts: previous.entryUiDrafts }
            : {}),
        workingDraft: draft,
        uiDrafts: body.uiDrafts ?? {},
        baseVersions: body.baseVersions ?? null,
      };
      const serialized = JSON.stringify(snapshot);
      atomicWrite(filename, serialized);
      let list = this.checkpoints(id).filter(
        (item) => item.id !== checkpointId,
      );
      list.push({
        id: checkpointId,
        generation,
        pageInstanceId: page,
        ...(recoveryId ? { recoveryId } : {}),
        reason: snapshot.reason,
        ...(snapshot.kind ? { kind: snapshot.kind } : {}),
        bytes: Buffer.byteLength(serialized),
        createdAt: String(snapshot.createdAt),
      });
      list = this.pruneCheckpoints(id, list);
      atomicWrite(this.checkpointIndex(id), JSON.stringify(list));
      this.checkpointLists.set(id, {
        observedAt: Date.now(),
        entries: structuredClone(list),
      });
      this.watchers.invalidate(this.checkpointIndex(id));
      log("checkpoint-saved", { id, checkpointId, generation });
      let totalBytes = 0;
      for (const item of list) {
        try {
          totalBytes += fs.statSync(
            path.join(directory, `${item.id}.json`),
          ).size;
        } catch {
          /* The next read reports missing data. */
        }
      }
      return {
        checkpointId,
        generation,
        ...(list.length > 20 || totalBytes > 20 * 1024 * 1024
          ? { storagePressure: true }
          : {}),
      };
    });
  }
  private pruneCheckpoints(
    id: string,
    entries: NonNullable<Comparison["recoveryCheckpoints"]>,
  ): NonNullable<Comparison["recoveryCheckpoints"]> {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const unresolved = entries.filter((entry) => !entry.resolvedAt);
    const recent = entries
      .filter(
        (entry) => entry.resolvedAt && Date.parse(entry.resolvedAt) >= cutoff,
      )
      .sort(
        (a, b) =>
          Date.parse(b.resolvedAt ?? b.createdAt) -
          Date.parse(a.resolvedAt ?? a.createdAt),
      )
      .slice(0, Math.max(0, 20 - unresolved.length));
    const retained = new Set(
      [...unresolved, ...recent].map((entry) => entry.id),
    );
    for (const entry of entries)
      if (!retained.has(entry.id))
        fs.rmSync(
          path.join(this.directory, "checkpoints", id, `${entry.id}.json`),
          { force: true },
        );
    return entries.filter((entry) => retained.has(entry.id));
  }
  readCheckpoint(id: string, checkpointId: string): unknown {
    this.readReview(id);
    if (!/^[a-f0-9]{64}$/.test(checkpointId))
      throw new ComparisonError(404, "Recovery copy not found");
    try {
      return JSON.parse(
        fs.readFileSync(
          path.join(this.directory, "checkpoints", id, `${checkpointId}.json`),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ComparisonError(404, "Recovery copy not found");
      throw error;
    }
  }
  private resolveCheckpoint(
    id: string,
    checkpointId: string | undefined,
    generation: number,
    copyId?: string,
  ): void {
    if (!checkpointId) return;
    const list = this.checkpoints(id);
    const entry = list.find((item) => item.id === checkpointId);
    if (!entry || entry.generation > generation) return;
    if (!copyId) {
      const snapshot = this.readCheckpoint(id, checkpointId) as {
        uiDrafts?: Record<string, unknown>;
        entryUiDrafts?: Record<string, unknown>;
      };
      const submitted = this.readReview(id).reviewComments;
      if (
        hasUnsubmittedReviewFeedback(snapshot.uiDrafts, submitted) ||
        hasUnsubmittedReviewFeedback(snapshot.entryUiDrafts, submitted)
      )
        return;
    }
    entry.resolvedAt = new Date().toISOString();
    entry.resolvedThroughGeneration = Math.max(
      entry.resolvedThroughGeneration ?? entry.generation,
      generation,
    );
    entry.savedCopyId = copyId;
    const retained = this.pruneCheckpoints(id, list);
    atomicWrite(this.checkpointIndex(id), JSON.stringify(retained));
    this.checkpointLists.set(id, {
      observedAt: Date.now(),
      entries: structuredClone(retained),
    });
    this.watchers.invalidate(this.checkpointIndex(id));
  }
  private preserveCopyFeedback(review: StoredComparison): void {
    const intent = review.pendingPublication;
    if (intent?.reason !== "copy" || !intent.uiDrafts) return;
    const hasDrafts = Object.values(intent.uiDrafts).some(
      (value) =>
        value &&
        (typeof value === "object"
          ? Object.keys(value).length > 0
          : Boolean(value)),
    );
    if (!hasDrafts) return;
    this.checkpoint(review.id, {
      pageInstanceId: intent.operation.pageInstanceId,
      conflictId: `copy-feedback-${intent.operation.operationId}`,
      generation: intent.generation ?? intent.operation.operationSequence,
      workingDraft: intent.draft,
      uiDrafts: intent.uiDrafts,
      kind: "copy-feedback",
      reason: "Unfinished feedback saved with separate copy",
    });
  }
  private logicalPath(filename: string): string {
    if (!this.options.documentRoot) return filename;
    return `Documents/${path.relative(fs.realpathSync(this.options.documentRoot), filename).split(path.sep).join("/")}`;
  }
  private requestedCopyPath(value: string): string {
    if (!this.options.documentRoot) return value;
    if (path.isAbsolute(value)) return value;
    const logical = value.startsWith("Documents/")
      ? value.slice("Documents/".length)
      : value;
    return path.resolve(this.options.documentRoot, logical);
  }
  private relativeDestinations(markdown: string): string[] {
    let fence: { marker: string; length: number } | null = null;
    const visible = markdown
      .split(/\r?\n/)
      .map((line) => {
        const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = { marker: marker[0], length: marker.length };
          else if (marker[0] === fence.marker && marker.length >= fence.length)
            fence = null;
          return "";
        }
        return fence ? "" : line.replace(/(`+)[\s\S]*?\1/g, "");
      })
      .join("\n");
    const destinations = [
      ...visible.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g),
    ].map((match) => match[1] ?? match[2]);
    for (const match of visible.matchAll(
      /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm,
    ))
      destinations.push(match[1] ?? match[2]);
    return [
      ...new Set(
        destinations.filter(
          (value): value is string =>
            typeof value === "string" &&
            Boolean(value) &&
            !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value),
        ),
      ),
    ];
  }
  copyDestination(
    id: string,
    requested?: string,
    workingDraft?: unknown,
  ): CopyDestination {
    const review = this.readReview(id);
    const current =
      review.destinationPath ??
      review.liveSourcePath ??
      review.savedPath ??
      review.afterPath ??
      review.beforePath ??
      review.targetPath;
    const working =
      workingDraft === undefined
        ? this.syncDraft(review)
        : this.parseSyncDraft(workingDraft, review);
    const installationName = this.options.displayName ?? "this server";
    let filename = requested ? this.requestedCopyPath(requested) : "";
    if (!filename) {
      const candidates = [
        review.copyDirectory,
        review.destinationPath
          ? path.dirname(review.destinationPath)
          : undefined,
        ...[
          review.liveSourcePath,
          review.savedPath,
          review.afterPath,
          review.beforePath,
          review.targetPath,
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => path.dirname(value)),
        this.options.documentRoot ?? this.options.projectDir ?? process.cwd(),
      ];
      let directory: string | undefined;
      for (const candidate of new Set(candidates)) {
        if (!candidate) continue;
        try {
          const canonical = fs.realpathSync(candidate);
          enforceDocumentRoot(this.options.documentRoot, canonical);
          if (!fs.statSync(canonical).isDirectory()) continue;
          fs.accessSync(canonical, fs.constants.W_OK | fs.constants.X_OK);
          directory = canonical;
          break;
        } catch {
          /* Try the next allowed, existing folder. */
        }
      }
      if (!directory)
        return {
          path: "",
          displayPath: "",
          installationName,
          exists: false,
          allowed: false,
          message: "No writable folder is available for a separate copy.",
          relativeLinks: [],
        };
      const stem = current
        ? path.basename(current, path.extname(current))
        : "Untitled";
      const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-");
      for (let suffix = 0; suffix < 1000; suffix++) {
        const candidate = path.join(
          directory,
          `${stem}-copy-${timestamp}${suffix ? `-${suffix}` : ""}.md`,
        );
        if (!fs.existsSync(candidate)) {
          filename = candidate;
          break;
        }
      }
    }
    try {
      const selected = this.inspectDestination(filename);
      fs.accessSync(
        path.dirname(selected.path),
        fs.constants.W_OK | fs.constants.X_OK,
      );
      const aliases = [
        review.destinationPath,
        review.liveSourcePath,
        review.beforePath,
        review.afterPath,
        review.targetPath,
      ].filter(Boolean);
      const currentDirectory = current
        ? path.dirname(current)
        : path.dirname(selected.path);
      const relativeLinks =
        path.dirname(selected.path) === currentDirectory
          ? []
          : this.relativeDestinations(
              working.cleanMarkdown ?? working.markdown,
            );
      const alias = aliases.includes(selected.path);
      return {
        path: selected.path,
        displayPath: this.logicalPath(selected.path),
        installationName,
        exists: Boolean(selected.current),
        allowed: !selected.current && !alias,
        ...(selected.current || alias
          ? {
              message:
                "Choose an unused path different from the document and comparison inputs.",
            }
          : {}),
        relativeLinks,
      };
    } catch (error) {
      return {
        path: filename,
        displayPath:
          this.options.documentRoot && !path.isAbsolute(requested ?? "")
            ? (requested ?? "")
            : filename,
        installationName,
        exists: false,
        allowed: false,
        message: error instanceof Error ? error.message : String(error),
        relativeLinks: [],
      };
    }
  }
  copy(id: string, body: Record<string, unknown>): SyncResult<Comparison> {
    const operation = readOperation(body);
    const requested =
      stringField(body, "path") ?? stringField(body, "logicalPath");
    if (!requested)
      throw new ComparisonError(400, "Choose a path for the separate copy");
    const canonical = this.requestedCopyPath(requested);
    return this.mutation(id, { ...body, path: canonical }, () => {
      const existing = this.operations.read(operation.operationId);
      if (existing) return this.operationStatus(operation.operationId);
      const original = this.readReview(id);
      if (this.operations.foreign(operation))
        return {
          status: "indeterminate",
          state: this.state(id, original),
          message: "This copy belongs to another server installation.",
        };
      if (this.operations.lost(operation))
        return {
          status: "indeterminate",
          state: this.state(id, original),
          message: "This copy's retained outcome is unavailable.",
        };
      if (!this.operations.valid(operation))
        return this.operations.reject(operation, id, {
          status: "operation-expired",
          state: this.state(id, original),
        });
      const destination = this.copyDestination(
        id,
        canonical,
        body.workingDraft,
      );
      const draft = this.parseSyncDraft(body.workingDraft, original);
      if (!destination.allowed)
        return this.operations.reject(operation, id, {
          status: "rejected",
          state: this.state(id, original),
          message: destination.message ?? "Choose an unused writable path.",
        });
      if (
        destination.relativeLinks.length &&
        body.relativeLinksAcknowledged !== true
      )
        return this.operations.reject(operation, id, {
          status: "rejected",
          state: this.state(id, original),
          message:
            "Acknowledge that relative links may resolve differently in this folder.",
        });
      assertPlainMarkdown(draft.cleanMarkdown ?? draft.markdown);
      const copy: StoredComparison = {
        ...original,
        id: crypto.randomUUID(),
        revision: 1,
        recoveredFrom: id,
        autosave: destination.path,
        destinationPath: destination.path,
        destinationVersion: null,
        savedPath: null,
        savedText: null,
        liveSourcePath:
          original.mode === "document" ? destination.path : undefined,
        liveSourceVersion: null,
        comment: "",
        feedback: null,
        status: "open",
        completion: null,
      };
      delete copy.pendingApply;
      delete copy.pendingSave;
      delete copy.pendingPublication;
      delete copy.operationOutcomes;
      delete copy.lastOperation;
      delete copy.lastOverwrite;
      delete copy.abandonedCopy;
      this.installDraft(copy, draft);
      const record = this.operations.begin(operation, copy.id);
      // The accepted operation already names the new review. Persist its intent
      // before creating bytes or changing the new file's document index.
      copy.pendingPublication = {
        owner: this.operations.owner,
        processInstance: this.operations.epoch,
        operation,
        startedAt: this.operations.now(),
        draft,
        path: destination.path,
        expectedDisk: null,
        writeFile: true,
        reason: "copy",
        generation: typeof body.generation === "number" ? body.generation : 0,
        ...(body.uiDrafts &&
        typeof body.uiDrafts === "object" &&
        !Array.isArray(body.uiDrafts)
          ? { uiDrafts: body.uiDrafts as Record<string, unknown> }
          : {}),
      };
      this.save(copy);
      this.registerChild(id, copy.id);
      this.preserveCopyFeedback(copy);
      const release = this.watchers.beginPublication(
        [destination.path, this.filename(copy.id)],
        operation.operationId,
      );
      const publishedVersions: Record<string, string | null> = {};
      try {
        createFile(
          destination.path,
          draft.cleanMarkdown ?? draft.markdown,
          () => {
            if (this.inspectDestination(destination.path).current)
              throw new FileChangedError();
          },
          (identity) => {
            this.preparedPublication(copy, identity, record);
            const version = preparedVersion(
              identity,
              draft.cleanMarkdown ?? draft.markdown,
            );
            if (version) publishedVersions[destination.path] = version;
          },
        );
        const current = this.sourceSnapshot(destination.path);
        if (
          current.path !== destination.path ||
          current.text !== (draft.cleanMarkdown ?? draft.markdown)
        )
          throw new FileChangedError();
        this.recordSave(
          copy,
          this.editorDraft(draft),
          copy.reviewComments,
          current,
        );
        copy.liveSourceVersion =
          copy.mode === "document" ? current.version : null;
        if (copy.mode === "document")
          atomicWrite(this.documentIndex(current.path), copy.id);
        delete copy.pendingPublication;
        const disk: SyncDisk = {
          path: current.path,
          version: current.version,
          hash: hash(current.text),
          text: current.text,
          availability: "available",
        };
        this.ownDisk.set(current.path, { observedAt: Date.now(), disk });
        const result: SyncResult<Comparison> = {
          status: "committed",
          state: this.state(copy.id, copy, disk),
          savedPath: destination.displayPath,
          canonicalPath: current.path,
          reviewUrl: `?comparison=${copy.id}`,
          ...(body.uiDrafts && typeof body.uiDrafts === "object"
            ? { uiDrafts: body.uiDrafts as Record<string, unknown> }
            : {}),
        };
        const committed = this.outcome(copy, operation, "copy", result, record);
        this.resolveCheckpoint(
          id,
          stringField(body, "conflictCheckpointId"),
          typeof body.generation === "number" ? body.generation : 0,
          copy.id,
        );
        log("copy-saved", {
          id,
          copyId: copy.id,
          operationId: operation.operationId,
          destinationPath: current.path,
        });
        return committed;
      } catch (error) {
        if (
          error instanceof FileChangedError ||
          (error instanceof ComparisonError && error.status === 409)
        ) {
          const preserved = this.checkpoint(id, {
            pageInstanceId: operation.pageInstanceId,
            conflictId: `failed-copy-${operation.operationId}`,
            generation:
              typeof body.generation === "number" ? body.generation : 0,
            workingDraft: draft,
            uiDrafts: body.uiDrafts ?? {},
            kind: "copy-feedback",
            reason: "Unfinished feedback from a failed separate save",
          });
          delete copy.pendingPublication;
          // Retain the candidate and private feedback for operation recovery,
          // but a definite failure owns no saved copy or autosave destination.
          copy.abandonedCopy = { checkpointId: preserved.checkpointId };
          copy.destinationPath = null;
          copy.destinationVersion = null;
          copy.liveSourcePath = undefined;
          copy.liveSourceVersion = null;
          copy.savedPath = null;
          copy.savedText = null;
          copy.autosave = "none";
          this.save(copy);
          log("copy-abandoned", {
            id,
            copyId: copy.id,
            operationId: operation.operationId,
            destinationPath: destination.path,
            message: error instanceof Error ? error.message : String(error),
          });
          this.operations.prepare(record, {
            status: "rejected",
            state: this.state(id, original),
            message:
              "That file now exists. Choose another path and save again.",
          });
          return this.operations.finish(record);
        }
        return {
          status: "publishing",
          operationId: operation.operationId,
          state: this.state(id, original),
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        const recordVersion = this.ownRecords.get(copy.id)?.version;
        if (recordVersion)
          publishedVersions[this.filename(copy.id)] = recordVersion;
        release(publishedVersions);
        this.watchers.invalidate(destination.path);
      }
    });
  }
  private recoverOwnedPublications(): void {
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const id = name.slice(0, -5);
      try {
        const review = this.readReview(id);
        const intent = review.pendingPublication;
        if (
          !intent ||
          intent.owner !== this.operations.owner ||
          intent.processInstance === this.operations.epoch
        )
          continue;
        if (!this.locks.available) continue; // uncertain foreign/container liveness requires explicit Recover
        this.mutation(
          id,
          intent.operation as unknown as Record<string, unknown>,
          () => this.recoverPublication(this.readReview(id)),
        );
      } catch (error) {
        if (!(error instanceof ComparisonLockBusy))
          log("recovery-deferred", {
            id,
            message: error instanceof Error ? error.message : String(error),
          });
      }
    }
  }
  private recoverPublication(review: StoredComparison): SyncResult<Comparison> {
    const intent = review.pendingPublication;
    if (!intent)
      return {
        status: "rejected",
        state: this.state(review.id, review),
        message: "There is no unfinished publication.",
      };
    let record = this.operations.read(intent.operation.operationId);
    // Capture only the original durable witness. Rebuilding cleanup metadata
    // below must not turn an unrecorded staging file into publication proof.
    const recordedWitness =
      record &&
      !record.resultUnavailable &&
      record.reviewId === review.id &&
      record.operation.operationId === intent.operation.operationId &&
      record.operation.pageInstanceId === intent.operation.pageInstanceId &&
      record.operation.operationSequence === intent.operation.operationSequence
        ? record.publicationWitness
        : undefined;
    if (!record) record = this.operations.begin(intent.operation, review.id);
    this.preserveCopyFeedback(review);
    const disk = intent.path ? this.diskAt(intent.path) : null;
    const clean = intent.draft.cleanMarkdown ?? intent.draft.markdown;
    let ownedFile = false;
    const witnessPath = intent.path
      ? this.publicationWitness(intent.path, intent.operation.operationId)
      : null;
    const publishedIdentity =
      intent.publishedIdentity ??
      (recordedWitness?.path === witnessPath
        ? { ...recordedWitness, inPlace: false, witnessPath }
        : undefined);
    let held: fs.Stats | null = null;
    if (witnessPath) {
      try {
        held = fs.lstatSync(witnessPath);
        // A crash before the witness path was recorded still leaves this
        // deterministic name discoverable for cleanup.
        this.operations.holdPublication(record, {
          path: witnessPath,
          device: held.dev,
          inode: held.ino,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (
      disk?.availability === "available" &&
      publishedIdentity &&
      intent.path &&
      held &&
      publishedIdentity.witnessPath === witnessPath
    ) {
      const stat = fs.statSync(intent.path);
      ownedFile =
        stat.dev === publishedIdentity.device &&
        stat.ino === publishedIdentity.inode &&
        held.dev === stat.dev &&
        held.ino === stat.ino;
    }
    if (
      !intent.writeFile ||
      (ownedFile && disk?.path === intent.path && disk.text === clean)
    ) {
      this.installDraft(review, intent.draft);
      if (intent.overwriteNotice) review.lastOverwrite = intent.overwriteNotice;
      if (disk && intent.writeFile) {
        syncExistingFile(disk.path);
        review.savedPath = disk.path;
        review.savedText = disk.text;
        review.destinationPath = disk.path;
        review.autosave = disk.path;
        review.destinationVersion = disk.version;
        if (review.mode === "document") review.liveSourcePath = disk.path;
        if (review.liveSourcePath) review.liveSourceVersion = disk.version;
        if (intent.baseVersion) review.baseVersion = intent.baseVersion;
        if (review.mode === "document")
          atomicWrite(this.documentIndex(disk.path), review.id);
      }
      delete review.pendingPublication;
      review.revision++;
      const result: SyncResult<Comparison> = {
        status: "committed",
        state: this.state(review.id, review, disk),
        ...(intent.reason === "copy" && intent.path
          ? {
              savedPath: this.logicalPath(intent.path),
              canonicalPath: intent.path,
              reviewUrl: `?comparison=${review.id}`,
            }
          : {}),
        ...(intent.uiDrafts ? { uiDrafts: intent.uiDrafts } : {}),
      };
      return this.outcome(
        review,
        intent.operation,
        "recovered",
        result,
        record,
      );
    }
    const checkpoint = this.checkpoint(review.id, {
      pageInstanceId: intent.operation.pageInstanceId,
      generation: intent.operation.operationSequence,
      conflictId: intent.operation.operationId,
      workingDraft: intent.draft,
      ...(intent.uiDrafts ? { uiDrafts: intent.uiDrafts } : {}),
      reason: "Publication stopped before its file was verified",
    });
    delete review.pendingPublication;
    const result: SyncResult<Comparison> = {
      status: "rejected",
      state: this.state(review.id, review, disk),
      checkpointId: checkpoint.checkpointId,
      message: "The unfinished save was preserved without rewriting the file.",
    };
    return this.outcome(
      review,
      intent.operation,
      "recovered-without-write",
      result,
      record,
    );
  }
  recover(id: string): SyncResult<Comparison> {
    return this.mutation(id, {}, () => {
      let review = this.readReview(id);
      const kind = review.pendingPublication
        ? "publication"
        : review.pendingSave
          ? "legacy-save"
          : review.pendingApply
            ? "legacy-apply"
            : "none";
      let result: SyncResult<Comparison>;
      if (review.pendingPublication) result = this.recoverPublication(review);
      else if (review.pendingSave || review.pendingApply) {
        // Explicit legacy recovery retains its existing no-file-replay contract.
        review = this.load(id);
        result = {
          status: "committed",
          state: this.state(id, review, this.currentDisk(review, true)),
        };
      } else result = { status: "committed", state: this.state(id, review) };
      log("publication-recovery", {
        id,
        kind,
        status: result.status,
        checkpointId: result.checkpointId,
        replayedFileWrite: false,
      });
      return result;
    });
  }
  binding(id: string, body: Record<string, unknown>): SyncResult<Comparison> {
    return this.mutation(id, body, () => {
      const review = this.readReview(id);
      const pageInstanceId = `legacy-${id}`;
      const previous = review.operationOutcomes?.[pageInstanceId];
      const operation = body.operationId
        ? readOperation(body)
        : {
            operationId: crypto.randomUUID(),
            operationSequence: (previous?.sequence ?? 0) + 1,
            pageInstanceId,
            operationContext: this.operations.context(),
            acknowledgedOperationIds: previous ? [previous.id] : [],
          };
      const recorded = this.operations.read(operation.operationId);
      if (recorded) return this.operationStatus(operation.operationId);
      if (this.operations.foreign(operation) || this.operations.lost(operation))
        return {
          status: "indeterminate",
          state: this.state(id, review),
          message:
            "The binding operation belongs to an unavailable save context.",
        };
      if (!this.operations.valid(operation))
        return this.operations.reject(operation, id, {
          status: "operation-expired",
          state: this.state(id, review),
        });
      const record = this.operations.begin(operation, id);
      const reject = (result: SyncResult<Comparison>) => {
        this.operations.prepare(record, result, { terminal: true });
        return this.operations.finish(record);
      };
      if (review.pendingPublication || review.pendingSave)
        return reject({
          status: "retry-later",
          retryAfter: 100,
          state: this.state(id, review),
          message: "Another publication is finishing.",
        });
      if (
        (body.expectedPath ?? body.expectedDestination ?? null) !==
        (review.destinationPath ?? null)
      )
        return reject({
          status: "binding-changed",
          state: this.state(id, review),
        });
      const requested =
        stringField(body, "path") ?? stringField(body, "autosave");
      if (!requested)
        return reject({
          status: "rejected",
          state: this.state(id, review),
          message: "Choose an autosave path or none",
        });
      if (requested === "none") {
        const changed =
          review.destinationPath !== null || review.autosave !== "none";
        review.destinationPath = null;
        review.autosave = "none";
        if (changed) review.revision++;
        return this.outcome(
          review,
          operation,
          "binding",
          { status: "committed", state: this.state(id, review) },
          record,
        );
      }
      let selected: ReturnType<ComparisonStore["inspectDestination"]>;
      try {
        selected = this.inspectDestination(this.requestedCopyPath(requested));
      } catch (error) {
        return reject({
          status: "rejected",
          state: this.state(id, review),
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const expectedVersion =
        body.expectedVersion === undefined && !selected.current
          ? null
          : body.expectedVersion;
      if (expectedVersion !== (selected.current?.version ?? null))
        return reject({
          status: "incoming-changed",
          state: this.state(id, review),
        });
      const working = review.draft ?? {
        markdown: review.afterText,
        decisions: {},
      };
      if (
        containsReviewMarkup(working.markdown) &&
        working.cleanMarkdown === undefined
      )
        return reject({
          status: "client-merge-required",
          state: this.state(id, review),
          message:
            "Open the editor to establish the accepted document before binding an annotated source.",
        });
      if (selected.current && selected.current.text !== cleanDraft(working))
        return reject({
          status: "conflict",
          state: this.state(id, review),
          message:
            "The inspected destination contains different text. Compare it before rebinding.",
        });
      this.publishDraft(
        review,
        working,
        review.reviewComments,
        selected.path,
        selected.path,
        selected.current,
        undefined,
        { operation, record },
      );
      return this.operationStatus(operation.operationId);
    });
  }
  private inspectDestination(filename: string) {
    return inspectDestination(filename, this.options.documentRoot);
  }
  private sourceSnapshot(filename: string): FileSnapshot {
    if (!this.options.documentRoot) return snapshot(filename);
    const { current } = this.inspectDestination(filename);
    if (!current) throw new ComparisonError(400, "Markdown file not found");
    return current;
  }
  private filename(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new ComparisonError(404, "Comparison not found");
    return path.join(this.directory, `${id}.json`);
  }
  private watchChildren(id: string): string {
    return path.join(this.directory, `watch-${id}`);
  }
  private registerChild(parent: string, child: string): void {
    const children = this.watchChildren(parent);
    if (fs.mkdirSync(children, { recursive: true, mode: 0o700 }))
      syncDirectory(this.directory);
    atomicWrite(path.join(children, child), "");
  }
  private isVisibleRecovery(review: StoredComparison): boolean {
    return (
      !review.abandonedCopy &&
      !review.pendingPublication &&
      (!review.destinationPath || Boolean(review.savedPath))
    );
  }
  watch(id: string): StoredComparison {
    const root = this.readReview(id);
    if (root.editor !== "unified") return root;
    let latest = root;
    const seen = new Set<string>();
    const pending = [id];
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const review = next === id ? root : this.loadIndexedReview(next);
      if (!review) continue;
      if (
        this.isVisibleRecovery(review) &&
        review.feedback &&
        review.feedback.sentAt > (latest.feedback?.sentAt ?? "")
      )
        latest = review;
      try {
        for (const child of fs.readdirSync(this.watchChildren(next)))
          pending.push(child);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return latest;
  }
  private documentIndex(filename: string, pending = false): string {
    return path.join(
      this.directory,
      `document-${hash(filename)}.${pending ? "pending" : "index"}`,
    );
  }
  private isDocumentMove(review: StoredComparison, filename: string): boolean {
    return review.mode === "document" && review.destinationPath !== filename;
  }
  private indexOwner(index: string): string | null {
    try {
      return fs.readFileSync(index, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private loadIndexedReview(owner: string | null): StoredComparison | null {
    if (!owner) return null;
    try {
      return this.readReview(owner);
    } catch (error) {
      if (error instanceof ComparisonError && error.status === 404) return null;
      throw error;
    }
  }
  private clearDocumentMove(filename: string, owner: string): void {
    const pending = this.documentIndex(filename, true);
    if (this.indexOwner(pending) === owner) fs.rmSync(pending, { force: true });
  }
  private recoverDocumentMove(filename: string): void {
    const pending = this.documentIndex(filename, true);
    const owner = this.indexOwner(pending);
    if (!owner) return;
    // The provisional pointer allows recovery by filename before the active
    // index has moved. Recovery never republishes any Markdown bytes.
    const review = this.loadIndexedReview(owner);
    if (!review?.pendingSave && !review?.pendingPublication)
      this.clearDocumentMove(filename, owner);
  }
  private save(review: StoredComparison): void {
    const firstCreated = fs.mkdirSync(this.directory, {
      recursive: true,
      mode: 0o700,
    });
    if (firstCreated) {
      const existingParent = path.dirname(path.resolve(firstCreated));
      for (
        let directory = path.resolve(this.directory);
        ;
        directory = path.dirname(directory)
      ) {
        syncDirectory(directory);
        if (directory === existingParent) break;
      }
    }
    const serialized = `${JSON.stringify(review)}\n`;
    let version: string | undefined;
    atomicWrite(this.filename(review.id), serialized, {
      onPrepared: (identity) => {
        version = preparedVersion(identity, serialized);
      },
    });
    this.ownRecords.set(review.id, {
      observedAt: Date.now(),
      review: structuredClone(review),
      version,
    });
    if (this.ownRecords.size > 128) {
      const oldest = this.ownRecords.keys().next().value;
      if (oldest) this.ownRecords.delete(oldest);
    }
  }
  readReview(id: string): StoredComparison {
    const filename = this.filename(id);
    if (!fs.existsSync(filename))
      throw new ComparisonError(404, "Comparison not found");
    const review = JSON.parse(
      fs.readFileSync(filename, "utf8"),
    ) as StoredComparison;
    review.reviewComments ??= [];
    // Old callers can still be waiting for the explicit Send operation.
    // Normalize only in memory: reading a review never changes its policy.
    if (review.editor === "unified") {
      review.handoff ??= "button";
      review.autosave ??= review.destinationPath ?? "none";
    }
    return review;
  }
  load(id: string): StoredComparison {
    const review = this.readReview(id);
    // An intent makes a retry safe if the process stopped after rename but before
    // recording completion. Never replay a write during recovery.
    if (review.pendingApply && review.targetPath) {
      let wroteExpectedOutput = false;
      try {
        wroteExpectedOutput =
          hash(this.sourceSnapshot(review.targetPath).text) ===
          review.pendingApply.outputHash;
      } catch {
        /* Missing/changed destinations stay open and conflicted. */
      }
      if (wroteExpectedOutput) {
        syncExistingFile(review.targetPath);
        review.status = "applied";
        review.completion = review.pendingApply.completion;
        review.revision++;
      }
      delete review.pendingApply;
      this.save(review);
      if (wroteExpectedOutput) {
        log("recovered", {
          id: review.id,
          fileWritten: review.completion?.fileWritten,
        });
      }
    }
    if (review.pendingSave) {
      const intent = review.pendingSave;
      let current: FileSnapshot | null = null;
      try {
        current = this.sourceSnapshot(intent.path);
      } catch {
        /* Recovery never writes to an unavailable or changed destination. */
      }
      const moving = this.isDocumentMove(review, intent.path);
      if (
        current?.path === intent.path &&
        current.text === cleanDraft(intent.draft) &&
        (!moving ||
          this.indexOwner(this.documentIndex(intent.path, true)) === review.id)
      ) {
        syncExistingFile(current.path);
        this.finishSave(
          review,
          intent.draft,
          intent.reviewComments,
          current,
          intent.baseVersion,
        );
        log("draft-save-recovered", {
          id: review.id,
          destinationPath: current.path,
        });
      } else {
        // A crash before the write (or an external edit afterward) must not
        // lose the draft from the Save request. Never mark it saved blindly.
        // A failed comparison copy may contain a different reference seed.
        // An untitled document can always recover its annotations in place.
        if (!intent.baseVersion || review.mode === "document")
          review.draft = intent.draft;
        review.reviewComments = intent.reviewComments;
        review.revision++;
        delete review.pendingSave;
        this.save(review);
        if (moving) this.clearDocumentMove(intent.path, review.id);
      }
    }
    return review;
  }
  view(
    review: StoredComparison,
    includeRecoveries = true,
    cachedDisk = false,
    includeRecoveryFeedback = includeRecoveries,
  ): Comparison {
    const {
      targetVersion,
      destinationVersion,
      baseInputVersions: _baseInputVersions,
      pendingApply: _pendingApply,
      pendingSave: _pendingSave,
      pendingPublication: _pendingPublication,
      abandonedCopy: _abandonedCopy,
      operationOutcomes: _operationOutcomes,
      ...result
    } = review;
    let targetChanged = false;
    let fileObservationWarning: string | undefined;
    const filename =
      review.editor === "unified"
        ? (review.destinationPath ?? review.liveSourcePath)
        : review.targetPath;
    if (filename && (review.editor === "unified" || review.status === "open")) {
      try {
        const current = this.currentDisk(review, !cachedDisk);
        if (current?.observation === "unobservable")
          fileObservationWarning = current.message;
        targetChanged =
          !current ||
          current.availability !== "available" ||
          current.path !== filename ||
          current.version !==
            (review.editor === "unified"
              ? review.destinationPath
                ? destinationVersion
                : review.liveSourceVersion
              : targetVersion);
      } catch {
        targetChanged = true;
      }
    }
    const recoveredReviews: Comparison[] = [];
    if (includeRecoveries) {
      const pending = [review.id];
      const visited = new Set([review.id]);
      for (let parent = pending.pop(); parent; parent = pending.pop()) {
        let children: string[] = [];
        try {
          children = fs.readdirSync(this.watchChildren(parent));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        for (const id of children) {
          if (visited.has(id)) continue;
          visited.add(id);
          const child = this.loadIndexedReview(id);
          if (!child) continue;
          pending.push(child.id);
          if (child.recoveredFrom === parent && this.isVisibleRecovery(child))
            recoveredReviews.push(
              this.view(child, false, false, includeRecoveryFeedback),
            );
        }
      }
    }
    return {
      ...result,
      targetChanged,
      referenceVersion: hash(
        JSON.stringify([review.beforeText, review.afterText, review.segments]),
      ),
      ...(fileObservationWarning ? { fileObservationWarning } : {}),
      ...(review.editor === "unified" && review.liveSourcePath
        ? { liveSourceChanged: !review.destinationPath && targetChanged }
        : {}),
      ...(includeRecoveryFeedback
        ? {
            recoveryCheckpoints: this.checkpoints(review.id).map((entry) => {
              if (entry.kind !== "copy-feedback") return entry;
              const snapshot = this.readCheckpoint(review.id, entry.id) as {
                uiDrafts?: Record<string, unknown>;
                entryUiDrafts?: Record<string, unknown>;
              };
              return {
                ...entry,
                ...(snapshot.uiDrafts ? { uiDrafts: snapshot.uiDrafts } : {}),
                ...(snapshot.entryUiDrafts
                  ? { entryUiDrafts: snapshot.entryUiDrafts }
                  : {}),
              };
            }),
          }
        : {}),
      ...(recoveredReviews.length ? { recoveredReviews } : {}),
    };
  }
  openDocument(body: Record<string, unknown>): StoredComparison {
    const targetPath = stringField(body, "targetPath");
    const policy = launchPolicy(body);
    const title = stringField(body, "title");
    const beforeLabel = stringField(body, "beforeLabel");
    const afterLabel = stringField(body, "afterLabel");
    const input = { ...body, mode: "document", editor: "unified", targetPath };
    if (targetPath === undefined) return this.create(input);
    const { path: filename, current: disk } =
      this.inspectDestination(targetPath);
    this.recoverDocumentMove(filename);
    const index = this.documentIndex(filename);
    const current = this.loadIndexedReview(this.indexOwner(index));
    if (
      current?.mode === "document" &&
      (current.destinationPath === filename ||
        (current.autosave === "none" && current.savedPath === filename))
    ) {
      const bindingChanged = current.liveSourcePath !== filename;
      current.liveSourcePath = filename;
      current.liveSourceVersion ??=
        current.destinationVersion ?? disk?.version ?? null;
      const working = current.draft ?? {
        markdown: current.afterText,
        decisions: {},
      };
      const hasWork =
        current.feedback ||
        current.reviewComments.length ||
        cleanDraft(working) !== current.savedText ||
        containsReviewMarkup(working.markdown);
      let changed = false;
      const revision = current.revision;
      if (disk && !hasWork && disk.text !== current.savedText) {
        current.draft = {
          ...working,
          markdown: disk.text,
          cleanMarkdown: disk.text,
        };
        current.savedPath = filename;
        current.savedText = disk.text;
        current.liveSourceVersion = disk.version;
        if (current.destinationPath) current.destinationVersion = disk.version;
        changed = true;
      }
      for (const [key, value] of [
        ["title", title],
        ["beforeLabel", beforeLabel],
        ["afterLabel", afterLabel],
      ] as const) {
        if (value !== undefined && current[key] !== value) {
          current[key] = value;
          changed = true;
        }
      }
      if (policy.handoff !== undefined && current.handoff !== policy.handoff) {
        current.handoff = policy.handoff;
        changed = true;
      }
      if (
        policy.autosave !== undefined &&
        policy.autosave !== current.autosave
      ) {
        this.configureAutosave(current, policy.autosave, policy.autosaveBase);
        changed = true;
      }
      const copyDirectory = stringField(body, "copyDirectory");
      if (copyDirectory !== undefined) {
        const directory = fs.realpathSync(
          this.requestedCopyPath(copyDirectory),
        );
        enforceDocumentRoot(this.options.documentRoot, directory, directory);
        if (!fs.statSync(directory).isDirectory())
          throw new ComparisonError(
            400,
            "The copy directory must already exist",
          );
        if (current.copyDirectory !== directory) {
          current.copyDirectory = directory;
          changed = true;
        }
      }
      if (changed || bindingChanged) {
        if (changed && current.revision === revision) current.revision++;
        this.save(current);
        log("document-reconfigured", {
          id: current.id,
          autosave: current.autosave,
          handoff: current.handoff,
        });
      }
      return current;
    }
    const review = this.create(input);
    review.liveSourcePath = filename;
    review.liveSourceVersion = disk?.version ?? null;
    if (review.autosave === "none" && disk) {
      review.savedPath = filename;
      review.savedText = disk.text;
    }
    this.save(review);
    atomicWrite(index, review.id);
    return review;
  }
  create(body: Record<string, unknown>): StoredComparison {
    const mode = body.mode;
    const editor = body.editor;
    const policy = launchPolicy(body);
    if (editor !== undefined && editor !== "unified")
      throw new ComparisonError(400, "editor must be unified");
    if (
      mode !== "proposal" &&
      mode !== "applied" &&
      mode !== "compare" &&
      mode !== "document"
    )
      throw new ComparisonError(
        400,
        "mode must be proposal, applied, compare, or document",
      );
    const targetInput = stringField(body, "targetPath");
    if (mode === "compare" && targetInput !== undefined)
      throw new ComparisonError(
        400,
        "A comparison has no destination; convert it to a proposal to choose a destination",
      );
    if (mode !== "compare" && mode !== "document" && !targetInput)
      throw new ComparisonError(400, "targetPath is required");
    if (mode === "document" && editor !== "unified")
      throw new ComparisonError(
        400,
        "Document sessions require the unified editor",
      );
    const target = targetInput
      ? mode === "document"
        ? this.inspectDestination(targetInput).current
        : this.sourceSnapshot(targetInput)
      : null;
    if (targetInput && !target)
      throw new ComparisonError(404, "Markdown file not found");
    const beforePath = stringField(body, "beforePath");
    const afterPath = stringField(body, "afterPath");
    const explicitBefore = stringField(body, "beforeText");
    const explicitAfter = stringField(body, "afterText");
    const beforeFile =
      beforePath && (explicitBefore === undefined || editor === "unified")
        ? this.sourceSnapshot(beforePath)
        : null;
    const afterFile =
      afterPath && (explicitAfter === undefined || editor === "unified")
        ? this.sourceSnapshot(afterPath)
        : null;
    const beforeText =
      mode === "document"
        ? ""
        : (explicitBefore ??
          beforeFile?.text ??
          (mode === "proposal" ? target?.text : undefined));
    const afterText =
      mode === "document"
        ? (target?.text ?? "")
        : (explicitAfter ??
          afterFile?.text ??
          (mode === "applied" ? target?.text : undefined));
    if (beforeText === undefined || afterText === undefined)
      throw new ComparisonError(
        400,
        "Both versions are required (beforePath/beforeText and afterPath/afterText)",
      );
    if (
      target &&
      mode !== "document" &&
      target.text !== (mode === "proposal" ? beforeText : afterText)
    )
      throw new ComparisonError(
        409,
        "The destination does not match the expected version. Create a comparison against its current contents.",
      );
    const selectable = (file: FileSnapshot | null, text: string) =>
      file?.text === text && path.extname(file.path).toLowerCase() === ".md"
        ? file
        : null;
    const old = selectable(
      mode === "proposal"
        ? target
        : mode === "compare" ||
            (mode === "applied" && beforeFile?.path !== target?.path)
          ? beforeFile
          : null,
      beforeText,
    );
    const newer = selectable(
      mode === "applied" ? target : afterFile,
      afterText,
    );
    // A candidate that aliases the original path cannot be a second writable
    // input. Which version would be overwritten would otherwise be ambiguous.
    const newInput = newer?.path === old?.path ? null : newer;
    const initial = mode === "document" ? target : null;
    const review: StoredComparison = {
      id: crypto.randomUUID(),
      revision: 1,
      mode,
      title:
        stringField(body, "title") ??
        (target
          ? path.basename(target.path)
          : mode === "document"
            ? "Untitled"
            : "Compare versions"),
      beforeLabel:
        stringField(body, "beforeLabel") ??
        beforePath ??
        (mode === "proposal" ? target?.path : undefined) ??
        "Before",
      afterLabel:
        stringField(body, "afterLabel") ??
        afterPath ??
        (mode === "applied" ? target?.path : undefined) ??
        "After",
      beforePath:
        (mode === "proposal" ? target?.path : beforeFile?.path) ?? null,
      afterPath:
        (mode === "applied" || mode === "document"
          ? target?.path
          : afterFile?.path) ?? null,
      targetPath: target?.path ?? null,
      targetVersion: target?.version ?? null,
      beforeText,
      afterText,
      segments:
        mode === "document" ? [] : comparisonSegments(beforeText, afterText),
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      ...(editor === "unified"
        ? {
            editor,
            handoff: policy.handoff ?? "chat",
            autosave: initial?.path ?? "none",
            draft: null,
            destinationPath: initial?.path ?? null,
            destinationVersion: initial?.version ?? null,
            savedPath: initial?.path ?? null,
            savedText: initial?.text ?? null,
            baseVersion: null,
            baseOptions: {
              old: old?.path ?? null,
              new: newInput?.path ?? null,
            },
            baseInputVersions: {
              old: old?.version ?? null,
              new: newInput?.version ?? null,
            },
            feedback: null,
          }
        : {}),
    };
    if (editor === "unified" && policy.autosave !== undefined)
      this.configureAutosave(review, policy.autosave, policy.autosaveBase);
    const copyDirectory = stringField(body, "copyDirectory");
    if (copyDirectory !== undefined) {
      const directory = fs.realpathSync(this.requestedCopyPath(copyDirectory));
      enforceDocumentRoot(this.options.documentRoot, directory, directory);
      if (!fs.statSync(directory).isDirectory())
        throw new ComparisonError(400, "The copy directory must already exist");
      review.copyDirectory = directory;
    }
    this.save(review);
    log("created", {
      id: review.id,
      mode,
      targetPath: review.targetPath,
      handoff: review.handoff,
      autosave: review.autosave,
      changes: review.segments.filter((segment) => segment.kind === "change")
        .length,
    });
    return review;
  }
  private seedDraft(
    review: StoredComparison,
    markdown: string,
    clean = false,
  ): EditorDraft {
    if (review.draft) return review.draft;
    const existing = new Set(
      review.reviewComments.map((comment) => comment.id),
    );
    const createdAt = new Date().toISOString();
    for (const item of extractRoughdraftReviewIndex(markdown).items) {
      if (item.kind === "suggestion" || existing.has(item.id)) continue;
      review.reviewComments.push({
        id: item.id,
        changeId: item.parentId ?? "document",
        content: item.text,
        createdAt: item.createdAt ?? createdAt,
        authorType: item.author?.toLowerCase() === "ai" ? "ai" : "user",
        authorId: item.author,
        parentCommentId: item.parentId,
        ...(!item.anchorText && !item.parentId
          ? { scope: "document" as const }
          : {}),
      });
      existing.add(item.id);
    }
    return {
      markdown,
      ...(clean ? { cleanMarkdown: cleanRoughdraftMarkdown(markdown) } : {}),
      decisions: {},
    };
  }
  private configureAutosave(
    review: StoredComparison,
    filename: string,
    seed: BaseVersion = "new",
  ): void {
    if (filename === "none") {
      review.autosave = "none";
      review.destinationPath = null;
      // Keep the saved snapshot/version so a later rebind still detects
      // external edits. The Markdown source is never written on detach.
      return;
    }
    const selected = this.inspectDestination(filename);
    if (selected.path === review.destinationPath) return;
    if (selected.current) {
      const side =
        review.mode === "document" &&
        (selected.path === review.targetPath ||
          selected.path === review.savedPath)
          ? "new"
          : selected.path === review.baseOptions?.old
            ? "old"
            : selected.path === review.baseOptions?.new
              ? "new"
              : null;
      if (!side)
        throw new ComparisonError(
          409,
          "A file already exists at that path. Choose an input file or a new path.",
        );
      const expectedVersion =
        selected.path === review.savedPath
          ? review.destinationVersion
          : review.mode === "document"
            ? review.targetVersion
            : review.baseInputVersions?.[side];
      if (selected.current.version !== expectedVersion)
        throw new ComparisonError(
          409,
          "The selected file changed on disk. Choose a copy or open a new review.",
        );
      review.baseVersion = side;
      review.autosaveBase = side;
      const draft = this.seedDraft(
        review,
        side === "old" ? review.beforeText : review.afterText,
      );
      this.recordSave(review, draft, review.reviewComments, selected.current);
      return;
    }
    if (
      [
        review.targetPath,
        review.savedPath,
        review.baseOptions?.old,
        review.baseOptions?.new,
      ].includes(selected.path)
    )
      throw new ComparisonError(
        409,
        "The selected file disappeared. Choose a copy or open a new review.",
      );
    const draft = this.seedDraft(
      review,
      seed === "old" ? review.beforeText : review.afterText,
      true,
    );
    assertPlainMarkdown(cleanDraft(draft));
    review.autosaveBase = seed;
    this.publishDraft(
      review,
      draft,
      review.reviewComments,
      filename,
      selected.path,
      null,
      seed,
    );
  }
  private requireRevision(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): void {
    if (body.revision !== review.revision)
      throw new ComparisonError(
        409,
        "Review choices changed in another browser. Reload the saved review before continuing.",
      );
    if (review.status !== "open")
      throw new ComparisonError(409, "This review is already finished");
    if (review.editor === "unified")
      throw new ComparisonError(
        400,
        "Use the editor draft, save, and feedback operations for this review",
      );
  }
  decisions(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    this.requireRevision(review, body);
    const updates = body.decisions ?? [];
    if (!Array.isArray(updates))
      throw new ComparisonError(400, "decisions must be an array");
    const proposed = new Map<
      string,
      { decision?: ComparisonDecision; comment?: string }
    >();
    for (const raw of updates) {
      const update = objectBody(raw);
      const id = stringField(update, "id");
      const segment = review.segments.find(
        (item) => item.id === id && item.kind === "change",
      );
      if (!id || !segment)
        throw new ComparisonError(400, "Unknown change in decision update");
      const decision = update.decision;
      if (
        decision !== undefined &&
        decision !== "pending" &&
        decision !== "before" &&
        decision !== "after"
      )
        throw new ComparisonError(
          400,
          "decision must be pending, before, or after",
        );
      if (review.mode === "compare" && decision !== undefined)
        throw new ComparisonError(
          400,
          "Comparisons have no accept/revert choices; convert to a proposal first",
        );
      proposed.set(id, { decision, comment: stringField(update, "comment") });
    }
    const comment = stringField(body, "comment");
    const reviewComments = reviewCommentsField(body.reviewComments, review);
    review.segments = review.segments.map((segment) => {
      const update = proposed.get(segment.id);
      return update
        ? {
            ...segment,
            decision: update.decision ?? segment.decision,
            comment: update.comment ?? segment.comment,
          }
        : segment;
    });
    review.comment = comment ?? review.comment;
    review.reviewComments = reviewComments ?? review.reviewComments;
    review.revision++;
    this.save(review);
    return review;
  }
  setHandoff(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    if (Object.hasOwn(body, "expectedHandoff")) {
      this.requireEditor(review);
      if (body.expectedHandoff !== review.handoff)
        throw new ComparisonError(
          409,
          "The handoff choice changed. Reload that setting before changing it.",
        );
    } else this.requireEditorRevision(review, body);
    const { handoff } = launchPolicy(body);
    if (!handoff) throw new ComparisonError(400, "handoff is required");
    if (review.handoff !== handoff) {
      review.handoff = handoff;
      review.revision++;
      this.save(review);
      log("handoff-changed", { id: review.id, handoff });
    }
    return review;
  }
  private requireEditor(review: StoredComparison): void {
    if (review.editor !== "unified")
      throw new ComparisonError(
        400,
        "This review uses the original comparison editor",
      );
  }
  private requireEditorRevision(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): void {
    this.requireEditor(review);
    if (review.pendingPublication)
      throw new ComparisonError(
        409,
        "A publication is finishing; retry after it completes",
      );
    if (body.revision !== review.revision)
      throw new ComparisonError(
        409,
        "This draft changed in another browser. Reload the saved draft before continuing.",
      );
  }
  private editorUpdate(
    review: StoredComparison,
    body: Record<string, unknown>,
  ) {
    this.requireEditorRevision(review, body);
    const draft = draftField(body);
    draft.reviewed = draft.reviewed?.map((entry) => {
      const previous = review.draft?.reviewed?.find(
        (item) => item.id === entry.id,
      );
      if (!previous) return entry;
      return {
        ...entry,
        ...(entry.staleReason === undefined &&
        previous.staleReason !== undefined
          ? { staleReason: previous.staleReason }
          : {}),
        ...(entry.unmappedSince === undefined &&
        previous.unmappedSince !== undefined
          ? { unmappedSince: previous.unmappedSince }
          : {}),
        ...(entry.originSignature === undefined &&
        previous.originSignature !== undefined
          ? { originSignature: previous.originSignature }
          : {}),
        ...(previous.staleReason === "needs-remap" ? { stale: true } : {}),
      };
    });
    return {
      draft,
      reviewComments:
        reviewCommentsField(body.reviewComments, review, true) ??
        review.reviewComments,
    };
  }
  recoverDraft(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    const { draft, reviewComments } = this.editorUpdate(review, body);
    review.draft = draft;
    review.reviewComments = reviewComments;
    review.revision++;
    this.save(review);
    log("draft-persisted", {
      id: review.id,
      revision: review.revision,
      autosave: review.autosave,
      decisions: Object.keys(draft.decisions).length,
      reviewed: draft.reviewed?.length ?? 0,
      comments: reviewComments.length,
    });
    return review;
  }
  inspect(review: StoredComparison, filename: string | undefined) {
    this.requireEditor(review);
    const requested = filename ?? review.destinationPath;
    if (!requested)
      throw new ComparisonError(400, "Choose a destination first");
    const { path: inspected, current } = this.inspectDestination(requested);
    return {
      path: inspected,
      version: current?.version ?? null,
      markdown: current?.text ?? null,
    };
  }
  chooseBase(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    if (
      Object.hasOwn(body, "expectedBaseVersion") ||
      Object.hasOwn(body, "expectedDestinationPath")
    ) {
      this.requireEditor(review);
      if (
        (body.expectedBaseVersion ?? null) !== (review.baseVersion ?? null) ||
        (body.expectedDestinationPath ?? null) !==
          (review.destinationPath ?? null)
      )
        throw new ComparisonError(
          409,
          "The selected base changed. Inspect the current choice before changing it.",
        );
    } else this.requireEditorRevision(review, body);
    const choice = body.choice;
    if (choice !== "old" && choice !== "new" && choice !== "copy")
      throw new ComparisonError(
        400,
        "Choose the old file, new file, or a copy",
      );
    if (review.destinationPath)
      throw new ComparisonError(
        409,
        "This review already has an autosave file. Ask the agent to change its destination.",
      );
    if (
      choice === "copy" &&
      body.seed !== undefined &&
      body.seed !== "old" &&
      body.seed !== "new"
    )
      throw new ComparisonError(
        400,
        "A copy must start from the old or new version",
      );
    const baseVersion =
      choice === "copy" ? (body.seed === "new" ? "new" : "old") : choice;
    const seed = baseVersion === "old" ? review.beforeText : review.afterText;
    const draft =
      body.markdown === undefined
        ? { markdown: seed, decisions: {} }
        : draftField(body);
    const reviewComments =
      reviewCommentsField(body.reviewComments, review, true) ??
      review.reviewComments;
    const text = cleanDraft(draft);
    if (text !== seed) {
      if (!containsReviewMarkup(seed))
        throw new ComparisonError(
          400,
          "The draft must match the selected version before editing it",
        );
      assertPlainMarkdown(text);
    }
    if (choice === "copy") {
      const filename = stringField(body, "path");
      if (!filename)
        throw new ComparisonError(400, "Choose a path for the copy");
      const selected = this.inspectDestination(filename);
      if (selected.current)
        throw new ComparisonError(
          409,
          "A file already exists at that path. Choose a different file.",
        );
      assertPlainMarkdown(text);
      return this.publishDraft(
        review,
        draft,
        reviewComments,
        filename,
        selected.path,
        null,
        baseVersion,
      );
    }
    const filename = review.baseOptions?.[choice];
    const version = review.baseInputVersions?.[choice];
    if (!filename || !version)
      throw new ComparisonError(
        400,
        "This version is a snapshot. Choose a copy to edit it.",
      );
    let current: FileSnapshot | null;
    try {
      current = this.inspectDestination(filename).current;
    } catch {
      current = null;
    }
    if (
      current?.path !== filename ||
      current.version !== version ||
      current.text !== seed
    )
      throw new ComparisonError(
        409,
        "The selected file changed on disk. Choose a copy or open a new review.",
      );
    review.baseVersion = baseVersion;
    this.recordSave(review, draft, reviewComments, current);
    this.save(review);
    return review;
  }
  private recordSave(
    review: StoredComparison,
    draft: EditorDraft,
    reviewComments: ComparisonReviewComment[],
    current: FileSnapshot,
  ): void {
    review.draft = draft;
    review.reviewComments = reviewComments;
    review.destinationPath = current.path;
    review.autosave = current.path;
    review.destinationVersion = current.version;
    review.savedPath = current.path;
    review.savedText = current.text;
    review.revision++;
  }
  saveDraft(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    const { draft, reviewComments } = this.editorUpdate(review, body);
    const requested = stringField(body, "path");
    const filename = requested ?? review.destinationPath;
    if (!filename) throw new ComparisonError(400, "Choose a destination first");
    if (
      requested !== undefined &&
      body.expectedVersion !== null &&
      typeof body.expectedVersion !== "string"
    )
      throw new ComparisonError(
        400,
        "Inspect the destination before saving to it",
      );
    const { path: resolved, current } = this.inspectDestination(filename);
    const version = current?.version ?? null;
    const sameDestination =
      requested === undefined ||
      resolved === review.destinationPath ||
      path.resolve(filename) === review.destinationPath;
    const errorMessage =
      "The destination changed on disk. Preserve this review before choosing another file.";
    if (
      (requested !== undefined && body.expectedVersion !== version) ||
      (sameDestination &&
        (resolved !== review.destinationPath ||
          version !== review.destinationVersion))
    )
      throw new ComparisonError(409, errorMessage);

    if (
      current?.text === cleanDraft(draft) &&
      !this.isDocumentMove(review, resolved)
    ) {
      this.recordSave(review, draft, reviewComments, current);
      this.save(review);
      return review;
    }
    assertPlainMarkdown(cleanDraft(draft));
    return this.publishDraft(
      review,
      draft,
      reviewComments,
      filename,
      resolved,
      current,
    );
  }
  forkDraft(id: string, body: Record<string, unknown>): StoredComparison {
    // Read only: a stale tab's copy must never update the shared review, even
    // if an earlier request on that review is still awaiting recovery.
    const review = this.readReview(id);
    this.requireEditor(review);
    const noFile = launchPolicy(body).autosave === "none";
    const selectedSide = body.baseVersion;
    if (
      selectedSide !== undefined &&
      selectedSide !== null &&
      selectedSide !== "old" &&
      selectedSide !== "new"
    )
      throw new ComparisonError(400, "baseVersion must be old, new, or null");
    const draft = draftField(body);
    if (!noFile) assertPlainMarkdown(cleanDraft(draft));
    const comments =
      reviewCommentsField(body.reviewComments, review, true) ?? [];
    const fork: StoredComparison = {
      id: crypto.randomUUID(),
      revision: 1,
      mode: review.mode,
      title: review.title,
      beforeLabel: review.beforeLabel,
      afterLabel: review.afterLabel,
      beforePath: review.beforePath,
      afterPath: review.afterPath,
      beforeText: review.beforeText,
      afterText: review.afterText,
      targetPath: review.targetPath,
      targetVersion: review.targetVersion,
      segments: review.segments,
      editor: "unified",
      handoff: review.handoff,
      autosave: "none",
      ...(noFile ? { recoveredFrom: review.id } : {}),
      baseVersion:
        selectedSide === undefined
          ? (review.baseVersion ?? null)
          : selectedSide,
      baseOptions: review.baseOptions,
      baseInputVersions: review.baseInputVersions,
      destinationPath: null,
      destinationVersion: null,
      savedPath: null,
      savedText: null,
      feedback: null,
      comment: "",
      reviewComments: comments,
      draft,
      status: "open",
      completion: null,
    };
    if (noFile) {
      // This is a durable review copy, including annotations and decisions,
      // without creating or replacing a Markdown file or the shared review.
      this.registerChild(review.id, fork.id);
      this.save(fork);
      log("review-recovered", {
        id: fork.id,
        recoveredFrom: review.id,
        decisions: Object.keys(draft.decisions).length,
        reviewed: draft.reviewed?.length ?? 0,
        comments: comments.length,
      });
      return fork;
    }
    const filename = stringField(body, "path");
    if (!filename) throw new ComparisonError(400, "Choose a path for the copy");
    const expectedVersion = body.expectedVersion;
    if (expectedVersion !== null && typeof expectedVersion !== "string")
      throw new ComparisonError(
        400,
        "Inspect the destination before saving to it",
      );
    const { path: resolved, current } = this.inspectDestination(filename);
    if (
      [review.destinationPath, review.pendingSave?.path].some(
        (active) => active === resolved || active === path.resolve(filename),
      )
    )
      throw new ComparisonError(409, "Choose a different file for the copy");
    if (expectedVersion !== (current?.version ?? null))
      throw new ComparisonError(
        409,
        "The destination changed on disk. Inspect it or choose another file.",
      );
    // Register the copy before publishing it so a restart cannot strand a
    // watch. Failed or incomplete copies have no readable review to report.
    this.registerChild(review.id, fork.id);
    return this.publishDraft(
      fork,
      draft,
      comments,
      filename,
      resolved,
      current,
    );
  }
  private publishDraft(
    review: StoredComparison,
    draft: EditorDraft,
    reviewComments: ComparisonReviewComment[],
    filename: string,
    resolved: string,
    current: FileSnapshot | null,
    baseVersion?: BaseVersion,
    active?: { operation: SyncOperation; record: OperationRecord<Comparison> },
  ): StoredComparison {
    const pageInstanceId = `legacy-${review.id}`;
    const previous = review.operationOutcomes?.[pageInstanceId];
    const operation: SyncOperation = active?.operation ?? {
      operationId: crypto.randomUUID(),
      operationSequence: (previous?.sequence ?? 0) + 1,
      pageInstanceId,
      operationContext: this.operations.context(),
      acknowledgedOperationIds: previous ? [previous.id] : [],
    };
    const record =
      active?.record ?? this.operations.begin(operation, review.id);
    const submitted: SyncDraft = {
      ...draft,
      reviewComments,
      ...(review.outdatedSuggestions
        ? { outdatedSuggestions: review.outdatedSuggestions }
        : {}),
    };
    const errorMessage =
      "The destination changed on disk. Preserve this review before choosing another file.";
    const verify = () => {
      const latest = this.inspectDestination(filename);
      if (
        latest.path !== resolved ||
        (latest.current?.version ?? null) !== (current?.version ?? null)
      )
        throw new ComparisonError(409, errorMessage);
    };
    const text = cleanDraft(draft);
    const moving = this.isDocumentMove(review, resolved);
    if (moving) this.recoverDocumentMove(resolved);
    const release = this.watchers.beginPublication(
      [resolved, this.filename(review.id)],
      operation.operationId,
    );
    const publishedVersions: Record<string, string | null> = {};
    const prepared = (identity: PreparedFileIdentity) => {
      this.preparedPublication(review, identity, record);
      const version = preparedVersion(identity, text);
      if (version) publishedVersions[resolved] = version;
      else delete publishedVersions[resolved];
    };
    try {
      if (current?.text === text) verify();
      else {
        review.pendingPublication = {
          owner: this.operations.owner,
          processInstance: this.operations.epoch,
          operation,
          startedAt: this.operations.now(),
          draft: submitted,
          path: resolved,
          expectedDisk: current
            ? {
                path: current.path,
                version: current.version,
                hash: hash(current.text),
                text: current.text,
                availability: "available",
              }
            : null,
          writeFile: true,
          reason: "legacy-save",
          ...(baseVersion ? { baseVersion } : {}),
        };
        this.save(review);
        if (moving) atomicWrite(this.documentIndex(resolved, true), review.id);
        if (current)
          atomicWrite(resolved, text, {
            mode: current.mode,
            beforePublish: verify,
            allowBusyFallback: this.options.allowFileBindMountWrites,
            onPrepared: prepared,
          });
        else createFile(resolved, text, verify, prepared);
      }
      const saved = this.sourceSnapshot(resolved);
      if (saved.path !== resolved || saved.text !== text)
        throw new ComparisonError(409, errorMessage);
      if (moving) atomicWrite(this.documentIndex(resolved), review.id);
      if (baseVersion) review.baseVersion = baseVersion;
      this.recordSave(review, draft, reviewComments, saved);
      if (review.mode === "document") {
        review.liveSourcePath = saved.path;
        review.liveSourceVersion = saved.version;
      }
      delete review.pendingPublication;
      const disk: SyncDisk = {
        path: saved.path,
        version: saved.version,
        hash: hash(saved.text),
        text: saved.text,
        availability: "available",
      };
      this.ownDisk.set(saved.path, { observedAt: Date.now(), disk });
      this.outcome(
        review,
        operation,
        "legacy-save",
        { status: "committed", state: this.state(review.id, review, disk) },
        record,
      );
      if (moving) this.clearDocumentMove(resolved, review.id);
      log("draft-saved", {
        id: review.id,
        destinationPath: resolved,
        reviewed: draft.reviewed?.length ?? 0,
      });
      return review;
    } catch (error) {
      if (
        error instanceof FileChangedError ||
        (error instanceof ComparisonError && error.status === 409)
      ) {
        delete review.pendingPublication;
        this.outcome(
          review,
          operation,
          "legacy-rejected",
          {
            status: "incoming-changed",
            state: this.state(review.id, review),
            message: errorMessage,
          },
          record,
        );
        if (moving) this.clearDocumentMove(resolved, review.id);
        throw new ComparisonError(409, errorMessage);
      }
      // Every file effect has a discoverable intent; ambiguous I/O failures
      // are resolved under the same publication lock, never by a GET.
      throw error;
    } finally {
      const recordVersion = this.ownRecords.get(review.id)?.version;
      if (recordVersion)
        publishedVersions[this.filename(review.id)] = recordVersion;
      release(publishedVersions);
      this.watchers.invalidate(resolved);
    }
  }
  private finishSave(
    review: StoredComparison,
    draft: EditorDraft,
    reviewComments: ComparisonReviewComment[],
    saved: FileSnapshot,
    baseVersion?: BaseVersion,
  ): void {
    const moving = this.isDocumentMove(review, saved.path);
    // Keep the intent until the new filename can find the review. The old
    // filename's pointer no longer matches and will get a fresh review on open.
    if (moving) atomicWrite(this.documentIndex(saved.path), review.id);
    if (baseVersion) review.baseVersion = baseVersion;
    this.recordSave(review, draft, reviewComments, saved);
    delete review.pendingSave;
    this.save(review);
    if (moving) this.clearDocumentMove(saved.path, review.id);
  }
  sendFeedback(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    const { draft, reviewComments } = this.editorUpdate(review, body);
    const comment = stringField(body, "comment") ?? review.comment;
    // Two sends in the same millisecond must still be distinguishable to a watcher.
    const previousTime = Date.parse(review.feedback?.sentAt ?? "") || 0;
    this.lastFeedbackTime = Math.max(
      Date.now(),
      previousTime + 1,
      this.lastFeedbackTime + 1,
    );
    const sentAt = new Date(this.lastFeedbackTime).toISOString();
    const destinationPath = review.destinationPath ?? null;
    const saved =
      destinationPath !== null &&
      review.savedPath === destinationPath &&
      review.savedText === cleanDraft(draft) &&
      !this.view(review).targetChanged;
    review.draft = draft;
    review.reviewComments = reviewComments;
    review.comment = comment;
    review.feedback = {
      draft,
      reference:
        review.mode === "document"
          ? null
          : review.baseVersion === "old"
            ? { label: review.afterLabel, markdown: review.afterText }
            : { label: review.beforeLabel, markdown: review.beforeText },
      destinationPath,
      saved,
      comment,
      reviewComments,
      sentAt,
    };
    review.status = "completed";
    review.completion = {
      fileWritten: false,
      targetPath: destinationPath,
      accepted: Object.keys(draft.decisions).length,
      reverted: 0,
      completedAt: sentAt,
    };
    review.revision++;
    this.save(review);
    log("feedback-sent", {
      id: review.id,
      destinationPath,
      saved,
      reviewed: draft.reviewed?.length ?? 0,
    });
    return review;
  }
  private destination(review: StoredComparison): FileSnapshot {
    if (!review.targetPath)
      throw new ComparisonError(400, "This comparison has no destination");
    let current: FileSnapshot;
    try {
      current = this.sourceSnapshot(review.targetPath);
    } catch {
      throw new ComparisonError(
        409,
        "The destination is unavailable. Restore it before refreshing this comparison.",
      );
    }
    if (
      current.path !== review.targetPath ||
      current.version !== review.targetVersion
    )
      throw new ComparisonError(
        409,
        "The destination changed during review. Your choices are saved. Refresh the comparison before applying.",
      );
    return current;
  }
  apply(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    if (review.status === "applied") return review;
    this.requireRevision(review, body);
    if (review.mode === "compare")
      throw new ComparisonError(
        400,
        "Comparisons cannot write files; convert to a proposal first",
      );
    const changes = review.segments.filter(
      (segment) => segment.kind === "change",
    );
    if (changes.some((segment) => segment.decision === "pending"))
      throw new ComparisonError(
        409,
        "Choose what to do with every change before applying, or finish without applying",
      );
    const current = this.destination(review);
    const output = review.segments
      .map((segment) =>
        segment.decision === "before" ? segment.before : segment.after,
      )
      .join("");
    const completion: ComparisonCompletion = {
      fileWritten: output !== current.text,
      targetPath: review.targetPath,
      accepted: changes.filter((segment) => segment.decision === "after")
        .length,
      reverted:
        review.mode === "applied"
          ? changes.filter((segment) => segment.decision === "before").length
          : 0,
      completedAt: new Date().toISOString(),
    };
    if (completion.fileWritten) {
      review.pendingApply = { outputHash: hash(output), completion };
      this.save(review);
      // The intent is durable before publication. Preserve it on failure:
      // recovery inspects the destination and never replays an uncertain write.
      atomicWrite(current.path, output, {
        mode: current.mode,
        allowBusyFallback: this.options.allowFileBindMountWrites,
        beforePublish: () => {
          this.destination(review);
        },
      });
    }
    delete review.pendingApply;
    review.status = "applied";
    review.completion = completion;
    review.revision++;
    this.save(review);
    log("applied", { id: review.id, ...completion });
    return review;
  }
  complete(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    if (review.status === "completed") return review;
    this.requireRevision(review, body);
    review.status = "completed";
    review.completion = {
      fileWritten: false,
      targetPath: review.targetPath,
      accepted: 0,
      reverted: 0,
      completedAt: new Date().toISOString(),
    };
    review.revision++;
    this.save(review);
    log("completed", {
      id: review.id,
      targetPath: review.targetPath,
      fileWritten: false,
    });
    return review;
  }
  refresh(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    this.requireRevision(review, body);
    if (!review.targetPath)
      throw new ComparisonError(
        400,
        "Comparisons have frozen snapshots and no destination to refresh",
      );
    const current = this.sourceSnapshot(review.targetPath);
    if (current.path !== review.targetPath)
      throw new ComparisonError(
        409,
        "The destination now points to a different file. Create a new comparison with the intended destination.",
      );
    const beforeText =
      review.mode === "proposal" ? current.text : review.beforeText;
    const afterText =
      review.mode === "applied" ? current.text : review.afterText;
    const oldSegments = new Map(
      review.segments.map((segment) => [segment.id, segment]),
    );
    review.segments = comparisonSegments(beforeText, afterText).map(
      (segment) => {
        const old = oldSegments.get(segment.id);
        return old &&
          old.before === segment.before &&
          old.after === segment.after
          ? { ...segment, decision: old.decision, comment: old.comment }
          : segment;
      },
    );
    // Keep feedback even if a changed source block no longer has an anchor.
    // The rendered view presents these threads as document feedback.
    const surviving = new Set(review.segments.map((segment) => segment.id));
    for (const segment of oldSegments.values()) {
      const id = `legacy:${segment.id}`;
      if (
        segment.comment &&
        !surviving.has(segment.id) &&
        !review.reviewComments.some((comment) => comment.id === id)
      )
        review.reviewComments.push({
          id,
          changeId: segment.id,
          content: segment.comment,
          createdAt: new Date().toISOString(),
          scope: "document",
        });
    }
    review.beforeText = beforeText;
    review.afterText = afterText;
    review.targetVersion = current.version;
    review.revision++;
    this.save(review);
    log("refreshed", {
      id: review.id,
      pending: review.segments.filter(
        (segment) =>
          segment.kind === "change" && segment.decision === "pending",
      ).length,
    });
    return review;
  }
  convert(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    this.requireRevision(review, body);
    if (review.mode !== "compare")
      throw new ComparisonError(
        400,
        "Only comparisons can be converted to proposals",
      );
    return this.create({
      mode: "proposal",
      targetPath: stringField(body, "targetPath"),
      beforeText: review.beforeText,
      afterText: review.afterText,
      beforeLabel: review.beforeLabel,
      afterLabel: review.afterLabel,
      title: review.title,
    });
  }
}

export function comparisonRouter(
  directory: string,
  options: ComparisonStoreOptions = {},
): Router {
  const router = Router();
  let store: ComparisonStore;
  router.use((_req, res, next) => {
    try {
      store ??= new ComparisonStore(directory, options);
      next();
    } catch (error) {
      log("error", {
        message: error instanceof Error ? error.message : String(error),
      });
      res
        .status(500)
        .json({ error: "The review store could not be initialized" });
    }
  });
  router.use((req, res, next) => {
    const protocol = req.get("X-Roughdraft-Sync");
    if (protocol === "compact-v1" || protocol === "compact-v2") {
      const signature = req.get("X-Roughdraft-Draft-Reference");
      const draft = req.body?.draft;
      const draftReference =
        req.method === "POST" &&
        signature &&
        draft &&
        typeof draft === "object" &&
        !Array.isArray(draft)
          ? { signature, draft: draft as SyncDraft }
          : undefined;
      const send = res.json.bind(res);
      res.json = (value) =>
        send(
          transferSyncResponse(
            value,
            typeof req.params.id === "string"
              ? req.params.id
              : String(req.body?.reviewId ?? ""),
            req.get("X-Roughdraft-Reference"),
            protocol,
            draftReference,
          ),
        );
    }
    next();
  });
  const handle =
    (action: (request: Request, response: Response) => void) =>
    (req: Request, res: Response) => {
      try {
        if (req.method === "GET") action(req, res);
        else
          store.mutation(
            typeof req.params.id === "string" ? req.params.id : null,
            objectBody(req.body ?? {}),
            () => action(req, res),
          );
      } catch (error) {
        if (error instanceof ComparisonLockBusy) {
          res.status(409).json({
            status: "retry-later",
            retryAfter: 25,
            error: error.message,
            message: error.message,
          });
          return;
        }
        const status =
          error instanceof ComparisonError
            ? error.status
            : (error as { status?: number }).status === 400
              ? 400
              : 500;
        const message =
          error instanceof Error
            ? error.message
            : "Comparison operation failed";
        log(status === 409 ? "conflict" : "error", {
          status,
          message,
          comparisonId: req.params.id,
        });
        res.status(status).json({ error: message });
      }
    };
  const load = (req: Request) => store.readReview(String(req.params.id));
  router.get(
    "/events",
    handle((req, res) => {
      if (req.query.protocol !== undefined && req.query.protocol !== "1")
        throw new ComparisonError(
          400,
          "Unsupported live-update protocol. Reload Roughdraft.",
        );
      const ids = [
        ...new Set(
          String(req.query.ids ?? "")
            .split(",")
            .filter(Boolean),
        ),
      ];
      if (!ids.length || ids.length > 100)
        throw new ComparisonError(
          400,
          "Choose between one and 100 reviews to follow",
        );
      for (const id of ids) store.readReview(id);
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      let stopped = false;
      let unsubscribe = () => {};
      let pathsKey = "";
      const output = new ComparisonEventStream(res, ids.length);
      const send = (id: string, reason: string, operationId?: string) => {
        if (stopped) return;
        output.send(id, () => {
          try {
            const state = store.state(id);
            return `event: change\ndata: ${JSON.stringify({ reviewId: id, revision: state.revision, diskVersion: state.disk?.version ?? null, registryGeneration: state.registryGeneration, reason, operationContext: state.operationContext, ...(operationId ? { operationId } : {}) })}\n\n`;
          } catch (error) {
            return `event: change\ndata: ${JSON.stringify({ reviewId: id, reason: "unavailable", message: error instanceof Error ? error.message : String(error) })}\n\n`;
          }
        });
      };
      const refresh = () => {
        const paths = [
          ...new Set(ids.flatMap((id) => store.statePaths(id))),
        ].sort();
        const nextKey = paths.join("\n");
        if (nextKey === pathsKey) return;
        unsubscribe();
        pathsKey = nextKey;
        unsubscribe = store.watchers.subscribe(paths, (event) => {
          for (const id of ids)
            if (store.statePaths(id).includes(event.path))
              send(id, event.reason, event.operationId);
          refresh();
        });
      };
      refresh();
      for (const id of ids) send(id, "initial");
      const heartbeat = setInterval(() => {
        if (!stopped)
          output.heartbeat(
            () =>
              `event: heartbeat\ndata: ${JSON.stringify({ operationContext: store.context() })}\n\n`,
          );
      }, 15_000);
      heartbeat.unref();
      const close = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(heartbeat);
        output.close();
        unsubscribe();
      };
      req.on("close", close);
      res.on("close", close);
      res.on("finish", close);
    }),
  );
  router.get(
    "/operations/:operationId",
    handle((req, res) => {
      res.json(store.operationStatus(String(req.params.operationId)));
    }),
  );
  router.post(
    "/operations/:operationId/resolve",
    handle((req, res) => {
      res.json(
        store.resolveOperation(
          String(req.params.operationId),
          objectBody(req.body),
        ),
      );
    }),
  );
  router.get(
    "/:id/state",
    handle((req, res) => {
      const id = String(req.params.id);
      store.watchers.lease(store.statePaths(id), 5000);
      const state = store.state(id);
      const tag = JSON.stringify(state.registryGeneration);
      res.set("ETag", tag);
      res.set("Cache-Control", "no-cache");
      res.set(
        "X-Roughdraft-Operation-Context",
        JSON.stringify(state.operationContext),
      );
      if (
        req.get("If-None-Match") === tag ||
        req.get("If-None-Match") === state.registryGeneration
      ) {
        res.status(304).end();
        return;
      }
      res.json(state);
    }),
  );
  router.post(
    "/:id/reconcile",
    handle((req, res) => {
      res.json(
        store.reconcile(String(req.params.id), objectBody(req.body), {
          compactRetry: req.get("X-Roughdraft-Sync") === "compact-v2",
        }),
      );
    }),
  );
  router.get(
    "/:id/copy-destination",
    handle((req, res) => {
      if (req.query.path !== undefined && typeof req.query.path !== "string")
        throw new ComparisonError(400, "path must be a string");
      res.json(
        store.copyDestination(
          String(req.params.id),
          req.query.path as string | undefined,
        ),
      );
    }),
  );
  router.post(
    "/:id/copy-destination",
    handle((req, res) => {
      const body = objectBody(req.body);
      res.json(
        store.copyDestination(
          String(req.params.id),
          stringField(body, "path"),
          body.workingDraft,
        ),
      );
    }),
  );
  router.post(
    "/:id/copy",
    handle((req, res) => {
      res.json(store.copy(String(req.params.id), objectBody(req.body)));
    }),
  );
  router.post(
    "/:id/checkpoint",
    handle((req, res) => {
      res.json(store.checkpoint(String(req.params.id), objectBody(req.body)));
    }),
  );
  router.get(
    "/:id/checkpoints/:checkpointId",
    handle((req, res) => {
      res.json(
        store.readCheckpoint(
          String(req.params.id),
          String(req.params.checkpointId),
        ),
      );
    }),
  );
  router.post(
    "/:id/recover",
    handle((req, res) => {
      res.json(store.recover(String(req.params.id)));
    }),
  );
  router.post(
    "/:id/binding",
    handle((req, res) => {
      res.json(store.binding(String(req.params.id), objectBody(req.body)));
    }),
  );
  router.post(
    "/",
    handle((req, res) => {
      res.status(201).json(store.view(store.create(objectBody(req.body))));
    }),
  );
  router.post(
    "/document",
    handle((req, res) => {
      res
        .status(201)
        .json(store.view(store.openDocument(objectBody(req.body))));
    }),
  );
  router.get(
    "/:id/watch",
    handle((req, res) => {
      res.json(store.view(store.watch(String(req.params.id))));
    }),
  );
  router.get(
    "/:id/destination",
    handle((req, res) => {
      const filename = req.query.path;
      if (filename !== undefined && typeof filename !== "string")
        throw new ComparisonError(400, "path must be a string");
      res.json(store.inspect(load(req), filename));
    }),
  );
  router.post(
    "/:id/draft",
    handle((req, res) => {
      res.json(store.view(store.recoverDraft(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/handoff",
    handle((req, res) => {
      res.json(store.view(store.setHandoff(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/base",
    handle((req, res) => {
      res.json(store.view(store.chooseBase(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/save",
    handle((req, res) => {
      res.json(store.view(store.saveDraft(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/fork",
    handle((req, res) => {
      res
        .status(201)
        .json(
          store.view(
            store.forkDraft(String(req.params.id), objectBody(req.body)),
          ),
        );
    }),
  );
  router.post(
    "/:id/send",
    handle((req, res) => {
      const body = objectBody(req.body);
      if (body.operationId)
        res.json(
          store.reconcile(
            String(req.params.id),
            {
              ...body,
              reason: "send",
              adoptDisk: body.reason === "adopt",
              writeFile: false,
            },
            { compactRetry: req.get("X-Roughdraft-Sync") === "compact-v2" },
          ),
        );
      else res.json(store.view(store.sendFeedback(load(req), body)));
    }),
  );
  router.get(
    "/:id",
    handle((req, res) => {
      res.json(store.view(load(req)));
    }),
  );
  router.post(
    "/:id/decisions",
    handle((req, res) => {
      res.json(store.view(store.decisions(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/apply",
    handle((req, res) => {
      res.json(store.view(store.apply(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/complete",
    handle((req, res) => {
      res.json(store.view(store.complete(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/refresh",
    handle((req, res) => {
      res.json(store.view(store.refresh(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/convert",
    handle((req, res) => {
      res
        .status(201)
        .json(store.view(store.convert(load(req), objectBody(req.body))));
    }),
  );
  return router;
}
