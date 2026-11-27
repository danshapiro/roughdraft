import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  duplicate() {
    const copy = new MemoryStorage();
    for (const [key, value] of this.values) copy.setItem(key, value);
    return copy;
  }
}

const saved: RevisionDraft = {
  markdown: "Saved document.\n",
  cleanMarkdown: "Saved document.\n",
  decisions: {},
  reviewComments: [],
};
const review: ComparisonReviewData = {
  id: "recovery-isolation",
  revision: 1,
  mode: "document",
  title: "Recover independent browser work",
  beforeLabel: "Original",
  afterLabel: "Working",
  targetPath: null,
  beforeText: saved.markdown,
  afterText: saved.markdown,
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
  draft: saved,
};
const controllers: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
});

function page(
  id: string,
  storage: MemoryStorage,
  tabStorage: MemoryStorage,
  checkpoint?: () => Promise<{ checkpointId: string }>,
) {
  const controller = new RevisionSessionController(review, saved, {
    id: () => id,
    storage,
    tabStorage,
    // No server response: these tests exercise private offline recovery.
    request: async <T>(path: string) =>
      path.endsWith("/checkpoint") && checkpoint
        ? ((await checkpoint()) as T)
        : null,
  });
  const drafts = new RevisionUiDraftStore();
  let editorMarkdown = controller.readDraft().markdown;
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => {
      editorMarkdown = value.markdown;
      return { ...value, cleanMarkdown: value.cleanMarkdown ?? value.markdown };
    },
    adopt: () => null,
    readUiDrafts: drafts.read,
    restoreUiDrafts: drafts.restore,
    subscribeUiDrafts: drafts.subscribe,
  });
  return { controller, drafts, editorMarkdown: () => editorMarkdown };
}
function edit(
  current: ReturnType<typeof page>,
  document: string,
  feedback: string,
) {
  current.drafts.setComment("c1", {
    value: feedback,
    original: "Saved comment",
    editing: true,
  });
  current.controller.updateDraft(() => ({
    ...saved,
    markdown: document,
    cleanMarkdown: document,
  }));
}

test("a duplicated tab inherits private work once, then each tab reloads only its own later edits", () => {
  const shared = new MemoryStorage();
  const originalTab = new MemoryStorage();
  const original = page("original", shared, originalTab);
  edit(original, "Inherited work.\n", "Inherited unfinished feedback");
  const originalRecovery = shared.getItem(
    "roughdraft-draft:recovery-isolation:original",
  );
  expect(originalRecovery).not.toBeNull();

  // Browsers copy sessionStorage when duplicating a tab, but share localStorage.
  const duplicateTab = originalTab.duplicate();
  const duplicate = page("duplicate", shared, duplicateTab);
  expect(duplicate.controller.readDraft().markdown).toBe("Inherited work.\n");
  expect(duplicate.drafts.getSnapshot().comments.c1.value).toBe(
    "Inherited unfinished feedback",
  );
  expect(shared.getItem("roughdraft-draft:recovery-isolation:original")).toBe(
    originalRecovery,
  );

  edit(original, "Original tab later work.\n", "Original private feedback");
  edit(duplicate, "Duplicate tab later work.\n", "Duplicate private feedback");
  original.controller.stop();
  duplicate.controller.stop();
  const originalReload = page("original-reload", shared, originalTab);
  const duplicateReload = page("duplicate-reload", shared, duplicateTab);
  expect(originalReload.controller.readDraft().markdown).toBe(
    "Original tab later work.\n",
  );
  expect(duplicateReload.controller.readDraft().markdown).toBe(
    "Duplicate tab later work.\n",
  );
  expect(originalReload.drafts.getSnapshot().comments.c1.value).toBe(
    "Original private feedback",
  );
  expect(duplicateReload.drafts.getSnapshot().comments.c1.value).toBe(
    "Duplicate private feedback",
  );
  expect(originalReload.controller.readDraft().reviewComments).toEqual([]);
  expect(duplicateReload.controller.readDraft().reviewComments).toEqual([]);
});

