import {
  type CopyDestination,
  type CopyRequest,
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
  type ReconcileRequest,
  renumberReviewDraft,
  reviewDraftSignature,
  type SyncConflict,
  type SyncDraft,
  type SyncMerge,
  type SyncOperation,
  type SyncResult,
  type SyncState,
  sameReviewDraft,
} from "@roughdraft/rfm";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { browserNavigationUrl, browserPath } from "./browser-base-path";
import type { ComparisonReviewData, EditorDraft } from "./comparison-types";
import {
  decodeBrowserRecovery,
  encodeBrowserRecovery,
} from "./revision-browser-recovery";
import type { RecoverySnapshot } from "./RevisionRecoveryDialog";
import { subscribeReviewChanges } from "./revision-live-transport";
import { measureRevision } from "./revision-performance";
import { receiveSyncResponse } from "./revision-sync-transfer";
import {
  disposeReviewMergeWorker,
  mergeReviewDraftsAsync,
  prepareReviewMergeWorker,
} from "./revision-reconciliation";
import { privateReplyTarget, privateRootTarget } from "./revision-ui-drafts";

export interface InspectedDestination {
  path: string;
  version: string | null;
  markdown: string | null;
}
export interface RevisionDraft extends EditorDraft {
  reviewComments: SyncDraft["reviewComments"];
}
export interface RevisionRemoteAdapter {
  /** The live editor maps newer buffered input through its remote transaction. */
  rebasesBufferedDocument?: boolean;
  /** Validate an immutable merged candidate without changing the live editor. */
  prepare?(draft: RevisionDraft): RevisionDraft | null;
  canRestorePrivateComment?(id: string, draft: unknown): boolean;
  apply(
    draft: RevisionDraft,
    options?: {
      idRemap?: Record<string, string>;
      originDrafts?: Record<string, SyncDraft>;
      localBase?: RevisionDraft;
      forceCleanProjection?: boolean;
      currentCleanMarkdown?: string;
    },
  ): RevisionDraft | null;
  adopt(
    base: RevisionDraft,
    markdown: string,
    force?: boolean,
  ): RevisionDraft | null;
  readUiDrafts(): Record<string, unknown>;
  restoreUiDrafts(drafts: Record<string, unknown>): void;
  flush?(): void;
  subscribeUiDrafts?(listener: () => void): () => void;
}
export interface RevisionConflictState {
  kind: "conflict" | "waiting" | "file" | "indeterminate";
  message: string;
  state: SyncState<ComparisonReviewData> | null;
  conflicts: SyncConflict[];
  signature: string;
  checkpointId?: string;
  checkpointSaved?: boolean;
  storagePressure?: boolean;
  reloadAvailable?: boolean;
}
export interface PendingOperation {
  operation: SyncOperation;
  reviewId: string;
  draft: RevisionDraft;
  base: RevisionDraft;
  generation: number;
  kind: "reconcile" | "copy";
  copyPath?: string;
  /** The immutable candidate was published before its incoming delta was shown. */
  editorBase?: RevisionDraft;
}
export interface BrowserRecovery {
  version: 2;
  pageInstanceId: string;
  aliveAt: number;
  revision: number;
  generation?: number;
  draft: RevisionDraft;
  base: RevisionDraft;
  operation?: PendingOperation | null;
  copyOperation?: PendingOperation | null;
  uiDrafts?: Record<string, unknown>;
  copyPath?: string;
  copyResult?: Pick<
    SyncResult<ComparisonReviewData>,
    "status" | "operationId" | "savedPath" | "reviewUrl"
  >;
}
interface SessionSnapshot {
  session: ComparisonReviewData;
  draft: RevisionDraft;
  recoveryError: string;
  browserRecoveryWarning: string;
  recoveryPending: boolean;
  writePaused: boolean;
  reviewChanged: boolean;
  conflict: RevisionConflictState | null;
  notice: string;
  copyLocked: boolean;
  orphans: Array<{ key: string; aliveAt: number }>;
  fileWritePending: boolean;
}
interface SessionDependencies {
  request?<T>(path: string, body?: object, etag?: string): Promise<T | null>;
  merge?: typeof mergeReviewDraftsAsync;
  now?: () => number;
  id?: () => string;
  storage?: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem" | "key" | "length"
  >;
  tabStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

class RevisionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  body?: object,
  etag?: string,
  referenceVersion?: string,
): Promise<T | null> {
  const serialized =
    body === undefined
      ? undefined
      : measureRevision("save-encode", () => JSON.stringify(body));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    if (body) measureRevision("save-fetch", () => {});
    const response = await fetch(browserPath(`/api/comparisons${path}`), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Roughdraft-Sync": "compact-v1",
        ...(referenceVersion
          ? { "X-Roughdraft-Reference": referenceVersion }
          : {}),
        ...(serialized ? { "Content-Type": "application/json" } : {}),
        ...(etag ? { "If-None-Match": etag } : {}),
      },
      body: serialized,
      signal: controller.signal,
      keepalive: Boolean(
        serialized &&
          document.visibilityState === "hidden" &&
          new TextEncoder().encode(serialized).byteLength <= 60 * 1024,
      ),
    });
    if (response.status === 304) return null;
    const data = await response.json();
    if (!response.ok && !data.status)
      throw new RevisionRequestError(
        data.error ?? "Roughdraft could not complete that action.",
        response.status,
      );
    return data;
  } finally {
    clearTimeout(timer);
  }
}
function persistedDraft(
  review: ComparisonReviewData,
  seed: RevisionDraft,
): RevisionDraft {
  return review.draft
    ? {
        ...review.draft,
        reviewComments: review.reviewComments ?? [],
        outdatedSuggestions:
          review.outdatedSuggestions ?? review.draft.outdatedSuggestions,
      }
    : seed;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function randomId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
function hasUiDrafts(drafts: Record<string, unknown> | undefined) {
  return (
    Boolean(
      drafts?.comments &&
        typeof drafts.comments === "object" &&
        Object.keys(drafts.comments).length,
    ) || drafts?.suggestion != null
  );
}

function readableState(
  state: SyncState<ComparisonReviewData>,
): SyncState<ComparisonReviewData> {
  const disk = state.disk;
  if (disk?.availability !== "unobservable" || disk.text === null) return state;
  const changed = disk.text !== state.review.savedText;
  return {
    ...state,
    disk: { ...disk, availability: "available", observation: "unobservable" },
    review: {
      ...state.review,
      targetChanged: changed,
      liveSourceChanged: !state.review.destinationPath && changed,
      fileObservationWarning: disk.message,
    },
  };
}

function readableResponse<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if ("disk" in value && "review" in value)
    return readableState(
      value as unknown as SyncState<ComparisonReviewData>,
    ) as T;
  if ("state" in value && value.state)
    return {
      ...value,
      state: readableState(value.state as SyncState<ComparisonReviewData>),
    };
  return value;
}

/** One coalescing queue owns writes; notifications never replace newer local work. */
export class RevisionSessionController {
  private snapshot: SessionSnapshot;
  private listeners = new Set<() => void>();
  private current: RevisionDraft;
  private base: RevisionDraft;
  private state: SyncState<ComparisonReviewData> | null = null;
  private operation: PendingOperation | null = null;
  private copyOperation: PendingOperation | null = null;
  private activeOperations = new Set<string>();
  private adapter: RevisionRemoteAdapter | null = null;
  private applyingRemote = false;
  private projectionReady = false;
  private exactCleanReady = false;
  private generation = 0;
  private sequence = 0;
  private baseRevision: number;
  private readonly pageId: string;
  private readonly now: () => number;
  private readonly api: NonNullable<SessionDependencies["request"]>;
  private readonly merge: typeof mergeReviewDraftsAsync;
  private readonly storage: SessionDependencies["storage"];
  private readonly tabStorage: SessionDependencies["tabStorage"];
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private autosaveRunning = false;
  private autosaveRequested = false;
  private autosaveDueAt = 0;
  private retryNotBefore = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private publicationTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeUi: (() => void) | null = null;
  private stopped = false;
  private started = false;
  private refreshPromise: Promise<void> | null = null;
  private lastRecord: string | null = null;
  private recoveryInputs: unknown[] = [];
  private recoveryRecord: string | null = null;
  private privateRecoveryKey: string | null = null;
  private privateRecoveryRecord: string | null = null;
  private pendingSharedRecovery: { key: string; record: string | null } | null =
    null;
  private sharedRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSharedRecoveryAt = Number.NEGATIVE_INFINITY;
  private lastRecoveryOperations: readonly string[] = [];
  private lastRecoveryHeartbeatAt = Number.NEGATIVE_INFINITY;
  private privateRecoveryFailed = false;
  private sharedRecoveryFailed = false;
  private claimedPredecessors = new Map<string, string>();
  private orphanRecords = new Map<
    string,
    { raw: string; record: BrowserRecovery }
  >();
  private inspectedOrphans = new Map<string, string>();
  private pendingIncoming: SyncState<ComparisonReviewData> | null = null;
  private acknowledged: string[] = [];
  private recoveredUiDrafts: Record<string, unknown> | null = null;
  private deferredCopy: SyncResult<ComparisonReviewData> | null = null;
  private copyRequestVersion = 0;
  private copyPath: string | undefined;
  private checkpointPromise: Promise<void> | null = null;
  private checkpointSignature = "";
  private checkpointGeneration = -1;
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointEntryId: string | undefined;
  private checkpointRecoveryId: string | undefined;
  private diskProjections = new Map<string, string>();
  private observedOverwriteId: string | undefined;

