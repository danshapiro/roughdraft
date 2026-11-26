import {
  mergeReviewDrafts,
  type ReviewMergeOptions,
  reviewDraftSignature,
  type SyncDraft,
  type SyncMerge,
} from "@roughdraft/rfm";

export interface MergeWorkerRequest {
  id: number;
  base: SyncDraft;
  local: SyncDraft;
  incoming: SyncDraft;
  options: ReviewMergeOptions;
}
export interface MergeWorkerReply {
  id: number;
  result: SyncMerge;
}
interface Pending {
  local: SyncDraft;
  resolve: (result: SyncMerge) => void;
  timeout: ReturnType<typeof setTimeout>;
}
let worker: Worker | null = null;
let sequence = 0;
let measuredSlow = false;
let retryAfter = 0;
let idle: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, Pending>();

function waiting(local: SyncDraft, reason: string): SyncMerge {
  return {
    status: "client-merge-required",
    draft: local,
    conflicts: [],
    signature: reviewDraftSignature(local),
    reason,
  };
}

export function disposeReviewMergeWorker(): void {
  retryAfter = 0;
  releaseWorker();
}

function releaseWorker(): void {
  if (idle) clearTimeout(idle);
  idle = null;
  worker?.terminate();
  worker = null;
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.resolve(
      waiting(
        entry.local,
        "The pending comparison was cancelled; your work is preserved.",
      ),
    );
  }
  pending.clear();
}

function settle(id: number, result: SyncMerge) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pending.delete(id);
  entry.resolve(result);
  if (!pending.size) idle = setTimeout(disposeReviewMergeWorker, 30_000);
}

function startWorker() {
  if (worker || performance.now() < retryAfter) return worker;
  try {
    if (typeof Worker === "undefined") return null;
    worker = new Worker(
      new URL("./revision-merge-worker.ts", import.meta.url),
      { type: "module", name: "roughdraft-review-merge-v1" },
    );
    worker.onmessage = (event: MessageEvent<MergeWorkerReply>) =>
      settle(event.data.id, event.data.result);
    worker.onerror = () => {
      console.warn(
        JSON.stringify({
          severity: "warn",
          event: "review-merge-worker-unavailable",
        }),
      );
      retryAfter = performance.now() + 1_000;
      releaseWorker();
    };
  } catch {
    retryAfter = performance.now() + 1_000;
  }
  return worker;
}

/** Only strings and review data cross this boundary; PM application stays local. */
export async function mergeReviewDraftsAsync(
  base: SyncDraft,
  local: SyncDraft,
  incoming: SyncDraft,
  options: ReviewMergeOptions = {},
): Promise<SyncMerge> {
  const large = [base, local, incoming].some(
    (draft) => draft.markdown.length > 50 * 1024,
  );
  if (!large && !measuredSlow) {
    const begin = performance.now();
    const result = mergeReviewDrafts(base, local, incoming, {
      ...options,
      server: false,
      budgetMs: options.budgetMs ?? 16,
    });
    measuredSlow =
      performance.now() - begin > 16 ||
      result.status === "client-merge-required";
    if (result.status !== "client-merge-required" || !measuredSlow)
      return result;
  }
  const active = startWorker();
  if (!active)
    return waiting(
      local,
      "This browser cannot run the background comparison. Your work is preserved while the outside update waits.",
    );
  if (idle) clearTimeout(idle);
  idle = null;
  // The session coalesces generations; the worker also bounds accidental callers.
  while (pending.size >= 4) {
    const oldest = pending.entries().next().value as [number, Pending];
    settle(
      oldest[0],
      waiting(
        oldest[1].local,
        "A newer comparison superseded this queued result.",
      ),
    );
  }
  const id = ++sequence;
  return new Promise<SyncMerge>((resolve) => {
    const timeout = setTimeout(() => {
      settle(
        id,
        waiting(
          local,
          "The comparison took too long. Your work is preserved; retry the outside update.",
        ),
      );
      // A stuck worker must not accumulate queued document snapshots.
      if (pending.size === 0) disposeReviewMergeWorker();
    }, 2_000);
    pending.set(id, { resolve, timeout, local });
    try {
      active.postMessage({
        id,
        base,
        local,
        incoming,
        options: {
          ...options,
          server: false,
          budgetMs: options.budgetMs ?? 500,
        },
      } satisfies MergeWorkerRequest);
    } catch {
      settle(
        id,
        waiting(
          local,
          "The background comparison could not start. Your work is preserved.",
        ),
      );
    }
  });
}