test("a new tab leaves live private work alone, offers it after its owner goes quiet, and retains an explicit restore over reload", async () => {
  const shared = new MemoryStorage();
  const original = page("original", shared, new MemoryStorage());
  edit(original, "Work from the closed tab.\n", "Unsubmitted private reply");
  original.controller.start();
  const observerTab = new MemoryStorage();
  const observer = page("observer", shared, observerTab);
  observer.controller.start();
  await vi.advanceTimersByTimeAsync(12_000);
  expect(observer.controller.getSnapshot().orphans).toEqual([]);
  expect(observer.controller.readDraft().markdown).toBe(saved.markdown);
  expect(observer.drafts.getSnapshot().comments).toEqual({});

  original.controller.stop();
  await vi.advanceTimersByTimeAsync(12_000);
  const orphans = observer.controller.getSnapshot().orphans;
  expect(orphans).toHaveLength(1);
  const recovered = observer.controller.inspectOrphan(orphans[0].key);
  expect(recovered.workingDraft.markdown).toBe("Work from the closed tab.\n");
  await observer.controller.restoreOrphan(orphans[0].key);
  expect(shared.getItem(orphans[0].key)).toBeNull();
  expect(observer.controller.getSnapshot().orphans).toEqual([]);
  expect(observer.controller.readDraft().markdown).toBe(
    "Work from the closed tab.\n",
  );
  expect(observer.editorMarkdown()).toBe("Work from the closed tab.\n");
  expect(observer.drafts.getSnapshot().comments.c1.value).toBe(
    "Unsubmitted private reply",
  );
  observer.controller.stop();

  const reloaded = page("observer-reload", shared, observerTab);
  expect(reloaded.controller.readDraft().markdown).toBe(
    "Work from the closed tab.\n",
  );
  expect(Object.keys(reloaded.drafts.getSnapshot().comments)).toEqual(["c1"]);
  expect(reloaded.drafts.getSnapshot().comments.c1.value).toBe(
    "Unsubmitted private reply",
  );
  expect(reloaded.controller.readDraft().reviewComments).toEqual([]);
});

test("a reloaded tab does not offer its specifically claimed predecessor as orphaned work", async () => {
  const shared = new MemoryStorage();
  const tab = new MemoryStorage();
  const original = page("original", shared, tab);
  edit(original, "Recovered body.\n", "Recovered private comment");
  original.controller.start();
  original.controller.stop();
  const reloaded = page("reloaded", shared, tab);
  reloaded.controller.start();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(reloaded.controller.readDraft().markdown).toBe("Recovered body.\n");
  expect(reloaded.drafts.getSnapshot().comments.c1.value).toBe(
    "Recovered private comment",
  );
  expect(reloaded.controller.getSnapshot().orphans).toEqual([]);
  expect(
    shared.getItem("roughdraft-draft:recovery-isolation:original"),
  ).toBeNull();
});

test("claiming an inspected browser copy refuses a newer record from its resumed owner", async () => {
  const shared = new MemoryStorage();
  const original = page("original", shared, new MemoryStorage());
  edit(original, "First private body.\n", "First private draft");
  original.controller.stop();
  const observer = page("observer", shared, new MemoryStorage());
  observer.controller.start();
  await vi.advanceTimersByTimeAsync(12_000);
  const key = observer.controller.getSnapshot().orphans[0].key;
  observer.controller.inspectOrphan(key);
  edit(original, "New private body.\n", "New private draft");
  original.controller.stop();
  await expect(observer.controller.restoreOrphan(key)).rejects.toThrow(
    /changed|active again/i,
  );
  expect(observer.controller.readDraft().markdown).toBe(saved.markdown);
  expect(shared.getItem(key)).toContain("New private body.");
});

test("dismissing one inspected orphan leaves the open review and other browser work intact", async () => {
  const shared = new MemoryStorage();
  for (const id of ["one", "two"]) {
    const closed = page(id, shared, new MemoryStorage());
    edit(closed, `Unique body ${id}.\n`, `Private feedback ${id}`);
    closed.controller.stop();
  }
  const observer = page("observer", shared, new MemoryStorage());
  observer.controller.start();
  await vi.advanceTimersByTimeAsync(12_000);
  const key = "roughdraft-draft:recovery-isolation:one";
  const other = shared.getItem("roughdraft-draft:recovery-isolation:two");
  observer.controller.inspectOrphan(key);
  await observer.controller.dismissOrphan(key);
  expect(shared.getItem(key)).toBeNull();
  expect(shared.getItem("roughdraft-draft:recovery-isolation:two")).toBe(other);
  expect(observer.controller.readDraft()).toEqual(saved);
  expect(observer.drafts.getSnapshot().comments).toEqual({});
  expect(
    observer.controller.getSnapshot().orphans.map((entry) => entry.key),
  ).toEqual(["roughdraft-draft:recovery-isolation:two"]);
});

