import fs from "node:fs";
import path from "node:path";
import { mergeReviewDrafts, reviewDraftSignature } from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonStore } from "../../server/src/comparisons";
import type { ComparisonReviewData } from "./comparison-types";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { adoptRevisionDisk } from "./revision-disk-adoption";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import {
  RevisionSessionController,
  type RevisionDraft,
} from "./revision-session";
import { RevisionSource } from "./revision-source";
import { RevisionUiDraftStore } from "./revision-ui-drafts";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));
const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
const parent = path.resolve(process.cwd(), "../../.test-tmp/disk-ancestry");
const original = "# Plan\n\nAlpha paragraph.\n\nBeta paragraph.\n";
const stamp = '{id="c1" by="AI" at="2026-11-22T12:00:00.000Z"}';
const annotated = `# Plan\n\nAlpha {==paragraph==}{>>Agent question.<<}${stamp}.\n\nBeta paragraph.\n`;
let directory: string;
let target: string;
let store: ComparisonStore;
let id: string;
const controllers: RevisionSessionController[] = [];
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
function draft(markdown: string): RevisionDraft {
  return {
    markdown,
    cleanMarkdown: cleanRevisionSourceMarkdown(markdown),
    decisions: {},
    reviewComments: [
      ...criticMarkdownToEditorState(markdown).comments.values(),
    ].map((comment) => ({
      ...comment,
      changeId: comment.parentCommentId ?? "document",
    })),
  };
}
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  directory = fs.mkdtempSync(path.join(parent, "run-"));
  target = path.join(directory, "source.md");
  store = new ComparisonStore(path.join(directory, "reviews"), {
    homeDir: directory,
  });
  vi.useFakeTimers();
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  store.watchers.close();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});
function open(markdown: string, autosave = "none") {
  fs.writeFileSync(target, markdown);
  id = store.openDocument({ targetPath: target, autosave }).id;
}
function commit(value: RevisionDraft, reason = "sync") {
  const state = store.state(id);
  const result = store.reconcile(id, {
    operationId: `seed-${state.revision}`,
    pageInstanceId: "seed",
    operationSequence: state.revision,
    operationContext: state.operationContext,
    expectedRevision: state.revision,
    baseRevision: state.revision,
    baseSignature: state.signature,
    base: state.draft,
    draft: value,
    expectedDisk: {
      path: target,
      version: state.disk?.version,
      hash: state.disk?.hash,
    },
    reason,
    writeFile: false,
    localGeneration: state.revision,
  });
  expect(result.status).toBe("committed");
}
function mount(
  beforeReconcile?: (body: Record<string, unknown>) => void,
  ui = new RevisionUiDraftStore(),
) {
  const initial = store.state(id);
  const controller = new RevisionSessionController(
    initial.review as unknown as ComparisonReviewData,
    initial.draft as RevisionDraft,
    {
      request: async <T>(route: string, body?: object) => {
        if (!body) return structuredClone(store.state(id)) as T;
        if (route.endsWith("/checkpoint"))
          return store.checkpoint(id, body as Record<string, unknown>) as T;
        if (route.endsWith("/reconcile")) {
          beforeReconcile?.(body as Record<string, unknown>);
          return store.reconcile(id, body as Record<string, unknown>) as T;
        }
        if (route.endsWith("/checkpoint/resolve")) return {} as T;
        throw new Error(`Unexpected request ${route}`);
      },
      merge: async (base, local, incoming, options) =>
        mergeReviewDrafts(base, local, incoming, {
          ...options,
          budgetMs: 1000,
        }),
      storage: new MemoryStorage(),
      tabStorage: new MemoryStorage(),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value, options) => {
      if (options?.idRemap) ui.remap(options.idRemap);
      return { ...value, cleanMarkdown: value.cleanMarkdown ?? value.markdown };
    },
    adopt: (base, markdown, force, diskBase) =>
      adoptRevisionDisk(base, markdown, schema, force, diskBase),
    readUiDrafts: ui.read,
    restoreUiDrafts: ui.restore,
  });
  controller.start();
  return controller;
}
async function writeDisk(markdown: string) {
  fs.writeFileSync(target, markdown);
  store.watchers.invalidate(target);
  await vi.waitFor(() => expect(store.state(id).disk?.text).toBe(markdown));
}
async function settle(controller: RevisionSessionController) {
  await controller.refresh(true);
  await vi.advanceTimersByTimeAsync(1200);
  await controller.flush(false);
}

test("autosave none merges saved browser prose with independent real disk edits", async () => {
  open(original);
  commit(
    draft(original.replace("Alpha paragraph.", "Alpha edited in browser.")),
  );
  const controller = mount();
  await vi.advanceTimersByTimeAsync(0);
  await writeDisk(original.replace("Beta paragraph.", "Beta edited on disk."));
  await settle(controller);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(store.state(id).draft.cleanMarkdown).toBe(
    "# Plan\n\nAlpha edited in browser.\n\nBeta edited on disk.\n",
  );
  expect(fs.readFileSync(target, "utf8")).not.toContain("browser");
});

