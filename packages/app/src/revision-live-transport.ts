import type { SyncContext, SyncState } from "@roughdraft/rfm";
import { browserBasePath } from "./browser-base-path";
import type { ComparisonReviewData } from "./comparison-types";

const LIVE_TRANSPORT_PROTOCOL = 2;
export interface ReviewVersionHint {
  reviewId?: string;
  revision?: number;
  diskVersion?: string | null;
  registryGeneration?: string;
  operationId?: string;
  operationContext?: SyncContext;
  reason?: string;
}
export interface ReviewChangeNotice {
  reason: "changed" | "foreground" | "reconnected" | "fallback" | "heartbeat";
  state?: SyncState<ComparisonReviewData>;
  hint?: ReviewVersionHint;
  operationContext?: SyncContext;
  error?: string;
}
interface Subscription {
  listeners: Set<(notice: ReviewChangeNotice) => void>;
  state?: SyncState<ComparisonReviewData>;
  etag?: string;
  timer: ReturnType<typeof setTimeout> | null;
  request: AbortController | null;
  failed: boolean;
}
export interface ReviewLiveTransportOptions {
  basePath?: string;
  authNamespace?: string;
}
const hubs = new Map<string, ReviewLiveHub>();
function namespaceHash(value: string) {
  let hash = 2166136261;
  for (let n = 0; n < value.length; n++) {
    hash ^= value.charCodeAt(n);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
function report(event: string, reason: string) {
  console.warn(
    JSON.stringify({
      severity: "warn",
      component: "revision-live-transport",
      event,
      reason,
    }),
  );
}
function contextFrom(value: unknown): SyncContext | undefined {
  if (!value || typeof value !== "object") return;
  const c = value as Partial<SyncContext>;
  if (
    typeof c.owner === "string" &&
    typeof c.epoch === "string" &&
    typeof c.acceptUntil === "number"
  )
    return c as SyncContext;
}
function changed(
  a: SyncState<ComparisonReviewData> | undefined,
  b: SyncState<ComparisonReviewData>,
) {
  return (
    !a ||
    a.revision !== b.revision ||
    a.signature !== b.signature ||
    a.registryGeneration !== b.registryGeneration ||
    a.disk?.version !== b.disk?.version ||
    a.disk?.availability !== b.disk?.availability
  );
}

class ReviewLiveHub {
  readonly subscriptions = new Map<string, Subscription>();
  private worker: SharedWorker | null = null;
  private fallback = false;
  private disposed = false;
  private suspended = false;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private readonly baseURL: URL;
  private readonly namespace: string;
  private readonly visibility = () => this.foreground();
  private readonly online = () => {
    if (this.disposed || this.suspended) return;
    for (const subscription of this.subscriptions.values())
      this.stopPolling(subscription);
    this.foreground();
    try {
      this.worker?.port.postMessage({ type: "reconnect" });
    } catch {
      this.startPollingFallback("worker-reconnect-failed");
    }
  };
  private readonly pagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      this.dispose();
      return;
    }
    this.suspended = true;
    this.disconnectWorker();
    for (const subscription of this.subscriptions.values())
      this.stopPolling(subscription);
  };
  private readonly pageshow = (event: PageTransitionEvent) => {
    if (event.persisted && this.suspended) {
      this.suspended = false;
      this.foreground();
    }
  };

  constructor(
    private readonly key: string,
    basePath: string,
    authNamespace: string,
  ) {
    this.baseURL = new URL(basePath, window.location.origin);
    if (!this.baseURL.pathname.endsWith("/")) this.baseURL.pathname += "/";
    this.namespace = `${this.baseURL.href}|${authNamespace}|${LIVE_TRANSPORT_PROTOCOL}`;
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("online", this.online);
    window.addEventListener("pagehide", this.pagehide);
    window.addEventListener("pageshow", this.pageshow);
  }
  add(id: string, listener: (notice: ReviewChangeNotice) => void): () => void {
    let subscription = this.subscriptions.get(id);
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        timer: null,
        request: null,
        failed: false,
      };
      this.subscriptions.set(id, subscription);
    }
    subscription.listeners.add(listener);
    if (!this.worker && !this.fallback) this.connect();
    if (this.fallback) void this.poll(id);
    else this.sendSubscriptions();
    const registered = subscription;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      registered.listeners.delete(listener);
      if (!registered.listeners.size) {
        this.stopPolling(registered);
        this.subscriptions.delete(id);
        this.sendSubscriptions();
      }
      if (!this.subscriptions.size) this.dispose();
    };
  }
  private emit(id: string, notice: ReviewChangeNotice) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    for (const listener of [...subscription.listeners]) {
      try {
        listener(notice);
      } catch {
        report("listener-failed", "callback");
      }
    }
  }
  private all(notice: ReviewChangeNotice) {
    for (const id of this.subscriptions.keys()) this.emit(id, notice);
  }
  private connect() {
    if (this.disposed || this.suspended || this.worker) return;
    if (typeof SharedWorker === "undefined") {
      this.startPollingFallback("worker-unavailable");
      return;
    }
    try {
      // Keep this constructor form: Vite recognizes and bundles the module-worker URL.
      const worker = new SharedWorker(
        new URL("./shared-live-worker.ts", import.meta.url),
        {
          type: "module",
          name: `roughdraft-live-v${LIVE_TRANSPORT_PROTOCOL}-${namespaceHash(this.namespace)}`,
        },
      );
      this.worker = worker;
      this.lastPong = Date.now();
      worker.port.start();
      worker.port.onmessage = (event) => {
        if (this.worker !== worker || this.disposed) return;
        const message = event.data as {
          type?: string;
          protocol?: number;
          namespace?: string;
          reason?: ReviewChangeNotice["reason"];
          hint?: ReviewVersionHint;
        };
        if (message.type === "ready") {
          if (
            message.protocol !== LIVE_TRANSPORT_PROTOCOL ||
            message.namespace !== this.namespace
          ) {
            this.startPollingFallback("protocol-mismatch");
            return;
          }
          if (this.handshake) clearTimeout(this.handshake);
          this.handshake = null;
          this.lastPong = Date.now();
        } else if (message.type === "pong") this.lastPong = Date.now();
        else if (message.type === "fallback")
          this.startPollingFallback("worker-or-stream-unavailable");
        else if (message.type === "notice") {
          const hint = message.hint;
          const operationContext = contextFrom(hint?.operationContext);
          const notice: ReviewChangeNotice = {
            reason: message.reason ?? "changed",
            ...(hint ? { hint } : {}),
            ...(operationContext ? { operationContext } : {}),
          };
          if (hint?.reviewId) this.emit(hint.reviewId, notice);
          else this.all(notice);
        }
      };
      worker.port.onmessageerror = () => {
        if (this.worker === worker)
          this.startPollingFallback("worker-message-error");
      };
      worker.onerror = () => {
        if (this.worker === worker) this.startPollingFallback("worker-error");
      };
      this.handshake = setTimeout(
        () => this.startPollingFallback("worker-handshake-timeout"),
        2000,
      );
      this.heartbeat = setInterval(() => {
        if (!this.worker) return;
        if (
          document.visibilityState === "visible" &&
          Date.now() - this.lastPong > 6500
        ) {
          this.startPollingFallback("worker-heartbeat-timeout");
          return;
        }
        this.worker.port.postMessage({ type: "heartbeat" });
      }, 2000);
    } catch {
      this.startPollingFallback("worker-constructor-failed");
    }
  }
  private sendSubscriptions() {
    if (!this.worker) return;
    try {
      this.worker.port.postMessage({
        type: "subscribe",
        protocol: LIVE_TRANSPORT_PROTOCOL,
        namespace: this.namespace,
        baseURL: this.baseURL.href,
        reviewIds: [...this.subscriptions.keys()],
      });
    } catch {
      this.startPollingFallback("worker-port-failed");
    }
  }
  private disconnectWorker() {
    if (this.handshake) clearTimeout(this.handshake);
    this.handshake = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onerror = null;
      worker.port.onmessage = null;
      worker.port.onmessageerror = null;
      try {
        worker.port.postMessage({ type: "unsubscribe" });
      } catch {
        /* A terminated worker has no live stream to release. */
      }
      worker.port.close();
    }
  }
  private startPollingFallback(reason: string) {
    if (this.disposed || this.fallback) return;
    this.disconnectWorker();
    this.fallback = true;
    report("fallback", reason);
    for (const id of this.subscriptions.keys()) void this.poll(id);
  }
  private async poll(id: string) {
    const subscription = this.subscriptions.get(id);
    if (
      !subscription ||
      subscription.request ||
      this.disposed ||
      this.suspended ||
      !this.fallback ||
      document.visibilityState !== "visible"
    )
      return;
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = null;
    const controller = new AbortController();
    subscription.request = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 5000);
    try {
      const url = new URL(
        `api/comparisons/${encodeURIComponent(id)}/state`,
        this.baseURL,
      );
      const previous = subscription.state;
      if (previous) {
        url.searchParams.set("knownRevision", String(previous.revision));
        url.searchParams.set("knownDisk", previous.disk?.version ?? "");
        url.searchParams.set("knownRegistry", previous.registryGeneration);
      }
      const response = await fetch(url.href, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
        ...(subscription.etag
          ? { headers: { "If-None-Match": subscription.etag } }
          : {}),
      });
      if (
        this.subscriptions.get(id) !== subscription ||
        subscription.request !== controller ||
        controller.signal.aborted ||
        this.disposed ||
        this.suspended
      )
        return;
      const headerContext = response.headers.get(
        "X-Roughdraft-Operation-Context",
      );
      if (response.status === 304 || response.status === 204) {
        if (headerContext) {
          try {
            const context = contextFrom(JSON.parse(headerContext));
            if (context)
              this.emit(id, { reason: "heartbeat", operationContext: context });
          } catch {
            /* The next full state response refreshes context. */
          }
        }
        subscription.failed = false;
        return;
      }
      if (!response.ok) throw new Error("Live state request failed");
      const payload = await response.json();
      if (payload?.unchanged) return;
      const state = (payload?.state ??
        payload) as SyncState<ComparisonReviewData>;
      if (
        typeof state.revision !== "number" ||
        !state.draft ||
        !state.operationContext
      )
        throw new Error("Invalid live state response");
      const wasFailed = subscription.failed;
      subscription.failed = false;
      subscription.etag = response.headers.get("ETag") ?? undefined;
      subscription.state = state;
      if (changed(previous, state))
        this.emit(id, {
          reason: wasFailed ? "reconnected" : "fallback",
          state,
          operationContext: state.operationContext,
        });
      else
        this.emit(id, {
          reason: "heartbeat",
          operationContext: state.operationContext,
        });
    } catch {
      if (
        (!controller.signal.aborted || timedOut) &&
        !subscription.failed &&
        !this.disposed &&
        !this.suspended &&
        this.subscriptions.get(id) === subscription
      ) {
        subscription.failed = true;
        this.emit(id, {
          reason: "fallback",
          error: "Live updates are unavailable. Retrying.",
        });
      }
    } finally {
      clearTimeout(timeout);
      const stillCurrent = subscription.request === controller;
      if (stillCurrent) subscription.request = null;
      if (
        stillCurrent &&
        !this.disposed &&
        !this.suspended &&
        this.subscriptions.get(id) === subscription &&
        this.fallback &&
        document.visibilityState === "visible"
      )
        subscription.timer = setTimeout(() => {
          subscription.timer = null;
          void this.poll(id);
        }, 1000);
    }
  }
  private stopPolling(subscription: Subscription) {
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = null;
    subscription.request?.abort();
    subscription.request = null;
  }
  private foreground() {
    if (this.disposed) return;
    if (document.visibilityState !== "visible") {
      for (const subscription of this.subscriptions.values())
        this.stopPolling(subscription);
      return;
    }
    this.all({ reason: "foreground" });
    if (this.fallback) {
      for (const id of this.subscriptions.keys()) void this.poll(id);
    } else {
      this.disconnectWorker();
      this.connect();
      this.sendSubscriptions();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnectWorker();
    for (const subscription of this.subscriptions.values())
      this.stopPolling(subscription);
    this.subscriptions.clear();
    document.removeEventListener("visibilitychange", this.visibility);
    window.removeEventListener("online", this.online);
    window.removeEventListener("pagehide", this.pagehide);
    window.removeEventListener("pageshow", this.pageshow);
    hubs.delete(this.key);
  }
}

/** One shared stream where supported; otherwise visible-only conditional short requests. */
export function subscribeReviewChanges(
  reviewId: string,
  onChange: (notice: ReviewChangeNotice) => void,
  options: ReviewLiveTransportOptions = {},
): () => void {
  const basePath = options.basePath ?? browserBasePath();
  const authNamespace = options.authNamespace ?? "";
  const key = `${new URL(basePath, window.location.origin).href}|${authNamespace}`;
  let hub = hubs.get(key);
  if (!hub) {
    hub = new ReviewLiveHub(key, basePath, authNamespace);
    hubs.set(key, hub);
  }
  return hub.add(reviewId, onChange);
}
