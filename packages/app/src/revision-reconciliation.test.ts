import { mergeReviewDrafts, type SyncDraft } from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  MergeWorkerReply,
  MergeWorkerRequest,
} from "./revision-reconciliation";

const draft = (markdown: string): SyncDraft => ({
  markdown,
  cleanMarkdown: markdown,
  decisions: {},
  reviewComments: [],
});
let active: typeof import("./revision-reconciliation");

class ComparisonWorker {
  static instances: ComparisonWorker[] = [];
  onmessage: ((event: MessageEvent<MergeWorkerReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  messages: MergeWorkerRequest[] = [];
  terminated = false;
  constructor() {
    ComparisonWorker.instances.push(this);
  }
  postMessage(message: MergeWorkerRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  complete(index = 0) {
    const input = this.messages[index];
    const result = mergeReviewDrafts(
      input.base,
      input.local,
      input.incoming,
      input.options,
    );
    this.onmessage?.(
      new MessageEvent("message", { data: { id: input.id, result } }),
    );
  }
}

beforeEach(async () => {
  vi.resetModules();
  ComparisonWorker.instances = [];
  active = await import("./revision-reconciliation");
});
afterEach(() => {
  active.disposeReviewMergeWorker();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("merges a small incoming update while retaining independent local typing", async () => {
  vi.stubGlobal("Worker", ComparisonWorker);
  const pending = active.mergeReviewDraftsAsync(
    draft("First.\n\nSecond."),
    draft("Local.\n\nSecond."),
    draft("First.\n\nIncoming."),
  );
  // Cold parser startup can use the same background path as a busy browser.
  ComparisonWorker.instances[0]?.complete();
  const result = await pending;
  expect(result.status).toBe("merged");
  expect(result.draft.markdown).toBe("Local.\n\nIncoming.");
});

it("preserves a large draft when background comparison is unavailable", async () => {
  vi.stubGlobal("Worker", undefined);
  const local = draft("Local text.\n".repeat(6000));
  const result = await active.mergeReviewDraftsAsync(
    draft("Base."),
    local,
    draft("Incoming."),
  );
  expect(result.status).toBe("client-merge-required");
  expect(result.draft).toBe(local);
  expect(result.conflicts).toEqual([]);
});

it("prepares one idle worker for a large review before its first comparison", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ComparisonWorker);
  active.prepareReviewMergeWorker("Small document.");
  expect(ComparisonWorker.instances).toHaveLength(0);
  const base = draft("Unchanged paragraph.\n\n".repeat(3000));
  active.prepareReviewMergeWorker(base.markdown);
  active.prepareReviewMergeWorker(base.markdown);
  expect(ComparisonWorker.instances).toHaveLength(1);
  const worker = ComparisonWorker.instances[0];
  expect(worker.messages).toEqual([]);
  const compared = active.mergeReviewDraftsAsync(base, base, base);
  worker.complete();
  expect((await compared).status).toBe("merged");
  expect(ComparisonWorker.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(worker.terminated).toBe(true);
});

it("matches out-of-order background results to their own local generations", async () => {
  vi.stubGlobal("Worker", ComparisonWorker);
  const base = draft("Untouched.\n".repeat(6000));
  const a = draft(`${base.markdown}Local A.`);
  const b = draft(`${base.markdown}Local B.`);
  const first = active.mergeReviewDraftsAsync(base, a, base);
  const second = active.mergeReviewDraftsAsync(base, b, base);
  const worker = ComparisonWorker.instances[0];
  worker.complete(1);
  worker.complete(0);
  expect((await first).draft.markdown).toBe(a.markdown);
  expect((await second).draft.markdown).toBe(b.markdown);
});

it("closing the review settles queued comparisons and releases the worker", async () => {
  vi.stubGlobal("Worker", ComparisonWorker);
  const local = draft("Recoverable text.\n".repeat(4000));
  const result = active.mergeReviewDraftsAsync(
    draft("Base."),
    local,
    draft("Incoming."),
  );
  active.disposeReviewMergeWorker();
  expect(ComparisonWorker.instances[0].terminated).toBe(true);
  expect((await result).draft).toBe(local);
  expect((await result).status).toBe("client-merge-required");
});

it("an explicit retry can compare again after a transient worker failure without reloading", async () => {
  vi.stubGlobal("Worker", ComparisonWorker);
  const prefix = "Unchanged paragraph.\n\n".repeat(3000);
  const base = draft(`${prefix}First.\n\nSecond.`);
  const local = draft(`${prefix}Local typing.\n\nSecond.`);
  const incoming = draft(`${prefix}First.\n\nPeer update.`);
  const failed = active.mergeReviewDraftsAsync(base, local, incoming);
  ComparisonWorker.instances[0].onerror?.();
  expect((await failed).draft).toBe(local);
  expect(ComparisonWorker.instances[0].terminated).toBe(true);

  // Retrying releases failed worker state; the same loaded app must recover.
  active.disposeReviewMergeWorker();
  const retry = active.mergeReviewDraftsAsync(base, local, incoming);
  expect(ComparisonWorker.instances).toHaveLength(2);
  ComparisonWorker.instances[1].complete();
  const result = await retry;
  expect(result.status).toBe("merged");
  expect(result.draft.markdown).toBe(`${prefix}Local typing.\n\nPeer update.`);
});

it("a transient worker failure backs off briefly, then retries without reloading", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ComparisonWorker);
  const local = draft("Recoverable text.\n".repeat(4000));
  const failed = active.mergeReviewDraftsAsync(local, local, local);
  ComparisonWorker.instances[0].onerror?.();
  expect((await failed).draft).toBe(local);
  const backedOff = await active.mergeReviewDraftsAsync(local, local, local);
  expect(backedOff.status).toBe("client-merge-required");
  expect(ComparisonWorker.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  const retry = active.mergeReviewDraftsAsync(local, local, local);
  expect(ComparisonWorker.instances).toHaveLength(2);
  ComparisonWorker.instances[1].complete();
  expect((await retry).status).toBe("merged");
});

it("a failed worker preserves pending work and an idle worker is terminated", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ComparisonWorker);
  const local = draft("Recoverable text.\n".repeat(4000));
  const failed = active.mergeReviewDraftsAsync(
    draft("Base."),
    local,
    draft("Incoming."),
  );
  ComparisonWorker.instances[0].onerror?.();
  expect((await failed).draft).toBe(local);
  expect(ComparisonWorker.instances[0].terminated).toBe(true);
  // A fresh module represents another opened review after unavailable state.
  vi.resetModules();
  active = await import("./revision-reconciliation");
  const complete = active.mergeReviewDraftsAsync(local, local, local);
  const worker = ComparisonWorker.instances.at(-1);
  if (!worker) throw new Error("The comparison did not start its worker.");
  worker.complete();
  expect((await complete).status).toBe("merged");
  await vi.runOnlyPendingTimersAsync();
  expect(worker.terminated).toBe(true);
});

it("a late error from a released worker cannot cancel its replacement's comparison", async () => {
  vi.stubGlobal("Worker", ComparisonWorker);
  const prefix = "Unchanged paragraph.\n\n".repeat(3000);
  const base = draft(`${prefix}First.\n\nSecond.`);
  const local = draft(`${prefix}Local typing.\n\nSecond.`);
  const incoming = draft(`${prefix}First.\n\nPeer update.`);
  const cancelled = active.mergeReviewDraftsAsync(base, local, incoming);
  const previous = ComparisonWorker.instances[0];
  const delayedError = previous.onerror;
  active.disposeReviewMergeWorker();
  expect((await cancelled).status).toBe("client-merge-required");

  const retry = active.mergeReviewDraftsAsync(base, local, incoming);
  const replacement = ComparisonWorker.instances[1];
  expect(replacement).toBeDefined();
  delayedError?.();
  expect(replacement.terminated).toBe(false);
  replacement.complete();
  const result = await retry;
  expect(result.status).toBe("merged");
  expect(result.draft.markdown).toBe(`${prefix}Local typing.\n\nPeer update.`);
});
