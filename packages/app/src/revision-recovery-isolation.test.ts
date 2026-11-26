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

function page(id: string, storage: MemoryStorage, tabStorage: MemoryStorage) {
  const controller = new RevisionSessionController(review, saved, {
    id: () => id,
    storage,
    tabStorage,
    // No server response: these tests exercise private offline recovery.
    request: async () => null,
  });
  const drafts = new RevisionUiDraftStore();
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => ({
      ...value,
      cleanMarkdown: value.cleanMarkdown ?? value.markdown,
    }),
    adopt: () => null,
    readUiDrafts: drafts.read,
    restoreUiDrafts: drafts.restore,
    subscribeUiDrafts: drafts.subscribe,
  });
  return { controller, drafts };
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
  expect(observer.controller.readDraft().markdown).toBe(
    "Work from the closed tab.\n",
  );
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