  constructor(
    initial: ComparisonReviewData,
    private readonly seed: RevisionDraft,
    dependencies: SessionDependencies = {},
  ) {
    this.baseRevision = initial.revision;
    this.observedOverwriteId = initial.lastOverwrite?.operationId;
    this.now = dependencies.now ?? Date.now;
    this.api = async <T>(path: string, body?: object, etag?: string) => {
      const previous = this.snapshot?.session ?? initial;
      const value = dependencies.request
        ? await dependencies.request<T>(path, body, etag)
        : await request<T>(path, body, etag, previous.referenceVersion);
      return readableResponse(receiveSyncResponse(value, previous));
    };
    this.merge = dependencies.merge ?? mergeReviewDraftsAsync;
    this.pageId = dependencies.id?.() ?? randomId();
    try {
      this.storage = dependencies.storage ?? globalThis.localStorage;
    } catch {
      this.storage = undefined;
    }
    try {
      this.tabStorage = dependencies.tabStorage ?? globalThis.sessionStorage;
    } catch {
      this.tabStorage = undefined;
    }
    this.current = persistedDraft(initial, seed);
    // Inline feedback is materialized locally. An empty sidecar on a fresh
    // server review is its original representation, not a deletion of that feedback.
    this.base = initial.draft
      ? this.current
      : {
          markdown: initial.afterText,
          decisions: {},
          reviewComments: initial.reviewComments ?? [],
        };
    const recovered = this.restore(initial.id);
    if (recovered) {
      this.current = recovered.draft;
      this.base = recovered.base;
      this.baseRevision = recovered.revision;
      this.operation =
        recovered.operation?.kind === "copy"
          ? null
          : (recovered.operation ?? null);
      this.copyOperation =
        recovered.copyOperation ??
        (recovered.operation?.kind === "copy" ? recovered.operation : null);
      this.copyPath = recovered.copyPath ?? this.copyOperation?.copyPath;
      this.deferredCopy = recovered.copyResult ?? null;
      this.recoveredUiDrafts = recovered.uiDrafts ?? null;
    }
    // Persisted and recovered drafts carry exact accepted Markdown spelling.
    // Only a new seed needs projection; reprojecting a saved draft on opening
    // can turn harmless editor normalization into an unintended file write.
    this.exactCleanReady = Boolean(
      (initial.draft || recovered) && this.current.cleanMarkdown !== undefined,
    );
    this.snapshot = {
      session: initial,
      draft: this.current,
      recoveryError: "",
      browserRecoveryWarning: "",
      recoveryPending: !sameReviewDraft(this.current, this.base),
      writePaused: false,
      reviewChanged: false,
      conflict: null,
      notice: "",
      copyLocked: false,
      orphans: [],
      fileWritePending: Boolean(
        initial.destinationPath &&
          this.current.markdown !== initial.savedText &&
          (this.current.cleanMarkdown ?? this.current.markdown) !==
            initial.savedText,
      ),
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  readDraft = () => this.current;
  getGeneration = () => this.generation;
  private emit(update: Partial<SessionSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      fileWritePending: this.state
        ? this.needsFileWrite(this.state)
        : this.snapshot.fileWritePending,
    };
    for (const listener of this.listeners) listener();
  }
  private key(id = this.snapshot.session.id) {
    return `roughdraft-draft:${id}:${this.pageId}`;
  }
  private restore(id: string): BrowserRecovery | null {
    try {
      const pointer = `roughdraft-page:${id}`;
      const previous = this.tabStorage?.getItem(pointer);
      this.tabStorage?.setItem(pointer, this.pageId);
      if (!previous) return null;
      const key = `roughdraft-draft:${id}:${previous}`;
      const raw = this.tabStorage?.getItem(key) ?? this.storage?.getItem(key);
      const record = decodeBrowserRecovery(raw ?? null);
      if (!record) return null;
      const sharedRaw = this.storage?.getItem(key) ?? null;
      const shared = decodeBrowserRecovery(sharedRaw);
      if (
        sharedRaw &&
        shared &&
        shared.pageInstanceId === record.pageInstanceId &&
        shared.revision <= record.revision &&
        (sharedRaw === raw ||
          shared.aliveAt < record.aliveAt ||
          (shared.aliveAt === record.aliveAt &&
            shared.generation !== undefined &&
            record.generation !== undefined &&
            shared.generation <= record.generation))
      )
        this.claimedPredecessors.set(key, sharedRaw);
      this.tabStorage?.removeItem(key); // Only this tab's private predecessor copy.
      return record;
    } catch {
      return null;
    }
  }
  private recoveryAliveKey(key = this.key()) {
    return key.replace(/^roughdraft-draft:/, "roughdraft-alive:");
  }
  private recoveryIsLive(key: string, fallback: number) {
    const heartbeat = this.storage?.getItem(this.recoveryAliveKey(key));
    const aliveAt =
      heartbeat === null || heartbeat === undefined
        ? fallback
        : Number(heartbeat);
    return this.now() - aliveAt <= 10_000;
  }
  private flushSharedRecovery() {
    if (this.sharedRecoveryTimer) clearTimeout(this.sharedRecoveryTimer);
    this.sharedRecoveryTimer = null;
    const pending = this.pendingSharedRecovery;
    if (!pending || !this.storage) return false;
    try {
      if (pending.record) {
        this.storage.setItem(pending.key, pending.record);
        this.lastRecord = pending.record;
      } else if (this.storage.getItem(pending.key) === this.lastRecord) {
        this.storage.removeItem(pending.key);
        this.storage.removeItem(this.recoveryAliveKey(pending.key));
        this.lastRecord = null;
      }
      this.pendingSharedRecovery = null;
      this.lastSharedRecoveryAt = this.now();
      this.sharedRecoveryFailed = false;
      this.reportRecoveryStorage();
      return true;
    } catch {
      // Keep the pending owned record for the next forced or scheduled retry.
      this.sharedRecoveryFailed = true;
      this.reportRecoveryStorage();
      return false;
    }
  }
  private reportRecoveryStorage() {
    const warning = this.privateRecoveryFailed
      ? this.sharedRecoveryFailed
        ? "Browser recovery is unavailable. Keep this tab open or use Save separately to preserve your work."
        : "Private browser recovery is unavailable. Recovery copies in other tabs remain available."
      : this.sharedRecoveryFailed
        ? "Your private browser recovery is available. Other tabs cannot recover it until browser storage is available."
        : "";
    if (this.snapshot.browserRecoveryWarning === warning) return;
    if (warning)
      console.warn(
        JSON.stringify({
          severity: "warn",
          component: "revision-session",
          event: "browser-recovery-storage-unavailable",
          privateFailed: this.privateRecoveryFailed,
          sharedFailed: this.sharedRecoveryFailed,
        }),
      );
    this.emit({ browserRecoveryWarning: warning });
  }
  private clearClaimedPredecessors() {
    for (const [key, raw] of this.claimedPredecessors) {
      if (this.storage?.getItem(key) !== raw) {
        this.claimedPredecessors.delete(key);
        continue;
      }
      const record = decodeBrowserRecovery(raw);
      if (record && !this.recoveryIsLive(key, record.aliveAt)) {
        if (this.storage?.getItem(key) === raw) {
          this.storage.removeItem(key);
          this.storage.removeItem(this.recoveryAliveKey(key));
        }
        this.claimedPredecessors.delete(key);
      }
    }
  }
  private persist(force = false, immediate = force) {
    const key = this.key();
    const uiDrafts =
      this.adapter?.readUiDrafts() ?? this.recoveredUiDrafts ?? {};
    const revision = this.state?.revision ?? this.snapshot.session.revision;
    const inputs = [
      key,
      this.current,
      this.base,
      this.operation,
      this.copyOperation,
      this.copyPath,
      this.deferredCopy,
      revision,
      this.generation,
      Boolean(this.snapshot.conflict),
      uiDrafts.comments,
      uiDrafts.suggestion,
    ];
    const changed = inputs.some(
      (value, index) => value !== this.recoveryInputs[index],
    );
    if (changed) {
      this.recoveryInputs = inputs;
      const useful =
        this.operation ||
        this.copyOperation ||
        this.copyPath ||
        this.deferredCopy ||
        !sameReviewDraft(this.current, this.base) ||
        this.snapshot.conflict ||
        hasUiDrafts(uiDrafts);
      this.recoveryRecord = useful
        ? encodeBrowserRecovery({
            version: 2,
            pageInstanceId: this.pageId,
            aliveAt: this.now(),
            revision,
            generation: this.generation,
            draft: this.current,
            base: this.base,
            operation: this.operation,
            copyOperation: this.copyOperation,
            ...(this.copyPath !== undefined ? { copyPath: this.copyPath } : {}),
            ...(this.deferredCopy?.status === "committed"
              ? {
                  copyResult: {
                    status: "committed" as const,
                    operationId: this.deferredCopy.operationId,
                    savedPath:
                      this.deferredCopy.savedPath ??
                      this.deferredCopy.state?.review.destinationPath ??
                      this.copyPath,
                    reviewUrl: this.deferredCopy.reviewUrl,
                  },
                }
              : {}),
            uiDrafts,
          })
        : null;
    }
    const record = this.recoveryRecord;
    let stored = false;
    try {
      if (
        this.privateRecoveryKey !== key ||
        this.privateRecoveryRecord !== record
      ) {
        if (record) this.tabStorage?.setItem(key, record);
        else this.tabStorage?.removeItem(key);
        this.privateRecoveryKey = key;
        this.privateRecoveryRecord = record;
      }
      stored = Boolean(this.tabStorage);
      this.privateRecoveryFailed = !stored;
    } catch {
      /* The durable server checkpoint remains available. */
      this.privateRecoveryFailed = true;
    }
    const operations = [
      this.operation?.operation.operationId ?? "",
      this.copyOperation?.operation.operationId ?? "",
    ];
    immediate ||=
      !stored ||
      operations.some(
        (id, index) => Boolean(id) && id !== this.lastRecoveryOperations[index],
      );
    this.lastRecoveryOperations = operations;
    if (changed || immediate) {
      this.pendingSharedRecovery = { key, record };
      if (
        immediate ||
        !record ||
        this.lastRecord === null ||
        this.now() - this.lastSharedRecoveryAt >= 750
      )
        stored = this.flushSharedRecovery() || stored;
      else if (!this.sharedRecoveryTimer)
        this.sharedRecoveryTimer = setTimeout(
          () => {
            this.sharedRecoveryTimer = null;
            this.flushSharedRecovery();
          },
          750 - (this.now() - this.lastSharedRecoveryAt),
        );
    }
    try {
      if (
        record &&
        !this.stopped &&
        this.now() - this.lastRecoveryHeartbeatAt >= 3000
      ) {
        this.storage?.setItem(this.recoveryAliveKey(key), String(this.now()));
        this.lastRecoveryHeartbeatAt = this.now();
      }
      if (stored) this.clearClaimedPredecessors();
    } catch {
      /* Do not clear another page's work or pretend local recovery succeeded. */
    }
    if (force && !stored)
      this.emit({
        recoveryError:
          "Browser recovery could not be saved. Your changes remain in this tab; retry storage before renumbering this suggestion.",
      });
    this.reportRecoveryStorage();
    return stored;
  }
  private findOrphans() {
    const orphans: SessionSnapshot["orphans"] = [];
    try {
      const prefix = `roughdraft-draft:${this.snapshot.session.id}:`;
      for (let index = 0; index < (this.storage?.length ?? 0); index++) {
        const key = this.storage?.key(index);
        if (!key?.startsWith(prefix) || key === this.key()) continue;
        if (this.recoveryIsLive(key, Number.NEGATIVE_INFINITY)) continue;
        const raw = this.storage?.getItem(key) ?? null;
        if (raw && this.claimedPredecessors.get(key) === raw) continue;
        const cached = this.orphanRecords.get(key);
        const record =
          cached?.raw === raw ? cached.record : decodeBrowserRecovery(raw);
        if (record && raw && !this.recoveryIsLive(key, record.aliveAt)) {
          this.orphanRecords.set(key, { raw, record });
          while (
            this.orphanRecords.size > 20 ||
            [...this.orphanRecords.values()].reduce(
              (bytes, entry) => bytes + entry.raw.length,
              0,
            ) >
              8 * 1024 * 1024
          )
            this.orphanRecords.delete(
              this.orphanRecords.keys().next().value as string,
            );
          if (
            record.operation ||
            record.copyOperation ||
            record.copyPath ||
            record.copyResult ||
            !sameReviewDraft(record.draft, this.base) ||
            hasUiDrafts(record.uiDrafts)
          )
            orphans.push({ key, aliveAt: record.aliveAt });
          else this.storage?.removeItem(key); // An abandoned copy exactly represented by the saved review has no unique work.
        }
      }
    } catch {
      /* Recovery discovery cannot prevent editing. */
    }
    this.emit({ orphans });
  }
  private availableOrphan(key: string) {
    if (
      !key.startsWith(`roughdraft-draft:${this.snapshot.session.id}:`) ||
      key === this.key()
    )
      throw new Error(
        "That browser recovery copy does not belong to this review.",
      );
    const raw = this.storage?.getItem(key) ?? null;
    const record = decodeBrowserRecovery(raw);
    if (!record || !raw)
      throw new Error("That browser recovery copy is no longer available.");
    const inspected = this.inspectedOrphans.get(key);
    if (inspected && inspected !== raw)
      throw new Error(
        "That recovery copy changed. Inspect its latest version before continuing.",
      );
    if (this.recoveryIsLive(key, record.aliveAt))
      throw new Error("That tab is active again. Its work remains there.");
    return { raw, record };
  }
  dismissOrphan = async (key: string) => {
    const { raw } = this.availableOrphan(key);
    if (this.storage?.getItem(key) !== raw)
      throw new Error("That recovery copy changed. Inspect it again.");
    this.storage?.removeItem(key);
    this.storage?.removeItem(this.recoveryAliveKey(key));
    this.inspectedOrphans.delete(key);
    this.orphanRecords.delete(key);
    this.findOrphans();
  };
  restoreOrphan = async (key: string) =>
    this.serialize(async () => {
      const { raw, record } = this.availableOrphan(key);
      if (!this.adapter)
        throw new Error("The editor is not ready to restore this work.");
      if (this.operation || this.copyOperation)
        throw new Error(
          "Check the current save status before restoring other browser work.",
        );
      const current = this.current;
      const generation = this.generation;
      const uiDrafts = this.adapter.readUiDrafts();
      if (!sameReviewDraft(current, this.base) || hasUiDrafts(uiDrafts)) {
        const checkpoint = await this.api<{ checkpointId: string }>(
          `/${encodeURIComponent(this.snapshot.session.id)}/checkpoint`,
          {
            operationId: randomId(),
            pageInstanceId: this.pageId,
            conflictId: `before-browser-recovery:${randomId()}`,
            generation: this.generation,
            workingDraft: current,
            uiDrafts,
            reason: "Before restoring browser work",
          },
        );
        if (!checkpoint)
          throw new Error(
            "Your current work must be preserved before restoring this copy. Retry when the server is available.",
          );
      }
      if (
        this.current !== current ||
        this.generation !== generation ||
        this.availableOrphan(key).raw !== raw
      )
        throw new Error(
          "The working review or recovery copy changed. Inspect it again.",
        );
      const restored = this.adapter.apply(record.draft, { localBase: current });
      if (!restored)
        throw new Error(
          "Finish your current edit before restoring this work. The recovery copy remains available.",
        );
      this.current = restored;
      this.base = record.base;
      this.baseRevision = record.revision;
      this.operation =
        record.operation?.kind === "copy" ? null : (record.operation ?? null);
      this.copyOperation =
        record.copyOperation ??
        (record.operation?.kind === "copy" ? record.operation : null);
      this.copyPath = record.copyPath ?? this.copyOperation?.copyPath;
      this.deferredCopy = record.copyResult ?? null;
      this.adapter?.restoreUiDrafts(record.uiDrafts ?? {});
      this.emit({
        draft: this.current,
        recoveryPending: true,
        notice: "Recovered work may still be open in another tab.",
      });
      if (!this.persist(true))
        throw new Error(
          "Browser recovery could not be preserved. This copy remains available.",
        );
      if (this.storage?.getItem(key) === raw) {
        this.storage.removeItem(key);
        this.storage.removeItem(this.recoveryAliveKey(key));
      }
      this.findOrphans();
    }).then(() => this.refresh(true));
  inspectRecovery = (id: string) =>
    this.api<RecoverySnapshot>(
      `/${encodeURIComponent(this.snapshot.session.id)}/checkpoints/${encodeURIComponent(id)}`,
    ) as Promise<RecoverySnapshot>;
  inspectOrphan = (key: string): RecoverySnapshot => {
    const raw = this.storage?.getItem(key) ?? null;
    const record = decodeBrowserRecovery(raw);
    if (!record)
      throw new Error("That browser recovery copy is no longer available.");
    if (raw) {
      this.inspectedOrphans.set(key, raw);
      while (this.inspectedOrphans.size > 20)
        this.inspectedOrphans.delete(
          this.inspectedOrphans.keys().next().value as string,
        );
    }
    return {
      entryDraft: record.base,
      workingDraft: record.draft,
      uiDrafts: record.uiDrafts,
    };
  };
  restoreRecoveryUi = async (
    snapshot: RecoverySnapshot,
  ): Promise<{ restored: number; skipped: number }> =>
    this.serialize(async () => {
      if (!this.adapter)
        throw new Error("The editor is not ready to restore feedback.");
      const before = this.adapter.readUiDrafts();
      const beforeKey = JSON.stringify(before);
      if (hasUiDrafts(before)) {
        const checkpoint = await this.api<{ checkpointId: string }>(
          `/${encodeURIComponent(this.snapshot.session.id)}/checkpoint`,
          {
            operationId: randomId(),
            pageInstanceId: this.pageId,
            conflictId: `before-feedback-restore:${randomId()}`,
            generation: this.generation,
            workingDraft: this.current,
            uiDrafts: before,
            reason: "Unfinished feedback before restoring a recovery copy",
          },
        );
        if (!checkpoint)
          throw new Error(
            "Your current unfinished feedback must be preserved before restoring this copy.",
          );
      }
      if (JSON.stringify(this.adapter.readUiDrafts()) !== beforeKey)
        throw new Error(
          "Your unfinished feedback changed. Inspect it and retry restoring the copy.",
        );
      const requested = snapshot.uiDrafts ?? {};
      const comments: Record<string, unknown> = {};
      let restored = 0;
      let skipped = 0;
      const oldComments = new Map(
        snapshot.workingDraft.reviewComments.map((comment) => [
          comment.id,
          comment,
        ]),
      );
      const currentComments = new Map(
        this.current.reviewComments.map((comment) => [comment.id, comment]),
      );
      const oldItems = extractRoughdraftReviewIndex(
        snapshot.workingDraft.markdown,
      ).items;
      const currentItems = extractRoughdraftReviewIndex(
        this.current.markdown,
      ).items;
      const anchors = (items: typeof oldItems) => {
        const result = new Map<string, string[]>();
        for (const item of items) {
          if (!item.anchorText) continue;
          const values = result.get(item.id) ?? [];
          values.push(item.anchorText);
          result.set(item.id, values);
        }
        return result;
      };
      const oldAnchors = anchors(oldItems);
      const currentAnchors = anchors(currentItems);
      const identity = (comment: RevisionDraft["reviewComments"][number]) =>
        JSON.stringify([
          comment.id,
          comment.content,
          comment.createdAt,
          comment.authorType ?? null,
          comment.authorId ?? null,
          comment.parentCommentId ?? null,
          comment.changeId,
          comment.scope ?? null,
          comment.originalQuote ?? null,
          comment.detachedReason ?? null,
        ]);
      const sameTarget = (id: string) => {
        const old = oldComments.get(id);
        const current = currentComments.get(id);
        return Boolean(
          old &&
            current &&
            identity(old) === identity(current) &&
            JSON.stringify(oldAnchors.get(id) ?? []) ===
              JSON.stringify(currentAnchors.get(id) ?? []),
        );
      };
      const proposalIdentities = (items: typeof oldItems) => {
        const result = new Map<string, unknown[]>();
        for (const item of items) {
          if (item.kind !== "suggestion") continue;
          const fragments = result.get(item.id) ?? [];
          fragments.push([
            item.id,
            item.kind,
            item.suggestionKind,
            item.text,
            item.originalText ?? null,
            item.replacementText ?? null,
            item.author,
            item.createdAt,
            item.status,
          ]);
          result.set(item.id, fragments);
        }
        return result;
      };
      const oldProposals = proposalIdentities(oldItems);
      const currentProposals = proposalIdentities(currentItems);
      const sameProposal = (id: string) =>
        !oldComments.has(id) &&
        !currentComments.has(id) &&
        oldProposals.has(id) &&
        JSON.stringify(oldProposals.get(id)) ===
          JSON.stringify(currentProposals.get(id));
      if (requested.comments && typeof requested.comments === "object")
        for (const [id, value] of Object.entries(requested.comments)) {
          const pending = privateReplyTarget(id, value);
          const root = privateRootTarget(id, value);
          const beforeValue = (
            before.comments as Record<string, unknown> | undefined
          )?.[id];
          const activeRoot = privateRootTarget(id, beforeValue);
          const active = privateReplyTarget(
            id,
            (before.comments as Record<string, unknown> | undefined)?.[id],
          );
          if (
            sameTarget(id) ||
            (root &&
              !oldComments.has(id) &&
              !currentComments.has(id) &&
              !oldItems.some((item) => item.id === id) &&
              !currentItems.some((item) => item.id === id) &&
              (!activeRoot ||
                JSON.stringify(activeRoot) === JSON.stringify(root)) &&
              this.adapter.canRestorePrivateComment?.(id, value)) ||
            (pending &&
              !oldComments.has(id) &&
              !currentComments.has(id) &&
              !currentAnchors.has(id) &&
              (!active || JSON.stringify(active) === JSON.stringify(pending)) &&
              (sameTarget(pending.parentCommentId) ||
                sameProposal(pending.parentCommentId)))
          ) {
            comments[id] = value;
            restored++;
          } else skipped++;
        }
      let suggestion: unknown;
      if (requested.suggestion != null) {
        if (sameReviewDraft(snapshot.workingDraft, this.current)) {
          suggestion = requested.suggestion;
          restored++;
        } else skipped++;
      }
      if (!restored) return { restored, skipped };
      this.adapter.restoreUiDrafts({ comments, suggestion });
      this.persist();
      this.emit({
        notice: skipped
          ? `Restored ${restored} unfinished feedback drafts. ${skipped} changed targets remain in Recovery copies.`
          : "Restored unfinished feedback from Recovery copies.",
      });
      return { restored, skipped };
    });
  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    prepareReviewMergeWorker(this.current.markdown);
    this.unsubscribe = subscribeReviewChanges(
      this.snapshot.session.id,
      (notice) => {
        if (notice.operationContext && this.state)
          this.state = {
            ...this.state,
            operationContext: notice.operationContext,
          };
        if (notice.reason === "heartbeat") return;
        if (notice.state) void this.observe(notice.state);
        else void this.refresh();
      },
    );
    this.heartbeat = setInterval(() => {
      this.persist();
      this.findOrphans();
    }, 3000);
    this.findOrphans();
    void this.refresh(true);
  }
  stop() {
    this.stopped = true;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeUi?.();
    this.unsubscribeUi = null;
    if (this.timer) clearTimeout(this.timer);
    this.autosaveRequested = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.publicationTimer) clearTimeout(this.publicationTimer);
    this.publicationTimer = null;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    this.persist(false, true);
    try {
      this.storage?.setItem(this.recoveryAliveKey(), "0");
    } catch {
      /* Private recovery remains available. */
    }
    disposeReviewMergeWorker();
  }
  setAdapter = (adapter: RevisionRemoteAdapter | null) => {
    this.unsubscribeUi?.();
    this.adapter = adapter;
    if (!adapter) this.projectionReady = false;
    this.unsubscribeUi =
      adapter?.subscribeUiDrafts?.(() => {
        if (this.applyingRemote) return;
        this.generation++;
        if (this.snapshot.conflict?.checkpointSaved)
          this.emit({
            conflict: { ...this.snapshot.conflict, checkpointSaved: false },
          });
        this.persist();
        if (this.snapshot.conflict) this.schedule();
      }) ?? null;
    if (adapter && this.recoveredUiDrafts) {
      adapter.restoreUiDrafts(this.recoveredUiDrafts);
      this.recoveredUiDrafts = null;
    }
    if (adapter) {
      const normalized = adapter.apply(
        this.exactCleanReady
          ? this.current
          : { ...this.current, cleanMarkdown: undefined },
        { forceCleanProjection: !this.exactCleanReady },
      );
      if (normalized) {
        this.projectionReady = true;
        this.exactCleanReady = true;
        this.current = normalized;
        if (
          this.state?.disk?.text === this.seed.markdown &&
          normalized.markdown === this.seed.markdown
        )
          this.rememberDiskProjection(this.state, normalized.cleanMarkdown);
        this.emit({ draft: normalized });
        this.persist();
      }
      void this.refresh(true);
      this.schedule(0);
    }
  };
  updateDraft = (
    update: (current: RevisionDraft) => RevisionDraft,
    options?: { readyToSave?: boolean },
  ) => {
    const next = update(this.current);
    if (sameReviewDraft(next, this.current)) return;
    this.current = next;
    this.generation++;
    this.emit({
      draft: next,
      recoveryPending: true,
      ...(this.snapshot.conflict
        ? { conflict: { ...this.snapshot.conflict, checkpointSaved: false } }
        : {}),
    });
    this.persist();
    if (this.pendingIncoming && this.snapshot.conflict?.kind === "waiting") {
      const pending = this.pendingIncoming;
      this.pendingIncoming = null;
      void this.observe(pending);
    }
    measureRevision(
      options?.readyToSave ? "autosave-ready" : "autosave-batched",
      () => this.schedule(options?.readyToSave ? 0 : 300),
    );
  };
  private schedule(delay = 300) {
    if (this.stopped) return;
    this.autosaveRequested = true;
    if (this.autosaveRunning) return;
    const wait = Math.max(0, delay, this.retryNotBefore - performance.now());
    const due = performance.now() + wait;
    if (this.timer && this.autosaveDueAt <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.autosaveDueAt = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.autosaveRequested = false;
      this.autosaveRunning = true;
      measureRevision("autosave-fired", () => {});
      void this.flush(false)
        .catch((error) => this.emit({ recoveryError: errorMessage(error) }))
        .finally(() => {
          this.autosaveRunning = false;
          if (this.autosaveRequested) this.schedule(0);
        });
    }, wait);
  }
  private deferAutosave(delay: number) {
    this.retryNotBefore =
      performance.now() + Math.max(20, Math.min(750, delay));
    this.schedule(0);
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private operationIdentity(): SyncOperation {
    if (!this.state) throw new Error("Waiting for the saved review.");
    return {
      operationId: randomId(),
      operationSequence: ++this.sequence,
      pageInstanceId: this.pageId,
      operationContext: this.state.operationContext,
      acknowledgedOperationIds: [...this.acknowledged],
    };
  }
  private acknowledge(id: string) {
    if (!this.acknowledged.includes(id)) this.acknowledged.push(id);
    this.acknowledged = this.acknowledged.slice(-16);
  }
  private async postOperation(path: string, body: SyncOperation) {
    this.activeOperations.add(body.operationId);
    try {
      return await this.api<SyncResult<ComparisonReviewData>>(path, body);
    } finally {
      this.activeOperations.delete(body.operationId);
    }
  }
  private resumeIncoming() {
    const incoming = this.pendingIncoming;
    this.pendingIncoming = null;
    if (incoming) queueMicrotask(() => void this.observe(incoming));
  }
  private async resolvePending() {
    const pending = this.operation;
    if (!pending) return true;
    if (this.activeOperations.has(pending.operation.operationId)) return false;
    const result = await this.api<SyncResult<ComparisonReviewData>>(
      `/operations/${encodeURIComponent(pending.operation.operationId)}/resolve`,
      { ...pending.operation, reviewId: pending.reviewId },
    );
    if (!result) return false;
    if (result.status === "committed" && result.state) {
      if (!(await this.applyAcknowledgment(result.state, pending)))
        return false;
      this.operation = null;
      this.persist();
      this.resumeIncoming();
      return true;
    }
    if (
      [
        "not-received",
        "rejected",
        "retry-later",
        "client-merge-required",
        "base-unavailable",
        "binding-changed",
        "operation-expired",
        "conflict",
      ].includes(result.status)
    ) {
      this.acknowledge(pending.operation.operationId);
      this.operation = null;
      this.persist();
      this.resumeIncoming();
      return true;
    }
    this.wait(
      result.status === "publishing" ? "waiting" : "indeterminate",
      result.message ??
        "The previous save result is not yet available. Your work remains here.",
      result.state ?? this.state,
    );
    return false;
  }
  refresh = async (force = false): Promise<void> => {
    if (this.refreshPromise && !force) return this.refreshPromise;
    const work = (async () => {
      try {
        const state = await this.api<SyncState<ComparisonReviewData>>(
          `/${encodeURIComponent(this.snapshot.session.id)}/state`,
          undefined,
          force ? undefined : this.state?.registryGeneration,
        );
        if (state) await this.observe(state);
        if (this.operation)
          await this.serialize(async () => {
            if (await this.resolvePending()) this.schedule(0);
          });
        if (
          this.copyOperation &&
          !this.activeOperations.has(this.copyOperation.operation.operationId)
        )
          await this.checkCopyStatus();
      } catch (error) {
        this.emit({
          recoveryError: `Updates are temporarily unavailable. Your work remains in this tab. ${errorMessage(error)}`,
        });
      }
    })();
    this.refreshPromise = work;
    try {
      await work;
    } finally {
      if (this.refreshPromise === work) this.refreshPromise = null;
    }
  };
  private wait(
    kind: RevisionConflictState["kind"],
    message: string,
    state: SyncState<ComparisonReviewData> | null,
    merge?: SyncMerge,
  ) {
    if (!this.snapshot.conflict) {
      this.checkpointRecoveryId = randomId();
      this.checkpointSignature = "";
      this.checkpointGeneration = -1;
      this.checkpointEntryId = undefined;
    }
    const conflict: RevisionConflictState = {
      kind,
      message,
      state,
      conflicts: merge?.conflicts ?? [],
      signature: merge?.signature ?? reviewDraftSignature(this.current),
      checkpointId: this.checkpointEntryId,
      checkpointSaved: false,
      reloadAvailable:
        kind === "waiting" &&
        Boolean(state?.disk?.availability === "available") &&
        sameReviewDraft(this.current, this.base),
    };
    this.emit({
      writePaused: true,
      reviewChanged: kind === "conflict",
      conflict,
      recoveryPending: true,
    });
    this.persist();
    void this.checkpoint();
  }
  private async applyDraft(
    next: RevisionDraft,
    merge?: SyncMerge,
    state = this.state,
    localBase?: RevisionDraft,
  ) {
    if (!this.adapter?.rebasesBufferedDocument) this.adapter?.flush?.();
    let input = next;
    if (localBase && !sameReviewDraft(localBase, this.current)) {
      const empty = (draft: RevisionDraft) => ({
        ...draft,
        markdown: "",
        cleanMarkdown: "",
      });
      const map = merge?.idRemap;
      const local = map
        ? renumberReviewDraft(empty(this.current), map)
        : empty(this.current);
      const base = map
        ? renumberReviewDraft(empty(localBase), map)
        : empty(localBase);
      const structured = mergeReviewDrafts(base, local, empty(next), {
        server: false,
        budgetMs: 16,
      });
      if (structured.status !== "merged") {
        this.wait(
          "conflict",
          "A newer local comment or decision overlaps the incoming review.",
          state,
          structured,
        );
        return false;
      }
      input = {
        ...structured.draft,
        markdown: next.markdown,
        cleanMarkdown: next.cleanMarkdown,
      };
    }
    let applied =
      input.cleanMarkdown === undefined &&
      input.markdown === this.current.markdown
        ? { ...input, cleanMarkdown: this.current.cleanMarkdown }
        : input;
    if (this.adapter) {
      let result: RevisionDraft | null;
      this.applyingRemote = true;
      try {
        result = this.adapter.apply(applied, {
          idRemap: merge?.idRemap,
          originDrafts: state?.originDrafts,
          localBase,
        });
      } finally {
        this.applyingRemote = false;
      }
      if (!result) {
        this.pendingIncoming = state;
        this.wait(
          "waiting",
          "An outside update is waiting while you finish this word or source edit.",
          state,
        );
        return false;
      }
      applied = result;
      this.projectionReady = true;
    } else if (input.markdown !== this.current.markdown) {
      this.pendingIncoming = state;
      return false;
    }
    this.current = applied;
    this.emit({ draft: applied });
    if (
      !this.persist(
        Boolean(merge?.idRemap && Object.keys(merge.idRemap).length),
      )
    ) {
      if (merge?.idRemap && Object.keys(merge.idRemap).length) {
        this.wait(
          "waiting",
          "Browser recovery must be available before saving renumbered feedback.",
          state,
        );
        return false;
      }
    }
    return true;
  }
  private async applyAcknowledgment(
    state: SyncState<ComparisonReviewData>,
    pending: PendingOperation,
  ) {
    this.observeOverwrite(state.review);
    if (this.acknowledged.includes(pending.operation.operationId)) return true;
    let next = this.current;
    if (pending.editorBase || !sameReviewDraft(state.draft, pending.draft)) {
      if (!this.adapter?.rebasesBufferedDocument) this.adapter?.flush?.();
      const localBase = this.current;
      const acknowledgmentBase = pending.editorBase ?? pending.draft;
      const merged: SyncMerge = sameReviewDraft(acknowledgmentBase, localBase)
        ? {
            status: "merged",
            draft: state.draft,
            conflicts: [],
            signature: state.signature,
          }
        : await this.merge(acknowledgmentBase, localBase, state.draft, {
            server: false,
          });
      if (merged.status !== "merged") {
        this.wait(
          merged.status === "conflict" ? "conflict" : "waiting",
          merged.reason ??
            "The saved result needs review before it can be applied.",
          state,
          merged,
        );
        return false;
      }
      next = merged.draft as RevisionDraft;
      if (!(await this.applyDraft(next, merged, state, localBase)))
        return false;
    }
    this.state = state;
    this.base = state.draft as RevisionDraft;
    this.baseRevision = state.revision;
    this.acknowledge(pending.operation.operationId);
    if (
      state.disk?.text === (state.draft.cleanMarkdown ?? state.draft.markdown)
    )
      this.rememberDiskProjection(state, state.disk.text ?? undefined);
    this.emit({
      session: state.review,
      recoveryError: "",
      recoveryPending:
        !sameReviewDraft(this.current, this.base) || this.needsFileWrite(state),
      writePaused: false,
      reviewChanged: false,
      conflict: null,
    });
    return true;
  }
  private diskKey(state: SyncState<ComparisonReviewData>) {
    return state.disk
      ? `${state.disk.path}\0${state.disk.version ?? "missing"}`
      : "";
  }
  private rememberDiskProjection(
    state: SyncState<ComparisonReviewData>,
    clean: string | undefined,
  ) {
    if (clean === undefined || !state.disk) return;
    this.diskProjections.set(this.diskKey(state), clean);
    while (this.diskProjections.size > 16)
      this.diskProjections.delete(
        this.diskProjections.keys().next().value as string,
      );
  }
  private needsFileWrite(
    state: SyncState<ComparisonReviewData>,
    draft = this.current,
  ) {
    // Projecting an unchanged annotated source must never authorize stripping
    // its annotations or rewriting whitespace. This also refreshes an earlier
    // projection cached before the editor finished its reading normalization.
    if (
      state.disk?.availability === "available" &&
      draft.markdown === state.disk.text
    ) {
      this.rememberDiskProjection(state, draft.cleanMarkdown);
      return false;
    }
    return Boolean(
      state.review.destinationPath &&
        (draft.cleanMarkdown ?? draft.markdown) !==
          (this.diskProjections.get(this.diskKey(state)) ??
            state.review.savedText ??
            ""),
    );
  }
  private incomingFor(
    state: SyncState<ComparisonReviewData>,
    force = false,
  ): RevisionDraft | null {
    const disk = state.disk;
    if (!disk || disk.text === null || disk.text === state.review.savedText)
      return state.draft as RevisionDraft;
    const adopted =
      this.adapter?.adopt(state.draft as RevisionDraft, disk.text, force) ??
      null;
    if (adopted) this.rememberDiskProjection(state, adopted.cleanMarkdown);
    return adopted;
  }
  private incomingUpdateCause(state: SyncState<ComparisonReviewData>) {
    const disk = state.disk;
    const fileChanged = Boolean(
      disk &&
        disk.text !== null &&
        (disk.text !== state.review.savedText ||
          state.review.liveSourceChanged ||
          state.review.targetChanged),
    );
    const reviewChanged = state.revision > this.baseRevision;
    return fileChanged
      ? reviewChanged
        ? "The file changed on disk and a newer saved review is available."
        : "The file changed on disk."
      : "A newer saved review is available.";
  }
  private schedulePublicationRefresh(reviewId: string, delay: number) {
    this.publicationTimer = setTimeout(() => {
      this.publicationTimer = null;
      if (this.stopped || this.snapshot.session.id !== reviewId) return;
      void this.refresh(true).finally(() => {
        if (
          !this.stopped &&
          !this.publicationTimer &&
          this.snapshot.session.id === reviewId &&
          this.state?.publishing &&
          !this.state.publishing.recoverable
        )
          this.schedulePublicationRefresh(reviewId, 1000);
      });
    }, delay);
  }
  private async observe(state: SyncState<ComparisonReviewData>) {
    state = readableState(state);
    if (state.review.id !== this.snapshot.session.id) return;
    const stale = () => {
      if (state.revision >= this.baseRevision) return false;
      if (this.state && this.diskKey(state) !== this.diskKey(this.state))
        void this.refresh(true);
      return true;
    };
    if (stale()) return;
    this.observeOverwrite(state.review);
    if (this.publicationTimer) clearTimeout(this.publicationTimer);
    this.publicationTimer = null;
    if (state.publishing) {
      this.state = state;
      const recoverable = state.publishing.recoverable === true;
      if (!recoverable) {
        const wait = Math.max(
          250,
          Math.min(30_000, state.publishing.retryAfter ?? 30_000),
        );
        this.schedulePublicationRefresh(state.review.id, wait);
      }
      this.wait(
        "waiting",
        recoverable
          ? "Publication did not finish. Recover the saved draft without rewriting the file."
          : "A save is finishing. Your edits remain available.",
        state,
      );
      return;
    }
    const own = this.operation;
    if (
      own &&
      state.review.lastOperation?.id === own.operation.operationId &&
      own.kind !== "copy"
    ) {
      if (await this.applyAcknowledgment(state, own)) {
        this.operation = null;
        this.persist();
        this.schedule(0);
      }
      return;
    }
    if (own) {
      this.pendingIncoming = state;
      return;
    }
    if (
      this.copyOperation &&
      this.activeOperations.has(this.copyOperation.operation.operationId)
    ) {
      this.pendingIncoming = state;
      return;
    }
    await this.serialize(async () => {
      if (state.review.id !== this.snapshot.session.id) return;
      if (stale()) return;
      const previousState = this.state;
      this.state = state;
      if (
        this.snapshot.conflict?.kind === "waiting" &&
        this.snapshot.conflict.state?.publishing
      )
        this.emit({ conflict: null, writePaused: false, recoveryError: "" });
      const disk = state.disk;
      if (disk && disk.availability !== "available") {
        this.emit({ session: state.review });
        this.wait(
          "file",
          disk.message ??
            `The file is ${disk.availability}. Your edits remain here.`,
          state,
        );
        return;
      }
      const incoming = this.incomingFor(state);
      const diskChanged = Boolean(
        disk?.text !== null &&
          disk?.text !== undefined &&
          (state.review.savedText !== disk.text ||
            state.review.liveSourceChanged ||
            state.review.targetChanged),
      );
      if (!incoming) {
        if (!this.adapter) {
          this.pendingIncoming = state;
          return;
        }
        this.wait(
          "waiting",
          `${this.incomingUpdateCause(state)} It could not be mapped safely. Your feedback is preserved.`,
          state,
        );
        return;
      }
      if (
        !this.diskProjections.has(this.diskKey(state)) &&
        state.disk?.text === this.seed.markdown
      )
        this.rememberDiskProjection(
          state,
          this.current.markdown === this.seed.markdown
            ? this.current.cleanMarkdown
            : this.seed.cleanMarkdown,
        );
      if (sameReviewDraft(incoming, this.base)) {
        this.base = state.draft as RevisionDraft;
        this.baseRevision = state.revision;
        this.emit({ session: state.review, recoveryError: "" });
        if (
          diskChanged ||
          !sameReviewDraft(this.current, this.base) ||
          this.needsFileWrite(state)
        )
          this.schedule(0);
        return;
      }
      if (!this.adapter?.rebasesBufferedDocument) this.adapter?.flush?.();
      const localBase = this.current;
      const merged = await this.merge(this.base, localBase, incoming, {
        server: false,
      });
      if (merged.status !== "merged") {
        this.wait(
          merged.status === "conflict" ? "conflict" : "waiting",
          `${this.incomingUpdateCause(state)} ${merged.status === "conflict" ? "Some of your unsaved changes overlap." : (merged.reason ?? "Your edits remain here while the update is mapped.")}`,
          state,
          merged,
        );
        return;
      }
      if (
        !(await this.applyDraft(
          merged.draft as RevisionDraft,
          merged,
          state,
          localBase,
        ))
      ) {
        this.state = previousState ?? state;
        return;
      }
      this.base = state.draft as RevisionDraft;
      this.baseRevision = state.revision;
      this.emit({
        session: state.review,
        conflict: null,
        writePaused: false,
        reviewChanged: false,
        recoveryError: "",
        recoveryPending:
          diskChanged || !sameReviewDraft(this.current, this.base),
      });
      this.persist();
      if (
        diskChanged ||
        !sameReviewDraft(this.current, this.base) ||
        this.needsFileWrite(state)
      )
        this.schedule(0);
    });
  }
  private observeOverwrite(review: ComparisonReviewData) {
    const notice = review.lastOverwrite;
    if (!notice || notice.operationId === this.observedOverwriteId) return;
    this.observedOverwriteId = notice.operationId;
    if (notice.pageInstanceId === this.pageId) return;
    this.emit({
      notice:
        "Another tab has overwritten overlapping saved changes. The previous version is preserved in Recovery copies.",
    });
  }
  private checkpointContentSignature() {
    return (
      reviewDraftSignature(this.current) +
      JSON.stringify(this.adapter?.readUiDrafts() ?? {})
    );
  }
  private scheduleCheckpoint() {
    if (this.checkpointTimer || this.stopped) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      void this.checkpoint();
    }, 300);
  }
  private async checkpoint(latest = false): Promise<void> {
    if (!this.snapshot.conflict) return;
    if (this.checkpointPromise) {
      await this.checkpointPromise;
      if (!this.snapshot.conflict) return;
      if (latest) return this.checkpoint(true);
      if (
        this.checkpointSignature !== this.checkpointContentSignature() ||
        this.checkpointGeneration !== this.generation
      )
        this.scheduleCheckpoint();
      return;
    }
    const signature = this.checkpointContentSignature();
    const generation = this.generation;
    if (
      signature === this.checkpointSignature &&
      generation === this.checkpointGeneration
    ) {
      this.emit({
        conflict: {
          ...this.snapshot.conflict,
          checkpointId: this.checkpointEntryId,
          checkpointSaved: true,
        },
      });
      return;
    }
    const workingDraft = this.current;
    const uiDrafts = this.adapter?.readUiDrafts() ?? {};
    this.checkpointRecoveryId ??= randomId();
    const recoveryId = this.checkpointRecoveryId;
    this.emit({
      conflict: { ...this.snapshot.conflict, checkpointSaved: false },
    });
    let succeeded = false;
    this.checkpointPromise = (async () => {
      try {
        const result = await this.api<{
          checkpointId: string;
          storagePressure?: boolean;
        }>(`/${encodeURIComponent(this.snapshot.session.id)}/checkpoint`, {
          operationId: randomId(),
          pageInstanceId: this.pageId,
          conflictId: this.snapshot.conflict?.signature,
          recoveryId,
          generation,
          workingDraft,
          uiDrafts,
          baseVersions: {
            revision: this.state?.revision,
            disk: this.state?.disk,
          },
        });
        if (result && this.checkpointRecoveryId === recoveryId) {
          succeeded = true;
          this.checkpointSignature = signature;
          this.checkpointGeneration = generation;
          this.checkpointEntryId = result.checkpointId;
          if (this.snapshot.conflict)
            this.emit({
              recoveryError: this.snapshot.recoveryError.startsWith(
                "Recovery has not synced.",
              )
                ? ""
                : this.snapshot.recoveryError,
              conflict: {
                ...this.snapshot.conflict,
                checkpointId: result.checkpointId,
                storagePressure: Boolean(result.storagePressure),
                checkpointSaved:
                  signature === this.checkpointContentSignature() &&
                  generation === this.generation,
              },
            });
        }
      } catch (error) {
        this.emit({
          recoveryError: `Recovery has not synced. Your changes remain in this tab. ${errorMessage(error)}`,
        });
      } finally {
        this.checkpointPromise = null;
      }
    })();
    await this.checkpointPromise;
    if (
      succeeded &&
      this.snapshot.conflict &&
      (signature !== this.checkpointContentSignature() ||
        generation !== this.generation)
    ) {
      if (latest) return this.checkpoint(true);
      this.scheduleCheckpoint();
    }
  }
  flush = async (includeEditor = true) => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (includeEditor) this.adapter?.flush?.();
    if (includeEditor) this.persist(false, true);
    // Initial and recovered drafts must observe/rebase the authoritative state
    // before entering the write queue. A raw read inside that queue bypasses
    // conflict detection and can publish recovered text over an outside edit.
    if (!this.state) await this.refresh(true);
    return this.serialize(async () => {
      measureRevision("savequeue-start", () => {});
      if (!includeEditor && performance.now() < this.retryNotBefore) {
        this.schedule(0);
        return false;
      }
      if (!this.adapter) return false;
      if (!this.projectionReady) {
        const normalized = this.adapter.apply(
          { ...this.current, cleanMarkdown: undefined },
          { forceCleanProjection: true },
        );
        if (!normalized) {
          this.schedule(100);
          return false;
        }
        this.current = normalized;
        this.projectionReady = true;
        this.emit({ draft: normalized });
      }
      if (this.operation && !(await this.resolvePending())) return false;
      if (this.snapshot.writePaused || this.snapshot.copyLocked) {
        await this.checkpoint();
        return false;
      }
      if (!this.state) return false;
      if (
        sameReviewDraft(this.current, this.base) &&
        !this.needsFileWrite(this.state) &&
        !this.state.review.targetChanged &&
        !this.state.review.liveSourceChanged
      ) {
        this.emit({ recoveryPending: false });
        return true;
      }
      return this.commit("sync");
    });
  };
  private async commit(
    reason: ReconcileRequest["reason"],
    resolution?: ReconcileRequest["resolution"],
    comment?: string,
  ) {
    let includeBase = false;
    attempts: for (let attempt = 0; attempt < 3; attempt++) {
      const state = this.state;
      if (!state) return false;
      const snapshot = this.current;
      const identity = this.operationIdentity();
      const adoptedDisk = Boolean(
        state.disk &&
          (state.disk.text !== state.review.savedText ||
            state.review.targetChanged ||
            state.review.liveSourceChanged),
      );
      const requestReason =
        (reason === "sync" || reason === "send") && adoptedDisk
          ? "adopt"
          : reason;
      const pending: PendingOperation = {
        operation: identity,
        reviewId: state.review.id,
        draft: snapshot,
        base: this.base,
        generation: this.generation,
        kind: "reconcile",
      };
      this.operation = pending;
      this.persist();
      const body: ReconcileRequest = {
        ...identity,
        expectedRevision: state.revision,
        baseRevision: this.baseRevision,
        baseSignature: reviewDraftSignature(this.base),
        ...(state.baseReferences && !includeBase ? {} : { base: this.base }),
        draft: snapshot,
        expectedDisk: state.disk
          ? {
              path: state.disk.path,
              version: state.disk.version,
              hash: state.disk.hash,
            }
          : null,
        writeFile:
          reason !== "send" &&
          (!adoptedDisk || reason === "resolve" || reason === "recreate") &&
          (reason === "recreate" || this.needsFileWrite(state, snapshot)),
        localGeneration: this.generation,
        reason: requestReason,
        resolution,
        comment,
      };
      try {
        let result = await this.postOperation(
          `/${encodeURIComponent(state.review.id)}/${reason === "send" ? "send" : "reconcile"}`,
          body,
        );
        if (!result) throw new Error("The server returned no save result.");
        if (result.status === "committed" && result.state) {
          if (!(await this.applyAcknowledgment(result.state, pending)))
            return false;
          this.operation = null;
          this.persist();
          this.resumeIncoming();
          this.emit({
            recoveryPending: !sameReviewDraft(this.current, this.base),
          });
          if (
            !sameReviewDraft(this.current, this.base) ||
            (reason !== "send" && this.needsFileWrite(result.state))
          )
            this.schedule(reason === "send" ? 300 : 0);
          return true;
        }
        if (
          result.status === "publishing" ||
          result.status === "indeterminate"
        ) {
          if (result.state) this.state = result.state;
          this.wait(
            result.status === "indeterminate" ? "indeterminate" : "waiting",
            result.message ??
              "The previous save is still finishing. Your work remains here.",
            result.state ?? state,
          );
          return false;
        }
        this.acknowledge(identity.operationId);
        this.operation = null;
        this.persist();
        if (result.state) this.state = result.state;
        if (
          reason === "recreate" &&
          (result.status === "incoming-changed" ||
            result.status === "binding-changed")
        ) {
          this.wait(
            "file",
            result.message ??
              "The file changed before it could be recreated. Inspect the latest version before trying again.",
            result.state ?? state,
          );
          return false;
        }
        if (result.status === "conflict") {
          this.wait(
            "conflict",
            result.message ?? "Some unsaved changes overlap a newer version.",
            result.state ?? state,
            result.merge,
          );
          return false;
        }
        let reservationRenewals = 0;
        while (
          [
            "client-merge-required",
            "base-unavailable",
            "incoming-changed",
            "binding-changed",
            "operation-expired",
            "not-received",
            "rejected",
          ].includes(result.status) &&
          result.state
        ) {
          if (result.status === "base-unavailable") includeBase = true;
          const incoming = this.incomingFor(result.state);
          const disk = result.state.disk;
          if (!incoming) {
            this.wait(
              "waiting",
              "The outside file update is waiting for safe mapping.",
              result.state,
            );
            return false;
          }
          if (!this.adapter?.rebasesBufferedDocument) this.adapter?.flush?.();
          const localBase = this.current;
          const mergeGeneration = this.generation;
          const check = await this.merge(this.base, localBase, incoming, {
            server: false,
          });
          if (
            resolution &&
            check.status === "conflict" &&
            check.signature !== resolution.signature
          ) {
            this.wait(
              "conflict",
              "The overlapping changes changed. Please inspect them again.",
              result.state,
              check,
            );
            return false;
          }
          const merged = resolution
            ? await this.merge(this.base, localBase, incoming, {
                server: false,
                resolution: resolution.choice,
              })
            : check;
          if (merged.status !== "merged") {
            this.wait(
              merged.status === "conflict" ? "conflict" : "waiting",
              merged.reason ?? "The latest update needs review.",
              result.state,
              merged,
            );
            return false;
          }
          const projected =
            result.reservation && !Object.keys(merged.idRemap ?? {}).length
              ? this.adapter?.prepare?.(merged.draft as RevisionDraft)
              : null;
          const prepared =
            typeof projected?.cleanMarkdown === "string"
              ? ({
                  ...merged.draft,
                  cleanMarkdown: projected.cleanMarkdown,
                } as RevisionDraft)
              : null;
          if (!prepared) {
            if (
              !(await this.applyDraft(
                merged.draft as RevisionDraft,
                merged,
                result.state,
                localBase,
              ))
            )
              return false;
            this.base = result.state.draft as RevisionDraft;
            this.baseRevision = result.state.revision;
          }
          if (result.reservation) {
            const candidate = prepared ?? this.current;
            const incomingBase = result.state.draft as RevisionDraft;
            const reservedIdentity = this.operationIdentity();
            const reserved: ReconcileRequest = {
              ...body,
              ...reservedIdentity,
              expectedRevision: result.reservation.revision,
              baseRevision: result.state.revision,
              baseSignature: reviewDraftSignature(incomingBase),
              ...(result.state.baseReferences
                ? { base: undefined }
                : { base: incomingBase }),
              draft: candidate,
              reservationToken: result.reservation.token,
              expectedDisk: result.state.disk
                ? {
                    path: result.state.disk.path,
                    version: result.state.disk.version,
                    hash: result.state.disk.hash,
                  }
                : null,
              localGeneration: prepared ? mergeGeneration : this.generation,
              writeFile:
                reason !== "send" &&
                (reason === "resolve" ||
                  reason === "recreate" ||
                  !disk ||
                  disk.text === result.state.review.savedText) &&
                (reason === "recreate" ||
                  this.needsFileWrite(result.state, candidate)),
              reason:
                reason !== "resolve" &&
                reason !== "recreate" &&
                disk &&
                disk.text !== result.state.review.savedText
                  ? "adopt"
                  : reason,
            };
            const submitted: PendingOperation = {
              operation: reservedIdentity,
              reviewId: state.review.id,
              draft: candidate,
              base: this.base,
              generation: prepared ? mergeGeneration : this.generation,
              kind: "reconcile",
              ...(prepared ? { editorBase: localBase } : {}),
            };
            this.operation = submitted;
            this.persist();
            const committed = await this.postOperation(
              `/${encodeURIComponent(state.review.id)}/${reason === "send" ? "send" : "reconcile"}`,
              reserved,
            );
            if (committed?.status === "committed" && committed.state) {
              if (await this.applyAcknowledgment(committed.state, submitted)) {
                this.operation = null;
                this.persist();
                this.resumeIncoming();
                if (
                  !sameReviewDraft(this.current, this.base) ||
                  (reason !== "send" && this.needsFileWrite(committed.state))
                )
                  this.schedule(reason === "send" ? 300 : 0);
                return true;
              }
              return false;
            }
            if (committed?.state) this.state = committed.state;
            if (
              committed?.status === "publishing" ||
              committed?.status === "indeterminate"
            ) {
              this.wait(
                committed.status === "publishing" ? "waiting" : "indeterminate",
                committed.message ?? "The save result is still pending.",
                committed.state ?? result.state,
              );
              return false;
            }
            if (!committed) {
              this.wait(
                "indeterminate",
                "The save result is unavailable. Check its status before retrying.",
                result.state,
              );
              return false;
            }
            this.acknowledge(reservedIdentity.operationId);
            this.operation = null;
            if (
              committed.status === "client-merge-required" &&
              committed.state &&
              committed.reservation
            ) {
              // A late reserved save can receive a fresh turn. An ordinary
              // retry would omit its token and wait against our own lease.
              if (reservationRenewals++ < 2) {
                result = committed;
                continue;
              }
              this.deferAutosave(committed.reservation.expiresAt - Date.now());
              return false;
            }
            if (
              reason === "recreate" &&
              (committed.status === "incoming-changed" ||
                committed.status === "binding-changed")
            ) {
              this.wait(
                "file",
                committed.message ??
                  "The file changed before it could be recreated. Inspect the latest version before trying again.",
                committed.state ?? result.state,
              );
              return false;
            }
            if (committed.status === "conflict") {
              this.wait(
                "conflict",
                committed.message ?? "The overlapping changes changed.",
                committed.state ?? result.state,
                committed.merge,
              );
              return false;
            }
            if (committed.status === "retry-later") {
              if (
                reason === "send" ||
                reason === "resolve" ||
                reason === "recreate"
              )
                await new Promise((resolve) =>
                  setTimeout(
                    resolve,
                    Math.max(20, Math.min(750, committed.retryAfter ?? 100)),
                  ),
                );
              else {
                this.deferAutosave(committed.retryAfter ?? 100);
                return false;
              }
            }
          }
          continue attempts;
        }
        if (result.status === "retry-later") {
          if (
            reason === "send" ||
            reason === "resolve" ||
            reason === "recreate"
          ) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.max(20, Math.min(750, result.retryAfter ?? 100)),
              ),
            );
            continue;
          }
          this.emit({
            recoveryPending: true,
            notice: "Waiting briefly for another save.",
          });
          this.deferAutosave(result.retryAfter ?? 100);
          return false;
        }
        this.wait(
          "waiting",
          result.message ??
            "The save could not finish. Your changes are preserved.",
          result.state ?? state,
        );
        return false;
      } catch (error) {
        this.persist();
        this.emit({
          recoveryError: `Saving is temporarily unavailable. Your changes remain in this tab. ${errorMessage(error)}`,
          recoveryPending: true,
        });
        return false; // Keep the exact in-flight identity until resolve proves its result.
      }
    }
    this.wait(
      "waiting",
      "Saving is taking longer than expected. Retry when the other update finishes.",
      this.state,
    );
    return false;
  }
  resolveConflict = async (
    choice: "local" | "incoming",
    inspectedSignature: string,
  ) =>
    this.serialize(async () => {
      this.adapter?.flush?.();
      const conflict = this.snapshot.conflict;
      if (!conflict || conflict.kind !== "conflict") return false;
      if (conflict.signature !== inspectedSignature)
        throw new Error(
          "The overlapping changes changed. Inspect the refreshed comparison before confirming.",
        );
      await this.checkpoint(true);
      if (!this.snapshot.conflict?.checkpointSaved)
        throw new Error(
          "Recovery must finish before replacing overlapping changes.",
        );
      const fresh = await this.api<SyncState<ComparisonReviewData>>(
        `/${encodeURIComponent(this.snapshot.session.id)}/state`,
      );
      if (!fresh) return false;
      const incoming = this.incomingFor(fresh);
      if (!incoming) {
        this.wait(
          "waiting",
          "The outside file update is waiting for safe mapping.",
          fresh,
        );
        return false;
      }
      const check = await this.merge(this.base, this.current, incoming, {
        server: false,
      });
      if (
        check.status === "conflict" &&
        check.signature !== inspectedSignature
      ) {
        this.state = fresh;
        this.wait(
          "conflict",
          "The overlapping changes changed. Please inspect them again.",
          fresh,
          check,
        );
        return false;
      }
      const incomingCheckpoint = await this.api<{ checkpointId: string }>(
        `/${encodeURIComponent(this.snapshot.session.id)}/checkpoint`,
        {
          operationId: randomId(),
          pageInstanceId: this.pageId,
          conflictId: `${inspectedSignature}:incoming`,
          recoveryId: `${this.checkpointRecoveryId ?? randomId()}:incoming`,
          generation: fresh.revision,
          workingDraft: incoming,
          reason: "Incoming version before conflict resolution",
        },
      );
      if (!incomingCheckpoint)
        throw new Error(
          "The incoming recovery copy must be saved before replacing overlapping changes.",
        );
      const merged = await this.merge(this.base, this.current, incoming, {
        server: false,
        resolution: choice,
      });
      if (merged.status !== "merged") return false;
      this.state = fresh;
      if (
        !(await this.applyDraft(merged.draft as RevisionDraft, merged, fresh))
      )
        return false;
      this.emit({ writePaused: false });
      const result = await this.commit("resolve", {
        signature: inspectedSignature,
        choice,
        checkpointIds: [
          this.checkpointEntryId,
          incomingCheckpoint.checkpointId,
        ].filter((id): id is string => Boolean(id)),
        checkpointGenerations: {
          ...(this.checkpointEntryId
            ? { [this.checkpointEntryId]: this.checkpointGeneration }
            : {}),
          [incomingCheckpoint.checkpointId]: fresh.revision,
        },
      });
      if (!result) this.emit({ writePaused: true });
      return result;
    });
  reloadFromFile = async () =>
    this.serialize(async () => {
      this.adapter?.flush?.();
      if (
        !this.snapshot.conflict?.reloadAvailable ||
        !sameReviewDraft(this.current, this.base)
      )
        throw new Error(
          "New local edits need review before reloading the file.",
        );
      await this.checkpoint(true);
      if (!this.snapshot.conflict?.checkpointSaved)
        throw new Error("Recovery must finish before reloading the file.");
      const fresh = await this.api<SyncState<ComparisonReviewData>>(
        `/${encodeURIComponent(this.snapshot.session.id)}/state`,
      );
      if (!fresh || fresh.disk?.availability !== "available")
        throw new Error(
          "The latest file is unavailable. Your review remains here.",
        );
      const incoming = this.incomingFor(fresh, true);
      if (!incoming || !(await this.applyDraft(incoming, undefined, fresh)))
        return false;
      this.state = fresh;
      this.base = fresh.draft as RevisionDraft;
      this.baseRevision = fresh.revision;
      this.emit({
        writePaused: false,
        conflict: null,
        notice:
          "Reloaded the file. Displaced feedback is preserved below and in Recovery copies.",
      });
      return this.commit("adopt");
    });
  recreateFile = (expectedPath: string) =>
    this.serialize(async () => {
      this.adapter?.flush?.();
      if (this.operation && !(await this.resolvePending())) return false;
      const fresh = await this.api<SyncState<ComparisonReviewData>>(
        `/${encodeURIComponent(this.snapshot.session.id)}/state`,
      );
      if (!fresh)
        throw new Error(
          "The latest file state is unavailable. Your work remains here.",
        );
      if (
        !fresh.canRecreateFile ||
        fresh.review.destinationPath !== expectedPath ||
        fresh.review.autosave === "none" ||
        fresh.disk?.path !== expectedPath ||
        fresh.disk.availability !== "missing" ||
        fresh.disk.version !== null
      ) {
        this.state = fresh;
        this.wait(
          "file",
          "This file can no longer be recreated at the confirmed path. Inspect its current state or save separately.",
          fresh,
        );
        return false;
      }
      await this.checkpoint(true);
      if (!this.snapshot.conflict?.checkpointSaved)
        throw new Error(
          "Recovery must finish before recreating the file. Your document and unfinished feedback remain here.",
        );
      this.state = fresh;
      const result = await this.commit("recreate");
      if (!result) this.emit({ writePaused: true });
      return result;
    });
  recoverPublication = async () => {
    const result = await this.serialize(async () => {
      this.adapter?.flush?.();
      const result = await this.api<SyncResult<ComparisonReviewData>>(
        `/${encodeURIComponent(this.snapshot.session.id)}/recover`,
        {},
      );
      if (!result?.state)
        throw new Error(
          "The recovery result is unavailable. Your work remains here.",
        );
      const pending = this.operation;
      if (
        pending &&
        result.operationId === pending.operation.operationId &&
        (result.status === "committed" || result.status === "rejected")
      ) {
        if (
          result.status === "committed" &&
          !(await this.applyAcknowledgment(result.state, pending))
        )
          return result;
        this.operation = null;
        this.acknowledge(pending.operation.operationId);
        this.persist();
      }
      return result;
    });
    const recoveredState = result.state;
    if (!recoveredState)
      throw new Error(
        "The recovery result is unavailable. Your work remains here.",
      );
    await this.observe(recoveredState);
    if (!recoveredState.publishing)
      this.emit({
        notice:
          result.message ??
          "Recovered the unfinished save without rewriting the file.",
      });
    return !recoveredState.publishing;
  };
  retry = async () => {
    this.emit({ recoveryError: "" });
    if (this.operation && !(await this.resolvePending())) return false;
    this.emit({ writePaused: false, conflict: null });
    await this.refresh(true);
    return this.flush();
  };
  inspect = (filename?: string) =>
    this.api<InspectedDestination>(
      `/${encodeURIComponent(this.snapshot.session.id)}/destination${filename ? `?${new URLSearchParams({ path: filename })}` : ""}`,
    ) as Promise<InspectedDestination>;
  inspectCopy = (path?: string) => {
    if (path !== undefined && !this.copyOperation) {
      this.copyPath = path;
      this.persist();
    }
    return this.api<CopyDestination>(
      `/${encodeURIComponent(this.snapshot.session.id)}/copy-destination`,
      { path: path ?? this.copyPath, workingDraft: this.current },
    ) as Promise<CopyDestination>;
  };
  acknowledgeCopyResult = (result: SyncResult<ComparisonReviewData>) => {
    if (
      this.deferredCopy === result ||
      (result.operationId &&
        this.deferredCopy?.operationId === result.operationId)
    )
      this.deferredCopy = null;
    this.persist();
  };
  checkCopyStatus = async () => {
    if (this.deferredCopy) return this.deferredCopy;
    if (this.copyOperation) {
      const operation = this.copyOperation;
      if (this.activeOperations.has(operation.operation.operationId))
        return null;
      const version = this.copyRequestVersion;
      const result = await this.api<SyncResult<ComparisonReviewData>>(
        `/operations/${encodeURIComponent(operation.operation.operationId)}/resolve`,
        { ...operation.operation, reviewId: operation.reviewId },
      );
      if (version !== this.copyRequestVersion) return null;
      if (result?.status === "committed") {
        this.deferredCopy = result;
        this.copyOperation = null;
        this.acknowledge(operation.operation.operationId);
        this.persist();
        return result;
      }
      if (result && ["not-received", "rejected"].includes(result.status)) {
        this.copyOperation = null;
        this.acknowledge(operation.operation.operationId);
        this.persist();
        return result;
      }
      return result;
    }
    return this.deferredCopy;
  };
  setCopyLocked = (locked: boolean) => this.emit({ copyLocked: locked });
  copy = async (path: string, relativeLinksAcknowledged: boolean) => {
    this.adapter?.flush?.();
    if (!this.state) await this.refresh(true);
    if (!this.state)
      throw new Error("The server is unavailable. Your changes remain here.");
    const generation = this.generation;
    const snapshot = this.current;
    const uiDrafts = this.adapter?.readUiDrafts() ?? {};
    return this.serialize(() =>
      this.copyCaptured(
        path,
        relativeLinksAcknowledged,
        generation,
        snapshot,
        uiDrafts,
      ),
    );
  };
  private async copyCaptured(
    path: string,
    relativeLinksAcknowledged: boolean,
    generation: number,
    snapshot: RevisionDraft,
    uiDrafts: Record<string, unknown>,
  ) {
    if (this.copyOperation) {
      await this.checkCopyStatus();
      if (this.copyOperation)
        throw new Error(
          "Check the previous copy before creating another copy.",
        );
    }
    this.copyRequestVersion++;
    this.deferredCopy = null;
    this.copyPath = path;
    const identity = this.operationIdentity();
    const body: CopyRequest = {
      ...identity,
      generation,
      workingDraft: snapshot,
      uiDrafts,
      path,
      relativeLinksAcknowledged,
      conflictCheckpointId: this.checkpointEntryId,
    };
    this.copyOperation = {
      operation: identity,
      reviewId: this.snapshot.session.id,
      draft: snapshot,
      base: this.base,
      generation,
      kind: "copy",
      copyPath: path,
    };
    this.emit({ copyLocked: true });
    this.persist();
    try {
      const result = await this.postOperation(
        `/${encodeURIComponent(this.snapshot.session.id)}/copy`,
        body,
      );
      if (!result) throw new Error("The copy result is unavailable.");
      if (result.status === "committed" && result.state) {
        this.acknowledge(identity.operationId);
        this.copyOperation = null;
        if (this.snapshot.copyLocked && generation === this.generation)
          this.switchToCopy(result, snapshot);
        else {
          this.deferredCopy = result;
          this.emit({
            notice:
              "A separate copy was saved. Newer edits remain in this review.",
          });
        }
      } else if (!["publishing", "indeterminate"].includes(result.status)) {
        this.acknowledge(identity.operationId);
        this.copyOperation = null;
      }
      return result;
    } finally {
      this.emit({ copyLocked: false });
      this.persist();
      this.resumeIncoming();
    }
  }
  private switchToCopy(
    result: SyncResult<ComparisonReviewData>,
    captured: RevisionDraft,
  ) {
    const state = result.state;
    if (!state) return;
    const oldKey = this.key();
    // An uncertain ordinary publication still belongs to the original review.
    // Preserve its recovery there before switching to the independently saved copy.
    const keepOriginalRecovery = Boolean(this.operation);
    if (keepOriginalRecovery) this.persist(false, true);
    this.flushSharedRecovery();
    this.operation = null;
    this.pendingIncoming = null;
    this.copyRequestVersion++;
    this.deferredCopy = null;
    this.state = state;
    this.current = state.draft as RevisionDraft;
    this.base = this.current;
    this.baseRevision = state.revision;
    this.checkpointEntryId = undefined;
    this.checkpointSignature = "";
    this.checkpointGeneration = -1;
    this.copyPath = undefined;
    this.emit({
      session: state.review,
      draft: this.current,
      writePaused: false,
      conflict: null,
      reviewChanged: false,
      recoveryPending: false,
      recoveryError: "",
      notice: "Saved separately.",
    });
    try {
      if (!keepOriginalRecovery) {
        this.tabStorage?.removeItem(oldKey);
        if (this.storage?.getItem(oldKey) === this.lastRecord)
          this.storage?.removeItem(oldKey);
      }
      this.tabStorage?.setItem(
        `roughdraft-page:${state.review.id}`,
        this.pageId,
      );
    } catch {
      /* Copy exists durably even with storage disabled. */
    }
    if (typeof window !== "undefined") {
      const url = result.reviewUrl
        ? browserNavigationUrl(result.reviewUrl)
        : new URL(
            `?${new URLSearchParams({ comparison: state.review.id })}`,
            window.location.href,
          ).href;
      window.history.replaceState(null, "", url);
    }
    if (this.started) {
      this.unsubscribe?.();
      this.unsubscribe = subscribeReviewChanges(state.review.id, (notice) => {
        if (notice.state) void this.observe(notice.state);
        else if (notice.reason !== "heartbeat") void this.refresh();
      });
    }
    void captured;
  }
  run = async (
    action: "sync" | "base" | "save" | "send" | "recover",
    snapshot: RevisionDraft,
    fields?: object,
  ) => {
    if (!sameReviewDraft(snapshot, this.current)) {
      this.current = snapshot;
      this.emit({ draft: snapshot });
    }
    if (action === "sync") {
      await this.flush();
      return this.snapshot.session;
    }
    if (action === "send") {
      this.adapter?.flush?.();
      if (!this.state) await this.refresh(true);
      if (this.snapshot.writePaused)
        throw new Error("Resolve the waiting update before sending feedback.");
      const sent = await this.serialize(async () => {
        if (this.operation && !(await this.resolvePending())) return false;
        return this.commit(
          "send",
          undefined,
          (fields as { comment?: string })?.comment,
        );
      });
      if (!sent)
        throw new Error(
          "Feedback has not been sent yet. Resolve the waiting update or retry; your review is preserved.",
        );
      return this.snapshot.session;
    }
    if (action === "recover")
      throw new Error(
        "Choose Save separately to create a file and preserve the complete review.",
      );
    // Retain explicitly guarded integration routes for base selection/destination changes.
    const next = await this.api<ComparisonReviewData>(
      `/${encodeURIComponent(this.snapshot.session.id)}/${action}`,
      { revision: this.snapshot.session.revision, ...snapshot, ...fields },
    );
    if (!next) throw new Error("The server returned no review.");
    this.emit({ session: next });
    await this.refresh(true);
    return next;
  };
}

