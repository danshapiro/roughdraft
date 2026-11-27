import fs from "node:fs";
import path from "node:path";
import {
  mergeReviewDrafts,
  reviewDraftSignature,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonStore } from "../../server/src/comparisons";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";
import { RevisionUiDraftStore } from "./revision-ui-drafts";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));

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
const original = "First owner: stable.\n\nSecond owner: stable.\n";
let root: string;
let store: ComparisonStore;
const active: RevisionSessionController[] = [];
beforeEach(() => {
  const parent = path.resolve(
    process.cwd(),
    "../../.test-tmp/wait-checkpoints",
  );
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  store = new ComparisonStore(path.join(root, "comparisons"), {
    homeDir: root,
  });
  vi.useFakeTimers();
});
afterEach(() => {
  for (const controller of active.splice(0)) controller.stop();
  store.watchers.close();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(autosave = false) {
  const target = path.join(root, "practice.md");
  fs.writeFileSync(target, original);
  const review = store.openDocument({
    targetPath: target,
    autosave: autosave ? target : "none",
  });
  const state = () =>
    store.state(review.id) as unknown as SyncState<ComparisonReviewData>;
  const checkpoints = () =>
    store.state(review.id).review.recoveryCheckpoints ?? [];
  const storage = new MemoryStorage();
  const tabStorage = new MemoryStorage();
  const posted: Array<{ path: string; body: object }> = [];
  let blockApply = false;
  let holdSaves = false;
  let releaseCheckpoint: (() => void) | undefined;
  let checkpointBarrier: Promise<void> | undefined;
  let releaseSave: (() => void) | undefined;
  let saveBarrier: Promise<void> | undefined;
  let merges = 0;
  let interceptResolve: (() => object | undefined) | undefined;
  const api = async <T>(route: string, body?: object): Promise<T | null> => {
    if (!body) return state() as T;
    posted.push({ path: route, body: structuredClone(body) });
    if (route.endsWith("/checkpoint")) {
      const result = store.checkpoint(
        review.id,
        body as Record<string, unknown>,
      );
      if (checkpointBarrier) await checkpointBarrier;
      return result as T;
    }
    if (route.endsWith("/reconcile")) {
      if (
        (body as { reason?: string }).reason === "resolve" &&
        interceptResolve
      ) {
        const intercept = interceptResolve;
        interceptResolve = undefined;
        const result = intercept();
        if (result) return result as T;
      }
      if (holdSaves)
        return { status: "retry-later", retryAfter: 25, state: state() } as T;
      const result = store.reconcile(
        review.id,
        body as Record<string, unknown>,
      );
      if (saveBarrier && result.status === "committed") await saveBarrier;
      return result as T;
    }
    if (route.endsWith("/resolve")) {
      const value = body as { operationId: string };
      return store.resolveOperation(
        value.operationId,
        body as Record<string, unknown>,
      ) as T;
    }
    throw new Error(`Unexpected request ${route}`);
  };
  const page = (name: string, prepare = false) => {
    const initial = state();
    const ui = new RevisionUiDraftStore();
    const controller = new RevisionSessionController(
      initial.review,
      initial.draft as RevisionDraft,
      {
        request: api,
        storage,
        tabStorage,
        id: () => name,
        merge: async (base, local, incoming, options) => {
          merges++;
          return mergeReviewDrafts(base, local, incoming, {
            ...options,
            server: false,
            budgetMs: 1000,
          });
        },
      },
    );
    active.push(controller);
    controller.setAdapter({
      ...(prepare ? { prepare: (draft: RevisionDraft) => draft } : {}),
      apply: (draft) => (blockApply ? null : draft),
      adopt: () => null,
      readUiDrafts: ui.read,
      restoreUiDrafts: ui.restore,
      subscribeUiDrafts: ui.subscribe,
    });
    controller.start();
    return { controller, ui };
  };
  let sequence = 0;
  const peer = (text: string) => {
    const base = state();
    sequence++;
    const result = store.reconcile(review.id, {
      operationId: `peer-${sequence}`,
      pageInstanceId: "peer",
      operationSequence: sequence,
      operationContext: base.operationContext,
      expectedRevision: base.revision,
      baseRevision: base.revision,
      baseSignature: reviewDraftSignature(base.draft),
      base: base.draft,
      draft: { ...base.draft, markdown: text, cleanMarkdown: text },
      expectedDisk: base.disk
        ? {
            path: base.disk.path,
            version: base.disk.version,
            hash: base.disk.hash,
          }
        : null,
      writeFile: false,
      localGeneration: sequence,
      reason: "sync",
    });
    expect(result.status).toBe("committed");
  };
  const local = (controller: RevisionSessionController, text: string) =>
    controller.updateDraft((draft) => ({
      ...draft,
      markdown: text,
      cleanMarkdown: text,
    }));
  return {
    review,
    target,
    state,
    checkpoints,
    page,
    peer,
    local,
    posted,
    merges: () => merges,
    interceptResolve: (callback: () => object | undefined) => {
      interceptResolve = callback;
    },
    holdSaveResponse: () => {
      saveBarrier = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    },
    releaseSaveResponse: () => {
      saveBarrier = undefined;
      releaseSave?.();
    },
    block: (value: boolean) => {
      blockApply = value;
    },
    hold: (value: boolean) => {
      holdSaves = value;
    },
    holdCheckpoint: () => {
      checkpointBarrier = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
    },
    releaseCheckpoint: () => {
      checkpointBarrier = undefined;
      releaseCheckpoint?.();
    },
  };
}

test("a composition wait's recovery snapshot becomes resolved after the next covering ordinary save", async () => {
  const f = fixture();
  const { controller } = f.page("owner");
  await vi.advanceTimersByTimeAsync(0);
  f.local(
    controller,
    original.replace("First owner: stable.", "First owner: my typing."),
  );
  f.peer(original.replace("Second owner: stable.", "Second owner: incoming."));
  f.block(true);
  await controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict?.kind).toBe("waiting");
  expect(f.checkpoints()).toHaveLength(1);
  f.block(false);
  await controller.refresh(true);
  await controller.flush(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(f.state().draft.markdown).toContain("First owner: my typing.");
  expect(f.state().draft.markdown).toContain("Second owner: incoming.");
  expect(f.checkpoints()[0].resolvedAt).toEqual(expect.any(String));
});

test("automatically-cleared word waits reuse one episode until a covering commit", async () => {
  const f = fixture();
  const { controller } = f.page("owner");
  await vi.advanceTimersByTimeAsync(0);
  f.hold(true);
  for (let index = 1; index <= 3; index++) {
    f.local(
      controller,
      controller
        .readDraft()
        .markdown.replace(
          /First owner:[^\n]*/,
          `First owner: my typing ${index}.`,
        ),
    );
    f.peer(
      f
        .state()
        .draft.markdown.replace(
          /Second owner:[^\n]*/,
          `Second owner: incoming ${index}.`,
        ),
    );
    f.block(true);
    await controller.refresh(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().conflict?.kind).toBe("waiting");
    f.block(false);
    await controller.refresh(true);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(f.checkpoints()).toHaveLength(1);
});

test("reload before the checkpoint response preserves the episode and can finish its ordinary-save cleanup", async () => {
  const f = fixture();
  const first = f.page("before-reload");
  await vi.advanceTimersByTimeAsync(0);
  f.holdCheckpoint();
  f.local(
    first.controller,
    original.replace("First owner: stable.", "First owner: recovered typing."),
  );
  f.peer(original.replace("Second owner: stable.", "Second owner: incoming."));
  f.block(true);
  await first.controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.checkpoints()).toHaveLength(1);
  first.controller.stop();
  f.block(false);
  const next = f.page("after-reload");
  f.releaseCheckpoint();
  await vi.advanceTimersByTimeAsync(0);
  await next.controller.flush(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state().draft.markdown).toContain("First owner: recovered typing.");
  expect(next.controller.getSnapshot().conflict).toBeNull();
  expect(f.checkpoints()[0].resolvedAt).toEqual(expect.any(String));
});

test("private typing during the covering save keeps the newer recovery generation unresolved", async () => {
  const f = fixture();
  const { controller, ui } = f.page("owner");
  await vi.advanceTimersByTimeAsync(0);
  f.local(
    controller,
    original.replace("First owner: stable.", "First owner: my typing."),
  );
  f.peer(original.replace("Second owner: stable.", "Second owner: incoming."));
  f.block(true);
  await controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  const id = f.checkpoints()[0].id;
  f.holdSaveResponse();
  f.block(false);
  await controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.checkpoints()[0].resolvedAt).toEqual(expect.any(String));
  ui.setComment("c9", {
    value: "New private reply during the save.",
    original: "",
    editing: true,
  });
  await vi.advanceTimersByTimeAsync(300);
  f.releaseSaveResponse();
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.getSnapshot().comments.c9.value).toBe(
    "New private reply during the save.",
  );
  const saved = store.readCheckpoint(f.review.id, id) as {
    uiDrafts: ReturnType<RevisionUiDraftStore["read"]>;
  };
  expect(saved.uiDrafts).toMatchObject({
    comments: { c9: { value: "New private reply during the save." } },
  });
  expect(f.checkpoints()[0].resolvedAt).toBeUndefined();
  expect(f.state().draft.reviewComments).toEqual([]);
  expect(f.state().draft.markdown).not.toContain("New private reply");
});

