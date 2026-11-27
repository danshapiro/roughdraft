import {
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  type RevisionRemoteAdapter,
  RevisionSessionController,
} from "./revision-session";

const notifications = vi.hoisted(
  () => new Map<string, (value: unknown) => void>(),
);
vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: (id: string, listener: (value: unknown) => void) => {
    notifications.set(id, listener);
    return () => notifications.delete(id);
  },
}));
const original = "First owner: ready.\n\nLast owner: ready.\n";
const outside = original.replace("Last owner: ready.", "Last owner: outside.");
const active: RevisionSessionController[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const controller of active.splice(0)) controller.stop();
  notifications.clear();
  vi.useRealTimers();
});
const draft = (markdown: string): RevisionDraft => ({
  markdown,
  cleanMarkdown: markdown,
  decisions: {},
  reviewComments: [],
});
type AsyncAdoption = (
  ...args: Parameters<RevisionRemoteAdapter["adopt"]>
) => Promise<ReturnType<RevisionRemoteAdapter["adopt"]>>;
async function fixture(
  evaluate: RevisionRemoteAdapter["adopt"] = () => null,
  evaluateAsync?: AsyncAdoption,
) {
  const initial = draft(original);
  let server: SyncState<ComparisonReviewData> = {
    review: {
      id: "review",
      revision: 1,
      mode: "document",
      title: "Review one outside update while typing",
      editor: "unified",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: "/practice.md",
      beforeText: original,
      afterText: original,
      segments: [],
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      targetChanged: false,
      draft: initial,
      autosave: "none",
      destinationPath: null,
      savedPath: null,
      savedText: original,
      handoff: "chat",
    },
    draft: initial,
    revision: 1,
    signature: reviewDraftSignature(initial),
    registryGeneration: "1",
    disk: {
      path: "/practice.md",
      text: original,
      version: "1",
      hash: "1",
      availability: "available",
    },
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120000,
    },
  };
  let holdApply = false;
  let indeterminate = false;
  let uiDrafts: Record<string, unknown> = {};
  let heldRead: Promise<SyncState<ComparisonReviewData>> | null = null;
  const evaluated = vi.fn(evaluate);
  const evaluatedAsync = evaluateAsync ? vi.fn(evaluateAsync) : undefined;
  const applied = vi.fn((value: RevisionDraft) =>
    holdApply && value.markdown.includes("outside") ? null : value,
  );
  const posts: ReconcileRequest[] = [];
  const checkpoints: object[] = [];
  const controller = new RevisionSessionController(server.review, initial, {
    request: async <T>(route: string, body?: object) => {
      if (!body) {
        const held = heldRead;
        heldRead = null;
        return (held ? await held : structuredClone(server)) as T;
      }
      if (route.endsWith("/checkpoint")) {
        checkpoints.push(structuredClone(body));
        return { checkpointId: "recovery-copy" } as T;
      }
      if (route.endsWith("/copy")) {
        const copy = body as { workingDraft: RevisionDraft; path: string };
        return {
          status: "committed",
          savedPath: copy.path,
          state: {
            ...structuredClone(server),
            draft: copy.workingDraft,
            review: {
              ...structuredClone(server.review),
              id: "separate-review",
              savedPath: copy.path,
              destinationPath: copy.path,
              savedText: copy.workingDraft.cleanMarkdown,
            },
          },
        } as T;
      }
      if (!route.endsWith("/reconcile") && !route.endsWith("/send"))
        throw new Error(`Unexpected ${route}`);
      const request = {
        ...body,
        ...(route.endsWith("/send") ? { reason: "send" } : {}),
      } as ReconcileRequest;
      posts.push(structuredClone(request));
      if (indeterminate)
        return { status: "indeterminate", state: structuredClone(server) } as T;
      if (request.expectedDisk?.version !== server.disk?.version)
        return {
          status: "incoming-changed",
          state: structuredClone(server),
        } as T;
      server = {
        ...server,
        draft: request.draft,
        revision: server.revision + 1,
        signature: reviewDraftSignature(request.draft),
        registryGeneration: String(Number(server.registryGeneration) + 1),
        review: {
          ...server.review,
          revision: server.revision + 1,
          draft: request.draft,
          reviewComments: request.draft.reviewComments,
          savedText:
            request.reason === "adopt"
              ? server.disk?.text
              : server.review.savedText,
          lastOperation: {
            id: request.operationId,
            pageInstanceId: request.pageInstanceId,
            reason: request.reason,
          },
        },
      };
      return { status: "committed", state: structuredClone(server) } as T;
    },
    storage: {
      length: 0,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      key: () => null,
    },
    tabStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    merge: async (base, local, incoming, options) =>
      mergeReviewDrafts(base, local, incoming, {
        ...options,
        server: false,
        budgetMs: 1000,
      }),
  });
  active.push(controller);
  const adapter = (): RevisionRemoteAdapter => ({
    apply: applied,
    adopt: evaluated,
    ...(evaluatedAsync ? { adoptAsync: evaluatedAsync } : {}),
    readUiDrafts: () => uiDrafts,
    restoreUiDrafts: () => {},
  });
  controller.setAdapter(adapter());
  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  evaluated.mockClear();
  applied.mockClear();
  const publish = async (
    change: (current: typeof server) => typeof server,
    notify = true,
  ) => {
    server = change(structuredClone(server));
    if (notify)
      notifications.get("review")?.({
        reason: "changed",
        state: structuredClone(server),
      });
    await vi.advanceTimersByTimeAsync(0);
  };
  const changedDisk = () =>
    publish((current) => ({
      ...current,
      disk: current.disk
        ? { ...current.disk, text: outside, version: "2", hash: "2" }
        : null,
    }));
  const registryNotice = (generation: number) =>
    publish((current) => ({
      ...current,
      registryGeneration: String(generation),
      review: {
        ...current.review,
        recoveryCheckpoints: [
          {
            id: "recovery-copy",
            generation,
            reason: "Unsaved conflict recovery",
            createdAt: "2026-11-27T00:00:00.000Z",
          },
        ],
      },
    }));
  return {
    controller,
    evaluated,
    evaluatedAsync,
    applied,
    posts,
    checkpoints,
    publish,
    changedDisk,
    registryNotice,
    adapter,
    blockApply: (value: boolean) => {
      holdApply = value;
    },
    setUiDrafts: (value: Record<string, unknown>) => {
      uiDrafts = value;
    },
    indeterminateSaves: () => {
      indeterminate = true;
    },
    state: () => structuredClone(server),
    notice: async (value: typeof server) => {
      notifications.get("review")?.({ reason: "changed", state: value });
      await vi.advanceTimersByTimeAsync(0);
    },
    holdRead: (value: Promise<typeof server>) => {
      heldRead = value;
    },
  };
}