test("a second disk write before the first adoption commits retains browser text", async () => {
  open(original, target);
  const disk1 = original.replace("Beta paragraph.", "Beta edited on disk.");
  const browser = draft(
    original.replace("Alpha paragraph.", "Alpha edited in browser."),
  );
  commit(browser);
  let raced = false;
  const controller = mount((body) => {
    if (!raced && body.reason === "adopt") {
      raced = true;
      fs.writeFileSync(
        target,
        disk1.replace("Beta edited on disk.", "Beta edited twice on disk."),
      );
    }
  });
  fs.writeFileSync(target, disk1);
  store.watchers.invalidate(target);
  await settle(controller);
  expect(raced).toBe(true);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(store.state(id).draft.cleanMarkdown).toContain(
    "Alpha edited in browser.",
  );
  expect(store.state(id).draft.cleanMarkdown).toContain(
    "Beta edited twice on disk.",
  );
});

test("a second disk write after adoption commits races the bound file save without losing saved browser text", async () => {
  open(original, target);
  const disk1 = original.replace("Beta paragraph.", "Beta edited on disk.");
  await writeDisk(disk1);
  commit(
    draft(disk1.replace("Alpha paragraph.", "Alpha edited in browser.")),
    "adopt",
  );
  expect(store.state(id).review.savedText).toBe(disk1);
  let raced = false;
  const controller = mount((body) => {
    if (!raced && body.writeFile) {
      raced = true;
      fs.writeFileSync(
        target,
        disk1.replace("Beta edited on disk.", "Beta edited twice on disk."),
      );
    }
  });
  await settle(controller);
  expect(raced).toBe(true);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(store.state(id).draft.cleanMarkdown).toContain(
    "Alpha edited in browser.",
  );
  expect(store.state(id).draft.cleanMarkdown).toContain(
    "Beta edited twice on disk.",
  );
});

test.each([
  "local",
  "incoming",
] as const)("the %s conflict choice resolves saved-browser versus disk prose against the disk ancestor", async (choice) => {
  open(original);
  commit(
    draft(original.replace("Alpha paragraph.", "Alpha edited in browser.")),
  );
  const controller = mount();
  await writeDisk(
    original
      .replace("Alpha paragraph.", "Alpha edited on disk.")
      .replace("Beta paragraph.", "Beta edited on disk."),
  );
  await settle(controller);
  const conflict = controller.getSnapshot().conflict;
  expect(conflict?.kind).toBe("conflict");
  if (!conflict) throw new Error("Expected a conflict to inspect");
  expect(await controller.resolveConflict(choice, conflict.signature)).toBe(
    true,
  );
  const value = store.state(id).draft.cleanMarkdown;
  expect(value).toContain(
    choice === "local" ? "Alpha edited in browser." : "Alpha edited on disk.",
  );
  expect(value).toContain("Beta edited on disk.");
});

test.each([
  annotated,
  annotated.replace(stamp, "{#c1}"),
])("real disk adoption preserves a browser-deleted imported comment (%#)", async (source) => {
  open(source);
  commit(draft(original));
  const controller = mount();
  await writeDisk(source.replace("Beta paragraph.", "Beta edited on disk."));
  await settle(controller);
  expect(store.state(id).draft.reviewComments).toEqual([]);
  expect(store.state(id).draft.markdown).not.toContain("{>>");
  expect(store.state(id).draft.markdown).toContain("Beta edited on disk.");
});

test("outside prose rewriting a saved anchor retains its feedback detached with the original quote", async () => {
  open(annotated);
  commit(draft(annotated));
  const controller = mount();
  await writeDisk(
    "# Plan\n\nAlpha rewritten by the agent.\n\nBeta paragraph.\n",
  );
  await settle(controller);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(store.state(id).draft.reviewComments).toEqual([
    expect.objectContaining({
      id: "c1",
      content: "Agent question.",
      originalQuote: "paragraph",
      scope: "document",
      detachedReason: expect.any(String),
    }),
  ]);
  expect(store.state(id).draft.cleanMarkdown).toContain(
    "Alpha rewritten by the agent.",
  );
});

test("real disk adoption preserves a browser-edited imported comment", async () => {
  open(annotated);
  const value = draft(annotated);
  value.reviewComments = value.reviewComments.map((comment) => ({
    ...comment,
    content: "Answered in the browser.",
  }));
  commit(value);
  const controller = mount();
  await writeDisk(annotated.replace("Beta paragraph.", "Beta edited on disk."));
  await settle(controller);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(store.state(id).draft.reviewComments).toEqual([
    expect.objectContaining({ id: "c1", content: "Answered in the browser." }),
  ]);
  expect(store.state(id).draft.markdown).toContain("Beta edited on disk.");
});

