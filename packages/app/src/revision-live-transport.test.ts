import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncState } from "@roughdraft/rfm";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type ReviewChangeNotice,
  subscribeReviewChanges,
} from "./revision-live-transport";

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: Record<string, unknown>[] = [];
  closed = false;
  start() {}
  close() {
    this.closed = true;
  }
  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
    if (message.type === "subscribe" && FakeWorker.respond)
      this.receive({
        type: "ready",
        protocol: 2,
        namespace: message.namespace,
      });
    if (message.type === "heartbeat" && FakeWorker.heartbeat)
      this.receive({ type: "pong" });
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}
class FakeWorker {
  static instances: FakeWorker[] = [];
  static respond = true;
  static heartbeat = true;
  port = new FakePort();
  onerror: (() => void) | null = null;
  constructor(
    readonly url: URL,
    readonly options: Record<string, unknown>,
  ) {
    FakeWorker.instances.push(this);
  }
}
const stops: (() => void)[] = [];
const state = (revision = 1) => ({
  review: { id: "review-1" },
  revision,
  signature: `sig${revision}`,
  registryGeneration: `reg${revision}`,
  draft: {
    markdown: "Text",
    cleanMarkdown: "Text",
    decisions: {},
    reviewComments: [],
  },
  disk: null,
  operationContext: { owner: "owner", epoch: "epoch", acceptUntil: 2000 },
});
function subscribe(
  id = "review-1",
  callback = (notice: ReviewChangeNotice) => {
    void notice;
  },
) {
  const stop = subscribeReviewChanges(id, callback);
  stops.push(stop);
  return stop;
}
function visible(value: "visible" | "hidden") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value);
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  FakeWorker.respond = true;
  FakeWorker.heartbeat = true;
  vi.stubGlobal("SharedWorker", FakeWorker);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.head.innerHTML = "";
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  window.dispatchEvent(new Event("pagehide"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("review change transport", () => {
  it("uses the controller's first read for the initial conditional fallback check", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetcher);
    const initial = state() as SyncState<ComparisonReviewData>;
    const callback = vi.fn();
    const stop = subscribeReviewChanges("review-1", callback, {
      initialState: initial,
    });
    stops.push(stop);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      "If-None-Match": '"reg1"',
    });
    expect(String(fetcher.mock.calls[0][0])).toContain("knownRevision=1");
    expect(callback).not.toHaveBeenCalled();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports recovery from a failed fallback even when the saved document is unchanged", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    const initial = state() as SyncState<ComparisonReviewData>;
    const context = { ...initial.operationContext, acceptUntil: 4000 };
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: {
            "X-Roughdraft-Operation-Context": JSON.stringify(context),
          },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const callback = vi.fn();
    stops.push(
      subscribeReviewChanges("review-1", callback, { initialState: initial }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "reconnected",
        state: { ...initial, operationContext: context },
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("negotiates compact changed states using only the matching frozen references", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    const initial = {
      ...state(),
      review: {
        ...state().review,
        referenceVersion: "frozen-v1",
        beforeText: "Before",
        afterText: "After",
        segments: [],
      },
    } as unknown as SyncState<ComparisonReviewData>;
    const incoming = {
      ...state(2),
      review: { id: "review-1", referenceVersion: "frozen-v1" },
      reviewFormat: "compact-v2",
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(incoming));
    vi.stubGlobal("fetch", fetcher);
    const callback = vi.fn();
    stops.push(
      subscribeReviewChanges("review-1", callback, { initialState: initial }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      "If-None-Match": '"reg1"',
      "X-Roughdraft-Sync": "compact-v2",
      "X-Roughdraft-Reference": "frozen-v1",
    });
    expect(callback.mock.calls[0][0].state.review).toMatchObject({
      beforeText: "Before",
      afterText: "After",
      draft: incoming.draft,
    });
    expect(callback.mock.calls[0][0].state.revision).toBe(2);
  });
  it("shares one worker port for this page's review subscriptions and releases it last", () => {
    const one = subscribe("one"),
      two = subscribe("two");
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    expect(worker.options.type).toBe("module");
    expect(worker.port.messages.at(-1)?.reviewIds).toEqual(["one", "two"]);
    one();
    expect(worker.port.closed).toBe(false);
    expect(worker.port.messages.at(-1)?.reviewIds).toEqual(["two"]);
    two();
    expect(worker.port.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains the complete authorized deployment prefix in the stream namespace", () => {
    document.head.innerHTML =
      '<base href="/roughdraft/bot-a/fixture-capability/">';
    subscribe();
    const worker = FakeWorker.instances[0];
    expect(worker.port.messages[0].baseURL).toBe(
      new URL("/roughdraft/bot-a/fixture-capability/", location.origin).href,
    );
    expect(String(worker.port.messages[0].namespace)).toContain(
      "fixture-capability",
    );
  });
  it("delivers only the named review's change hint and forwards context heartbeats", () => {
    const one = vi.fn(),
      two = vi.fn();
    subscribe("one", one);
    subscribe("two", two);
    const port = FakeWorker.instances[0].port;
    port.receive({
      type: "notice",
      reason: "changed",
      hint: { reviewId: "one", revision: 2 },
    });
    expect(one).toHaveBeenCalledOnce();
    expect(two).not.toHaveBeenCalled();
    port.receive({
      type: "notice",
      reason: "heartbeat",
      hint: { operationContext: state().operationContext },
    });
    expect(two.mock.calls[0][0]).toMatchObject({
      reason: "heartbeat",
      operationContext: state().operationContext,
    });
  });
  it("uses conditional short requests when workers are unavailable and stops while hidden", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(state()), { headers: { ETag: '"reg1"' } }),
      )
      .mockResolvedValue(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    subscribe("review-1", changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls[0][0].state.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].headers).toEqual({
      "If-None-Match": '"reg1"',
    });
    expect(String(fetcher.mock.calls[1][0])).toContain("knownRevision=1");
    visible("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    visible("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("falls back on a protocol mismatch without creating an EventSource per tab", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(state())));
    vi.stubGlobal("fetch", fetcher);
    const source = vi.fn();
    vi.stubGlobal("EventSource", source);
    subscribe();
    const worker = FakeWorker.instances[0];
    worker.port.receive({ type: "ready", protocol: 99, namespace: "wrong" });
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.port.closed).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(source).not.toHaveBeenCalled();
  });
  it("falls back when an old named worker has a different compiled script URL", async () => {
    vi.stubGlobal(
      "SharedWorker",
      class {
        constructor() {
          throw new DOMException("Worker URL changed", "URLMismatchError");
        }
      },
    );
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(state())));
    vi.stubGlobal("fetch", fetcher);
    subscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("recovers into short requests when a ready worker stops answering heartbeats", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(state())));
    vi.stubGlobal("fetch", fetcher);
    subscribe();
    const port = FakeWorker.instances[0].port;
    FakeWorker.heartbeat = false;
    await vi.advanceTimersByTimeAsync(8000);
    expect(port.closed).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("times out a dead worker handshake into polling and clears its timers", async () => {
    FakeWorker.respond = false;
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(state())));
    vi.stubGlobal("fetch", fetcher);
    const stop = subscribe();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(FakeWorker.instances[0].port.closed).toBe(true);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("refreshes operation context from a not-modified response without re-merging the document", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    const context = { ...state().operationContext, acceptUntil: 5000 };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(state())))
      .mockResolvedValue(
        new Response(null, {
          status: 304,
          headers: {
            "X-Roughdraft-Operation-Context": JSON.stringify(context),
          },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const callback = vi.fn();
    subscribe("review-1", callback);
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback.mock.calls.at(-1)?.[0]).toEqual({
      reason: "heartbeat",
      operationContext: context,
    });
  });
  it("reports a stalled state request and keeps only one in-flight request", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    const fetcher = vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const callback = vi.fn();
    subscribe("review-1", callback);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
  it("reconnects when a page is restored from the browser's back-forward cache", () => {
    const callback = vi.fn();
    subscribe("review-1", callback);
    const first = FakeWorker.instances[0];
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    expect(first.port.closed).toBe(true);
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].port.receive({
      type: "notice",
      reason: "changed",
      hint: { reviewId: "review-1", revision: 2 },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "changed" }),
    );
  });

  it("refreshes each subscribed review and replaces the silent shared stream when the network returns", () => {
    const one = vi.fn();
    const two = vi.fn();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const stopOne = subscribe("one", one);
    const stopTwo = subscribe("two", two);
    const stale = FakeWorker.instances[0];
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));

    expect(one).toHaveBeenCalledExactlyOnceWith({ reason: "foreground" });
    expect(two).toHaveBeenCalledExactlyOnceWith({ reason: "foreground" });
    expect(stale.port.closed).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(
      FakeWorker.instances[1].port.messages
        .filter((message) => message.type === "subscribe")
        .at(-1)?.reviewIds,
    ).toEqual(["one", "two"]);
    expect(
      FakeWorker.instances[1].port.messages.some(
        (message) => message.type === "reconnect",
      ),
    ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();

    stopOne();
    stopTwo();
    window.dispatchEvent(new Event("online"));
    expect(FakeWorker.instances).toHaveLength(2);
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abandons an old polling request on reconnect and immediately reads the latest state without leaking timers", async () => {
    vi.stubGlobal("SharedWorker", undefined);
    let staleSignal: AbortSignal | undefined;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            staleSignal = options.signal;
            options.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify(state(2)), {
          headers: { ETag: '"reg2"' },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const callback = vi.fn();
    const stop = subscribe("review-1", callback);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(staleSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ revision: 2 }),
      }),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns from temporary stream polling without disconnecting the healthy shared worker", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(state())));
    vi.stubGlobal("fetch", fetcher);
    const callback = vi.fn();
    const stop = subscribe("review-1", callback);
    const worker = FakeWorker.instances[0];
    worker.port.receive({
      type: "fallback",
      reason: "stream-unavailable",
      recoverable: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(worker.port.closed).toBe(false);

    worker.port.receive({ type: "notice", reason: "reconnected" });
    const polls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetcher).toHaveBeenCalledTimes(polls);
    worker.port.receive({
      type: "notice",
      reason: "changed",
      hint: { reviewId: "review-1", revision: 2 },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ hint: { reviewId: "review-1", revision: 2 } }),
    );
    expect(FakeWorker.instances).toHaveLength(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a transient worker failure and stops polling after stream recovery", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(state())));
    vi.stubGlobal("fetch", fetcher);
    const stop = subscribe();
    const failed = FakeWorker.instances[0];
    failed.onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed.port.closed).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    const recovered = FakeWorker.instances[1];
    recovered.port.receive({ type: "notice", reason: "reconnected" });
    const polls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetcher).toHaveBeenCalledTimes(polls);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
