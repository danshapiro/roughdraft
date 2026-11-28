// Round-5 review: a browser-saved comment (review only) on a clean bound file.
// The agent rewrites the commented word. Plan §4: adopt without conflict and
// detach the comment; ADR 0003 / plan §4: preserve unchanged source spelling;
// unchanged source must not authorize a file write.
import fs from "node:fs";
import path from "node:path";
import * as rfm from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonStore } from "../../server/src/comparisons";
import type { ComparisonReviewData } from "./comparison-types";
import { createEditorExtensions } from "./editor-extensions";
import { EditorState } from "@tiptap/pm/state";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  createCriticChange,
  createCriticComment,
} from "./critic-markup";
import { adoptRevisionDisk } from "./revision-disk-adoption";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";
import { RevisionSource } from "./revision-source";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));
const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
const parent = path.resolve(
  process.cwd(),
  "../../.test-tmp/disk-source-spelling",
);

beforeEach(() => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const merge = rfm.mergeReviewDrafts;
  vi.spyOn(rfm, "mergeReviewDrafts").mockImplementation((...args) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      return merge(...args);
    } finally {
      clock.mockRestore();
    }
  });
});
afterEach(() => vi.restoreAllMocks());

const file =
  "# Plan\n\nThe release supports for longer documents.\n\nBeta paragraph.\n";
const commented =
  "# Plan\n\nThe release {==supports==}{>>Why this verb?<<}{#c1} for longer documents.\n\nBeta paragraph.\n";

for (const bound of [true, false]) {
  test(`${bound ? "bound" : "autosave none"}: agent rewrites a word with a saved review-only comment`, async () => {
    const agent = file.replace("supports", "enables");
    const result = await followOutsideEdit(
      file,
      commented,
      [
        {
          id: "c1",
          content: "Why this verb?",
          createdAt: "2026-11-22T12:00:00.000Z",
          changeId: "document",
        },
      ],
      agent,
      bound,
    );
    expect(result.conflict).toBeNull();
    expect(result.file).toBe(agent);
    expect(result.draft.markdown).toContain("# Plan\n\nThe release enables");
    expect(
      result.draft.reviewComments.find((comment) => comment.id === "c1"),
    ).toMatchObject({
      content: "Why this verb?",
      originalQuote: "supports",
      detachedReason: expect.any(String),
    });
    expect(result.requests).not.toContain("sync:true");
    expect(result.draft.cleanMarkdown).toBe(agent);
  });
}

for (const proposal of [
  "{++offline review++}{#s1} ",
  "{++offline review ++}{#s1}",
]) {
  for (const [from, to] of [
    ["supports", "enables"],
    ["for longer", "for all"],
    ["documents.", "documents today."],
    ["Beta paragraph.", "Beta paragraph, edited."],
  ]) {
    test(`an outside ${from} edit preserves exact accepted spacing for ${proposal}`, () => {
      const reviewText = file.replace("supports ", `supports ${proposal}`);
      const disk = file.replace(from, to);
      const review: rfm.SyncDraft = {
        markdown: reviewText,
        cleanMarkdown: file,
        decisions: {},
        reviewComments: [],
      };
      const result = adoptRevisionDisk(review, disk, schema, false, {
        path: "/practice.md",
        markdown: file,
      });
      expect(
        result && "status" in result ? result.status : result,
        result && "reason" in result ? result.reason : undefined,
      ).toBe("merged");
      if (!result || !("status" in result) || result.status !== "merged")
        throw new Error("Expected independent disk text");
      expect(result.draft.cleanMarkdown).toBe(disk);
      expect(result.diskCleanMarkdown).toBe(disk);
      expect(result.draft.markdown).toBe(reviewText.replace(from, to));
      expect(result.draft.outdatedSuggestions ?? []).toEqual([]);
    });
  }
}