test("an ambiguous disk edit at a pending proposal edge waits without removing feedback", async () => {
  const source = "A {++proposal++}{#s1}B.\n";
  open(source);
  commit(draft(source));
  const controller = mount();
  await writeDisk("A extraB.\n");
  await settle(controller);
  expect(controller.getSnapshot().conflict?.kind).toBe("waiting");
  expect(store.state(id).draft.markdown).toBe(source);
});

test("real disk adoption preserves a kept imported suggestion", async () => {
  const source =
    "# Plan\n\nAlpha {++signed++}{#s1} paragraph.\n\nBeta paragraph.\n";
  open(source);
  commit({
    ...draft(source.replace("{++signed++}{#s1}", "signed")),
    decisions: { s1: "kept" },
  });
  const controller = mount();
  await writeDisk(source.replace("Beta paragraph.", "Beta edited on disk."));
  await settle(controller);
  expect(store.state(id).draft.markdown).not.toContain("{++");
  expect(store.state(id).draft.decisions).toEqual({ s1: "kept" });
  expect(store.state(id).draft.cleanMarkdown).toContain(
    "Alpha signed paragraph.",
  );
});

test("renumbered imported feedback is not added again after reload and another real disk write", async () => {
  open(original);
  commit(
    draft(
      original.replace(
        "Alpha paragraph.",
        `Alpha {==paragraph==}{>>Browser feedback.<<}${stamp}.`,
      ),
    ),
  );
  const ui = new RevisionUiDraftStore();
  ui.restore({
    comments: {
      "private-reply": {
        value: "Unfinished private reply to browser feedback.",
        original: "",
        editing: true,
        target: {
          id: "private-reply",
          parentCommentId: "c1",
          changeId: "document",
          content: "",
          createdAt: "2026-11-22T12:05:00.000Z",
        },
      },
    },
  });
  let controller = mount(undefined, ui);
  const disk1 = original.replace(
    "Beta paragraph.",
    `Beta {==paragraph==}{>>Agent feedback.<<}${stamp}.`,
  );
  await writeDisk(disk1);
  await settle(controller);
  expect(store.state(id).draft.reviewComments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "c1", content: "Browser feedback." }),
      expect.objectContaining({ id: "c2", content: "Agent feedback." }),
    ]),
  );
  expect(
    ui.getSnapshot().comments["private-reply"]?.target?.parentCommentId,
  ).toBe("c1");
  expect(
    store
      .state(id)
      .draft.reviewComments.some((comment) =>
        comment.content.includes("Unfinished"),
      ),
  ).toBe(false);
  controller.stop();
  controller = mount();
  await writeDisk(disk1.replace("# Plan", "# Updated plan"));
  await settle(controller);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(
    store
      .state(id)
      .draft.reviewComments.filter(
        (comment) => comment.content === "Agent feedback.",
      ),
  ).toEqual([expect.objectContaining({ id: "c2" })]);
});

test("a saved browser edit overlapping the disk edit still enters conflict recovery", async () => {
  open(original);
  commit(
    draft(original.replace("Alpha paragraph.", "Alpha edited in browser.")),
  );
  const controller = mount();
  await writeDisk(
    original.replace("Alpha paragraph.", "Alpha edited on disk."),
  );
  await settle(controller);
  expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
  expect(store.state(id).draft.cleanMarkdown).toContain(
    "Alpha edited in browser.",
  );
});

test("an imported comment edited differently in the browser and on disk remains a real conflict", async () => {
  open(annotated);
  const value = draft(annotated.replace("Agent question.", "Browser answer."));
  commit(value);
  const controller = mount();
  await writeDisk(annotated.replace("Agent question.", "Agent follow-up."));
  await settle(controller);
  expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
  expect(reviewDraftSignature(store.state(id).draft)).toBe(
    reviewDraftSignature(value),
  );
});

