import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncResult,
  type SyncState,
} from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { cleanSourceFromNode } from "./revision-clean-cache";
import {
  cleanRevisionMarkdown,
  editableMarkdownOptions,
} from "./revision-markdown";
import {
  capturePrivateCommentAnchor,
  containsReviewIdentity,
  resolvePrivateCommentAnchor,
} from "./revision-private-anchors";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";
import { RevisionSource } from "./revision-source";
import { RevisionUiDraftStore } from "./revision-ui-drafts";

const notifications = vi.hoisted(
  () => new Map<string, (notice: unknown) => void>(),
);
vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: (id: string, listener: (notice: unknown) => void) => {
    notifications.set(id, listener);
    return () => notifications.delete(id);
  },
}));
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected the test value to exist");
  return value;
}
class MemoryStorage {
  records = new Map<string, string>();
  get length() {
    return this.records.size;
  }
  getItem(key: string) {
    return this.records.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.records.set(key, value);
  }
  removeItem(key: string) {
    this.records.delete(key);
  }
  key(index: number) {
    return [...this.records.keys()][index] ?? null;
  }
}
const controllers: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  notifications.clear();
  vi.useRealTimers();
});
function draft(markdown: string): RevisionDraft {
  return {
    markdown,
    cleanMarkdown: markdown,
    decisions: {},
    reviewComments: [],
  };
}

test.each([
  "unchanged",
  "moved",
  "changed quote",
  "ambiguous quote",
  "reused ID",
])("explicit private root recovery validates the current model anchor: %s", async (scenario) => {
  const source = "A unique anchor for a private comment.\n";
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const originalDoc = schema.nodeFromJSON(
    criticMarkdownToEditorState(source).doc,
  );
  const anchor = capturePrivateCommentAnchor(originalDoc, 3, 16);
  expect(anchor?.quote).toBe("unique anchor");
  const current =
    scenario === "moved"
      ? `New paragraph.\n\n${source}`
      : scenario === "changed quote"
        ? source.replace("unique anchor", "edited anchor")
        : scenario === "ambiguous quote"
          ? `${source}\n${source}`
          : scenario === "reused ID"
            ? source.replace(
                "unique anchor",
                "{==unique anchor==}{>>Foreign comment<<}{#c9}",
              )
            : source;
  const initial = state(current);
  const model = schema.nodeFromJSON(criticMarkdownToEditorState(current).doc);
  const ui = new RevisionUiDraftStore();
  const writes = vi.fn();
  const controller = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    {
      request: async <T>(_path: string, body?: object) => {
        if (body) {
          writes();
          throw new Error("Restoring private feedback must not write");
        }
        return null as T | null;
      },
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => value,
    adopt: () => null,
    readUiDrafts: ui.read,
    restoreUiDrafts: ui.restore,
    canRestorePrivateComment: (id, value) =>
      !containsReviewIdentity(model, id) &&
      Boolean(
        resolvePrivateCommentAnchor(
          model,
          (value as { anchor: NonNullable<typeof anchor> }).anchor,
        ),
      ),
  });
  const old = draft(source);
  const result = await controller.restoreRecoveryUi({
    entryDraft: old,
    workingDraft: old,
    uiDrafts: {
      comments: {
        c9: {
          value: "Unsubmitted root feedback",
          original: "",
          editing: true,
          target: {
            id: "c9",
            content: "",
            createdAt: "2026-11-26T12:02:00.000Z",
            parentCommentId: null,
          },
          anchor,
        },
      },
    },
  });
  const accepted = scenario === "unchanged" || scenario === "moved";
  expect(result).toEqual(
    accepted ? { restored: 1, skipped: 0 } : { restored: 0, skipped: 1 },
  );
  expect(ui.getSnapshot().comments.c9?.value).toBe(
    accepted ? "Unsubmitted root feedback" : undefined,
  );
  expect(controller.readDraft().reviewComments).toEqual([]);
  expect(controller.readDraft().markdown).not.toContain(
    "Unsubmitted root feedback",
  );
  expect(writes).not.toHaveBeenCalled();
});