for (const metadataChange of ["unchanged", "edit", "delete"] as const) {
  test(`ambiguous mixed endmatter waits safely during an intentional metadata ${metadataChange}`, () => {
    const source =
      '# Plan\r\n\r\n* Preserve this list marker.\r\n\r\nThe release supports {++offline review++}{#s1} for longer documents.\r\n\r\nBeta paragraph.\r\n\r\n---\r\n# Keep the metadata comment.\r\nstatus: "in progress" # Keep the scalar comment.\r\nowner: \'Dan\'\r\nsuggestions:\r\n  s1:\r\n    by: AI\r\n    at: "2026-11-22T12:00:00.000Z"\r\n';
    let disk = source.replace("Beta paragraph.", "Beta paragraph, edited.");
    if (metadataChange === "edit")
      disk = disk.replace("owner: 'Dan'", "owner: 'Product team'");
    if (metadataChange === "delete")
      disk = disk.replace("owner: 'Dan'\r\n", "");
    const result = adoptRevisionDisk(
      {
        markdown: source,
        cleanMarkdown: cleanRevisionSourceMarkdown(source),
        decisions: {},
        reviewComments: [],
      },
      disk,
      schema,
      false,
      { path: "/practice.md", markdown: source },
    );
    // Clean source without review keys is currently parsed as body text while
    // the annotated source recognizes the same tail as metadata. Until that
    // existing parser ambiguity is resolved, adoption must preserve the original
    // review and wait instead of inventing a second tail or normalizing YAML.
    expect(result && "status" in result ? result.status : result).toBe(
      "client-merge-required",
    );
    if (!result || !("status" in result))
      throw new Error("Expected safe waiting");
    expect(result.draft.markdown).toBe(source);
    expect(result.draft.cleanMarkdown).toBe(
      cleanRevisionSourceMarkdown(source),
    );
  });
}

test("unverified clean text cannot become a new browser prose edit during disk adoption", () => {
  const review: rfm.SyncDraft = {
    markdown: commented,
    cleanMarkdown: file.replace("supports", "silently replaces"),
    decisions: {},
    reviewComments: [],
  };
  const result = adoptRevisionDisk(
    review,
    file.replace("Beta paragraph.", "Agent's independent update."),
    schema,
    false,
    { path: "/practice.md", markdown: file },
  );
  expect(
    result && "status" in result ? result.status : result,
    result && "reason" in result ? result.reason : undefined,
  ).toBe("client-merge-required");
  if (!result || !("status" in result))
    throw new Error("Expected a guarded merge");
  expect(result.draft).toEqual(review);
});

