import fs from "node:fs";
import path from "node:path";
import {
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
} from "@roughdraft/rfm";
import { Extension, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonStore } from "../../server/src/comparisons";
import type { ComparisonReviewData } from "./comparison-types";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
import { adoptRevisionDisk } from "./revision-disk-adoption";
import { recordReviewedChange, reviewedChanges } from "./revision-history";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";
import { RevisionSource } from "./revision-source";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));

const schema = getSchema([
  ...createEditorExtensions(""),
  RevisionSource,
  Extension.create({
    name: "explicitReloadHistory",
    addGlobalAttributes: () => [
      {
        types: ["doc"],
        attributes: { kept: { default: [] }, reviewed: { default: [] } },
      },
    ],
  }),
]);
const parent = path.resolve(
  process.cwd(),
  "../../.test-tmp/explicit-disk-recovery",
);
const original =
  '# Plan\r\n\r\nThe release supports {++offline review++}{#s1} for longer documents.\r\n\r\nBeta paragraph.\r\n\r\n---\r\n# Keep this metadata comment.\r\nstatus: "in progress" # Keep this scalar comment.\r\nsuggestions:\r\n  s1:\r\n    by: AI\r\n    at: "2026-11-22T12:00:00.000Z"\r\n';
let root: string;
let store: ComparisonStore;
const active: RevisionSessionController[] = [];
beforeEach(() => {
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

async function waitingReview(withFeedback = false, collision = false) {
  const target = path.join(root, "practice.md");
  fs.writeFileSync(target, original);
  const review = store.openDocument({ targetPath: target, autosave: target });
  const initial = store.state(review.id);
  const posted: Array<{ route: string; body: Record<string, unknown> }> = [];
  const controller = new RevisionSessionController(
    initial.review as unknown as ComparisonReviewData,
    initial.draft as RevisionDraft,
    {
      request: async <T>(route: string, body?: object) => {
        const id = route.split("/")[1];
        if (!body) return structuredClone(store.state(id)) as T;
        const request = body as Record<string, unknown>;
        posted.push({ route, body: structuredClone(request) });
        if (route.endsWith("/checkpoint"))
          return store.checkpoint(id, request) as T;
        if (route.endsWith("/reconcile"))
          return store.reconcile(id, request) as T;
        if (route.endsWith("/copy")) return store.copy(id, request) as T;
        throw new Error(`Unexpected request ${route}`);
      },
      merge: async (base, local, incoming, options) =>
        mergeReviewDrafts(base, local, incoming, {
          ...options,
          budgetMs: 1000,
        }),
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        key: () => null,
        length: 0,
      },
      tabStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    },
  );
  active.push(controller);
  controller.setAdapter({
    apply: (draft) => ({
      ...draft,
      cleanMarkdown:
        draft.cleanMarkdown ?? cleanRevisionSourceMarkdown(draft.markdown),
    }),
    adopt: (base, markdown, force, diskBase) =>
      adoptRevisionDisk(base, markdown, schema, force, diskBase),
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  await controller.refresh(true);
  const annotated = withFeedback
    ? original
        .replace(
          "Beta paragraph.",
          "{==Beta paragraph.==}{>>Discuss the original paragraph.<<}{#c2}",
        )
        .replace("supports ", "{~~supports~>enables~~}{#s2} ")
    : original;
  const comments: RevisionDraft["reviewComments"] = withFeedback
    ? [
        {
          id: "c2",
          changeId: "document",
          content: "Discuss the original paragraph.",
          createdAt: "2026-11-22T12:00:00.000Z",
        },
        {
          id: "c3",
          changeId: "c2",
          parentCommentId: "c2",
          content: "Keep this reply with its original discussion.",
          createdAt: "2026-11-22T12:01:00.000Z",
        },
        {
          id: "c4",
          changeId: "s2",
          parentCommentId: "s2",
          content: "Keep the discussion on the displaced proposal.",
          createdAt: "2026-11-22T12:02:00.000Z",
        },
      ]
    : [];
  controller.updateDraft((draft) => ({
    ...draft,
    markdown: annotated,
    cleanMarkdown: cleanRevisionSourceMarkdown(original),
    reviewComments: comments,
  }));
  await controller.flush(false);
  let incoming = original
    .replace("Beta paragraph.", "Beta paragraph, edited.")
    .replace(
      "The release",
      withFeedback
        ? 'The {==release==}{>>Review the incoming source.<<}{id="c8" by="AI" at="2026-11-22T13:00:00.000Z"}'
        : "The release",
    );
  if (collision)
    incoming = incoming
      .replace('id="c8"', 'id="c2"')
      .replace("for longer", "for {++agent proposal++}{#s2} longer")
      .replace(
        "\r\nsuggestions:\r\n",
        '\r\nliteral: "s2 and {#c2} remain literal"\r\ncomments:\r\n  c8:\r\n    body: Incoming reply stays with its incoming root.\r\n    re: c2\r\n    at: "2026-11-22T13:01:00.000Z"\r\nsuggestions:\r\n',
      );
  fs.writeFileSync(target, incoming);
  store.watchers.invalidate(target);
  await vi.waitFor(() =>
    expect(store.state(review.id).disk?.text).toBe(incoming),
  );
  await controller.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().conflict).toMatchObject({
    kind: "waiting",
    reloadAvailable: true,
    checkpointSaved: true,
  });
  expect(fs.readFileSync(target, "utf8")).toBe(incoming);
  return { controller, posted, review, target, incoming, comments };
}

test("explicit Reload from file accepts the exact outside source when mixed endmatter cannot be mapped automatically", async () => {
  const f = await waitingReview();
  const reloaded = await f.controller.reloadFromFile();
  expect(reloaded).toBe(true);
  expect(f.controller.getSnapshot().conflict).toBeNull();
  expect(f.controller.readDraft().markdown).toBe(f.incoming);
  expect(store.state(f.review.id).review.savedText).toBe(f.incoming);
  for (let index = 0; index < 3; index++) {
    await f.controller.refresh(true);
    await f.controller.flush(false);
    await vi.advanceTimersByTimeAsync(300);
  }
  expect(f.controller.getSnapshot().conflict).toBeNull();
  expect(fs.readFileSync(f.target, "utf8")).toBe(f.incoming);
  expect(f.posted.filter(({ body }) => body.writeFile === true)).toEqual([]);
});

test("explicit raw Reload retains incoming annotations and preserves displaced discussion and proposals visibly", async () => {
  const f = await waitingReview(true);
  expect(await f.controller.reloadFromFile()).toBe(true);
  const draft = f.controller.readDraft();
  expect(draft.markdown).toBe(f.incoming);
  expect(draft.reviewComments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ...f.comments[0],
        originalQuote: "Beta paragraph.",
        detachedReason: expect.any(String),
      }),
      expect.objectContaining(f.comments[1]),
      expect.objectContaining(f.comments[2]),
      expect.objectContaining({
        id: "c8",
        content: "Review the incoming source.",
      }),
    ]),
  );
  expect(draft.outdatedSuggestions).toEqual([
    expect.objectContaining({
      id: "s2",
      originalText: "supports",
      proposedText: "enables",
    }),
  ]);
  expect(
    extractRoughdraftReviewIndex(draft.markdown)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => item.id),
  ).toEqual(["s1"]);
  await f.controller.flush(false);
  expect(store.state(f.review.id).draft.reviewComments).toEqual(
    draft.reviewComments,
  );
  expect(fs.readFileSync(f.target, "utf8")).toBe(f.incoming);
  expect(f.posted.filter(({ body }) => body.writeFile === true)).toEqual([]);
});

