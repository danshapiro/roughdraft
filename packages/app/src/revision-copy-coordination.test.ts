import {
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncResult,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
function draft(markdown = "The saved review.\n"): RevisionDraft {
  return {
    markdown,
    cleanMarkdown: markdown,
    decisions: {},
    reviewComments: [],
  };
}
function state(
  value = draft(),
  id = "original",
  revision = 1,
): SyncState<ComparisonReviewData> {
  return {
    review: {
      id,
      revision,
      mode: "document",
      title: "Save a review separately while another save finishes",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: null,
      beforeText: draft().markdown,
      afterText: draft().markdown,
      segments: [],
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      targetChanged: false,
      editor: "unified",
      autosave: "none",
      handoff: "chat",
      destinationPath: null,
      savedPath: null,
      savedText: null,
      draft: value,
    },
    draft: value,
    revision,
    signature: reviewDraftSignature(value),
    disk: null,
    registryGeneration: String(revision),
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120_000,
    },
  };
}
function gate<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const active: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
});
afterEach(() => {
  for (const controller of active.splice(0)) controller.stop();
  vi.useRealTimers();
});
function install(
  initial: SyncState<ComparisonReviewData>,
  request: <T>(path: string, body?: object) => Promise<T | null>,
  storage = new MemoryStorage(),
  tabStorage = new MemoryStorage(),
  id = "page",
) {
  const controller = new RevisionSessionController(
    initial.review,
    initial.draft as RevisionDraft,
    { request, storage, tabStorage, id: () => id },
  );
  active.push(controller);
  controller.setAdapter({
    apply: (value) => ({
      ...value,
      cleanMarkdown: value.cleanMarkdown ?? value.markdown,
    }),
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  return controller;
}
function copyResult(
  value: RevisionDraft,
  operationId?: string,
): SyncResult<ComparisonReviewData> {
  return {
    status: "committed",
    operationId,
    state: state(value, "saved-copy"),
    savedPath: "/saved-copy.md",
    reviewUrl: "?comparison=saved-copy",
  };
}

test("live refresh and copy-status inspection never resolve this page's still-active copy POST or prevent its unchanged-generation switch", async () => {
  const initial = state();
  const response = gate<SyncResult<ComparisonReviewData>>();
  const copies: Array<{ operationId: string }> = [];
  const resolutions = vi.fn();
  const controller = install(
    initial,
    async <T>(path: string, body?: object) => {
      if (path.endsWith("/copy")) {
        copies.push(body as { operationId: string });
        return (await response.promise) as T;
      }
      if (path.includes("/operations/")) {
        resolutions(body);
        return copyResult(
          initial.draft as RevisionDraft,
          copies[0]?.operationId,
        ) as T;
      }
      if (path.endsWith("/checkpoint"))
        return { checkpointId: "checkpoint" } as T;
      if (!body) return structuredClone(initial) as T;
      throw new Error(`Unexpected ${path}`);
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  const copy = controller.copy("/saved-copy.md", false);
  let refresh: Promise<void> | undefined;
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(copies).toHaveLength(1);
    await controller.checkCopyStatus();
    refresh = controller.refresh(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolutions).not.toHaveBeenCalled();
  } finally {
    response.resolve(
      copyResult(initial.draft as RevisionDraft, copies[0]?.operationId),
    );
    await copy;
    await refresh;
  }
  expect(controller.getSnapshot().session.id).toBe("saved-copy");
  expect(controller.getSnapshot().notice).toBe("Saved separately.");
});

test("Save separately queues behind this page's active autosave instead of resolving or replacing its identity", async () => {
  let server = state();
  const saved = gate<SyncResult<ComparisonReviewData>>();
  const copies: Array<{ workingDraft: RevisionDraft }> = [];
  const resolutions = vi.fn();
  const controller = install(server, async <T>(path: string, body?: object) => {
    if (path.endsWith("/reconcile")) return (await saved.promise) as T;
    if (path.endsWith("/copy")) {
      copies.push(body as { workingDraft: RevisionDraft });
      return copyResult(copies[0].workingDraft) as T;
    }
    if (path.includes("/operations/")) {
      resolutions();
      return { status: "not-received", state: server } as T;
    }
    if (path.endsWith("/checkpoint"))
      return { checkpointId: "checkpoint" } as T;
    if (!body) return structuredClone(server) as T;
    throw new Error(`Unexpected ${path}`);
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("My unsaved review.\n"));
  const autosave = controller.flush();
  await vi.advanceTimersByTimeAsync(0);
  const copy = controller.copy("/saved-copy.md", false);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(resolutions).not.toHaveBeenCalled();
    expect(copies).toHaveLength(0);
  } finally {
    server = state(draft("My unsaved review.\n"), "original", 2);
    saved.resolve({ status: "committed", state: server });
    await autosave;
    await copy;
  }
  expect(copies).toHaveLength(1);
  expect(copies[0].workingDraft.markdown).toBe("My unsaved review.\n");
  expect(controller.getSnapshot().session.id).toBe("saved-copy");
});

test.each([
  "publishing",
  "indeterminate",
] as const)("an unresolved ordinary %s save still allows one independent separate copy without losing its recovery identity", async (status) => {
  const initial = state();
  const storage = new MemoryStorage();
  const tab = new MemoryStorage();
  const saves: ReconcileRequest[] = [];
  const copies: Array<{ workingDraft: RevisionDraft }> = [];
  const controller = install(
    initial,
    async <T>(path: string, body?: object) => {
      if (path.endsWith("/reconcile")) {
        saves.push(body as ReconcileRequest);
        return { status, state: initial } as T;
      }
      if (path.endsWith("/copy")) {
        copies.push(body as { workingDraft: RevisionDraft });
        return copyResult(copies[0].workingDraft) as T;
      }
      if (path.includes("/operations/")) return { status, state: initial } as T;
      if (path.endsWith("/checkpoint"))
        return { checkpointId: "checkpoint" } as T;
      if (!body) return structuredClone(initial) as T;
      throw new Error(`Unexpected ${path}`);
    },
    storage,
    tab,
  );
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => draft("My complete recovery document.\n"));
  expect(await controller.flush()).toBe(false);
  expect(saves).toHaveLength(1);
  const result = await controller.copy("/saved-copy.md", false);
  expect(result.status).toBe("committed");
  expect(copies).toHaveLength(1);
  expect(copies[0].workingDraft.markdown).toBe(
    "My complete recovery document.\n",
  );
  const retained = storage.getItem("roughdraft-draft:original:page");
  expect(retained).not.toBeNull();
  expect(JSON.parse(retained ?? "null").operation.operation.operationId).toBe(
    saves[0].operationId,
  );
});

test("an unknown copy remains the same recoverable operation across reload and blocks a second copy", async () => {
  const initial = state();
  const storage = new MemoryStorage();
  const tab = new MemoryStorage();
  const copies: Array<{ operationId: string }> = [];
  const resolved: string[] = [];
  const api = async <T>(path: string, body?: object): Promise<T | null> => {
    if (path.endsWith("/copy")) {
      copies.push(body as { operationId: string });
      throw new Error("Lost copy response");
    }
    if (path.includes("/operations/")) {
      resolved.push((body as { operationId: string }).operationId);
      return { status: "indeterminate", state: initial } as T;
    }
    if (path.endsWith("/checkpoint"))
      return { checkpointId: "checkpoint" } as T;
    if (!body) return structuredClone(initial) as T;
    throw new Error(`Unexpected ${path}`);
  };
  const first = install(initial, api, storage, tab, "first");
  await vi.advanceTimersByTimeAsync(0);
  await expect(first.copy("/saved-copy.md", false)).rejects.toThrow(
    "Lost copy response",
  );
  first.stop();
  const reloaded = install(initial, api, storage, tab, "reloaded");
  await vi.advanceTimersByTimeAsync(0);
  await expect(reloaded.copy("/another-copy.md", false)).rejects.toThrow();
  expect(copies).toHaveLength(1);
  expect(resolved.length).toBeGreaterThan(0);
  expect(resolved.every((id) => id === copies[0].operationId)).toBe(true);
});
