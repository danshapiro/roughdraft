/** The worker receives version hints only; document parsing stays out of this transport. */
export const LIVE_TRANSPORT_PROTOCOL = 2;
// Page/worker commands evolve independently of the unchanged HTTP hint stream.
const EVENT_STREAM_PROTOCOL = 1;
const MAX_REVIEW_IDS = 64;
const PORT_TTL_MS = 10_000;
interface WorkerScope {
  location: { origin: string };
  onconnect: ((event: MessageEvent) => void) | null;
  close?: () => void;
}
interface PortSubscription {
  ids: Set<string>;
  seenAt: number;
}
interface WorkerMessage {
  type?: string;
  protocol?: number;
  namespace?: string;
  baseURL?: string;
  reviewIds?: unknown;
}

export function installSharedLiveWorker(
  scope: WorkerScope,
  createSource: (url: string) => EventSource = (url) => new EventSource(url),
) {
  const ports = new Map<MessagePort, PortSubscription>();
  let namespace: string | null = null;
  let baseURL: string | null = null;
  let source: EventSource | null = null;
  let sourceURL: string | null = null;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 1000;
  let streaming = false;
  let disposed = false;
  let lastSequence: number | null = null;
  function send(port: MessagePort, value: unknown) {
    try {
      port.postMessage(value);
    } catch {
      ports.delete(port);
      schedule();
    }
  }
  function broadcast(value: unknown, id?: string) {
    for (const [port, subscription] of ports)
      if (!id || subscription.ids.has(id)) send(port, value);
  }
  function closeSource() {
    if (retry) clearTimeout(retry);
    retry = null;
    source?.close();
    source = null;
    sourceURL = null;
    lastSequence = null;
    streaming = false;
  }
  function retryStream() {
    if (disposed || retry || !ports.size) return;
    retry = setTimeout(() => {
      retry = null;
      if (scheduled) clearTimeout(scheduled);
      scheduled = null;
      reconcile();
    }, retryDelay);
    retryDelay = Math.min(30_000, retryDelay * 2);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    closeSource();
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
    clearInterval(sweeper);
    for (const port of ports.keys()) port.close();
    ports.clear();
    scope.onconnect = null;
  }
  function reconcile() {
    scheduled = null;
    if (disposed) return;
    const ids = [
      ...new Set([...ports.values()].flatMap((p) => [...p.ids])),
    ].sort();
    if (!ids.length) {
      closeSource();
      if (!ports.size) {
        dispose();
        scope.close?.();
      }
      return;
    }
    if (ids.length > MAX_REVIEW_IDS) {
      closeSource();
      broadcast({ type: "fallback", reason: "subscription-limit" });
      return;
    }
    if (!baseURL) {
      broadcast({ type: "fallback", reason: "invalid-namespace" });
      return;
    }
    const url = new URL("api/comparisons/events", baseURL);
    url.searchParams.set("ids", ids.join(","));
    url.searchParams.set("protocol", String(EVENT_STREAM_PROTOCOL));
    if (retry) return;
    if (source && sourceURL === url.href) return;
    closeSource();
    sourceURL = url.href;
    let current: EventSource;
    try {
      current = createSource(url.href);
      source = current;
    } catch {
      sourceURL = null;
      broadcast({
        type: "fallback",
        reason: "stream-unavailable",
        recoverable: true,
      });
      retryStream();
      return;
    }
    current.onopen = () => {
      if (disposed || source !== current) return;
      streaming = true;
      lastSequence = null;
      retryDelay = 1000;
      broadcast({ type: "notice", reason: "reconnected" });
    };
    current.onerror = () => {
      if (disposed || source !== current) return;
      streaming = false;
      broadcast({
        type: "fallback",
        reason: "stream-unavailable",
        recoverable: true,
      });
      // CONNECTING sources already retry natively. A CLOSED source never does.
      if (current.readyState === 2) {
        closeSource();
        retryStream();
      }
    };
    const receive = (event: Event) => {
      if (disposed || source !== current) return;
      const message = event as MessageEvent<string>;
      try {
        const hint = JSON.parse(message.data) as Record<string, unknown>;
        const sequence = message.lastEventId
          ? Number(message.lastEventId)
          : null;
        if (sequence !== null && Number.isFinite(sequence)) {
          if (lastSequence !== null && sequence !== lastSequence + 1)
            broadcast({ type: "notice", reason: "reconnected" });
          lastSequence = sequence;
        }
        const id =
          typeof hint.reviewId === "string"
            ? hint.reviewId
            : typeof hint.id === "string"
              ? hint.id
              : undefined;
        broadcast(
          {
            type: "notice",
            reason: event.type === "heartbeat" ? "heartbeat" : "changed",
            hint,
          },
          id,
        );
      } catch {
        broadcast({ type: "notice", reason: "reconnected" });
      }
    };
    current.addEventListener("message", receive);
    current.addEventListener("change", receive);
    current.addEventListener("heartbeat", receive);
  }
  function schedule() {
    if (disposed) return;
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(reconcile, 50);
  }
  const sweeper = setInterval(() => {
    const now = Date.now();
    let removed = false;
    for (const [port, subscription] of ports)
      if (now - subscription.seenAt > PORT_TTL_MS) {
        ports.delete(port);
        port.close();
        removed = true;
      }
    if (removed || !ports.size) schedule();
  }, 2000);
  scope.onconnect = (event) => {
    const port = event.ports[0];
    if (!port || disposed) return;
    port.start();
    port.onmessage = (event) => {
      const message = event.data as WorkerMessage;
      if (message.type === "subscribe") {
        let incomingBase: URL;
        try {
          incomingBase = new URL(message.baseURL ?? "");
        } catch {
          send(port, { type: "fallback", reason: "invalid-namespace" });
          port.close();
          return;
        }
        if (
          message.protocol !== LIVE_TRANSPORT_PROTOCOL ||
          incomingBase.origin !== scope.location.origin ||
          (namespace && message.namespace !== namespace) ||
          (baseURL && incomingBase.href !== baseURL)
        ) {
          send(port, { type: "fallback", reason: "protocol-mismatch" });
          port.close();
          return;
        }
        const ids = Array.isArray(message.reviewIds)
          ? message.reviewIds.filter(
              (id): id is string =>
                typeof id === "string" && id.length > 0 && id.length <= 128,
            )
          : [];
        if (
          ids.length > MAX_REVIEW_IDS ||
          (ports.size >= 128 && !ports.has(port))
        ) {
          send(port, { type: "fallback", reason: "subscription-limit" });
          port.close();
          return;
        }
        namespace = message.namespace ?? incomingBase.href;
        baseURL = incomingBase.href;
        ports.set(port, { ids: new Set(ids), seenAt: Date.now() });
        send(port, {
          type: "ready",
          protocol: LIVE_TRANSPORT_PROTOCOL,
          namespace,
          streaming,
        });
        schedule();
      } else if (message.type === "heartbeat") {
        const subscription = ports.get(port);
        if (subscription) {
          subscription.seenAt = Date.now();
          send(port, { type: "pong" });
        }
      } else if (message.type === "reconnect" && ports.has(port)) {
        closeSource();
        schedule();
      } else if (message.type === "unsubscribe") {
        ports.delete(port);
        port.close();
        schedule();
      }
    };
    port.onmessageerror = () => {
      ports.delete(port);
      port.close();
      schedule();
    };
  };
  return {
    dispose,
    diagnostics: () => ({
      ports: ports.size,
      ids: new Set([...ports.values()].flatMap((p) => [...p.ids])).size,
      streaming: source !== null,
      sourceURL,
    }),
  };
}

if (typeof document === "undefined" && "onconnect" in globalThis)
  installSharedLiveWorker(globalThis as unknown as WorkerScope);