test("Save separately remains usable while ambiguous outside metadata waits", async () => {
  const f = await waitingReview(true);
  const draft = structuredClone(f.controller.readDraft());
  const separate = path.join(root, "my-review.md");
  const result = await f.controller.copy(separate, true);
  expect(result.status).toBe("committed");
  expect(result.savedPath).toBe(separate);
  expect(fs.readFileSync(separate, "utf8")).toBe(draft.cleanMarkdown);
  expect(fs.readFileSync(f.target, "utf8")).toBe(f.incoming);
  expect(result.state?.draft.markdown).toBe(draft.markdown);
  expect(result.state?.draft.reviewComments).toEqual(draft.reviewComments);
  expect(result.state?.review.savedPath).toBe(separate);
});

test("raw Reload renumbers only incoming collisions and reuses those aliases on the next outside update", async () => {
  const f = await waitingReview(true, true);
  expect(await f.controller.reloadFromFile()).toBe(true);
  const first = structuredClone(f.controller.readDraft());
  const aliases = first.diskOrigin?.ids;
  expect(aliases?.c2).toBeTruthy();
  expect(aliases?.c2).not.toBe("c2");
  expect(aliases?.s2).toBeTruthy();
  expect(aliases?.s2).not.toBe("s2");
  const renamed = (source: string) =>
    source
      .replace('id="c2"', `id="${aliases?.c2}"`)
      .replace("{#s2}", `{#${aliases?.s2}}`)
      .replace("re: c2", `re: ${aliases?.c2}`);
  expect(first.markdown).toBe(renamed(f.incoming));
  expect(first.markdown).toContain('literal: "s2 and {#c2} remain literal"');
  expect(first.reviewComments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "c2",
        content: f.comments[0].content,
        detachedReason: expect.any(String),
      }),
      expect.objectContaining({ id: "c3", parentCommentId: "c2" }),
      expect.objectContaining({ id: "c4", parentCommentId: "s2" }),
      expect.objectContaining({
        id: aliases?.c2,
        content: "Review the incoming source.",
      }),
      expect.objectContaining({ id: "c8", parentCommentId: aliases?.c2 }),
    ]),
  );
  expect(first.outdatedSuggestions?.map((item) => item.id)).toEqual(["s2"]);
  const updated = f.incoming.replace(
    "Beta paragraph, edited.",
    "Beta paragraph, edited again.",
  );
  fs.writeFileSync(f.target, updated);
  store.watchers.invalidate(f.target);
  await vi.waitFor(() =>
    expect(store.state(f.review.id).disk?.text).toBe(updated),
  );
  await f.controller.refresh(true);
  expect(f.controller.getSnapshot().conflict?.reloadAvailable).toBe(true);
  expect(await f.controller.reloadFromFile()).toBe(true);
  const second = f.controller.readDraft();
  expect(second.diskOrigin?.ids).toEqual(aliases);
  expect(second.markdown).toBe(renamed(updated));
  expect(second.reviewComments).toEqual(first.reviewComments);
  expect(second.outdatedSuggestions).toEqual(first.outdatedSuggestions);
  await f.controller.flush(false);
  await f.controller.refresh(true);
  expect(f.controller.getSnapshot().conflict).toBeNull();
  expect(fs.readFileSync(f.target, "utf8")).toBe(updated);
  expect(f.posted.filter(({ body }) => body.writeFile === true)).toEqual([]);
});