test.each([
  "unchanged",
  "retry",
  "unrelated peer",
  "changed overlap",
  "outside disk",
] as const)("typing through a committed-save overlap updates recovery and explicit resolution stays guarded: %s", async (race) => {
  const f = fixture(race === "outside disk");
  const { controller } = f.page("owner", true);
  await vi.advanceTimersByTimeAsync(0);
  f.local(
    controller,
    original.replace("First owner: stable.", "First owner: my typing."),
  );
  f.peer(original.replace("Second owner: stable.", "Second owner: incoming."));
  f.holdSaveResponse();
  const saving = controller.flush(false);
  await vi.advanceTimersByTimeAsync(0);
  f.local(
    controller,
    controller
      .readDraft()
      .markdown.replace(
        "Second owner: stable.",
        "Second owner: competing typing.",
      ),
  );
  f.releaseSaveResponse();
  await saving;
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
  const previousMerges = f.merges();
  const previousResolves = f.posted.filter((entry) =>
    entry.path.endsWith("/resolve"),
  ).length;
  for (let index = 1; index <= 3; index++) {
    f.local(
      controller,
      controller
        .readDraft()
        .markdown.replace(
          /First owner:[^\n]*/,
          `First owner: independent typing ${index}.`,
        ),
    );
    await controller.flush(false);
  }
  expect(f.merges()).toBe(previousMerges);
  expect(
    f.posted.filter((entry) => entry.path.endsWith("/resolve")),
  ).toHaveLength(previousResolves);
  const recovery = store.readCheckpoint(f.review.id, f.checkpoints()[0].id) as {
    workingDraft: RevisionDraft;
  };
  expect(recovery.workingDraft.markdown).toContain(
    "First owner: independent typing 3.",
  );
  expect(recovery.workingDraft.markdown).toContain(
    "Second owner: competing typing.",
  );
  expect(f.checkpoints()[0].resolvedAt).toBeUndefined();
  await controller.refresh(true);
  const conflict = controller.getSnapshot().conflict;
  if (!conflict) throw new Error("The real overlap must still need a decision");
  const outsideText = "Outside disk contents must survive.\n";
  if (race === "retry")
    f.interceptResolve(() => ({
      status: "retry-later",
      retryAfter: 20,
      state: f.state(),
    }));
  if (race === "unrelated peer")
    f.interceptResolve(() => {
      f.peer(`${f.state().draft.markdown}\nUnrelated peer paragraph.\n`);
      return undefined;
    });
  if (race === "changed overlap")
    f.interceptResolve(() => {
      f.peer(
        f
          .state()
          .draft.markdown.replace(
            "Second owner: incoming.",
            "Second owner: changed after inspection.",
          ),
      );
      return undefined;
    });
  if (race === "outside disk")
    f.interceptResolve(() => {
      fs.writeFileSync(f.target, outsideText);
      return undefined;
    });
  const resolving = controller.resolveConflict(
    race === "changed overlap" ? "local" : "incoming",
    conflict.signature,
  );
  await vi.advanceTimersByTimeAsync(25);
  const resolved = await resolving;
  if (race === "changed overlap") {
    expect(resolved).toBe(false);
    expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
    expect(f.state().draft.markdown).toContain(
      "Second owner: changed after inspection.",
    );
    return;
  }
  if (race === "outside disk") {
    expect(resolved).toBe(false);
    expect(fs.readFileSync(f.target, "utf8")).toBe(outsideText);
    return;
  }
  expect(
    resolved,
    JSON.stringify({
      conflict: controller.getSnapshot().conflict,
      error: controller.getSnapshot().recoveryError,
      requests: f.posted.slice(-5),
    }),
  ).toBe(true);
  expect(f.state().draft.markdown).toContain(
    "First owner: independent typing 3.",
  );
  expect(f.state().draft.markdown).toContain("Second owner: incoming.");
  if (race === "unrelated peer")
    expect(f.state().draft.markdown).toContain("Unrelated peer paragraph.");
});