export function useRevisionSession(
  initial: ComparisonReviewData,
  seed: RevisionDraft,
) {
  const [controller] = useState(
    () => new RevisionSessionController(initial, seed),
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const registerAdapter = useCallback(
    (adapter: RevisionRemoteAdapter | null) => controller.setAdapter(adapter),
    [controller],
  );
  return {
    ...snapshot,
    updateDraft: controller.updateDraft,
    readDraft: controller.readDraft,
    run: controller.run,
    inspect: controller.inspect,
    flush: controller.flush,
    registerAdapter,
    resolveConflict: controller.resolveConflict,
    reloadFromFile: controller.reloadFromFile,
    retrySync: controller.retry,
    recoverPublication: controller.recoverPublication,
    recreateFile: controller.recreateFile,
    inspectCopy: controller.inspectCopy,
    saveCopy: controller.copy,
    setCopyLocked: controller.setCopyLocked,
    acknowledgeCopyResult: controller.acknowledgeCopyResult,
    checkCopyStatus: controller.checkCopyStatus,
    generation: controller.getGeneration,
    restoreOrphan: controller.restoreOrphan,
    dismissOrphan: controller.dismissOrphan,
    inspectRecovery: controller.inspectRecovery,
    inspectOrphan: controller.inspectOrphan,
    restoreRecoveryUi: controller.restoreRecoveryUi,
  };
}
