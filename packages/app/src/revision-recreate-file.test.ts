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
const markdown = "First paragraph.\n\nFinal paragraph.\n";
const draft: RevisionDraft = {
  markdown,
  cleanMarkdown: markdown,
  decisions: {},
  reviewComments: [],
};
const privateUi = {
  comments: {
    c1: {
      value: "Do not submit this unfinished reply",
      original: "",
      editing: true,
    },
  },
};
function state(): SyncState<ComparisonReviewData> & {
  canRecreateFile: boolean;
} {
  return {
    review: {
      id: "deleted-destination",
      revision: 1,
      mode: "document",
      title: "Recreate a deleted autosave file",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: "/practice.md",
      beforeText: markdown,
      afterText: markdown,
      segments: [],
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      targetChanged: true,
      editor: "unified",
      autosave: "/practice.md",
      handoff: "chat",
      destinationPath: "/practice.md",
      savedPath: "/practice.md",
      savedText: markdown,
      draft,
    },
    draft,
    revision: 1,
    signature: reviewDraftSignature(draft),
    disk: {
      path: "/practice.md",
      version: null,
      hash: null,
      text: null,
      availability: "missing",
    },
    registryGeneration: "1:missing",
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120_000,
    },
    canRecreateFile: true,
  };
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
  request: <T>(path: string, body?: object) => Promise<T | null>,
) {
  const initial = state();
  const controller = new RevisionSessionController(initial.review, draft, {
    request,
    storage: new MemoryStorage(),
    tabStorage: new MemoryStorage(),
  });
  active.push(controller);
  controller.setAdapter({
    apply: (value) => ({
      ...value,
      cleanMarkdown: value.cleanMarkdown ?? value.markdown,
    }),
    adopt: () => null,
    readUiDrafts: () => privateUi,
    restoreUiDrafts: () => {},
  });
  controller.start();
  return controller;
}

test.each([
  false,
  true,
])("explicit recreation preserves local/private input and merges independent review changes (local edit=%s)", async (edit) => {
  let server = state();
  const writes: ReconcileRequest[] = [];
  const checkpoints: Array<{ uiDrafts: unknown }> = [];
  const controller = install(
    async <T>(path: string, body?: object): Promise<T | null> => {
      if (!body) return structuredClone(server) as T;
      if (path.endsWith("/checkpoint")) {
        checkpoints.push(body as { uiDrafts: unknown });
        return { checkpointId: "local-recovery" } as T;
      }
      if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
      const request = body as ReconcileRequest;
      writes.push(request);
      const merged = mergeReviewDrafts(
        request.base ?? draft,
        request.draft,
        server.draft,
        { server: false, budgetMs: 1000 },
      );
      if (merged.status !== "merged")
        throw new Error("Independent fixture changes must merge");
      server = {
        ...server,
        canRecreateFile: false,
        draft: merged.draft,
        revision: 3,
        signature: reviewDraftSignature(merged.draft),
        registryGeneration: "3:created",
        disk: {
          path: "/practice.md",
          version: "created",
          hash: "created",
          text: merged.draft.cleanMarkdown ?? merged.draft.markdown,
          availability: "available",
        },
        review: {
          ...server.review,
          draft: merged.draft,
          revision: 3,
          targetChanged: false,
          savedText: merged.draft.cleanMarkdown ?? merged.draft.markdown,
        },
      };
      return { status: "committed", state: structuredClone(server) } as T;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  if (edit)
    controller.updateDraft(() => ({
      ...draft,
      markdown: markdown.replace("First", "My first"),
      cleanMarkdown: markdown.replace("First", "My first"),
    }));
  const remote = {
    ...draft,
    markdown: markdown.replace("Final", "Remote final"),
    cleanMarkdown: markdown.replace("Final", "Remote final"),
  };
  server = {
    ...server,
    draft: remote,
    revision: 2,
    signature: reviewDraftSignature(remote),
    registryGeneration: "2:missing",
    review: { ...server.review, draft: remote, revision: 2 },
  };
  expect(writes).toEqual([]);
  expect(await controller.recreateFile("/practice.md")).toBe(true);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    reason: "recreate",
    writeFile: true,
    expectedDisk: { path: "/practice.md", version: null },
  });
  expect(server.draft.markdown).toContain(
    edit ? "My first" : "First paragraph",
  );
  expect(server.draft.markdown).toContain("Remote final");
  expect(controller.readDraft().markdown).toBe(server.draft.markdown);
  expect(controller.readDraft().reviewComments).toEqual([]);
  expect(checkpoints.at(-1)?.uiDrafts).toEqual(privateUi);
  expect(controller.getSnapshot().conflict).toBeNull();
});

