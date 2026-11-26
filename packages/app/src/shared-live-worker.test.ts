import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSharedLiveWorker } from "./shared-live-worker";

class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: Array<Record<string, unknown>> = [];
  closed = false;
  start() {}
  close() {
    this.closed = true;
  }
  postMessage(value: Record<string, unknown>) {
    this.messages.push(value);
  }
  receive(value: unknown) {
    this.onmessage?.({ data: value });
  }
}
class Source extends EventTarget {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.closed = true;
  }
  event(value: unknown, type = "change", sequence = "") {
    this.dispatchEvent(
      new MessageEvent(type, {
        data: JSON.stringify(value),
        lastEventId: sequence,
      }),
    );
  }
}
const disposers: (() => void)[] = [];
function setup(failures = 0) {
  const sources: Source[] = [];
  const scope = {
    location: { origin: "https://review.example" },
    onconnect: null as ((event: MessageEvent) => void) | null,
    close: vi.fn(),
  };
  const worker = installSharedLiveWorker(scope, (url) => {
    if (failures-- > 0) throw new Error("Temporary stream startup failure");
    const source = new Source(url);
    sources.push(source);
    return source as unknown as EventSource;
  });
  disposers.push(worker.dispose);
  const connect = (ids: string[], options: Record<string, unknown> = {}) => {
    const port = new Port();
    scope.onconnect?.({ ports: [port] } as unknown as MessageEvent);
    port.receive({
      type: "subscribe",
      protocol: 2,
      namespace: "auth-a",
      baseURL: "https://review.example/roughdraft/bot-a/capability-a/",
      reviewIds: ids,
      ...options,
    });
    return port;
  };
  return { sources, scope, worker, connect };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
describe("shared live worker", () => {
  it("multiplexes review IDs through one prefixed stream and reopens only when the set changes", async () => {
    const { sources, connect } = setup();
    const first = connect(["one"]);
    const second = connect(["two"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(sources).toHaveLength(1);
    const url = new URL(sources[0].url);
    expect(url.pathname).toBe(
      "/roughdraft/bot-a/capability-a/api/comparisons/events",
    );
    expect(url.searchParams.get("ids")).toBe("one,two");
    expect(url.searchParams.get("protocol")).toBe("1");
    const third = connect(["one"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(sources).toHaveLength(1);
    first.receive({ type: "unsubscribe" });
    await vi.advanceTimersByTimeAsync(50);
    expect(sources).toHaveLength(1);
    second.receive({ type: "unsubscribe" });
    await vi.advanceTimersByTimeAsync(50);
    expect(sources).toHaveLength(2);
    expect(sources[0].closed).toBe(true);
    expect(new URL(sources[1].url).searchParams.get("ids")).toBe("one");
    third.receive({ type: "unsubscribe" });
    await vi.advanceTimersByTimeAsync(50);
    expect(sources[1].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects incompatible protocols and authorization namespaces before sharing data", async () => {
    const { sources, connect } = setup();
    const first = connect(["one"]);
    await vi.advanceTimersByTimeAsync(50);
    const foreign = connect(["one"], {
      namespace: "auth-b",
      baseURL: "https://review.example/roughdraft/bot-b/capability-b/",
    });
    const old = connect(["one"], { protocol: 0 });
    expect(foreign.closed).toBe(true);
    expect(old.closed).toBe(true);
    expect(foreign.messages.at(-1)?.type).toBe("fallback");
    sources[0].event({ reviewId: "one", revision: 2 });
    expect(first.messages.at(-1)?.type).toBe("notice");
    expect(foreign.messages.some((m) => m.type === "notice")).toBe(false);
  });
  it("routes hints to subscribed reviews and forces resync after an event-sequence gap", async () => {
    const { sources, connect } = setup();
    const first = connect(["one"]);
    const second = connect(["two"]);
    await vi.advanceTimersByTimeAsync(50);
    sources[0].event({ reviewId: "one", revision: 2 }, "change", "1");
    expect(first.messages.at(-1)).toMatchObject({
      type: "notice",
      reason: "changed",
      hint: { reviewId: "one", revision: 2 },
    });
    expect(second.messages.filter((m) => m.type === "notice")).toHaveLength(0);
    sources[0].event({ reviewId: "one", revision: 4 }, "change", "3");
    expect(second.messages.at(-1)).toMatchObject({ reason: "reconnected" });
  });
  it("forwards fresh context heartbeats and requests fallback on stream failure", async () => {
    const { sources, connect } = setup();
    const port = connect(["one"]);
    await vi.advanceTimersByTimeAsync(50);
    sources[0].event(
      {
        operationContext: { owner: "owner", epoch: "epoch", acceptUntil: 5000 },
      },
      "heartbeat",
    );
    expect(port.messages.at(-1)).toMatchObject({
      reason: "heartbeat",
      hint: { operationContext: { acceptUntil: 5000 } },
    });
    sources[0].onerror?.();
    expect(port.messages.at(-1)).toMatchObject({ type: "fallback" });
    expect(sources).toHaveLength(1);
  });
  it("expires abandoned ports while preserving a live heartbeat subscriber", async () => {
    const { sources, connect, scope } = setup();
    const live = connect(["one"]);
    const abandoned = connect(["two"]);
    await vi.advanceTimersByTimeAsync(6050);
    live.receive({ type: "heartbeat" });
    expect(live.messages.at(-1)).toEqual({ type: "pong" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(abandoned.closed).toBe(true);
    expect(live.closed).toBe(false);
    expect(sources.filter((s) => !s.closed)).toHaveLength(1);
    live.receive({ type: "unsubscribe" });
    await vi.advanceTimersByTimeAsync(50);
    expect(scope.close).toHaveBeenCalledOnce();
    expect(sources.every((s) => s.closed)).toBe(true);
  });
  it("falls back rather than opening unbounded review subscriptions", async () => {
    const { sources, connect } = setup();
    const one = connect(Array.from({ length: 40 }, (_, n) => `a${n}`));
    const two = connect(Array.from({ length: 40 }, (_, n) => `b${n}`));
    await vi.advanceTimersByTimeAsync(50);
    expect(sources).toHaveLength(0);
    expect(one.messages.at(-1)?.type).toBe("fallback");
    expect(two.messages.at(-1)?.type).toBe("fallback");
  });

  it("coalesces resumed tabs into one fresh stream even when the review IDs are unchanged", async () => {
    const { sources, connect } = setup();
    const tabs = Array.from({ length: 8 }, (_, index) =>
      connect([index % 2 ? "two" : "one"]),
    );
    const [first, second] = tabs;
    await vi.advanceTimersByTimeAsync(50);
    const silent = sources[0];
    for (const tab of tabs) tab.receive({ type: "reconnect" });
    await vi.advanceTimersByTimeAsync(50);

    expect(silent.closed).toBe(true);
    expect(sources).toHaveLength(2);
    expect(sources.filter((source) => !source.closed)).toHaveLength(1);
    expect(new URL(sources[1].url).searchParams.get("ids")).toBe("one,two");
    sources[1].event({ reviewId: "two", revision: 3 });
    expect(second.messages.at(-1)).toMatchObject({
      type: "notice",
      hint: { reviewId: "two", revision: 3 },
    });
    expect(first.closed).toBe(false);
    expect(second.closed).toBe(false);
    for (const tab of tabs) tab.receive({ type: "unsubscribe" });
    await vi.advanceTimersByTimeAsync(50);
    expect(sources.every((source) => source.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces a closed stream once for eight live tabs after a transient error", async () => {
    const { sources, connect } = setup();
    const tabs = Array.from({ length: 8 }, () => connect(["one"]));
    await vi.advanceTimersByTimeAsync(50);
    const failed = sources[0];
    failed.readyState = 2;
    failed.onerror?.();
    expect(failed.closed).toBe(true);
    for (const tab of tabs) {
      expect(tab.closed).toBe(false);
      expect(tab.messages.at(-1)).toMatchObject({
        type: "fallback",
        recoverable: true,
      });
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(sources).toHaveLength(2);
    expect(sources.filter((source) => !source.closed)).toHaveLength(1);
    failed.onopen?.();
    failed.onerror?.();
    expect(tabs[0].messages.at(-1)?.type).toBe("fallback");
    expect(sources).toHaveLength(2);
    sources[1].readyState = 1;
    sources[1].onopen?.();
    for (const tab of tabs)
      expect(tab.messages.at(-1)).toMatchObject({
        type: "notice",
        reason: "reconnected",
      });
    for (const tab of tabs) tab.receive({ type: "unsubscribe" });
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a temporary stream constructor failure without creating parallel streams", async () => {
    const { sources, connect } = setup(1);
    const tab = connect(["one"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(sources).toHaveLength(0);
    expect(tab.messages.at(-1)).toMatchObject({
      type: "fallback",
      recoverable: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sources).toHaveLength(1);
    expect(sources.filter((source) => !source.closed)).toHaveLength(1);
  });

  it("bounds repeated startup failures and releases every retry when the last tab closes", async () => {
    const { sources, connect } = setup(Number.POSITIVE_INFINITY);
    const tab = connect(["one"]);
    for (let second = 0; second < 40; second += 2) {
      tab.receive({ type: "heartbeat" });
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(sources).toHaveLength(0);
    const attempts = tab.messages.filter(
      (message) => message.type === "fallback",
    );
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.length).toBeLessThan(8);
    tab.receive({ type: "unsubscribe" });
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(0);
  });
});