test("restoring other work waits until the current unsaved document and private feedback can be preserved", async () => {
  const shared = new MemoryStorage();
  const closed = page("closed", shared, new MemoryStorage());
  edit(closed, "Closed browser work.\n", "Closed private feedback");
  closed.controller.stop();
  const current = page("current", shared, new MemoryStorage());
  edit(current, "Current unsaved work.\n", "Current private feedback");
  current.controller.start();
  await vi.advanceTimersByTimeAsync(12_000);
  const key = "roughdraft-draft:recovery-isolation:closed";
  current.controller.inspectOrphan(key);
  await expect(current.controller.restoreOrphan(key)).rejects.toThrow(
    /must be preserved/i,
  );
  expect(current.controller.readDraft().markdown).toBe(
    "Current unsaved work.\n",
  );
  expect(current.drafts.getSnapshot().comments.c1.value).toBe(
    "Current private feedback",
  );
  expect(shared.getItem(key)).not.toBeNull();
});

test("a duplicated tab never clears a live predecessor's newer independently owned recovery", async () => {
  const shared = new MemoryStorage();
  const originalTab = new MemoryStorage();
  const original = page("original", shared, originalTab);
  edit(original, "Inherited work.\n", "Inherited feedback");
  original.controller.start();
  const duplicate = page("duplicate", shared, originalTab.duplicate());
  duplicate.controller.start();
  edit(original, "New original work.\n", "New original feedback");
  await vi.advanceTimersByTimeAsync(12_000);
  const key = "roughdraft-draft:recovery-isolation:original";
  expect(shared.getItem(key)).toContain("New original work.");
  expect(duplicate.controller.getSnapshot().orphans).toEqual([]);
  original.controller.stop();
  await vi.advanceTimersByTimeAsync(12_000);
  expect(shared.getItem(key)).toContain("New original work.");
  expect(
    duplicate.controller.getSnapshot().orphans.map((entry) => entry.key),
  ).toContain(key);
});

test("reload claims the older shared checkpoint when private recovery contains newer work from the same quiet predecessor", async () => {
  const shared = new MemoryStorage();
  const tab = new MemoryStorage();
  const original = page("original", shared, tab);
  edit(original, "Newest private body.\n", "Newest private draft");
  // Simulate losing the old page before its trailing shared write can run.
  vi.clearAllTimers();
  const reloaded = page("reloaded", shared, tab);
  reloaded.controller.start();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(reloaded.controller.readDraft().markdown).toBe(
    "Newest private body.\n",
  );
  expect(reloaded.controller.getSnapshot().orphans).toEqual([]);
  expect(
    shared.getItem("roughdraft-draft:recovery-isolation:original"),
  ).toBeNull();
});

test("private typing while current work is being preserved cancels an orphan restore without losing either copy", async () => {
  const shared = new MemoryStorage();
  const closed = page("closed", shared, new MemoryStorage());
  edit(closed, "Closed work.\n", "Closed private feedback");
  closed.controller.stop();
  let finish = (_value: { checkpointId: string }) => {};
  const pending = new Promise<{ checkpointId: string }>((resolve) => {
    finish = resolve;
  });
  const current = page("current", shared, new MemoryStorage(), () => pending);
  edit(current, "Current work.\n", "Current private feedback");
  current.controller.start();
  await vi.advanceTimersByTimeAsync(12_000);
  const key = "roughdraft-draft:recovery-isolation:closed";
  current.controller.inspectOrphan(key);
  const restoring = current.controller.restoreOrphan(key);
  await vi.advanceTimersByTimeAsync(0);
  current.drafts.setComment("c1", {
    value: "Newer private typing",
    original: "Saved comment",
    editing: true,
  });
  finish({ checkpointId: "preserved-earlier-draft" });
  await expect(restoring).rejects.toThrow(/changed/i);
  expect(current.controller.readDraft().markdown).toBe("Current work.\n");
  expect(current.drafts.getSnapshot().comments.c1.value).toBe(
    "Newer private typing",
  );
  expect(shared.getItem(key)).not.toBeNull();
});