test.each([
  "null",
  "waiting",
  "conflict",
] as const)("checkpoint notices and continued local typing reuse the same %s disk-adoption evaluation", async (result) => {
  const f = await fixture((base) =>
    result === "null"
      ? null
      : {
          status: result === "waiting" ? "client-merge-required" : "conflict",
          draft: base,
          conflicts: [],
          signature: reviewDraftSignature(base),
        },
  );
  await f.changedDisk();
  for (let generation = 2; generation <= 8; generation++) {
    f.controller.updateDraft((current) => ({
      ...current,
      markdown: current.markdown.replace("First owner:", "First owner: typing"),
      cleanMarkdown: current.cleanMarkdown?.replace(
        "First owner:",
        "First owner: typing",
      ),
    }));
    await f.registryNotice(generation);
  }
  expect(f.evaluated).toHaveBeenCalledTimes(1);
  expect(f.controller.readDraft().markdown.match(/typing/g)).toHaveLength(7);
  expect(f.controller.getSnapshot().writePaused).toBe(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("async adoption deduplicates in-flight checkpoint notices and merges typing received while it yields", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    () => pending.promise,
  );
  await f.changedDisk();
  for (let index = 2; index <= 4; index++) await f.registryNotice(index);
  f.controller.updateDraft((current) => ({
    ...current,
    markdown: current.markdown.replace(
      "First owner: ready.",
      "First owner: newer typing.",
    ),
    cleanMarkdown: current.cleanMarkdown?.replace(
      "First owner: ready.",
      "First owner: newer typing.",
    ),
  }));
  expect(f.evaluatedAsync).toHaveBeenCalledTimes(1);
  expect(f.evaluated).not.toHaveBeenCalled();
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.readDraft().markdown).toContain(
    "First owner: newer typing.",
  );
  expect(f.controller.readDraft().markdown).toContain("Last owner: outside.");
  expect(f.controller.getSnapshot().conflict).toBeNull();
});