async function followOutsideEdit(
  file: string,
  annotated: string,
  reviewComments: RevisionDraft["reviewComments"],
  agent: string,
  bound: boolean,
  clean = file,
) {
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "native-"));
  const target = path.join(directory, "practice.md");
  fs.writeFileSync(target, file);
  const store = new ComparisonStore(path.join(directory, "reviews"), {
    homeDir: directory,
  });
  const id = store.openDocument({
    targetPath: target,
    autosave: bound ? target : "none",
  }).id;
  const initial = store.state(id);
  const requests: string[] = [];
  const controller = new RevisionSessionController(
    initial.review as unknown as ComparisonReviewData,
    initial.draft as RevisionDraft,
    {
      request: async <T>(route: string, body?: object) => {
        if (!body) return structuredClone(store.state(id)) as T;
        if (route.endsWith("/checkpoint"))
          return store.checkpoint(id, body as Record<string, unknown>) as T;
        if (route.endsWith("/reconcile")) {
          const request = body as Record<string, unknown>;
          requests.push(`${request.reason}:${request.writeFile}`);
          return store.reconcile(id, request) as T;
        }
        if (route.endsWith("/checkpoint/resolve")) return {} as T;
        throw new Error(`Unexpected request ${route}`);
      },
      merge: async (base, local, incoming, options) =>
        rfm.mergeReviewDrafts(base, local, incoming, {
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
  controller.setAdapter({
    apply: (value) => ({
      ...value,
      cleanMarkdown:
        value.cleanMarkdown ?? cleanRevisionSourceMarkdown(value.markdown),
    }),
    adopt: (base, markdown, force, diskBase) =>
      adoptRevisionDisk(base, markdown, schema, force, diskBase),
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  try {
    controller.start();
    await controller.refresh(true);
    controller.updateDraft((value) => ({
      ...value,
      markdown: annotated,
      cleanMarkdown: clean,
      reviewComments,
    }));
    await controller.flush(false);
    expect(fs.readFileSync(target, "utf8")).toBe(file);
    fs.writeFileSync(target, agent);
    store.watchers.invalidate(target);
    await vi.waitFor(() => expect(store.state(id).disk?.text).toBe(agent));
    await controller.refresh(true);
    await controller.flush(false);
    await controller.flush(false);
    return {
      savedText: store.state(id).review.savedText,
      draft: structuredClone(store.state(id).draft),
      conflict: controller.getSnapshot().conflict,
      file: fs.readFileSync(target, "utf8"),
      requests,
    };
  } finally {
    controller.stop();
    store.watchers.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const bound of [false, true]) {
  for (const [from, to] of [
    ["supports", "enables"],
    ["Beta paragraph.", "Beta paragraph, edited."],
  ]) {
    test(`${bound ? "bound" : "autosave-none"} browser-native Suggest serialization cannot change accepted spacing after an outside ${from} edit`, async () => {
      const annotation = file.replace(
        "supports ",
        'supports {++offline review++}{id="s1" by="user" at="2026-11-22T12:00:00.000Z"} ',
      );
      const agent = file.replace(from, to);
      const result = await followOutsideEdit(
        file,
        annotation,
        [],
        agent,
        bound,
      );
      expect(result.conflict).toBeNull();
      expect(result.file).toBe(agent);
      expect(result.draft.cleanMarkdown).toBe(agent);
      expect(result.requests).not.toContain("sync:true");
      expect(
        rfm
          .extractRoughdraftReviewIndex(result.draft.markdown)
          .items.filter((item) => item.kind === "suggestion")
          .map((item) => item.id),
      ).toEqual(["s1"]);
      expect(result.draft.outdatedSuggestions ?? []).toEqual([]);
    });
  }
}

const rich = [
  "---",
  "title: Plan",
  "---",
  "",
  "# Plan",
  "",
  "Intro paragraph with __bold__ and _em_ text.",
  "",
  "* First item",
  "* Second item",
  "",
  "1) One",
  "2) Two",
  "",
  "| A | B |",
  "|:--|--:|",
  "| x | y |",
  "",
  "Setext heading",
  "==============",
  "",
  "The release supports for longer documents.\\",
  "Hard break line.",
  "",
  "~~~text",
  "code",
  "~~~",
  "",
  "See the [ref link][r].",
  "",
  '[r]: https://example.com "Title"',
  "",
].join("\n");
for (const crlf of [false, true]) {
  for (const kind of ["comment", "substitution"] as const) {
    test(`${crlf ? "CRLF" : "LF"} rich source spelling survives displacement of a registry-less ${kind}`, async () => {
      const file = crlf ? rich.replaceAll("\n", "\r\n") : rich;
      const annotation = file.replace(
        "supports",
        kind === "comment"
          ? "{==supports==}{>>Why this verb?<<}{#c1}"
          : "{~~supports~>enables~~}{#s1}",
      );
      const comments =
        kind === "comment"
          ? [
              {
                id: "c1",
                content: "Why this verb?",
                createdAt: "2026-11-22T12:00:00.000Z",
                changeId: "document",
              },
            ]
          : [];
      const agent = file.replace("supports", "provides");
      const result = await followOutsideEdit(
        file,
        annotation,
        comments,
        agent,
        true,
      );
      expect(result.conflict).toBeNull();
      expect(result.file).toBe(agent);
      expect(result.draft.cleanMarkdown).toBe(agent);
      expect(result.requests).not.toContain("sync:true");
      for (const preserved of [
        "__bold__",
        "_em_",
        "* First item",
        "1) One",
        "|:--|--:|",
        "Setext heading",
        "==============",
        "~~~text",
        '[r]: https://example.com "Title"',
      ])
        expect(result.draft.markdown).toContain(preserved);
      if (kind === "comment")
        expect(result.draft.reviewComments).toEqual([
          expect.objectContaining({
            id: "c1",
            content: "Why this verb?",
            originalQuote: "supports",
            detachedReason: expect.any(String),
          }),
        ]);
      else
        expect(result.draft.outdatedSuggestions).toEqual([
          expect.objectContaining({
            id: "s1",
            originalText: "supports",
            proposedText: "enables",
          }),
        ]);
    });
  }
}

test("a truncated clean projection cannot remove a document body with frontmatter and definitions", () => {
  const source =
    '---\ntitle: [Malformed frontmatter\n---\n\n# Review\n\nThe {==release==}{>>Discuss this.<<}{#c1} is ready.[^n]\n\nSee [setup][r].\n\n[r]: https://example.com "Title"\n\n[^n]: Preserve this note.\n';
  const review: rfm.SyncDraft = {
    markdown: source,
    cleanMarkdown: "---\ntitle: [Malformed frontmatter\n---\n\n",
    decisions: {},
    reviewComments: [],
  };
  const result = adoptRevisionDisk(
    review,
    source.replace("is ready", "is approved"),
    schema,
    false,
    { path: "/practice.md", markdown: source },
  );
  expect(result && "status" in result ? result.status : result).toBe(
    "client-merge-required",
  );
  if (!result || !("status" in result))
    throw new Error("Expected a guarded projection");
  expect(result.draft.markdown).toBe(source);
});

test("quoted CRLF frontmatter comments remain exact through an outside text and metadata update", () => {
  const file =
    "---\r\n# Keep the metadata comment.\r\ntitle: \"in progress\" # Keep the scalar comment.\r\nowner: 'Dan'\r\n---\r\n\r\n# Plan\r\n\r\n* Preserve this list marker.\r\n\r\nThe release supports for longer documents.\r\n\r\nBeta paragraph.\r\n";
  const reviewText = file.replace(
    "supports ",
    "supports {++offline review++}{#s1} ",
  );
  const disk = file
    .replace("Beta paragraph.", "Beta paragraph, edited.")
    .replace("owner: 'Dan'", "owner: 'Product team'");
  const result = adoptRevisionDisk(
    {
      markdown: reviewText,
      cleanMarkdown: file,
      decisions: {},
      reviewComments: [],
    },
    disk,
    schema,
    false,
    { path: "/practice.md", markdown: file },
  );
  expect(
    result && "status" in result ? result.status : result,
    result && "reason" in result ? result.reason : undefined,
  ).toBe("merged");
  if (!result || !("status" in result) || result.status !== "merged")
    throw new Error("Expected recognized frontmatter to adopt");
  expect(result.draft.markdown).toBe(
    reviewText
      .replace("Beta paragraph.", "Beta paragraph, edited.")
      .replace("owner: 'Dan'", "owner: 'Product team'"),
  );
  expect(result.draft.cleanMarkdown).toBe(disk);
});

test("ambiguous mixed endmatter waits without acknowledging or writing outside work, and keeps explicit recovery available", async () => {
  const file =
    '# Plan\r\n\r\nThe release supports {++offline review++}{#s1} for longer documents.\r\n\r\nBeta paragraph.\r\n\r\n---\r\n# Keep this metadata comment.\r\nstatus: "in progress" # Keep this scalar comment.\r\nsuggestions:\r\n  s1:\r\n    by: AI\r\n    at: "2026-11-22T12:00:00.000Z"\r\n';
  const agent = file.replace("Beta paragraph.", "Beta paragraph, edited.");
  const result = await followOutsideEdit(
    file,
    file,
    [],
    agent,
    true,
    cleanRevisionSourceMarkdown(file),
  );
  expect(result.conflict?.kind).toBe("waiting");
  expect(result.conflict?.reloadAvailable).toBe(true);
  expect(result.savedText).toBe(file);
  expect(result.file).toBe(agent);
  expect(result.requests).not.toContain("sync:true");
});

for (const bound of [false, true]) {
  for (const kind of ["comment", "suggestion"] as const) {
    test(`${bound ? "bound" : "autosave none"}: an outside YAML field rewrite retains displaced ${kind} feedback without a write`, async () => {
      const source =
        "---\ntitle: Plan\nowner: Product team\n---\n\n# Plan\n\nKeep __this body__ unchanged.\n";
      const parsed = criticMarkdownToEditorState(source);
      const state = EditorState.create({
        doc: schema.nodeFromJSON(parsed.doc),
      });
      const at = state.doc.firstChild?.textContent.indexOf("Plan") ?? -1;
      const from = at + 1;
      const tr = state.tr;
      const comments = new Map(parsed.comments);
      if (kind === "comment") {
        const comment = createCriticComment({
          id: "c1",
          content: "Discuss this title.",
          createdAt: "2026-11-28T01:00:00.000Z",
        });
        comments.set(comment.id, comment);
        tr.addMark(
          from,
          from + 4,
          schema.marks.commentRef.create({ commentIds: [comment.id] }),
        );
      } else {
        const change = createCriticChange("substitution-old", {
          changeId: "s1",
          createdAt: "2026-11-28T01:00:00.000Z",
        });
        tr.addMark(from, from + 4, schema.marks.criticChange.create(change));
        tr.insertText("Browser plan", from + 4);
        tr.addMark(
          from + 4,
          from + 16,
          schema.marks.criticChange.create({
            ...change,
            kind: "substitution-new",
          }),
        );
      }
      const annotated = editorStateToCriticMarkdown(tr.doc.toJSON(), comments);
      const agent = source.replace("title: Plan", "title: Agent plan");
      const result = await followOutsideEdit(
        source,
        annotated,
        [...comments.values()].map((comment) => ({
          ...comment,
          changeId: "document",
        })),
        agent,
        bound,
      );
      expect(result.conflict).toBeNull();
      expect(result.file).toBe(agent);
      expect(result.draft.cleanMarkdown).toBe(agent);
      expect(result.requests).not.toContain("sync:true");
      if (kind === "comment")
        expect(
          result.draft.reviewComments.find((comment) => comment.id === "c1"),
        ).toMatchObject({
          content: "Discuss this title.",
          originalQuote: "Plan",
          scope: "document",
          detachedReason: expect.any(String),
        });
      else
        expect(
          result.draft.outdatedSuggestions?.find(
            (proposal) => proposal.id === "s1",
          ),
        ).toMatchObject({ originalText: "Plan", proposedText: "Browser plan" });
    });
  }
}