test("a reserved candidate is prepared and posted before reflection, then its acknowledgment rebases newer native typing", async () => {
  let server = state();
  let editorText = server.draft.markdown;
  const events: string[] = [];
  const requests: ReconcileRequest[] = [];
  let release: ((value: SyncResult<ComparisonReviewData>) => void) | undefined;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
    const sent = body as ReconcileRequest;
    requests.push(structuredClone(sent));
    if (!sent.reservationToken) {
      const peer = state("First.\n\nPeer last.\n");
      server = {
        ...peer,
        revision: 2,
        review: { ...peer.review, revision: 2 },
      };
      return {
        status: "client-merge-required",
        state: structuredClone(server),
        reservation: {
          token: "lease",
          revision: 2,
          expiresAt: Date.now() + 750,
        },
      } as T;
    }
    events.push("post-reserved");
    editorText = editorText.replace("My first.", "My first. Newer typing.");
    return new Promise<T>((resolve) => {
      release = (result) => resolve(result as T);
    });
  };
  const controller = new RevisionSessionController(
    server.review,
    server.draft as RevisionDraft,
    {
      request: api,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
      merge: async (base, local, incoming, options) =>
        mergeReviewDrafts(base, local, incoming, {
          ...options,
          server: false,
          budgetMs: 100,
        }),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    rebasesBufferedDocument: true,
    prepare: (value) => {
      events.push("prepare");
      return { ...value, cleanMarkdown: value.markdown };
    },
    apply: (value, options) => {
      if (!value.markdown.includes("Peer last.")) return value;
      events.push("reflect-peer");
      const merged = mergeReviewDrafts(
        options?.localBase ?? value,
        draft(editorText),
        value,
        { server: false, budgetMs: 100 },
      );
      if (merged.status !== "merged")
        throw new Error(`Unexpected editor merge ${merged.status}`);
      editorText = merged.draft.markdown;
      return { ...merged.draft, cleanMarkdown: merged.draft.markdown };
    },
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  editorText = "My first.\n\nLast.\n";
  controller.updateDraft(() => draft(editorText));
  const pending = controller.flush(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual(["prepare", "post-reserved"]);
  expect(requests).toHaveLength(2);
  expect(requests[1].draft.markdown).toContain("My first.");
  expect(requests[1].draft.markdown).toContain("Peer last.");
  expect(requests[1].draft.markdown).not.toContain("Newer typing");
  server = commit(server, requests[1]);
  release?.({ status: "committed", state: structuredClone(server) });
  await pending;
  expect(events).toEqual(["prepare", "post-reserved", "reflect-peer"]);
  expect(editorText).toContain("My first. Newer typing.");
  expect(editorText).toContain("Peer last.");
  expect(controller.readDraft().markdown).toBe(editorText);
});

for (const reserved of [false, true]) {
  test.each([
    false,
    true,
  ])(`a newer peer notice parked behind an own ${reserved ? "reserved" : "ordinary"} response resumes without another event (newer typing: %s)`, async (newerTyping) => {
    let server = state();
    let own: SyncState<ComparisonReviewData> | undefined;
    let release:
      | ((value: SyncResult<ComparisonReviewData>) => void)
      | undefined;
    const sent: ReconcileRequest[] = [];
    const ui = new RevisionUiDraftStore();
    const api = async <T>(path: string, body?: object): Promise<T | null> => {
      if (!body) return structuredClone(server) as T;
      if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
      const request = body as ReconcileRequest;
      sent.push(structuredClone(request));
      if (reserved && sent.length === 1) {
        server = state("First.\n\nPeer last.\n");
        server.revision = server.review.revision = 2;
        return {
          status: "client-merge-required",
          state: structuredClone(server),
          reservation: {
            token: "initial-turn",
            revision: 2,
            expiresAt: Date.now() + 750,
          },
        } as T;
      }
      if (!release) {
        server = commit(server, request);
        own = structuredClone(server);
        return await new Promise<T>((resolve) => {
          release = resolve;
        });
      }
      if (request.expectedRevision !== server.revision)
        return {
          // Annotated/large reviews cannot use the server's quick merge.
          status: "client-merge-required",
          state: structuredClone(server),
          reservation: {
            token: "avoidable-turn",
            revision: server.revision,
            expiresAt: Date.now() + 750,
          },
        } as T;
      server = commit(server, request);
      return { status: "committed", state: structuredClone(server) } as T;
    };
    const controller = new RevisionSessionController(
      server.review,
      server.draft as RevisionDraft,
      {
        request: api,
        storage: new MemoryStorage(),
        tabStorage: new MemoryStorage(),
      },
    );
    controllers.push(controller);
    controller.setAdapter({
      rebasesBufferedDocument: true,
      prepare: (value) => ({ ...value, cleanMarkdown: value.markdown }),
      apply: (value) => ({ ...value, cleanMarkdown: value.markdown }),
      adopt: () => null,
      readUiDrafts: ui.read,
      restoreUiDrafts: ui.restore,
      subscribeUiDrafts: ui.subscribe,
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    controller.updateDraft(() => draft("My first.\n\nLast.\n"));
    const pending = controller.flush(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toBeDefined();
    const committed = required(own);
    const incoming = draft(
      committed.draft.markdown.replace(
        /(?:Peer )?Last\.|Peer last\./,
        "Latest peer last.",
      ),
    );
    server = {
      ...committed,
      draft: incoming,
      revision: committed.revision + 1,
      signature: reviewDraftSignature(incoming),
      registryGeneration: String(committed.revision + 1),
      review: {
        ...committed.review,
        revision: committed.revision + 1,
        draft: incoming,
        lastOperation: {
          id: "newer-peer",
          pageInstanceId: "other-page",
          reason: "sync",
        },
      },
    };
    if (newerTyping)
      controller.updateDraft((current) =>
        draft(current.markdown.replace("My first.", "My first. Newer typing.")),
      );
    ui.setComment("private-reply", {
      value: "Unsubmitted private reply",
      original: "",
      editing: true,
    });
    notifications.get("review")?.({
      reason: "changed",
      state: structuredClone(server),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.readDraft().markdown).not.toContain("Latest peer last.");
    release?.({ status: "committed", state: committed });
    expect(await pending).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.readDraft().markdown).toContain("Latest peer last.");
    expect(controller.readDraft().markdown).toContain(
      newerTyping ? "My first. Newer typing." : "My first.",
    );
    expect(sent).toHaveLength((reserved ? 2 : 1) + Number(newerTyping));
    expect(
      sent.every(
        (request) =>
          !JSON.stringify(request).includes("Unsubmitted private reply"),
      ),
    ).toBe(true);
    expect(ui.getSnapshot().comments["private-reply"]?.value).toBe(
      "Unsubmitted private reply",
    );
    expect(controller.getSnapshot().conflict).toBeNull();
    expect(controller.getSnapshot().writePaused).toBe(false);
  });
}

test.each([
  false,
  true,
])("a stale reserved submission consumes its replacement turn and respects a subsequent peer turn (%s)", async (peerTurn) => {
  let server = state();
  const requests: ReconcileRequest[] = [];
  const sentAt: number[] = [];
  let controller: RevisionSessionController;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
    const sent = body as ReconcileRequest;
    requests.push(structuredClone(sent));
    sentAt.push(performance.now());
    if (requests.length <= 2) {
      if (requests.length === 1) {
        server = state("First.\n\nPeer last.\n");
        server.revision = server.review.revision = 2;
      } else {
        expect(sent.reservationToken).toBe("initial-turn");
        controller.updateDraft(() =>
          draft("My first. Newer typing.\n\nLast.\n"),
        );
        server = state("First.\n\nPeer changed last.\n");
        server.revision = server.review.revision = 3;
      }
      return {
        status: "client-merge-required",
        state: structuredClone(server),
        reservation: {
          token: requests.length === 1 ? "initial-turn" : "replacement-turn",
          revision: server.revision,
          expiresAt: Date.now() + 750,
        },
      } as T;
    }
    if (requests.length === 3) {
      // An ordinary save here would wait against this page's own reservation.
      expect(sent.reservationToken).toBe("replacement-turn");
      expect(sent.expectedRevision).toBe(3);
      expect(sent.draft.markdown).toContain("Newer typing.");
      expect(sent.draft.markdown).toContain("Peer changed last.");
      if (peerTurn)
        return {
          status: "retry-later",
          state: structuredClone(server),
          retryAfter: 241,
        } as T;
    } else {
      expect(sent.reservationToken).toBeUndefined();
      expect(sentAt[3] - sentAt[2]).toBeGreaterThanOrEqual(241);
    }
    server = commit(server, sent);
    return { status: "committed", state: structuredClone(server) } as T;
  };
  controller = new RevisionSessionController(
    server.review,
    server.draft as RevisionDraft,
    {
      request: api,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    rebasesBufferedDocument: true,
    prepare: (value) => ({ ...value, cleanMarkdown: value.markdown }),
    apply: (value) => ({ ...value, cleanMarkdown: value.markdown }),
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("My first.\n\nLast.\n"));
  const saved = await controller.flush(false);
  expect(requests).toHaveLength(3);
  expect(requests.map((request) => request.reservationToken)).toEqual([
    undefined,
    "initial-turn",
    "replacement-turn",
  ]);
  if (peerTurn) {
    expect(saved).toBe(false);
    await vi.advanceTimersByTimeAsync(240);
    expect(requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(4);
  } else expect(saved).toBe(true);
  expect(new Set(requests.map((request) => request.operationId)).size).toBe(
    requests.length,
  );
  expect(requests.at(-1)?.acknowledgedOperationIds).toEqual(
    expect.arrayContaining(
      requests.slice(0, -1).map((request) => request.operationId),
    ),
  );
  expect(controller.readDraft().markdown).toBe(
    "My first. Newer typing.\n\nPeer changed last.\n",
  );
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(controller.getSnapshot().writePaused).toBe(false);
});

test("repeated replacement turns remain bounded and preserve typing until a later autosave", async () => {
  let server = state();
  const requests: ReconcileRequest[] = [];
  const controller = new RevisionSessionController(
    server.review,
    server.draft as RevisionDraft,
    {
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
      request: async <T>(_path: string, body?: object): Promise<T | null> => {
        if (!body) return structuredClone(server) as T;
        const sent = body as ReconcileRequest;
        requests.push(structuredClone(sent));
        server = state("First.\n\nPeer last.\n");
        server.revision = server.review.revision = 2;
        return {
          status: "client-merge-required",
          state: structuredClone(server),
          reservation: {
            token: `turn-${requests.length}`,
            revision: server.revision,
            expiresAt: Date.now() + 750,
          },
        } as T;
      },
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    prepare: (value) => ({ ...value, cleanMarkdown: value.markdown }),
    apply: (value) => ({ ...value, cleanMarkdown: value.markdown }),
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("My first.\n\nLast.\n"));
  expect(await controller.flush(false)).toBe(false);
  expect(requests.map((request) => request.reservationToken)).toEqual([
    undefined,
    "turn-1",
    "turn-2",
    "turn-3",
  ]);
  await vi.advanceTimersByTimeAsync(749);
  expect(requests).toHaveLength(4);
  expect(controller.readDraft().markdown).toContain("My first.");
  expect(controller.getSnapshot().writePaused).toBe(false);
  expect(controller.getSnapshot().conflict).toBeNull();
});

test.each([
  "peer",
  "self",
  "historical",
] as const)("overwrite recovery notice is nonblocking and identifies only a new peer action: %s", async (source) => {
  let server = state();
  const notice = {
    operationId: "peer-overwrite",
    pageInstanceId: source === "self" ? "page" : "other-page",
    checkpointId: "displaced-checkpoint",
    displacedSignature: server.signature,
    createdAt: "2026-11-26T12:00:00.000Z",
  };
  if (source === "historical") server.review.lastOverwrite = notice;
  const controller = install(
    server,
    async <T>(_path: string, body?: object) => {
      if (body) throw new Error("An overwrite notification must not publish");
      return structuredClone(server) as T;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  server = state("Incoming first.\n\nLast.\n");
  server.revision = 2;
  server.review.revision = 2;
  server.registryGeneration = "2";
  server.review.lastOverwrite = notice;
  await controller.refresh(true);
  expect(controller.readDraft().markdown).toContain("Incoming first");
  expect(controller.getSnapshot().writePaused).toBe(false);
  expect(controller.getSnapshot().conflict).toBeNull();
  if (source === "peer")
    expect(controller.getSnapshot().notice).toMatch(
      /overwrit.*Recovery copies/i,
    );
  else expect(controller.getSnapshot().notice).toBe("");
});
function state(content = "First.\n\nLast.\n"): SyncState<ComparisonReviewData> {
  const data = draft(content);
  const review: ComparisonReviewData = {
    id: "review",
    revision: 1,
    mode: "document",
    title: "A document",
    beforeLabel: "Original",
    afterLabel: "Working",
    targetPath: null,
    beforeText: content,
    afterText: content,
    segments: [],
    comment: "",
    status: "open",
    targetChanged: false,
    editor: "unified",
    draft: data,
    reviewComments: [],
    destinationPath: null,
    savedPath: null,
    savedText: null,
    autosave: "none",
    handoff: "chat",
    completion: null,
  };
  return {
    review,
    draft: data,
    revision: 1,
    signature: reviewDraftSignature(data),
    disk: null,
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120_000,
    },
    registryGeneration: "1",
  };
}
function install(
  initial: SyncState<ComparisonReviewData>,
  api: <T>(path: string, body?: object) => Promise<T | null>,
  options: {
    storage?: MemoryStorage;
    tab?: MemoryStorage;
    id?: string;
    projection?: (value: RevisionDraft) => RevisionDraft;
    flush?: () => void;
    adopt?: (base: RevisionDraft, markdown: string) => RevisionDraft | null;
  } = {},
) {
  const controller = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    {
      request: api,
      storage: options.storage ?? new MemoryStorage(),
      tabStorage: options.tab ?? new MemoryStorage(),
      id: () => options.id ?? "page",
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) =>
      options.projection?.(value) ?? {
        ...value,
        cleanMarkdown: value.cleanMarkdown ?? value.markdown,
      },
    adopt: options.adopt ?? (() => null),
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
    flush: options.flush,
  });
  controller.start();
  return controller;
}
function commit(
  server: SyncState<ComparisonReviewData>,
  body: ReconcileRequest,
) {
  const merged = mergeReviewDrafts(body.base, body.draft, server.draft, {
    server: false,
    budgetMs: 100,
  });
  if (merged.status !== "merged")
    throw new Error(`Unexpected test merge ${merged.status}`);
  const revision = server.revision + 1;
  return {
    ...server,
    draft: merged.draft,
    revision,
    signature: reviewDraftSignature(merged.draft),
    registryGeneration: String(revision),
    review: {
      ...server.review,
      revision,
      draft: merged.draft,
      reviewComments: merged.draft.reviewComments,
      lastOperation: {
        id: body.operationId,
        pageInstanceId: body.pageInstanceId,
        reason: body.reason,
      },
    },
  };
}

test("continuous typing commits coalesced generations before typing stops", async () => {
  let server = state();
  const times: number[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/reconcile")) {
      server = commit(server, body as ReconcileRequest);
      times.push(Date.now());
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 40; index++) {
    controller.updateDraft((current) =>
      draft(current.markdown.replace("Last.", `Last.${index} `)),
    );
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(times.length).toBeGreaterThanOrEqual(4);
  expect(times[0]).toBeLessThan(Date.now() - 1000);
  expect(controller.getSnapshot().writePaused).toBe(false);
  await controller.flush();
  expect(server.draft.markdown).toBe(controller.readDraft().markdown);
});

test("autosave sends a coalesced snapshot without reserializing newer live typing; explicit flush captures it", async () => {
  let server = state();
  let live = server.draft.markdown;
  let controller: RevisionSessionController;
  const flush = vi.fn(() => controller.updateDraft(() => draft(live)));
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/reconcile")) {
      server = commit(server, body as ReconcileRequest);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  controller = install(server, api, {
    flush,
    projection: (value) => {
      live = value.markdown;
      return value;
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  flush.mockClear();
  controller.updateDraft(() => draft("Coalesced snapshot.\n"), {
    readyToSave: true,
  });
  live = "Coalesced snapshot with newer live typing.\n";
  await vi.advanceTimersByTimeAsync(0);
  expect(flush).not.toHaveBeenCalled();
  expect(server.draft.markdown).toBe("Coalesced snapshot.\n");
  expect(live).toBe("Coalesced snapshot with newer live typing.\n");
  await controller.flush();
  expect(flush).toHaveBeenCalledTimes(1);
  expect(server.draft.markdown).toBe(live);
});

test.each([
  true,
  false,
])("incoming peer state retains buffered typing with the registered adapter's flush contract (rebases=%s)", async (rebasesBufferedDocument) => {
  let server = state();
  let live = server.draft.markdown;
  const controller = new RevisionSessionController(
    server.review,
    server.draft as RevisionDraft,
    {
      request: async <T>(_path: string, body?: object) => {
        if (body) throw new Error("Observing peer state must not publish");
        return structuredClone(server) as T;
      },
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
      id: () => "buffered-page",
    },
  );
  controllers.push(controller);
  const flush = vi.fn(() =>
    controller.updateDraft(() => draft(live), { readyToSave: false }),
  );
  controller.setAdapter({
    rebasesBufferedDocument,
    flush,
    apply: (value, options) => {
      const result =
        rebasesBufferedDocument && options?.localBase
          ? mergeReviewDrafts(options.localBase, draft(live), value, {
              server: false,
            })
          : { status: "merged", draft: value };
      if (result.status !== "merged")
        throw new Error("Independent buffered text and peer text must merge");
      live = result.draft.markdown;
      return result.draft as RevisionDraft;
    },
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  flush.mockClear();

  controller.updateDraft(() => draft("My first.\n\nLast.\n"), {
    readyToSave: false,
  });
  live = "My first. Newer buffered typing.\n\nLast.\n";
  server = state("First.\n\nPeer last.\n");
  server.revision = server.review.revision = 2;
  server.registryGeneration = "2";
  await controller.refresh(true);

  expect(live).toBe("My first. Newer buffered typing.\n\nPeer last.\n");
  expect(controller.readDraft().markdown).toBe(live);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(controller.getSnapshot().writePaused).toBe(false);
  if (rebasesBufferedDocument) expect(flush).not.toHaveBeenCalled();
  else expect(flush).toHaveBeenCalled();
});

test.each([
  "incoming",
  "local",
] as const)("resolving a disk conflict chooses %s against actual disk and preserves both checkpoints", async (choice) => {
  let server = state("Original paragraph.\n\nLast.\n");
  server.review = {
    ...server.review,
    destinationPath: "/practice.md",
    savedText: server.draft.markdown,
  };
  server.disk = {
    path: "/practice.md",
    version: "v1",
    hash: "one",
    text: server.draft.markdown,
    availability: "available",
  };
  const checkpoints: RevisionDraft[] = [];
  const writes: ReconcileRequest[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/checkpoint")) {
      checkpoints.push((body as { workingDraft: RevisionDraft }).workingDraft);
      return { checkpointId: `copy-${checkpoints.length}` } as T;
    }
    if (path.endsWith("/reconcile")) {
      const request = body as ReconcileRequest;
      writes.push(request);
      server = commit(server, request);
      if (request.writeFile) {
        server.disk = {
          ...required(server.disk),
          text: request.draft.cleanMarkdown ?? request.draft.markdown,
          version: "v3",
        };
      }
      server.review = { ...server.review, savedText: server.disk?.text };
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api, {
    adopt: (_base, text) => draft(text),
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("My paragraph.\n\nLast.\n"));
  server = {
    ...server,
    disk: {
      ...required(server.disk),
      text: "Agent paragraph.\n\nLast.\n",
      version: "v2",
      hash: "two",
    },
  };
  await controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
  const signature = required(controller.getSnapshot().conflict).signature;
  expect(await controller.resolveConflict(choice, signature)).toBe(true);
  expect(controller.readDraft().markdown).toContain(
    choice === "incoming" ? "Agent paragraph." : "My paragraph.",
  );
  expect(writes.at(-1)?.writeFile).toBe(choice === "local");
  expect(checkpoints.map((entry) => entry.markdown)).toEqual(
    expect.arrayContaining([
      "My paragraph.\n\nLast.\n",
      "Agent paragraph.\n\nLast.\n",
    ]),
  );
});

test("a repeated incoming notice retains the completed local recovery checkpoint", async () => {
  let server = state("Original.\n");
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/checkpoint"))
      return { checkpointId: "saved-copy" } as T;
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("Mine.\n"));
  server = { ...server, draft: draft("Theirs.\n") };
  server.review = { ...server.review, draft: server.draft };
  await controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict?.checkpointSaved).toBe(true);
  await controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict?.checkpointSaved).toBe(true);
});

test("Send records the current feedback without initiating its pending file autosave", async () => {
  let server = state("Original.\n");
  server.review = {
    ...server.review,
    destinationPath: "/practice.md",
    savedText: server.draft.markdown,
  };
  server.disk = {
    path: "/practice.md",
    version: "one",
    hash: "one",
    text: server.draft.markdown,
    availability: "available",
  };
  const calls: Array<{ path: string; writeFile: boolean }> = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    const request = body as ReconcileRequest;
    calls.push({ path, writeFile: request.writeFile });
    server = commit(server, request);
    return { status: "committed", state: structuredClone(server) } as T;
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("New feedback.\n"));
  await controller.run("send", controller.readDraft(), { comment: "Ready" });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([{ path: "/review/send", writeFile: false }]);
  expect(controller.getSnapshot().fileWritePending).toBe(true);
  expect(server.draft.markdown).toBe("New feedback.\n");
});

test("an older notice queued during an own save cannot roll back its acknowledged revision", async () => {
  let server = state();
  const old = structuredClone(server);
  let release: ((result: SyncResult<ComparisonReviewData>) => void) | undefined;
  let response: SyncResult<ComparisonReviewData> | undefined;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/reconcile")) {
      server = commit(server, body as ReconcileRequest);
      if (!release) {
        response = { status: "committed", state: structuredClone(server) };
        return await new Promise<T>((resolve) => {
          release = resolve as (
            value: SyncResult<ComparisonReviewData>,
          ) => void;
        });
      }
      return { status: "committed", state: structuredClone(server) } as T;
    }
    if (path.endsWith("/checkpoint")) return { checkpointId: "copy" } as T;
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("Saved first.\n\nLast.\n"));
  await vi.advanceTimersByTimeAsync(300);
  const emitted: string[] = [];
  controller.subscribe(() => emitted.push(controller.readDraft().markdown));
  notifications.get("review")?.({ reason: "changed", state: old });
  controller.updateDraft(() => draft("Saved first.\n\nNewer local last.\n"));
  if (!release || !response) throw new Error("Expected the held save");
  release(response);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(50);
  expect(emitted.every((value) => value.includes("Saved first."))).toBe(true);
  expect(controller.readDraft().markdown).toContain("Saved first.");
  expect(controller.readDraft().markdown).toContain("Newer local last.");
  expect(controller.getSnapshot().conflict).toBeNull();
});

test("the first flush rebases preserved local work before it may write a newer loaded review", async () => {
  const initial = state("Original.\n");
  const latest = state("External.\n");
  latest.revision = 2;
  latest.review = {
    ...latest.review,
    revision: 2,
    destinationPath: "/practice.md",
    savedPath: "/practice.md",
    savedText: "External.\n",
  };
  latest.disk = {
    path: "/practice.md",
    version: "two",
    hash: "two",
    text: "External.\n",
    availability: "available",
  };
  const writes: ReconcileRequest[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return structuredClone(latest) as T;
    }
    if (path.endsWith("/checkpoint")) return { checkpointId: "copy" } as T;
    if (path.endsWith("/reconcile")) {
      writes.push(body as ReconcileRequest);
      return {
        status: "committed",
        state: { ...latest, draft: (body as ReconcileRequest).draft },
      } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(initial, api);
  controller.updateDraft(() => draft("My preserved work.\n"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(writes).toHaveLength(0);
  expect(controller.readDraft().markdown).toBe("My preserved work.\n");
  expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
});

test("reload retains an unfinished comment editor even when document and saved comments are unchanged", () => {
  const initial = state();
  const storage = new MemoryStorage();
  const tab = new MemoryStorage();
  const ui = {
    comments: {
      c1: {
        value: "My unfinished reply",
        original: "Original comment",
        editing: true,
      },
    },
  };
  const first = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    { storage, tabStorage: tab, id: () => "first-page" },
  );
  controllers.push(first);
  first.setAdapter({
    apply: (value) => value,
    adopt: () => null,
    readUiDrafts: () => ui,
    restoreUiDrafts: () => {},
  });
  first.stop();
  const restore = vi.fn();
  const second = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    { storage, tabStorage: tab, id: () => "second-page" },
  );
  controllers.push(second);
  second.setAdapter({
    apply: (value) => value,
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: restore,
  });
  expect(restore).toHaveBeenCalledWith(ui);
});

test.each([
  "event-first",
  "response-first",
])("a server-merged own save retains later typing in %s order", async (order) => {
  let server = state();
  let release: ((value: SyncResult<ComparisonReviewData>) => void) | undefined;
  let first = true;
  let committed: SyncResult<ComparisonReviewData> | undefined;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/reconcile")) {
      if (first) {
        first = false;
        server = {
          ...server,
          draft: draft(
            server.draft.markdown.replace("First.", "Remote first."),
          ),
        };
        server.review = { ...server.review, draft: server.draft };
        server = commit(server, body as ReconcileRequest);
        committed = { status: "committed", state: structuredClone(server) };
        return await new Promise<T>((resolve) => {
          release = resolve as (
            value: SyncResult<ComparisonReviewData>,
          ) => void;
        });
      }
      server = commit(server, body as ReconcileRequest);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft((current) =>
    draft(current.markdown.replace("Last.", "Local last.")),
  );
  await vi.advanceTimersByTimeAsync(300);
  controller.updateDraft((current) =>
    draft(current.markdown.replace("Local last.", "Local last continued.")),
  );
  expect(release).toBeDefined();
  if (order === "event-first") {
    notifications.get("review")?.({
      reason: "changed",
      state: structuredClone(server),
    });
    await vi.advanceTimersByTimeAsync(0);
    release?.(required(committed));
  } else {
    release?.(required(committed));
    await vi.advanceTimersByTimeAsync(0);
    notifications.get("review")?.({
      reason: "changed",
      state: structuredClone(server),
    });
  }
  await vi.advanceTimersByTimeAsync(1);
  expect(controller.readDraft().markdown).toContain("Remote first.");
  expect(controller.readDraft().markdown).toContain("Local last continued.");
  expect(controller.getSnapshot().conflict).toBeNull();
  await controller.flush();
  expect(server.draft.markdown).toContain("Remote first.");
  expect(server.draft.markdown).toContain("Local last continued.");
});

test("resolving an older committed save also applies the newer authoritative peer revision", async () => {
  let server = state();
  let saved: SyncState<ComparisonReviewData> | undefined;
  let held: ReconcileRequest | undefined;
  let first = true;
  const storage = new MemoryStorage();
  const tab = new MemoryStorage();
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.includes("/operations/"))
      return {
        status: "committed",
        state: structuredClone(required(saved)),
      } as T;
    if (path.endsWith("/reconcile")) {
      held = body as ReconcileRequest;
      server = commit(server, held);
      if (first) {
        first = false;
        saved = structuredClone(server);
        throw new Error("response lost");
      }
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const before = install(server, api, { storage, tab, id: "before" });
  await vi.advanceTimersByTimeAsync(0);
  before.updateDraft(() => draft("First.\n\nMy saved last.\n"));
  await vi.advanceTimersByTimeAsync(300);
  before.stop();
  const peer = draft("Remote first.\n\nMy saved last.\n");
  server = {
    ...server,
    draft: peer,
    revision: 3,
    signature: reviewDraftSignature(peer),
    registryGeneration: "3",
    review: {
      ...server.review,
      draft: peer,
      revision: 3,
      lastOperation: {
        id: "peer",
        pageInstanceId: "peer-page",
        reason: "sync",
      },
    },
  };
  const after = install(server, api, { storage, tab, id: "after" });
  await vi.advanceTimersByTimeAsync(700);
  expect(held).toBeDefined();
  expect(after.readDraft().markdown).toContain("Remote first.");
  expect(after.readDraft().markdown).toContain("My saved last.");
});

test("explicit feedback restore preserves current UI drafts and rejects a reused comment target", async () => {
  const markdown = "A {==target==}{>>Original comment<<}{#c1}.\n";
  const initial = state(markdown);
  initial.draft.reviewComments = [
    {
      id: "c1",
      changeId: "document",
      content: "Original comment",
      createdAt: "2026-01-01",
    },
  ];
  initial.review.reviewComments = initial.draft.reviewComments;
  let ui: Record<string, unknown> = {
    comments: {
      c2: { value: "Current unfinished work", original: "", editing: true },
    },
  };
  const preserved: unknown[] = [];
  const restore = vi.fn((value: Record<string, unknown>) => {
    ui = value;
  });
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(initial) as T;
    if (path.endsWith("/checkpoint")) {
      preserved.push((body as { uiDrafts: unknown }).uiDrafts);
      return { checkpointId: "copy" } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    {
      request: api,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => value,
    adopt: () => null,
    readUiDrafts: () => ui,
    restoreUiDrafts: restore,
  });
  const requested = {
    comments: {
      c1: {
        value: "Recovered unfinished comment",
        original: "Original comment",
        editing: true,
      },
    },
  };
  expect(
    await controller.restoreRecoveryUi({
      entryDraft: initial.draft,
      workingDraft: initial.draft,
      uiDrafts: requested,
    }),
  ).toEqual({ restored: 1, skipped: 0 });
  expect(preserved).toEqual([
    {
      comments: {
        c2: { value: "Current unfinished work", original: "", editing: true },
      },
    },
  ]);
  expect(restore).toHaveBeenLastCalledWith({
    ...requested,
    suggestion: undefined,
  });
  restore.mockClear();
  expect(
    await controller.restoreRecoveryUi({
      entryDraft: initial.draft,
      workingDraft: {
        ...initial.draft,
        markdown: markdown.replace("target", "different passage"),
      },
      uiDrafts: requested,
    }),
  ).toEqual({ restored: 0, skipped: 1 });
  expect(restore).not.toHaveBeenCalled();
});

test.each([
  "unchanged",
  "moved",
  "modified",
  "missing",
  "reused",
  "new author",
  "new kind",
])("private reply recovery validates the semantic proposal parent: %s", async (scenario) => {
  const source =
    'A {~~old~>proposed~~}{#s2} replacement.\n\n---\nsuggestions:\n  s2:\n    by: User\n    at: "2026-11-26T12:00:00.000Z"\n';
  const changed =
    scenario === "moved"
      ? `New paragraph above.\n\n${source}`
      : scenario === "modified"
        ? source.replace("proposed", "rewritten")
        : scenario === "missing"
          ? source.replace("{~~old~>proposed~~}{#s2}", "old")
          : scenario === "reused"
            ? source.replace("12:00:00", "12:01:00")
            : scenario === "new author"
              ? source.replace("by: User", "by: AI")
              : scenario === "new kind"
                ? source.replace("{~~old~>proposed~~}", "{++proposed++}")
                : source;
  const initial = state(changed);
  const ui = new RevisionUiDraftStore();
  const mutated = vi.fn();
  const controller = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    {
      request: async <T>(_path: string, body?: object) => {
        if (body) {
          mutated();
          throw new Error("Restoring a private reply must not publish it");
        }
        return null as T | null;
      },
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => value,
    adopt: () => null,
    readUiDrafts: ui.read,
    restoreUiDrafts: ui.restore,
  });
  const original = draft(source);
  const result = await controller.restoreRecoveryUi({
    entryDraft: original,
    workingDraft: original,
    uiDrafts: {
      comments: {
        c9: {
          value: "Unsubmitted proposal reply",
          original: "",
          editing: true,
          target: {
            id: "c9",
            content: "",
            createdAt: "2026-11-26T12:02:00.000Z",
            parentCommentId: "s2",
          },
        },
      },
    },
  });
  const accepted = scenario === "unchanged" || scenario === "moved";
  expect(result).toEqual(
    accepted ? { restored: 1, skipped: 0 } : { restored: 0, skipped: 1 },
  );
  expect(ui.getSnapshot().comments.c9?.value).toBe(
    accepted ? "Unsubmitted proposal reply" : undefined,
  );
  expect(controller.readDraft().reviewComments).toEqual([]);
  expect(mutated).not.toHaveBeenCalled();
});

test("UI-only edits advance the captured copy generation and a late result keeps newer unfinished feedback", async () => {
  const initial = state();
  const store = new RevisionUiDraftStore();
  let release: ((result: SyncResult<ComparisonReviewData>) => void) | undefined;
  let generation: number | undefined;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(initial) as T;
    if (path.endsWith("/copy")) {
      generation = (body as { generation: number }).generation;
      return await new Promise<T>((resolve) => {
        release = resolve as (value: SyncResult<ComparisonReviewData>) => void;
      });
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    {
      request: api,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => value,
    adopt: () => null,
    readUiDrafts: store.read,
    restoreUiDrafts: store.restore,
    subscribeUiDrafts: store.subscribe,
  });
  await vi.advanceTimersByTimeAsync(0);
  const pending = controller.copy("/copy.md", false);
  await vi.advanceTimersByTimeAsync(0);
  controller.setCopyLocked(false);
  store.setComment("c1", {
    value: "Newer unfinished text",
    original: "Original",
    editing: true,
  });
  expect(controller.getGeneration()).toBeGreaterThan(generation ?? -1);
  expect(controller.getSnapshot().recoveryPending).toBe(false);
  if (!release) throw new Error("Expected the pending copy");
  release({
    status: "committed",
    savedPath: "/copy.md",
    state: { ...initial, review: { ...initial.review, id: "copy" } },
  });
  await pending;
  expect(controller.getSnapshot().session.id).toBe("review");
  expect(store.getSnapshot().comments.c1.value).toBe("Newer unfinished text");
});

test("a held recovery write coalesces its newer draft and resolution waits for that latest checkpoint", async () => {
  let server = state("Original.\n\nLast.\n");
  const checkpoints: Array<{
    body: { generation: number; workingDraft: RevisionDraft };
    release: (value: { checkpointId: string }) => void;
  }> = [];
  let writes = 0;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/checkpoint")) {
      if ((body as { reason?: string }).reason)
        return { checkpointId: "incoming-copy" } as T;
      return await new Promise<T>((resolve) => {
        checkpoints.push({
          body: body as { generation: number; workingDraft: RevisionDraft },
          release: resolve as (value: { checkpointId: string }) => void,
        });
      });
    }
    if (path.endsWith("/reconcile")) {
      writes++;
      server = commit(server, body as ReconcileRequest);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("Mine.\n\nLast.\n"));
  server = { ...server, draft: draft("Peer.\n\nLast.\n"), revision: 2 };
  server.review = { ...server.review, draft: server.draft, revision: 2 };
  await controller.refresh(true);
  expect(checkpoints).toHaveLength(1);
  const signature = required(controller.getSnapshot().conflict).signature;
  const resolving = controller.resolveConflict("incoming", signature);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("Mine.\n\nLast with extra.\n"));
  await vi.advanceTimersByTimeAsync(300);
  checkpoints[0].release({ checkpointId: "local-copy" });
  await vi.advanceTimersByTimeAsync(0);
  expect(checkpoints).toHaveLength(2);
  expect(checkpoints[1].body.generation).toBeGreaterThan(
    checkpoints[0].body.generation,
  );
  expect(checkpoints[1].body.workingDraft.markdown).toContain("extra");
  expect(controller.getSnapshot().conflict?.checkpointSaved).toBe(false);
  expect(writes).toBe(0);
  checkpoints[1].release({ checkpointId: "local-copy" });
  expect(await resolving).toBe(true);
  expect(controller.readDraft().markdown).toContain("Peer.");
  expect(controller.readDraft().markdown).toContain("Last with extra.");
});

test("background recovery writes the trailing generation after a held request without another keystroke", async () => {
  let server = state("Original.\n\nLast.\n");
  const saves: Array<{
    generation: number;
    release: (value: { checkpointId: string }) => void;
  }> = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/checkpoint"))
      return await new Promise<T>((resolve) =>
        saves.push({
          generation: (body as { generation: number }).generation,
          release: resolve as (value: { checkpointId: string }) => void,
        }),
      );
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("Mine.\n\nLast.\n"));
  server = { ...server, draft: draft("Peer.\n\nLast.\n") };
  server.review = { ...server.review, draft: server.draft };
  await controller.refresh(true);
  expect(saves).toHaveLength(1);
  controller.updateDraft(() => draft("Mine.\n\nLast updated.\n"));
  await vi.advanceTimersByTimeAsync(300);
  saves[0].release({ checkpointId: "copy" });
  await vi.advanceTimersByTimeAsync(0);
  expect(saves).toHaveLength(1);
  expect(controller.getSnapshot().conflict?.checkpointSaved).toBe(false);
  await vi.advanceTimersByTimeAsync(300);
  expect(saves).toHaveLength(2);
  expect(saves[1].generation).toBeGreaterThan(saves[0].generation);
  saves[1].release({ checkpointId: "copy" });
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict?.checkpointSaved).toBe(true);
});

test("reload resolves a never-received old operation before resuming under a fresh page ID", async () => {
  let server = state();
  const storage = new MemoryStorage();
  const tab = new MemoryStorage();
  let offline = true;
  const sent: ReconcileRequest[] = [];
  const resolved: object[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.includes("/operations/")) {
      resolved.push(body);
      return { status: "not-received", state: structuredClone(server) } as T;
    }
    if (path.endsWith("/reconcile")) {
      sent.push(body as ReconcileRequest);
      if (offline) throw new Error("offline");
      server = commit(server, body as ReconcileRequest);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const first = install(server, api, { storage, tab, id: "first-page" });
  await vi.advanceTimersByTimeAsync(0);
  first.updateDraft((current) =>
    draft(current.markdown.replace("Last.", "Recovered last.")),
  );
  await vi.advanceTimersByTimeAsync(300);
  first.stop();
  offline = false;
  server = {
    ...server,
    operationContext: {
      ...server.operationContext,
      epoch: "after-restart",
      acceptUntil: Date.now() + 120_000,
    },
  };
  const second = install(server, api, { storage, tab, id: "second-page" });
  await vi.advanceTimersByTimeAsync(700);
  expect(resolved).toHaveLength(1);
  expect(sent.at(-1)?.pageInstanceId).toBe("second-page");
  expect(sent.at(-1)?.operationId).not.toBe(sent[0].operationId);
  expect(server.draft.markdown).toContain("Recovered last.");
  expect(second.getSnapshot().writePaused).toBe(false);
});

test("an uncertain publication keeps its operation ID until resolve reports a commit", async () => {
  let server = state();
  let publishing = true;
  let firstBody: ReconcileRequest | undefined;
  const identities: string[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.includes("/checkpoint"))
      return { checkpointId: "checkpoint" } as T;
    if (path.includes("/operations/")) {
      expect((body as { operationId: string }).operationId).toBe(
        firstBody?.operationId,
      );
      server = commit(server, required(firstBody));
      publishing = false;
      return { status: "committed", state: structuredClone(server) } as T;
    }
    if (path.endsWith("/reconcile")) {
      const request = body as ReconcileRequest;
      identities.push(request.operationId);
      if (publishing) {
        firstBody = request;
        return { status: "publishing", state: structuredClone(server) } as T;
      }
      server = commit(server, request);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft((current) =>
    draft(current.markdown.replace("Last.", "Local last.")),
  );
  await vi.advanceTimersByTimeAsync(300);
  expect(controller.getSnapshot().writePaused).toBe(true);
  controller.updateDraft((current) =>
    draft(current.markdown.replace("Local last.", "Local last continued.")),
  );
  await controller.retry();
  expect(identities.length).toBeGreaterThanOrEqual(2);
  expect(new Set(identities).size).toBe(identities.length);
  expect(server.draft.markdown).toContain("Local last continued.");
});

test.each([
  ["review", "A newer saved review is available."],
  ["file", "The file changed on disk."],
  ["both", "The file changed on disk and a newer saved review is available."],
] as const)("overlap notices identify the observed %s update", async (source, message) => {
  let server = state();
  const controller = install(
    server,
    async <T>(_path: string, body?: object) =>
      body
        ? ({ checkpointId: "preserved" } as T)
        : (structuredClone(server) as T),
    { adopt: (_base, markdown) => draft(markdown) },
  );
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("My first.\n\nLast.\n"));
  if (source !== "file") {
    server = state("Peer first.\n\nLast.\n");
    server.revision = 2;
    server.review.revision = 2;
  }
  if (source !== "review") {
    server.review.savedText = "First.\n\nLast.\n";
    server.disk = {
      path: "/practice.md",
      version: "incoming",
      hash: "hash",
      availability: "available",
      text: "File first.\n\nLast.\n",
    };
  }
  await controller.refresh(true);
  expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
  expect(controller.getSnapshot().conflict?.message).toContain(message);
});

test("normalizing the browser projection never writes an untouched annotated source", async () => {
  const markdown = "{~~\nOriginal.\n~>\nProposed.\n~~}{#s1}\n";
  const initial = state(markdown);
  initial.draft = { ...draft(markdown), cleanMarkdown: "\nOriginal.\n\n" };
  initial.review = {
    ...initial.review,
    draft: initial.draft,
    destinationPath: "/practice.md",
    savedPath: "/practice.md",
    savedText: markdown,
    autosave: "/practice.md",
  };
  initial.disk = {
    path: "/practice.md",
    version: "v1",
    hash: "hash",
    text: markdown,
    availability: "available",
  };
  let server = initial;
  const writes: boolean[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/reconcile")) {
      writes.push((body as ReconcileRequest).writeFile);
      server = commit(server, body as ReconcileRequest);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = new RevisionSessionController(
    initial.review,
    { ...draft(markdown), cleanMarkdown: "Original.\n" },
    {
      request: api,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => ({ ...value, cleanMarkdown: "Original.\n" }),
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(700);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((write) => !write)).toBe(true);
  expect(server.review.savedText).toBe(markdown);
});

test("opening an annotated review preserves its saved clean file until an actual source edit", async () => {
  const markdown = "The {++new ++}{#s1}draft.\n## Footer\nFooter stays.\n";
  const savedClean = "The draft.\n## Footer\nFooter stays.\n";
  const normalizedClean = "The draft.\n\n## Footer\nFooter stays.\n";
  let server = state(markdown);
  server.draft = { ...draft(markdown), cleanMarkdown: savedClean };
  server.signature = reviewDraftSignature(server.draft);
  server.review = {
    ...server.review,
    draft: server.draft,
    destinationPath: "/feedback-copy.md",
    savedPath: "/feedback-copy.md",
    savedText: savedClean,
    autosave: "/feedback-copy.md",
  };
  server.disk = {
    path: "/feedback-copy.md",
    version: "v1",
    hash: "hash",
    text: savedClean,
    availability: "available",
  };
  const writes: ReconcileRequest[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
    const sent = body as ReconcileRequest;
    writes.push(structuredClone(sent));
    server = commit(server, sent);
    if (sent.writeFile) {
      const text = sent.draft.cleanMarkdown ?? sent.draft.markdown;
      server.disk = {
        ...required(server.disk),
        text,
        version: `v${server.revision}`,
      };
      server.review = { ...server.review, savedText: text };
    }
    return { status: "committed", state: structuredClone(server) } as T;
  };
  const projection = (value: RevisionDraft) => ({
    ...value,
    cleanMarkdown:
      value.cleanMarkdown ??
      (value.markdown === markdown ? normalizedClean : value.markdown),
    reviewComments: [
      {
        id: "c1",
        changeId: "document",
        content: "An imported comment retained by review synchronization.",
        createdAt: "2026-11-26T12:00:00.000Z",
      },
    ],
  });
  const firstController = install(server, api, { projection });
  await vi.advanceTimersByTimeAsync(700);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((sent) => !sent.writeFile)).toBe(true);
  expect(server.disk?.text).toBe(savedClean);
  firstController.stop();

  // A new browser has no in-memory disk-projection cache from the first load.
  const controller = install(server, api, { projection });
  await vi.advanceTimersByTimeAsync(700);
  expect(writes.every((sent) => !sent.writeFile)).toBe(true);
  expect(server.disk?.text).toBe(savedClean);
  expect(server.draft.cleanMarkdown).toBe(savedClean);
  expect(controller.getSnapshot().fileWritePending).toBe(false);

  controller.updateDraft((current) => ({
    ...current,
    markdown: current.markdown.replace("Footer stays.", "Footer edited."),
    cleanMarkdown: normalizedClean.replace("Footer stays.", "Footer edited."),
  }));
  await controller.flush();
  expect(writes.at(-1)?.writeFile).toBe(true);
  expect(server.disk?.text).toBe(
    normalizedClean.replace("Footer stays.", "Footer edited."),
  );

  controller.updateDraft((current) => ({
    ...current,
    markdown: current.markdown.replace("\n## Footer", "\n\n## Footer"),
    cleanMarkdown: current.cleanMarkdown?.replace(
      "\n\n## Footer",
      "\n\n\n## Footer",
    ),
  }));
  await controller.flush();
  expect(writes.at(-1)?.writeFile).toBe(true);
  expect(server.disk?.text).toContain("\n\n\n## Footer");
  controller.stop();

  // A saved review can legitimately have prose awaiting publication, for
  // example after Send feedback. Its next browser must still write that prose.
  const pendingMarkdown = server.draft.markdown.replace(
    "Footer edited.",
    "Footer edited again.",
  );
  const pendingClean = server.draft.cleanMarkdown?.replace(
    "Footer edited.",
    "Footer edited again.",
  );
  server.draft = {
    ...server.draft,
    markdown: pendingMarkdown,
    cleanMarkdown: pendingClean,
  };
  server.review = { ...server.review, draft: server.draft };
  server.signature = reviewDraftSignature(server.draft);
  install(server, api, {
    projection: (value) => ({
      ...value,
      cleanMarkdown: value.cleanMarkdown ?? pendingClean,
    }),
  });
  await vi.advanceTimersByTimeAsync(700);
  expect(writes.at(-1)?.writeFile).toBe(true);
  expect(server.disk?.text).toBe(pendingClean);
});

test("a fresh maintained review normalizes through a merge reservation without writing its annotated file", async () => {
  const markdown = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const model = schema.nodeFromJSON({
    ...parsed.doc,
    attrs: {
      sourceMetadata: {
        markdown,
        frontmatter: parsed.frontmatter,
        endmatter: parsed.endmatter,
      },
    },
  });
  const clean = cleanSourceFromNode(markdown, model, parsed.comments);
  let server = state(markdown);
  server.draft = { markdown, decisions: {}, reviewComments: [] };
  server.review = {
    ...server.review,
    draft: null,
    reviewComments: [],
    destinationPath: "/fixture.md",
    savedPath: "/fixture.md",
    savedText: markdown,
    autosave: "/fixture.md",
  };
  server.disk = {
    path: "/fixture.md",
    version: "v1",
    hash: "hash",
    text: markdown,
    availability: "available",
  };
  const writes: boolean[] = [];
  let first = true;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/reconcile")) {
      const request = body as ReconcileRequest;
      writes.push(request.writeFile);
      if (first) {
        first = false;
        return {
          status: "base-unavailable",
          state: structuredClone(server),
          reservation: {
            token: "reserved",
            revision: 1,
            expiresAt: Date.now() + 750,
          },
        } as T;
      }
      server = commit(server, request);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const seed = {
    markdown,
    cleanMarkdown: cleanRevisionMarkdown(markdown),
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: comment.parentCommentId ?? "document",
    })),
  };
  const controller = new RevisionSessionController(server.review, seed, {
    request: api,
    storage: new MemoryStorage(),
    tabStorage: new MemoryStorage(),
  });
  controllers.push(controller);
  let normalized = 0;
  controller.setAdapter({
    apply: (draft) => ({
      ...draft,
      cleanMarkdown: normalized++ ? `${clean}\n\n` : clean,
    }),
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(700);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((write) => !write)).toBe(true);
  expect(server.review.savedText).toBe(markdown);
  expect(server.draft.reviewComments).toHaveLength(parsed.comments.size);
  expect(controller.getSnapshot().fileWritePending).toBe(false);
});

test("two fresh pages materialize one undated inline comment without a false conflict", async () => {
  const markdown = "An {==anchor==}{>>One imported comment.<<}{#c1}.\n";
  let server = state(markdown);
  server.draft = { markdown, decisions: {}, reviewComments: [] };
  server.review = { ...server.review, draft: null, reviewComments: [] };
  const initial = structuredClone(server.review);
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/checkpoint")) return { checkpointId: "copy" } as T;
    if (path.endsWith("/reconcile")) {
      server = commit(server, body as ReconcileRequest);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  function page(id: string) {
    const parsed = criticMarkdownToEditorState(markdown);
    const seed = {
      markdown,
      cleanMarkdown: "An anchor.\n",
      decisions: {},
      reviewComments: [...parsed.comments.values()].map((comment) => ({
        ...comment,
        changeId: "document",
      })),
    };
    const controller = new RevisionSessionController(initial, seed, {
      id: () => id,
      request: api,
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    });
    controllers.push(controller);
    return controller;
  }
  const first = page("first");
  vi.setSystemTime(Date.now() + 1000);
  const second = page("second");
  for (const controller of [first, second]) {
    controller.setAdapter({
      apply: (value) => ({ ...value, cleanMarkdown: "An anchor.\n" }),
      adopt: () => null,
      readUiDrafts: () => ({}),
      restoreUiDrafts: () => {},
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(300);
  }
  expect(await first.flush()).toBe(true);
  expect(await second.flush()).toBe(true);
  expect(first.getSnapshot().conflict).toBeNull();
  expect(second.getSnapshot().conflict).toBeNull();
  expect(server.draft.reviewComments).toHaveLength(1);
  expect(server.draft.reviewComments[0].id).toBe("c1");
});

test.each([
  "not-received",
  "rejected",
  "indeterminate",
] as const)("reload preserves and reinspects a pending copy's chosen destination after %s", async (status) => {
  const server = state();
  const storage = new MemoryStorage();
  const tab = new MemoryStorage();
  const chosen = "/my-chosen-recovery-copy.md";
  const copies: string[] = [];
  const inspected: Array<string | undefined> = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (path.includes("/operations/"))
      return { status, state: structuredClone(server) } as T;
    if (path.endsWith("/copy-destination")) {
      const candidate = (body as { path?: string }).path;
      inspected.push(candidate);
      return {
        displayPath: candidate ?? "/new-generated-default.md",
        allowed: true,
        relativeLinks: [],
      } as T;
    }
    if (path.endsWith("/copy")) {
      copies.push((body as { path: string }).path);
      throw new Error("The copy request never received a response");
    }
    if (path.endsWith("/checkpoint"))
      return { checkpointId: "private-recovery" } as T;
    if (body) throw new Error(`Unexpected mutation ${path}`);
    return structuredClone(server) as T;
  };
  const first = install(server, api, { storage, tab, id: "before-reload" });
  await vi.advanceTimersByTimeAsync(0);
  await expect(first.copy(chosen, false)).rejects.toThrow("never received");
  first.stop();
  const reloaded = install(server, api, { storage, tab, id: "after-reload" });
  await vi.advanceTimersByTimeAsync(0);
  expect((await reloaded.inspectCopy()).displayPath).toBe(chosen);
  expect(inspected.at(-1)).toBe(chosen);
  expect(copies).toEqual([chosen]);
  if (status === "indeterminate") {
    await expect(reloaded.copy("/different-copy.md", false)).rejects.toThrow();
    expect(copies).toEqual([chosen]);
  }
  reloaded.stop();
  const reloadedAgain = install(server, api, {
    storage,
    tab,
    id: "second-reload",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect((await reloadedAgain.inspectCopy()).displayPath).toBe(chosen);
  expect(copies).toEqual([chosen]);
  if (status !== "indeterminate") {
    expect(
      (await reloadedAgain.inspectCopy("/explicit-new-choice.md")).displayPath,
    ).toBe("/explicit-new-choice.md");
    reloadedAgain.stop();
    const finalReload = install(server, api, {
      storage,
      tab,
      id: "explicit-choice-reload",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await finalReload.inspectCopy()).displayPath).toBe(
      "/explicit-new-choice.md",
    );
    expect(copies).toEqual([chosen]);
  }
});

test("continuous ready snapshots keep at most one autosave queued behind an in-flight save", async () => {
  let server = state();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitted: string[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/reconcile")) {
      const request = body as ReconcileRequest;
      submitted.push(request.draft.markdown);
      if (submitted.length === 1) await held;
      server = commit(server, request);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  const originalFlush = controller.flush;
  let outstandingAutosaves = 0;
  let maximumOutstanding = 0;
  vi.spyOn(controller, "flush").mockImplementation(
    async (includeEditor = true) => {
      if (includeEditor) return originalFlush(includeEditor);
      outstandingAutosaves++;
      maximumOutstanding = Math.max(maximumOutstanding, outstandingAutosaves);
      try {
        return await originalFlush(false);
      } finally {
        outstandingAutosaves--;
      }
    },
  );
  try {
    controller.updateDraft(() => draft("First.\n\nLocal generation 0.\n"), {
      readyToSave: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(submitted).toHaveLength(1);
    for (let generation = 1; generation <= 12; generation++) {
      controller.updateDraft(
        () => draft(`First.\n\nLocal generation ${generation}.\n`),
        {
          readyToSave: true,
        },
      );
      await vi.advanceTimersByTimeAsync(225);
    }
    expect(submitted).toHaveLength(1);
    expect(maximumOutstanding).toBeLessThanOrEqual(2);
  } finally {
    release();
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(submitted).toEqual([
    "First.\n\nLocal generation 0.\n",
    "First.\n\nLocal generation 12.\n",
  ]);
  expect(server.draft.markdown).toBe("First.\n\nLocal generation 12.\n");
});

test("ready snapshots respect the server retry deadline while retaining the newest generation", async () => {
  let server = state();
  const start = Date.now();
  const deadline = start + 750;
  const requests: Array<{ at: number; markdown: string }> = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/reconcile")) {
      const request = body as ReconcileRequest;
      requests.push({ at: Date.now(), markdown: request.draft.markdown });
      if (Date.now() < deadline)
        return {
          status: "retry-later",
          retryAfter: deadline - Date.now(),
          state: structuredClone(server),
        } as T;
      server = commit(server, request);
      return { status: "committed", state: structuredClone(server) } as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(server, api);
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("First.\n\nLocal generation 0.\n"), {
    readyToSave: true,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(1);
  for (let generation = 1; generation <= 6; generation++) {
    await vi.advanceTimersByTimeAsync(100);
    controller.updateDraft(
      () => draft(`First.\n\nLocal generation ${generation}.\n`),
      {
        readyToSave: true,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(149);
  expect(requests).toHaveLength(1);
  expect(Date.now()).toBe(deadline - 1);
  await vi.advanceTimersByTimeAsync(2);
  expect(requests).toHaveLength(2);
  expect(requests[1].at).toBeGreaterThanOrEqual(deadline);
  expect(server.draft.markdown).toBe("First.\n\nLocal generation 6.\n");
});

test.each([
  "shown",
  "not shown",
])("checking a late copy result is idempotent until displayed or a new explicit copy starts: %s", async (visibility) => {
  const initial = state();
  const storage = new MemoryStorage();
  const tab = new MemoryStorage();
  let copies = 0;
  let resolutions = 0;
  const completed: SyncResult<ComparisonReviewData> = {
    status: "committed",
    operationId: "completed-copy",
    savedPath: "/saved-copy.md",
    reviewUrl: "?comparison=saved-copy",
    state: { ...initial, review: { ...initial.review, id: "saved-copy" } },
  };
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(initial) as T;
    if (path.endsWith("/copy")) {
      copies++;
      if (copies === 1) throw new Error("Copy response lost");
      return { status: "rejected", message: "Choose another unused path" } as T;
    }
    if (path.includes("/operations/")) {
      resolutions++;
      return completed as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  let controller = install(initial, api, {
    storage,
    tab,
    id: "receipt-before",
  });
  await vi.advanceTimersByTimeAsync(0);
  await expect(controller.copy("/saved-copy.md", false)).rejects.toThrow(
    "response lost",
  );
  const abandonedDialogResult = await controller.checkCopyStatus();
  expect(abandonedDialogResult).toEqual(completed);
  expect(await controller.checkCopyStatus()).toEqual(completed);
  expect(resolutions).toBe(1);
  expect(copies).toBe(1);
  controller.stop();
  controller = install(initial, api, { storage, tab, id: "receipt-reload" });
  await vi.advanceTimersByTimeAsync(0);
  expect(await controller.checkCopyStatus()).toMatchObject({
    status: "committed",
    operationId: completed.operationId,
    savedPath: completed.savedPath,
    reviewUrl: completed.reviewUrl,
  });
  expect(resolutions).toBe(1);
  expect(copies).toBe(1);
  if (visibility === "shown") {
    controller.acknowledgeCopyResult(completed);
    expect(await controller.checkCopyStatus()).toBeNull();
  }
  await controller.copy("/new-explicit-choice.md", false);
  expect(copies).toBe(2);
  expect(await controller.checkCopyStatus()).toBeNull();
});

test("an older delayed status reply cannot resurrect a copy after a new explicit copy request", async () => {
  const initial = state();
  const completed: SyncResult<ComparisonReviewData> = {
    status: "committed",
    operationId: "older-copy",
    savedPath: "/older-copy.md",
    reviewUrl: "?comparison=older-copy",
    state: { ...initial, review: { ...initial.review, id: "older-copy" } },
  };
  let release = (_value: SyncResult<ComparisonReviewData>) => {};
  const held = new Promise<SyncResult<ComparisonReviewData>>((resolve) => {
    release = resolve;
  });
  let copies = 0;
  let statuses = 0;
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (!body) return structuredClone(initial) as T;
    if (path.endsWith("/copy")) {
      copies++;
      if (copies === 1) throw new Error("Copy response lost");
      return {
        status: "rejected",
        message: "The second path is occupied",
      } as T;
    }
    if (path.includes("/operations/")) {
      statuses++;
      return (statuses === 1 ? await held : completed) as T;
    }
    throw new Error(`Unexpected ${path}`);
  };
  const controller = install(initial, api);
  await vi.advanceTimersByTimeAsync(0);
  await expect(controller.copy("/older-copy.md", false)).rejects.toThrow(
    "response lost",
  );
  const late = controller.checkCopyStatus();
  await controller.copy("/new-explicit-copy.md", false);
  release(completed);
  expect(await late).toBeNull();
  expect(await controller.checkCopyStatus()).toBeNull();
  expect(copies).toBe(2);
  expect(statuses).toBe(2);
});