test.each([
  "disk",
  "review",
  "binding",
] as const)("a newer authoritative %s update supersedes an in-flight result without displaying or saving the stale text", async (changed) => {
  const first = deferred<RevisionDraft | null>();
  const second = deferred<RevisionDraft | null>();
  let count = 0;
  const f = await fixture(
    () => null,
    () => (++count === 1 ? first.promise : second.promise),
  );
  await f.changedDisk();
  const latest = outside.replace("outside.", "newer outside.");
  await f.publish((current) => {
    if (!current.disk) throw new Error("Expected source");
    if (changed === "disk")
      current.disk = { ...current.disk, text: latest, version: "3", hash: "3" };
    if (changed === "binding")
      current.disk = { ...current.disk, path: "/moved.md" };
    if (changed === "review") {
      current.revision++;
      current.review.revision++;
      current.draft = draft(
        original.replace("First owner: ready.", "First owner: peer update."),
      );
      current.signature = reviewDraftSignature(current.draft);
    }
    return current;
  });
  first.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(
    f.applied.mock.calls.some(([value]) => value.markdown === outside),
  ).toBe(false);
  expect(f.posts.some((body) => body.draft.markdown === outside)).toBe(false);
  expect(f.evaluatedAsync).toHaveBeenCalledTimes(2);
  second.resolve(draft(latest));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.readDraft().markdown).toContain("newer outside.");
  expect(f.controller.getSnapshot().conflict).toBeNull();
});

test("replacing an adapter discards its unfinished async evaluation", async () => {
  const first = deferred<RevisionDraft | null>();
  const second = deferred<RevisionDraft | null>();
  let count = 0;
  const f = await fixture(
    () => null,
    () => (++count === 1 ? first.promise : second.promise),
  );
  await f.changedDisk();
  f.controller.setAdapter(f.adapter());
  await vi.advanceTimersByTimeAsync(0);
  first.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(
    f.applied.mock.calls.some(([value]) => value.markdown === outside),
  ).toBe(false);
  second.resolve(draft(outside.replace("outside.", "replacement adapter.")));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.readDraft().markdown).toContain("replacement adapter.");
});

test("Save separately captures the current draft without applying an unfinished disk result to either review", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    () => pending.promise,
  );
  await f.changedDisk();
  const copying = f.controller.copy("/separate.md", true);
  expect(f.evaluatedAsync).toHaveBeenCalledTimes(1);
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect((await copying).status).toBe("committed");
  expect(f.controller.getSnapshot().session.id).toBe("separate-review");
  expect(f.controller.readDraft().markdown).toBe(original);
  expect(
    f.applied.mock.calls.some(([value]) => value.markdown === outside),
  ).toBe(false);
  expect(f.posts).toEqual([]);
});

test("Save separately completes while the async disk parser is still unresolved", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    () => pending.promise,
  );
  await f.changedDisk();
  let copied = false;
  const copying = f.controller.copy("/separate.md", true).then((result) => {
    copied = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(copied).toBe(true);
  expect((await copying).status).toBe("committed");
  expect(f.controller.getSnapshot().session.id).toBe("separate-review");
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.readDraft().markdown).toBe(original);
});