for (const autosave of ["none", "target"] as const) {
  for (const feedback of ["comment", "suggestion"] as const) {
    test(`saved review-only ${feedback} becomes detached feedback after an outside rewrite, autosave ${autosave}`, async () => {
      open(original, autosave === "target" ? target : "none");
      const annotated =
        feedback === "comment"
          ? original.replace(
              "Alpha paragraph.",
              `Alpha {==paragraph==}{>>Browser question.<<}${stamp}.`,
            )
          : original.replace(
              "Alpha paragraph.",
              'Alpha {++long ++}{id="s1" by="Dan" at="2026-11-22T12:00:00.000Z"}paragraph.',
            );
      commit(draft(annotated));
      const controller = mount();
      await vi.advanceTimersByTimeAsync(0);
      await writeDisk(
        original.replace("Alpha paragraph.", "Alpha rewritten by the agent."),
      );
      await settle(controller);
      expect(controller.getSnapshot().conflict).toBeNull();
      const saved = store.state(id).draft;
      expect(saved.cleanMarkdown).toContain("Alpha rewritten by the agent.");
      expect(fs.readFileSync(target, "utf8")).toContain(
        "Alpha rewritten by the agent.",
      );
      if (feedback === "comment") {
        expect(saved.reviewComments).toEqual([
          expect.objectContaining({
            id: "c1",
            content: "Browser question.",
            scope: "document",
            originalQuote: "paragraph",
            detachedReason: expect.any(String),
          }),
        ]);
      } else {
        expect(saved.markdown).not.toContain("{++long ++}");
        expect(saved.outdatedSuggestions).toEqual([
          expect.objectContaining({
            id: "s1",
            proposedText: "long ",
            reason: expect.any(String),
          }),
        ]);
      }
    });
  }
}

test("detaching a saved review-only comment also preserves unrelated saved browser prose", async () => {
  open(original);
  commit(
    draft(
      original
        .replace(
          "Alpha paragraph.",
          `Alpha {==paragraph==}{>>Browser question.<<}${stamp}.`,
        )
        .replace("Beta paragraph.", "Beta saved in the browser."),
    ),
  );
  const controller = mount();
  await vi.advanceTimersByTimeAsync(0);
  await writeDisk(
    original.replace("Alpha paragraph.", "Alpha rewritten by the agent."),
  );
  await settle(controller);
  expect(controller.getSnapshot().conflict).toBeNull();
  const saved = store.state(id).draft;
  expect(saved.cleanMarkdown).toContain("Alpha rewritten by the agent.");
  expect(saved.cleanMarkdown).toContain("Beta saved in the browser.");
  expect(saved.reviewComments[0]).toEqual(
    expect.objectContaining({ originalQuote: "paragraph", scope: "document" }),
  );
});

test("new disk comment IDs that equal prior alias targets stay distinct through later writes and reload", async () => {
  open(original);
  commit(
    draft(
      original.replace(
        "Alpha paragraph.",
        `Alpha {==paragraph==}{>>Browser feedback.<<}${stamp}.`,
      ),
    ),
  );
  let controller = mount();
  await vi.advanceTimersByTimeAsync(0);
  const first = original.replace(
    "Beta paragraph.",
    `Beta {==paragraph==}{>>Agent first note.<<}${stamp}.`,
  );
  await writeDisk(first);
  await settle(controller);
  expect(store.state(id).draft.diskOrigin?.ids).toEqual({ c1: "c2" });
  controller.stop();
  controller = mount();
  const second = first.replace(
    "# Plan",
    '# {==Plan==}{>>Agent second note.<<}{id="c2" by="AI" at="2026-11-22T12:20:00.000Z"}',
  );
  await writeDisk(second);
  await settle(controller);
  const saved = store.state(id).draft;
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(saved.reviewComments.map((c) => [c.id, c.content]).sort()).toEqual([
    ["c1", "Browser feedback."],
    ["c2", "Agent first note."],
    ["c3", "Agent second note."],
  ]);
  expect(
    draft(saved.markdown)
      .reviewComments.map((c) => [c.id, c.content])
      .sort(),
  ).toEqual(saved.reviewComments.map((c) => [c.id, c.content]).sort());
  expect(saved.diskOrigin?.ids).toEqual({ c1: "c2", c2: "c3" });
  controller.stop();
  controller = mount();
  await writeDisk(second.replace("Beta", "Updated Beta"));
  await settle(controller);
  expect(store.state(id).draft.reviewComments).toHaveLength(3);
  expect(
    store
      .state(id)
      .draft.reviewComments.map((c) => c.content)
      .sort(),
  ).toEqual(["Agent first note.", "Agent second note.", "Browser feedback."]);
});

test.each([
  "\n",
  "\r\n",
])("outside adoption keeps list spelling and line endings %j while merging independent prose", async (newline) => {
  const source = [
    "# Plan",
    "",
    "* Alpha paragraph.",
    "* Beta paragraph.",
    "",
  ].join(newline);
  open(source);
  commit(
    draft(source.replace("Alpha paragraph.", "Alpha saved in the browser.")),
  );
  const controller = mount();
  await vi.advanceTimersByTimeAsync(0);
  await writeDisk(source.replace("Beta paragraph.", "Beta edited on disk."));
  await settle(controller);
  expect(controller.getSnapshot().conflict).toBeNull();
  const expected = source
    .replace("Alpha paragraph.", "Alpha saved in the browser.")
    .replace("Beta paragraph.", "Beta edited on disk.");
  expect(store.state(id).draft.cleanMarkdown).toBe(expected);
});