test.each([
  "appeared",
  "rebound",
  "unsupported",
  "autosave-none",
] as const)("recreation refuses a freshly %s destination and retains local work", async (change) => {
  let server = state();
  const writes = vi.fn();
  const controller = install(async <T>(path: string, body?: object) => {
    if (!body) return structuredClone(server) as T;
    if (path.endsWith("/checkpoint"))
      return { checkpointId: "local-recovery" } as T;
    writes();
    throw new Error("Recreation must not submit an unconfirmed destination");
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => ({
    ...draft,
    markdown: "My retained local document.\n",
    cleanMarkdown: "My retained local document.\n",
  }));
  if (change === "appeared")
    server = {
      ...server,
      canRecreateFile: false,
      disk: {
        path: "/practice.md",
        version: "outside",
        hash: "outside",
        text: "Outside document",
        availability: "available",
      },
    };
  if (change === "rebound")
    server = {
      ...server,
      review: { ...server.review, destinationPath: "/different.md" },
      disk: {
        path: "/different.md",
        version: null,
        hash: null,
        text: null,
        availability: "missing",
      },
    };
  if (change === "unsupported") server.canRecreateFile = false;
  if (change === "autosave-none")
    server = {
      ...server,
      canRecreateFile: false,
      review: { ...server.review, destinationPath: null, autosave: "none" },
    };
  expect(await controller.recreateFile("/practice.md")).toBe(false);
  expect(writes).not.toHaveBeenCalled();
  expect(controller.readDraft().markdown).toBe("My retained local document.\n");
});

test("a failed durable checkpoint prevents recreation instead of dropping unfinished feedback", async () => {
  const writes = vi.fn();
  const controller = install(async <T>(path: string, body?: object) => {
    if (!body) return state() as T;
    if (path.endsWith("/checkpoint"))
      throw new Error("Recovery storage unavailable");
    writes();
    throw new Error("No file may be recreated before recovery succeeds");
  });
  await vi.advanceTimersByTimeAsync(0);
  await expect(controller.recreateFile("/practice.md")).rejects.toThrow(
    /recovery/i,
  );
  expect(writes).not.toHaveBeenCalled();
});

test.each([
  false,
  true,
])("recreation never retries against a file that appeared after confirmation (reserved=%s)", async (reserved) => {
  let server = state();
  const writes: ReconcileRequest[] = [];
  const controller = install(
    async <T>(path: string, body?: object): Promise<T | null> => {
      if (!body) return structuredClone(server) as T;
      if (path.endsWith("/checkpoint"))
        return { checkpointId: "local-recovery" } as T;
      if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
      writes.push(body as ReconcileRequest);
      if (reserved && writes.length === 1)
        return {
          status: "client-merge-required",
          state: structuredClone(server),
          reservation: {
            token: "turn",
            revision: server.revision,
            expiresAt: Date.now() + 750,
          },
        } as T;
      server = {
        ...server,
        canRecreateFile: false,
        disk: {
          path: "/practice.md",
          version: "outside",
          hash: "outside",
          text: "The arriving outside file.\n",
          availability: "available",
        },
      };
      return {
        status: "incoming-changed",
        state: structuredClone(server),
      } as T;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => ({
    ...draft,
    markdown: "My retained document.\n",
    cleanMarkdown: "My retained document.\n",
  }));
  expect(await controller.recreateFile("/practice.md")).toBe(false);
  expect(writes).toHaveLength(reserved ? 2 : 1);
  expect(writes.every((write) => write.expectedDisk?.version === null)).toBe(
    true,
  );
  expect(controller.readDraft().markdown).toBe("My retained document.\n");
  expect(controller.getSnapshot().conflict?.state?.disk?.text).toBe(
    "The arriving outside file.\n",
  );
});

test("recreation retains an unresolved ordinary operation instead of replacing its save identity", async () => {
  let server: ReturnType<typeof state> = {
    ...state(),
    canRecreateFile: false,
    review: { ...state().review, targetChanged: false },
    disk: {
      path: "/practice.md",
      version: "original",
      hash: "original",
      text: markdown,
      availability: "available",
    },
  };
  const writes: ReconcileRequest[] = [];
  const resolved: string[] = [];
  const controller = install(
    async <T>(path: string, body?: object): Promise<T | null> => {
      if (!body) return structuredClone(server) as T;
      if (path.endsWith("/checkpoint"))
        return { checkpointId: "local-recovery" } as T;
      if (path.includes("/operations/")) {
        resolved.push((body as { operationId: string }).operationId);
        return { status: "indeterminate", state: state() } as T;
      }
      if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
      writes.push(body as ReconcileRequest);
      server = state();
      return { status: "indeterminate", state: state() } as T;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => ({
    ...draft,
    markdown: "My retained document.\n",
    cleanMarkdown: "My retained document.\n",
  }));
  expect(await controller.flush()).toBe(false);
  expect(writes).toHaveLength(1);
  expect(await controller.recreateFile("/practice.md")).toBe(false);
  expect(writes).toHaveLength(1);
  expect(resolved).toEqual([writes[0].operationId]);
  expect(controller.readDraft().markdown).toBe("My retained document.\n");
});