test("a newer recovery checkpoint can save while explicit Reload is still awaiting its parser", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    (_base, _text, force) => (force ? pending.promise : Promise.resolve(null)),
  );
  await f.changedDisk();
  const reloading = f.controller.reloadFromFile();
  await vi.advanceTimersByTimeAsync(0);
  const before = f.checkpoints.length;
  f.controller.updateDraft(() =>
    draft(original.replace("ready.", "private new edit.")),
  );
  let flushed = false;
  const saving = f.controller.flush(false).then((value) => {
    flushed = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(flushed).toBe(true);
  expect(f.checkpoints.length).toBeGreaterThan(before);
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  await saving;
  expect(await reloading).toBe(false);
  expect(f.controller.readDraft().markdown).toContain("private new edit.");
});

test("explicit Reload does not overwrite a new local edit made during asynchronous source parsing", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    (_base, _text, force) => (force ? pending.promise : Promise.resolve(null)),
  );
  await f.changedDisk();
  await vi.advanceTimersByTimeAsync(0);
  const reloading = f.controller.reloadFromFile();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    f.evaluatedAsync?.mock.calls.some(
      (call) => call[2] === true && call[3]?.resolution === "incoming",
    ),
  ).toBe(true);
  f.controller.updateDraft((current) => ({
    ...current,
    markdown: current.markdown.replace("ready.", "my newer input."),
    cleanMarkdown: current.cleanMarkdown?.replace("ready.", "my newer input."),
  }));
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(await reloading).toBe(false);
  expect(f.controller.readDraft().markdown).toContain("my newer input.");
  expect(f.controller.getSnapshot().writePaused).toBe(true);
  expect(f.posts).toEqual([]);
});

test("an async parser error is cached until explicit Retry without falling back to synchronous parsing", async () => {
  let attempts = 0;
  const f = await fixture(
    () => {
      throw new Error("No synchronous fallback");
    },
    async () => {
      attempts++;
      throw new Error("Async parser unavailable");
    },
  );
  await f.publish(
    (current) => ({
      ...current,
      disk: current.disk
        ? { ...current.disk, text: outside, version: "2", hash: "2" }
        : null,
    }),
    false,
  );
  await f.controller.refresh(true);
  await f.controller.refresh(true);
  expect(attempts).toBe(1);
  expect(f.controller.getSnapshot().recoveryError).toContain(
    "Async parser unavailable",
  );
  await f.controller.retry();
  expect(attempts).toBe(2);
  expect(f.evaluated).not.toHaveBeenCalled();
});

test("a cached successful adoption still retries editor application after composition ends and preserves local typing", async () => {
  const f = await fixture((_base, text) => draft(text));
  f.blockApply(true);
  await f.changedDisk();
  const before = f.applied.mock.calls.length;
  f.controller.updateDraft((current) => ({
    ...current,
    markdown: current.markdown.replace(
      "First owner: ready.",
      "First owner: my typing.",
    ),
    cleanMarkdown: current.cleanMarkdown?.replace(
      "First owner: ready.",
      "First owner: my typing.",
    ),
  }));
  await f.registryNotice(2);
  f.blockApply(false);
  await f.controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.evaluated).toHaveBeenCalledTimes(1);
  expect(f.applied.mock.calls.length).toBeGreaterThan(before);
  expect(f.controller.getSnapshot().conflict).toBeNull();
  expect(f.controller.readDraft().markdown).toContain(
    "First owner: my typing.",
  );
  expect(f.controller.readDraft().markdown).toContain("Last owner: outside.");
});

