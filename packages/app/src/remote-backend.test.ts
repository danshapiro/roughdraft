import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteBackend } from "./remote-backend";
import { MarkdownFileConflictError } from "./storage";

describe("RemoteBackend", () => {
  const originalFetch = global.fetch;
  const originalEventSource = global.EventSource;

  afterEach(() => {
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
    vi.restoreAllMocks();
  });

  function bootstrap() {
    return new RemoteBackend(
      {
        kind: "remote",
        label: "Remote document",
        detail: "draft.md",
        sessionId: "session-1",
        originPath: "/work/draft.md",
      },
      {
        id: "session-1",
        originPath: "/work/draft.md",
        content: "v1",
        version: "version-1",
      },
    );
  }

  it("creates an info object that exposes the session id and origin path", async () => {
    const backend = bootstrap();
    expect(backend.info.kind).toBe("remote");
    expect(backend.info.sessionId).toBe("session-1");
    expect(backend.info.originPath).toBe("/work/draft.md");
    expect(backend.canManageProjects).toBe(false);
  });

  it("getMarkdownFile fetches /api/remote-document/:id and returns the page", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "session-1",
            originPath: "/work/draft.md",
            content: "v2",
            version: "version-2",
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const backend = bootstrap();
    const page = await backend.getMarkdownFile("ignored.md");

    expect(fetchMock).toHaveBeenCalledWith("/api/remote-document/session-1", {
      headers: {},
    });
    expect(page.content).toBe("v2");
    expect(page.version).toBe("version-2");
  });

  it("includes the bearer token on requests when constructed with one", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "session-1",
            originPath: "/work/draft.md",
            content: "v1",
            version: "v",
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const backend = new RemoteBackend(
      {
        kind: "remote",
        label: "Remote document",
        detail: "draft.md",
        sessionId: "session-1",
        originPath: "/work/draft.md",
      },
      {
        id: "session-1",
        originPath: "/work/draft.md",
        content: "v1",
        version: "v",
      },
      "secret-token",
    );

    await backend.getMarkdownFile("ignored.md");

    expect(fetchMock).toHaveBeenCalledWith("/api/remote-document/session-1", {
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  it("saveMarkdownFile PUTs the new content with expectedVersion", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as {
        content: string;
        expectedVersion?: string;
      };
      expect(body).toMatchObject({
        content: "v2",
        expectedVersion: "version-1",
      });
      return new Response(
        JSON.stringify({ id: "session-1", version: "version-2" }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const backend = bootstrap();
    const page = await backend.saveMarkdownFile(
      "ignored.md",
      "v2",
      "version-1",
    );

    expect(page.version).toBe("version-2");
    expect(page.content).toBe("v2");
  });

  it("surfaces a 409 as MarkdownFileConflictError carrying current state", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            current: {
              id: "session-1",
              originPath: "/work/draft.md",
              content: "server-content",
              version: "version-server",
            },
          }),
          { status: 409 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const backend = bootstrap();
    await expect(
      backend.saveMarkdownFile("ignored.md", "client-content", "stale-version"),
    ).rejects.toBeInstanceOf(MarkdownFileConflictError);
  });

  it("saveAsset throws a clear error", async () => {
    const backend = bootstrap();
    const file = new File(["bytes"], "image.png");
    await expect(backend.saveAsset(file)).rejects.toThrow(
      /do not support asset uploads/,
    );
  });

  it("resolveFileUrl returns null", () => {
    const backend = bootstrap();
    expect(backend.resolveFileUrl("anything.png")).toBeNull();
  });

  it("openProject is a no-op for remote sessions", async () => {
    const backend = bootstrap();
    await expect(backend.openProject("/elsewhere")).resolves.toBeUndefined();
    expect(backend.info.projectPath).toBeUndefined();
  });

  it("onSessionStatusChange immediately reports the current status and any future changes", () => {
    const backend = bootstrap();
    const events: string[] = [];
    const unsubscribe = backend.onSessionStatusChange((status) =>
      events.push(status),
    );

    expect(events).toEqual(["disconnected"]);

    // Simulate the SSE flow flipping the status to connected, then disconnected.
    (
      backend as unknown as { setSessionStatus: (s: string) => void }
    ).setSessionStatus("connected");
    (
      backend as unknown as { setSessionStatus: (s: string) => void }
    ).setSessionStatus("disconnected");

    expect(events).toEqual(["disconnected", "connected", "disconnected"]);

    unsubscribe();

    (
      backend as unknown as { setSessionStatus: (s: string) => void }
    ).setSessionStatus("connected");
    expect(events).toEqual(["disconnected", "connected", "disconnected"]);
  });

  it("watchMarkdownFile opens a viewer event stream with the token in the query string", () => {
    const instances: Array<{
      url: string;
      listeners: Record<string, Array<(event: Event) => void>>;
      readyState: number;
      close: () => void;
    }> = [];

    class FakeEventSource {
      static CLOSED = 2;
      url: string;
      listeners: Record<string, Array<(event: Event) => void>> = {};
      readyState = 1;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }

      addEventListener(type: string, listener: (event: Event) => void) {
        this.listeners[type] ??= [];
        this.listeners[type].push(listener);
      }

      close() {
        this.readyState = FakeEventSource.CLOSED;
      }
    }

    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    const backend = new RemoteBackend(
      {
        kind: "remote",
        label: "Remote document",
        detail: "draft.md",
        sessionId: "session-1",
        originPath: "/work/draft.md",
      },
      {
        id: "session-1",
        originPath: "/work/draft.md",
        content: "v1",
        version: "version-1",
      },
      "secret-token",
    );

    const statuses: string[] = [];
    backend.onSessionStatusChange((status) => statuses.push(status));

    const stopWatching = backend.watchMarkdownFile("ignored.md", () => {});
    expect(instances).toHaveLength(1);

    const eventsUrl = new URL(instances[0].url);
    expect(eventsUrl.pathname).toBe("/api/remote-document/session-1/events");
    expect(eventsUrl.searchParams.get("role")).toBe("viewer");
    expect(eventsUrl.searchParams.get("token")).toBe("secret-token");

    instances[0].listeners.connected?.forEach((listener) => {
      listener(new Event("connected"));
    });
    expect(statuses).toEqual(["disconnected", "connected"]);

    stopWatching();
    expect(statuses).toEqual(["disconnected", "connected", "disconnected"]);
  });

  it("reports writer disconnection while the viewer event stream stays open", () => {
    let source: EventTarget | undefined;
    class FakeEventSource extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor(_url: string) {
        super();
        source = this;
      }
      close() {
        this.readyState = FakeEventSource.CLOSED;
      }
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;
    const backend = bootstrap();
    const statuses: string[] = [];
    backend.onSessionStatusChange((status) => statuses.push(status));
    const stop = backend.watchMarkdownFile("draft.md", () => {});
    try {
      if (!source) throw new Error("Expected a viewer event stream");
      source.dispatchEvent(new Event("connected"));
      source.dispatchEvent(new Event("disconnected"));
      expect(backend.sessionStatus).toBe("disconnected");
      source.dispatchEvent(new Event("connected"));
      expect(statuses).toEqual([
        "disconnected",
        "connected",
        "disconnected",
        "connected",
      ]);
    } finally {
      stop();
    }
  });
});
