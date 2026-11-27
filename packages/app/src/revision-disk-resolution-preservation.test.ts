import fs from "node:fs";
import path from "node:path";
import type { SyncDraft } from "@roughdraft/rfm";
import * as rfm from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonStore } from "../../server/src/comparisons";
import type { ComparisonReviewData } from "./comparison-types";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
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
const source = fs.readFileSync(
  path.resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
  "utf8",
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
function draft(markdown: string): SyncDraft {
  const parsed = criticMarkdownToEditorState(markdown);
  return {
    markdown,
    cleanMarkdown: cleanRevisionSourceMarkdown(markdown),
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: comment.parentCommentId ?? "document",
    })),
  };
}

test("annotated disk ancestry keeps a remote pending addition while resolving unrelated prose", () => {
  const baseline = draft(source);
  const disk = source
    .replace("planting schedule", "garden schedule")
    .replace("lighting schedule", "lantern schedule");
  const result = adoptRevisionDisk(baseline, disk, schema, false, {
    path: "/practice.md",
    markdown: source,
  });
  expect(result && "status" in result ? result.status : result).toBe("merged");
  if (!result || !("status" in result) || result.status !== "merged")
    throw new Error("Expected independent adoption");
  expect(result.draft.markdown).toContain("{++offline review++}{#s1}");
  expect(
    rfm
      .extractRoughdraftReviewIndex(result.draft.markdown)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => item.id)
      .sort(),
  ).toEqual(
    rfm
      .extractRoughdraftReviewIndex(source)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => item.id)
      .sort(),
  );
  expect(
    result.draft.reviewComments
      .map((comment) => ({
        id: comment.id,
        content: comment.content,
        parent: comment.parentCommentId ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  ).toEqual(
    baseline.reviewComments
      .map((comment) => ({
        id: comment.id,
        content: comment.content,
        parent: comment.parentCommentId ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  expect(result.draft.outdatedSuggestions ?? []).toEqual([]);
});

const compact = `# Plan

The release supports {++offline review++}{#s1} for longer documents.

Saved {~~old~>new~~}{#s2} ending.

{~~
The team reviews the draft. The team publishes after approval.
~>
The team reviews the draft.

The team publishes after approval.
~~}{#s3}

Alpha owner: ready.

Beta owner: ready.

* Preserve this list spelling.
`;

for (const savedText of ["annotated", "clean"] as const) {
  for (const reviewText of ["source", "canonical"] as const) {
    test(`${savedText} disk ancestry preserves pending feedback with a ${reviewText} review`, () => {
      const parsed = criticMarkdownToEditorState(compact);
      const review = draft(
        reviewText === "source"
          ? compact
          : editorStateToCriticMarkdown(parsed.doc, parsed.comments),
      );
      const acknowledged =
        savedText === "annotated"
          ? compact
          : cleanRevisionSourceMarkdown(compact);
      const incoming = acknowledged.replace(
        "Beta owner: ready.",
        "Beta owner: edited on disk.",
      );
      const result = adoptRevisionDisk(review, incoming, schema, false, {
        path: "/practice.md",
        markdown: acknowledged,
      });
      expect(result && "status" in result ? result.status : result).toBe(
        "merged",
      );
      if (!result || !("status" in result) || result.status !== "merged")
        throw new Error("Expected independent adoption");
      const suggestions = rfm
        .extractRoughdraftReviewIndex(result.draft.markdown)
        .items.filter((item) => item.kind === "suggestion");
      expect(suggestions.map((item) => item.id).sort()).toEqual([
        "s1",
        "s2",
        "s3",
      ]);
      expect(result.draft.markdown).toContain("Beta owner: edited on disk.");
      expect(result.draft.outdatedSuggestions ?? []).toEqual([]);
    });
  }
}

test("a genuine rewrite across a proposal stays outdated while the unrelated insertion stays pending", () => {
  const incoming = compact.replace(
    "Saved {~~old~>new~~}{#s2} ending.",
    "Saved agent wording ending.",
  );
  const result = adoptRevisionDisk(draft(compact), incoming, schema, false, {
    path: "/practice.md",
    markdown: compact,
  });
  expect(result && "status" in result ? result.status : result).toBe("merged");
  if (!result || !("status" in result) || result.status !== "merged")
    throw new Error("Expected safe displacement");
  expect(result.draft.markdown).toContain("{++offline review++}{#s1}");
  expect(result.draft.markdown).toContain("Saved agent wording ending.");
  expect(result.draft.outdatedSuggestions).toEqual([
    expect.objectContaining({
      id: "s2",
      originalText: "old",
      proposedText: "new",
    }),
  ]);
});

test("a real whitespace insertion at a pending proposal edge applies exactly or waits without committing it away", () => {
  const source =
    "# Review\n\nThe release supports {++offline review++}{#s1} for longer documents.\n";
  const incoming = source.replace("supports ", "supports   ");
  const result = adoptRevisionDisk(draft(source), incoming, schema, false, {
    path: "/practice.md",
    markdown: source,
  });
  expect(result).not.toBeNull();
  if (!result || !("status" in result))
    throw new Error("Expected a guarded disk merge result");
  if (result.status === "merged") {
    expect(result.draft.markdown).toContain(
      "supports   {++offline review++}{#s1} for",
    );
    expect(result.draft.cleanMarkdown).toContain("supports    for");
  } else {
    expect(result.status).toBe("client-merge-required");
    expect(result.draft.markdown).toBe(source);
  }
});

test("unrelated disk edits preserve raw CRLF and list markers around pending feedback", () => {
  const source =
    "# Review\r\n\r\n* Preserve this list marker.\r\n\r\nThe release supports {++offline review++}{#s1} for longer documents.\r\n\r\nBeta owner: ready.\r\n";
  const incoming = source.replace(
    "Beta owner: ready.",
    "Beta owner: changed on disk.",
  );
  const result = adoptRevisionDisk(draft(source), incoming, schema, false, {
    path: "/practice.md",
    markdown: source,
  });
  expect(result && "status" in result ? result.status : result).toBe("merged");
  if (!result || !("status" in result) || result.status !== "merged")
    throw new Error("Expected independent adoption");
  expect(result.draft.markdown).toBe(incoming);
  expect(result.draft.cleanMarkdown).toBe(
    cleanRevisionSourceMarkdown(incoming),
  );
});

for (const bound of [false, true]) {
  for (const choice of ["local", "incoming"] as const) {
    test(`${bound ? "bound-file" : "autosave-none"} ${choice === "local" ? "Overwrite" : "Discard"} preserves proposals through the real controller and store`, async () => {
      const parent = path.resolve(
        process.cwd(),
        "../../.test-tmp/disk-proposal-resolution",
      );
      fs.mkdirSync(parent, { recursive: true });
      const directory = fs.mkdtempSync(path.join(parent, "run-"));
      const target = path.join(directory, "practice.md");
      fs.writeFileSync(target, compact);
      const store = new ComparisonStore(path.join(directory, "reviews"), {
        homeDir: directory,
      });
      const id = store.openDocument({
        targetPath: target,
        autosave: bound ? target : "none",
      }).id;
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
              const result = store.reconcile(
                id,
                body as Record<string, unknown>,
              );
              return result as T;
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
          cleanMarkdown: cleanRevisionSourceMarkdown(value.markdown),
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
          ...draft(
            compact.replace(
              "Alpha owner: ready.",
              "Alpha owner: browser wording.",
            ),
          ),
        }));
        const disk = compact
          .replace("Alpha owner: ready.", "Alpha owner: disk wording.")
          .replace(
            "Beta owner: ready.",
            "Beta owner: independent disk update.",
          );
        fs.writeFileSync(target, disk);
        store.watchers.invalidate(target);
        await vi.waitFor(() => expect(store.state(id).disk?.text).toBe(disk));
        await controller.refresh(true);
        const conflict = controller.getSnapshot().conflict;
        expect(conflict?.kind).toBe("conflict");
        if (!conflict) throw new Error("Expected an actual text overlap");
        expect(
          await controller.resolveConflict(choice, conflict.signature),
        ).toBe(true);
        await controller.flush(false);
        expect(controller.getSnapshot().conflict).toBeNull();
        const saved = store.state(id).draft;
        expect(saved.markdown).toContain(
          choice === "local"
            ? "Alpha owner: browser wording."
            : "Alpha owner: disk wording.",
        );
        expect(saved.markdown).toContain(
          "Beta owner: independent disk update.",
        );
        expect(
          rfm
            .extractRoughdraftReviewIndex(saved.markdown)
            .items.filter((item) => item.kind === "suggestion")
            .map((item) => item.id)
            .sort(),
        ).toEqual(["s1", "s2", "s3"]);
        expect(saved.outdatedSuggestions ?? []).toEqual([]);
        if (bound && choice === "local")
          expect(fs.readFileSync(target, "utf8")).toBe(saved.cleanMarkdown);
        else expect(fs.readFileSync(target, "utf8")).toBe(disk);
      } finally {
        controller.stop();
        store.watchers.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