test.each([
  "disk text",
  "disk version",
  "disk hash",
  "disk binding",
  "review content",
  "review revision",
  "saved source",
  "source aliases",
] as const)("a real change to %s invalidates the disk-adoption result", async (input) => {
  const f = await fixture();
  await f.changedDisk();
  await f.publish((current) => {
    if (!current.disk) throw new Error("Expected a real source binding");
    if (input === "disk text")
      current.disk.text = `${outside}\nAnother disk edit.\n`;
    if (input === "disk version") current.disk.version = "3";
    if (input === "disk hash") current.disk.hash = "3";
    if (input === "disk binding") current.disk.path = "/moved.md";
    if (input === "saved source")
      current.review.savedText = `${original}\nPrevious acknowledged file.\n`;
    if (input === "review revision") {
      current.revision++;
      current.review.revision++;
    }
    if (input === "review content") {
      current.draft.reviewComments.push({
        id: "c1",
        changeId: "document",
        content: "A newly shared comment.",
        createdAt: "2026-11-27T00:00:00.000Z",
      });
      current.signature = reviewDraftSignature(current.draft);
    }
    if (input === "source aliases") {
      current.draft.diskOrigin = {
        path: "/practice.md",
        signature: "source",
        ids: { s1: "s2" },
      };
      current.signature = reviewDraftSignature(current.draft);
    }
    return current;
  });
  expect(f.evaluated).toHaveBeenCalledTimes(2);
});

test("replacing the editor adapter invalidates a waiting evaluation", async () => {
  const f = await fixture();
  await f.changedDisk();
  f.controller.setAdapter(f.adapter());
  await vi.advanceTimersByTimeAsync(0);
  expect(f.evaluated).toHaveBeenCalledTimes(2);
});

test("explicit Retry reevaluates the same waiting source", async () => {
  const f = await fixture();
  await f.changedDisk();
  await f.controller.retry();
  expect(f.evaluated).toHaveBeenCalledTimes(2);
});

for (const asynchronous of [false, true])
  test(`explicit Reload evaluates its force and incoming choice instead of reusing automatic refusal (async: ${asynchronous})`, async () => {
    const evaluate: RevisionRemoteAdapter["adopt"] = (_base, text, force) =>
      force ? draft(text) : null;
    const f = await fixture(
      asynchronous ? () => null : evaluate,
      asynchronous ? async (...args) => evaluate(...args) : undefined,
    );
    const evaluated = asynchronous ? f.evaluatedAsync : f.evaluated;
    await f.changedDisk();
    await f.registryNotice(2);
    expect(await f.controller.reloadFromFile()).toBe(true);
    expect(evaluated).toHaveBeenCalledTimes(2);
    expect(evaluated?.mock.calls[1]?.[2]).toBe(true);
    expect(evaluated?.mock.calls[1]?.[3]?.resolution).toBe("incoming");
    expect(f.controller.readDraft().markdown).toBe(outside);
    expect(f.posts.some((request) => request.reason === "adopt")).toBe(true);
  });

test("an evaluator error remains visible without rerunning expensive work on every refresh, and Retry reevaluates it", async () => {
  const f = await fixture(() => {
    throw new Error("The source parser is unavailable.");
  });
  await f.publish(
    (current) => ({
      ...current,
      disk: current.disk
        ? { ...current.disk, text: outside, version: "2", hash: "2" }
        : null,
    }),
    false,
  );
  for (let index = 0; index < 4; index++) await f.controller.refresh(true);
  expect(f.evaluated).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot().recoveryError).toContain(
    "The source parser is unavailable.",
  );
  await f.controller.retry();
  expect(f.evaluated).toHaveBeenCalledTimes(2);
});

for (const asynchronous of [false, true])
  test.each([
    "local",
    "incoming",
  ] as const)(`the explicit %s conflict choice evaluates that resolution and preserves its chosen text (async: ${asynchronous})`, async (choice) => {
    const peer = original.replace(
      "First owner: ready.",
      "First owner: browser wording.",
    );
    const disk = original.replace(
      "First owner: ready.",
      "First owner: outside wording.",
    );
    const evaluate: RevisionRemoteAdapter["adopt"] = (
      base,
      markdown,
      _force,
      diskBase,
    ) => ({
      ...mergeReviewDrafts(draft(original), base, draft(markdown), {
        server: false,
        budgetMs: 1000,
        resolution: diskBase?.resolution,
      }),
      diskCleanMarkdown: markdown,
    });
    const f = await fixture(
      asynchronous ? () => null : evaluate,
      asynchronous ? async (...args) => evaluate(...args) : undefined,
    );
    const evaluated = asynchronous ? f.evaluatedAsync : f.evaluated;
    await f.publish((current) => ({
      ...current,
      draft: draft(peer),
      signature: reviewDraftSignature(draft(peer)),
      disk: current.disk
        ? { ...current.disk, text: disk, version: "2", hash: "2" }
        : null,
    }));
    await f.registryNotice(2);
    expect(evaluated).toHaveBeenCalledTimes(1);
    const conflict = f.controller.getSnapshot().conflict;
    if (!conflict || conflict.kind !== "conflict")
      throw new Error("Expected a genuine overlap");
    expect(await f.controller.resolveConflict(choice, conflict.signature)).toBe(
      true,
    );
    expect(
      evaluated?.mock.calls.some((call) => call[3]?.resolution === choice),
    ).toBe(true);
    expect(f.controller.readDraft().markdown).toBe(
      choice === "local" ? peer : disk,
    );
  });