function rawReload(review: RevisionDraft, incoming: string, before = original) {
  const result = adoptRevisionDisk(review, incoming, schema, true, {
    path: "/practice.md",
    markdown: before,
    resolution: "incoming",
  });
  expect(result && "status" in result ? result.status : result).toBe("merged");
  if (!result || !("status" in result) || result.status !== "merged")
    throw new Error("Explicit reload must keep this source and its feedback");
  return result.draft;
}

for (const browserChanges of [false, true]) {
  test(`known disk comment ${browserChanges ? "keeps both independently edited discussions" : "accepts an agent-only update without renumbering it"}`, () => {
    const before = original.replace(
      "Beta paragraph.",
      "{==Beta paragraph.==}{>>Original discussion.<<}{#c1}",
    );
    const browserBody = browserChanges
      ? "Browser saved discussion."
      : "Original discussion.";
    const review: RevisionDraft = {
      markdown: before.replace("Original discussion.", browserBody),
      cleanMarkdown: cleanRevisionSourceMarkdown(before),
      decisions: {},
      reviewComments: [
        {
          id: "c1",
          changeId: "document",
          content: browserBody,
          createdAt: "2026-11-22T12:00:00.000Z",
          authorType: "user",
          authorId: "user",
        },
        {
          id: "c2",
          changeId: "c1",
          parentCommentId: "c1",
          content: "Browser reply stays with its saved root.",
          createdAt: "2026-11-22T12:01:00.000Z",
        },
      ],
    };
    const incoming = before.replace(
      "Original discussion.",
      "Agent revised discussion.",
    );
    const reloaded = rawReload(review, incoming, before);
    if (browserChanges) {
      expect(reloaded.reviewComments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "c1",
            content: browserBody,
            detachedReason: expect.any(String),
          }),
          expect.objectContaining({ id: "c2", parentCommentId: "c1" }),
          expect.objectContaining({
            id: expect.not.stringMatching(/^c[12]$/),
            content: "Agent revised discussion.",
          }),
        ]),
      );
      expect(reloaded.diskOrigin?.ids.c1).not.toBe("c1");
      expect(reloaded.diskOrigin?.ids.c1).toBeTruthy();
    } else {
      expect(reloaded.markdown).toBe(incoming);
      expect(reloaded.diskOrigin?.ids.c1).toBeUndefined();
      expect(
        reloaded.reviewComments.find((item) => item.id === "c1")?.content,
      ).toBe("Agent revised discussion.");
      expect(
        reloaded.reviewComments.find((item) => item.id === "c1"),
      ).toMatchObject({
        createdAt: "2026-11-22T12:00:00.000Z",
        authorType: "user",
        authorId: "user",
      });
      expect(
        reloaded.reviewComments.filter((item) => !item.parentCommentId),
      ).toHaveLength(1);
    }
  });
}

