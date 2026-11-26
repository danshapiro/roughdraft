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
import type { RecoverySnapshot } from "./RevisionRecoveryDialog";
import { subscribeReviewChanges } from "./revision-live-transport";
import { measureRevision } from "./revision-performance";
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
  reloadAvailable?: boolean;
}
interface PendingOperation {
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
interface BrowserRecovery {
  version: 2;
  pageInstanceId: string;
  aliveAt: number;
  revision: number;
  draft: RevisionDraft;
  base: RevisionDraft;
  operation?: PendingOperation | null;
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
function validRecovery(value: unknown): value is BrowserRecovery {
  const record = value as BrowserRecovery | null;
  return Boolean(
    record?.version === 2 &&
      typeof record.draft?.markdown === "string" &&
      record.draft.decisions &&
      Array.isArray(record.draft.reviewComments) &&
      record.base?.decisions,
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

/** One coalescing queue owns writes; notifications never replace newer local work. */
export class RevisionSessionController {
  private snapshot: SessionSnapshot;
  private listeners = new Set<() => void>();
  private current: RevisionDraft;
  private base: RevisionDraft;
  private state: SyncState<ComparisonReviewData> | null = null;
  private operation: PendingOperation | null = null;
  private adapter: RevisionRemoteAdapter | null = null;
  private applyingRemote = false;
  private projectionReady = false;
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
  private unsubscribe: (() => void) | null = null;
  private unsubscribeUi: (() => void) | null = null;
  private stopped = false;
  private started = false;
  private refreshPromise: Promise<void> | null = null;
  private lastRecord: string | null = null;
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
    this.api = dependencies.request ?? request;
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
      this.operation = recovered.operation ?? null;
      this.copyPath = recovered.copyPath ?? this.operation?.copyPath;
      this.deferredCopy = recovered.copyResult ?? null;
      this.recoveredUiDrafts = recovered.uiDrafts ?? null;
    }
    this.snapshot = {
      session: initial,
      draft: this.current,
      recoveryError: "",
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
      const raw = this.tabStorage?.getItem(key);
      const record: unknown = raw ? JSON.parse(raw) : null;
      if (!validRecovery(record)) return null;
      this.tabStorage?.removeItem(key); // Only this tab's private predecessor copy.
      return record;
    } catch {
      return null;
    }
  }
  private persist(force = false) {
    const key = this.key();
    const uiDrafts =
      this.adapter?.readUiDrafts() ?? this.recoveredUiDrafts ?? {};
    const useful =
      this.operation ||
      this.copyPath ||
      this.deferredCopy ||
      !sameReviewDraft(this.current, this.base) ||
      this.snapshot.conflict ||
      hasUiDrafts(uiDrafts);
    const record = useful
      ? JSON.stringify({
          version: 2,
          pageInstanceId: this.pageId,
          aliveAt: this.now(),
          revision: this.state?.revision ?? this.snapshot.session.revision,
          draft: this.current,
          base: this.base,
          operation: this.operation,
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
        } satisfies BrowserRecovery)
      : null;
    let stored = false;
    try {
      if (record) this.tabStorage?.setItem(key, record);
      else this.tabStorage?.removeItem(key);
      stored = Boolean(this.tabStorage);
    } catch {
      /* The durable server checkpoint remains available. */
    }
    try {
      if (record) {
        this.storage?.setItem(key, record);
        this.lastRecord = record;
        stored ||= Boolean(this.storage);
      } else if (this.storage?.getItem(key) === this.lastRecord) {
        this.storage?.removeItem(key);
        this.lastRecord = null;
      }
    } catch {
      /* Do not clear another page's work or pretend local recovery succeeded. */
    }
    if (force && !stored)
      this.emit({
        recoveryError:
          "Browser recovery could not be saved. Your changes remain in this tab; retry storage before renumbering this suggestion.",
      });
    return stored;
  }
  private findOrphans() {
    const orphans: SessionSnapshot["orphans"] = [];
    try {
      const prefix = `roughdraft-draft:${this.snapshot.session.id}:`;
      for (let index = 0; index < (this.storage?.length ?? 0); index++) {
        const key = this.storage?.key(index);
        if (!key?.startsWith(prefix) || key === this.key()) continue;
        const record: unknown = JSON.parse(
          this.storage?.getItem(key) ?? "null",
        );
        if (validRecovery(record) && this.now() - record.aliveAt > 10_000) {
          if (
            record.operation ||
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
  restoreOrphan = async (key: string) => {
    const record: unknown = JSON.parse(this.storage?.getItem(key) ?? "null");
    if (!validRecovery(record)) return;
    await this.checkpoint();
    this.current = record.draft;
    this.base = record.base;
    this.operation = record.operation ?? null;
    this.copyPath = record.copyPath ?? this.operation?.copyPath;
    this.deferredCopy = record.copyResult ?? null;
    this.adapter?.restoreUiDrafts(record.uiDrafts ?? {});
    this.emit({
      draft: this.current,
      recoveryPending: true,
      notice: "Recovered work may still be open in another tab.",
    });
    this.persist();
    await this.refresh(true);
  };
  inspectRecovery = (id: string) =>
    this.api<RecoverySnapshot>(
      `/${encodeURIComponent(this.snapshot.session.id)}/checkpoints/${encodeURIComponent(id)}`,
    ) as Promise<RecoverySnapshot>;
  inspectOrphan = (key: string): RecoverySnapshot => {
    const record: unknown = JSON.parse(this.storage?.getItem(key) ?? "null");
    if (!validRecovery(record))
      throw new Error("That browser recovery copy is no longer available.");
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
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    this.persist();
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
        { ...this.current, cleanMarkdown: undefined },
        { forceCleanProjection: true },
      );
      if (normalized) {
        this.projectionReady = true;
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
  private resumeIncoming() {
    const incoming = this.pendingIncoming;
    this.pendingIncoming = null;
    if (incoming) queueMicrotask(() => void this.observe(incoming));
  }
  private async resolvePending() {
    const pending = this.operation;
    if (!pending) return true;
    const result = await this.api<SyncResult<ComparisonReviewData>>(
      `/operations/${encodeURIComponent(pending.operation.operationId)}/resolve`,
      { ...pending.operation, reviewId: pending.reviewId },
    );
    if (!result) return false;
    if (result.status === "committed" && result.state) {
      if (pending.kind === "copy") {
        this.deferredCopy = result;
        this.operation = null;
        this.acknowledge(pending.operation.operationId);
        this.emit({
          copyLocked: false,
          notice:
            "The separate copy was saved. Open Save separately to see its path.",
        });
        this.resumeIncoming();
        return true;
      }
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
  private async observe(state: SyncState<ComparisonReviewData>) {
    if (state.review.id !== this.snapshot.session.id) return;
    const stale = () => {
      if (state.revision >= this.baseRevision) return false;
      if (this.state && this.diskKey(state) !== this.diskKey(this.state))
        void this.refresh(true);
      return true;
    };
    if (stale()) return;
    this.observeOverwrite(state.review);
    if (state.publishing) {
      this.state = state;
      this.wait(
        "waiting",
        "A save is finishing. Your edits remain available.",
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
    await this.serialize(async () => {
      if (stale()) return;
      const previousState = this.state;
      this.state = state;
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
          "The outside file update could not be mapped safely. Your feedback is preserved.",
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
      this.adapter?.flush?.();
      const localBase = this.current;
      const merged = await this.merge(this.base, localBase, incoming, {
        server: false,
      });
      if (merged.status !== "merged") {
        this.wait(
          merged.status === "conflict" ? "conflict" : "waiting",
          merged.reason ??
            "The file or saved review overlaps your unsaved changes.",
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
    this.emit({
      conflict: { ...this.snapshot.conflict, checkpointSaved: false },
    });
    let succeeded = false;
    this.checkpointPromise = (async () => {
      try {
        const result = await this.api<{ checkpointId: string }>(
          `/${encodeURIComponent(this.snapshot.session.id)}/checkpoint`,
          {
            operationId: randomId(),
            pageInstanceId: this.pageId,
            conflictId: this.snapshot.conflict?.signature,
            generation,
            workingDraft,
            uiDrafts,
            baseVersions: {
              revision: this.state?.revision,
              disk: this.state?.disk,
            },
          },
        );
        if (result) {
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
    for (let attempt = 0; attempt < 3; attempt++) {
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
        base: this.base,
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
          (!adoptedDisk || reason === "resolve") &&
          this.needsFileWrite(state, snapshot),
        localGeneration: this.generation,
        reason: requestReason,
        resolution,
        comment,
      };
      try {
        const result = await this.api<SyncResult<ComparisonReviewData>>(
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
        if (result.status === "conflict") {
          this.wait(
            "conflict",
            result.message ?? "Some unsaved changes overlap a newer version.",
            result.state ?? state,
            result.merge,
          );
          return false;
        }
        if (
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
              base: incomingBase,
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
                  !disk ||
                  disk.text === result.state.review.savedText) &&
                this.needsFileWrite(result.state, candidate),
              reason:
                reason !== "resolve" &&
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
            const committed = await this.api<SyncResult<ComparisonReviewData>>(
              `/${encodeURIComponent(state.review.id)}/${reason === "send" ? "send" : "reconcile"}`,
              reserved,
            );
            if (committed?.status === "committed" && committed.state) {
              if (await this.applyAcknowledgment(committed.state, submitted)) {
                this.operation = null;
                this.persist();
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
              if (reason === "send")
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
          continue;
        }
        if (result.status === "retry-later") {
          if (reason === "send") {
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
    if (path !== undefined && this.operation?.kind !== "copy") {
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
    if (this.operation?.kind === "copy") {
      const operation = this.operation;
      const version = this.copyRequestVersion;
      const result = await this.api<SyncResult<ComparisonReviewData>>(
        `/operations/${encodeURIComponent(operation.operation.operationId)}/resolve`,
        { ...operation.operation, reviewId: operation.reviewId },
      );
      if (version !== this.copyRequestVersion) return null;
      if (result?.status === "committed") {
        this.deferredCopy = result;
        this.operation = null;
        this.acknowledge(operation.operation.operationId);
        this.persist();
        return result;
      }
      if (result && ["not-received", "rejected"].includes(result.status)) {
        this.operation = null;
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
    if (this.operation && !(await this.resolvePending()))
      throw new Error("Check the previous save before creating another copy.");
    this.copyRequestVersion++;
    this.deferredCopy = null;
    this.copyPath = path;
    const identity = this.operationIdentity();
    const generation = this.generation;
    const snapshot = this.current;
    const body: CopyRequest = {
      ...identity,
      generation,
      workingDraft: snapshot,
      uiDrafts: this.adapter?.readUiDrafts() ?? {},
      path,
      relativeLinksAcknowledged,
      conflictCheckpointId: this.checkpointEntryId,
    };
    this.operation = {
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
      const result = await this.api<SyncResult<ComparisonReviewData>>(
        `/${encodeURIComponent(this.snapshot.session.id)}/copy`,
        body,
      );
      if (!result) throw new Error("The copy result is unavailable.");
      if (result.status === "committed" && result.state) {
        this.acknowledge(identity.operationId);
        this.operation = null;
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
        this.operation = null;
      }
      return result;
    } finally {
      this.emit({ copyLocked: false });
      this.persist();
    }
  };
  private switchToCopy(
    result: SyncResult<ComparisonReviewData>,
    captured: RevisionDraft,
  ) {
    const state = result.state;
    if (!state) return;
    const oldKey = this.key();
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
      this.tabStorage?.removeItem(oldKey);
      if (this.storage?.getItem(oldKey) === this.lastRecord)
        this.storage?.removeItem(oldKey);
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
    inspectCopy: controller.inspectCopy,
    saveCopy: controller.copy,
    setCopyLocked: controller.setCopyLocked,
    acknowledgeCopyResult: controller.acknowledgeCopyResult,
    checkCopyStatus: controller.checkCopyStatus,
    generation: controller.getGeneration,
    restoreOrphan: controller.restoreOrphan,
    inspectRecovery: controller.inspectRecovery,
    inspectOrphan: controller.inspectOrphan,
    restoreRecoveryUi: controller.restoreRecoveryUi,
  };
}