test("Retry during an unfinished async adoption discards its old result and completes without a deadlock", async () => {
  const first = deferred<RevisionDraft | null>();
  const second = deferred<RevisionDraft | null>();
  let count = 0;
  const f = await fixture(
    () => null,
    () => (++count === 1 ? first.promise : second.promise),
  );
  await f.changedDisk();
  const retrying = f.controller.retry();
  await vi.advanceTimersByTimeAsync(0);
  first.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(
    f.applied.mock.calls.some(([value]) => value.markdown === outside),
  ).toBe(false);
  expect(f.evaluatedAsync).toHaveBeenCalledTimes(2);
  second.resolve(null);
  await vi.advanceTimersByTimeAsync(0);
  expect(await retrying).toBe(false);
  expect(f.controller.readDraft().markdown).toBe(original);
  expect(f.controller.getSnapshot().writePaused).toBe(true);
});

test("an older review notice cannot replace a newer review already being prepared", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    () => pending.promise,
  );
  await f.publish((current) => ({
    ...current,
    revision: 3,
    review: { ...current.review, revision: 3 },
    disk: current.disk
      ? { ...current.disk, text: outside, version: "3", hash: "3" }
      : null,
  }));
  const older = f.state();
  older.revision = older.review.revision = 2;
  older.disk = older.disk
    ? { ...older.disk, text: "Stale source.", version: "2", hash: "2" }
    : null;
  await f.notice(older);
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.evaluatedAsync).toHaveBeenCalledTimes(1);
  expect(f.controller.readDraft().markdown).toBe(outside);
});

test("explicit Reload protects private UI edits even when the adapter has no UI change subscription", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    (_base, _text, force) => (force ? pending.promise : Promise.resolve(null)),
  );
  await f.changedDisk();
  const reloading = f.controller.reloadFromFile();
  await vi.advanceTimersByTimeAsync(0);
  const ui = {
    comments: {
      c1: { value: "My private newer comment", original: "", editing: true },
    },
  };
  f.setUiDrafts(ui);
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(await reloading).toBe(false);
  expect(f.controller.readDraft().markdown).toBe(original);
  expect(f.checkpoints).toEqual(
    expect.arrayContaining([expect.objectContaining({ uiDrafts: ui })]),
  );
});

test("a pending own publication created during preparation keeps the incoming result off its baseline", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    () => pending.promise,
  );
  await f.changedDisk();
  const local = original.replace(
    "First owner: ready.",
    "First owner: unpublished typing.",
  );
  f.controller.updateDraft(() => draft(local));
  f.indeterminateSaves();
  expect(await f.controller.flush(false)).toBe(false);
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.readDraft().markdown).toBe(local);
  expect(
    f.applied.mock.calls.some(([value]) => value.markdown.includes("outside")),
  ).toBe(false);
  expect(f.controller.getSnapshot().conflict?.kind).toBe("indeterminate");
});