for (const change of ["payload", "context"] as const) {
  test(`a known proposal whose browser ${change} changed keeps its committed identity separate from raw incoming feedback`, () => {
    const browser =
      change === "payload"
        ? original.replace("offline review", "browser proposal")
        : original
            .replace("{++offline review++}{#s1}", "")
            .replace(
              "Beta paragraph.",
              "Different passage: {++offline review++}{#s1}",
            );
    const incoming = original.replace("offline review", "agent proposal");
    const draft = rawReload(
      {
        markdown: browser,
        cleanMarkdown: cleanRevisionSourceMarkdown(browser),
        decisions: {},
        reviewComments: [],
      },
      incoming,
    );
    expect(draft.outdatedSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "s1",
          proposedText:
            change === "payload" ? "browser proposal" : "offline review",
        }),
      ]),
    );
    expect(draft.diskOrigin?.ids.s1).toBeTruthy();
    expect(draft.diskOrigin?.ids.s1).not.toBe("s1");
    expect(
      extractRoughdraftReviewIndex(draft.markdown)
        .items.filter((item) => item.kind === "suggestion")
        .map((item) => item.id),
    ).not.toContain("s1");
  });
}

test("a deleted committed disk comment is not recreated with the identity reserved by comment Undo", () => {
  const before = original.replace(
    "Beta paragraph.",
    "{==Beta paragraph.==}{>>Original discussion.<<}{#c1}",
  );
  const review: RevisionDraft = {
    markdown: original,
    cleanMarkdown: cleanRevisionSourceMarkdown(original),
    decisions: {},
    reviewComments: [],
  };
  const incoming = before.replace(
    "Original discussion.",
    "Incoming discussion after deletion.",
  );
  const draft = rawReload(review, incoming, before);
  const comment = draft.reviewComments.find(
    (item) => item.content === "Incoming discussion after deletion.",
  );
  expect(comment).toBeTruthy();
  expect(comment?.id).not.toBe("c1");
  expect(draft.diskOrigin?.ids.c1).toBe(comment?.id);
});

for (const decision of ["accept", "reject"] as const) {
  test(`a proposal already resolved with ${decision} is not resurrected into its History identity`, () => {
    const parsed = criticMarkdownToEditorState(original);
    const state = EditorState.create({ doc: schema.nodeFromJSON(parsed.doc) });
    const transaction = state.tr;
    applySuggestionDecisions(transaction, ["s1"], decision);
    const detail = suggestionDetail(state.doc, "s1");
    const decided = state.apply(
      recordReviewedChange(
        transaction,
        {
          decision,
          oldText: detail.oldText,
          newText: detail.newText,
          keptId: "s1",
        },
        detail,
      ),
    );
    const source = editorStateToCriticMarkdown(
      decided.doc.toJSON(),
      parsed.comments,
      { frontmatter: parsed.frontmatter, endmatter: parsed.endmatter },
    );
    const review: RevisionDraft = {
      markdown: source,
      cleanMarkdown: cleanRevisionSourceMarkdown(source),
      decisions: decision === "accept" ? { s1: "kept" } : {},
      reviewComments: [],
      reviewed: reviewedChanges(decided.doc),
    };
    expect(review.reviewed).toHaveLength(1);
    const draft = rawReload(
      review,
      original.replace("Beta paragraph.", "Beta paragraph, edited."),
    );
    const proposalIds = extractRoughdraftReviewIndex(draft.markdown)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => item.id);
    expect(proposalIds).toHaveLength(1);
    expect(proposalIds).not.toContain("s1");
    expect(draft.diskOrigin?.ids.s1).toBe(proposalIds[0]);
    expect(draft.reviewed).toEqual([
      expect.objectContaining({
        ...review.reviewed?.[0],
        stale: true,
        staleReason: expect.any(String),
      }),
    ]);
    expect(draft.decisions).toEqual(review.decisions);
  });
}