test("Send waits outside the queue and preserves its original feedback through asynchronous adoption", async () => {
  const pending = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    () => pending.promise,
  );
  await f.changedDisk();
  f.controller.updateDraft(() =>
    draft(
      original.replace("First owner: ready.", "First owner: my feedback edit."),
    ),
  );
  let completed = false;
  const sending = f.controller
    .run("send", f.controller.readDraft(), {
      comment: "Send this complete feedback to the agent.",
    })
    .then((value) => {
      completed = true;
      return value;
    });
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(false);
  pending.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect((await sending).id).toBe("review");
  const sent = f.posts.filter((item) => item.reason === "send").at(-1);
  expect(sent?.comment).toBe("Send this complete feedback to the agent.");
  expect(sent?.draft.markdown).toContain("First owner: my feedback edit.");
  expect(sent?.draft.markdown).toContain("Last owner: outside.");
});

test("a delayed state read cannot roll back a same-revision disk notice received while that read was in flight", async () => {
  const parsing = deferred<RevisionDraft | null>();
  const read = deferred<SyncState<ComparisonReviewData>>();
  const f = await fixture(
    () => null,
    () => parsing.promise,
  );
  const older = f.state();
  f.holdRead(read.promise);
  const refreshing = f.controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  await f.changedDisk();
  read.resolve(older);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.evaluatedAsync).toHaveBeenCalledTimes(1);
  expect(f.posts).toEqual([]);
  parsing.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  await refreshing;
  expect(f.controller.readDraft().markdown).toBe(outside);
  expect(f.evaluatedAsync).toHaveBeenCalledTimes(1);
});

test("repeated autosaves cannot acknowledge unreflected disk prose while async preparation is unfinished", async () => {
  const parsing = deferred<RevisionDraft | null>();
  const f = await fixture(
    () => null,
    () => parsing.promise,
  );
  await f.changedDisk();
  f.controller.updateDraft(() =>
    draft(original.replace("First owner: ready.", "First owner: my typing.")),
  );
  await f.controller.flush(false);
  await f.controller.flush(false);
  expect(f.posts.filter((item) => item.reason === "adopt")).toEqual([]);
  parsing.resolve(draft(outside));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.readDraft().markdown).toContain(
    "First owner: my typing.",
  );
  expect(f.controller.readDraft().markdown).toContain("Last owner: outside.");
});

test.each([
  "local",
  "incoming",
] as const)("ordinary refresh during an async %s choice cannot cancel that choice", async (choice) => {
  const pending = deferred<ReturnType<RevisionRemoteAdapter["adopt"]>>();
  const peer = original.replace(
    "First owner: ready.",
    "First owner: browser wording.",
  );
  const disk = original.replace(
    "First owner: ready.",
    "First owner: outside wording.",
  );
  const evaluate: RevisionRemoteAdapter["adopt"] = (
    base,
    text,
    _force,
    diskBase,
  ) => ({
    ...mergeReviewDrafts(draft(original), base, draft(text), {
      server: false,
      budgetMs: 1000,
      resolution: diskBase?.resolution,
    }),
    diskCleanMarkdown: text,
  });
  let chosen = false;
  const f = await fixture(
    () => null,
    (base, text, force, diskBase) => {
      if (diskBase?.resolution === choice && !chosen) {
        chosen = true;
        return pending.promise;
      }
      return Promise.resolve(evaluate(base, text, force, diskBase));
    },
  );
  await f.publish((current) => ({
    ...current,
    draft: draft(peer),
    signature: reviewDraftSignature(draft(peer)),
    disk: current.disk
      ? { ...current.disk, text: disk, version: "2", hash: "2" }
      : null,
  }));
  const conflict = f.controller.getSnapshot().conflict;
  if (!conflict) throw new Error("Expected overlap");
  const resolving = f.controller.resolveConflict(choice, conflict.signature);
  await vi.advanceTimersByTimeAsync(0);
  expect(chosen).toBe(true);
  await f.registryNotice(2);
  pending.resolve(
    evaluate(draft(peer), disk, false, {
      path: "/practice.md",
      markdown: original,
      resolution: choice,
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(await resolving).toBe(true);
  expect(f.controller.readDraft().markdown).toBe(
    choice === "local" ? peer : disk,
  );
  expect(
    f.evaluatedAsync?.mock.calls.filter(
      (call) => call[3]?.resolution === undefined,
    ),
  ).toHaveLength(1);
});
