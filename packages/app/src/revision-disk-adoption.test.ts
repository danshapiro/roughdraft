import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
} from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { adoptRevisionDisk } from "./revision-disk-adoption";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import { suggestionPositions } from "./revision-projection";
import { RevisionSource } from "./revision-source";

const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
function draft(markdown: string) {
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

test("an agent's new nearby proposal does not make unchanged saved feedback into new ID collisions", () => {
  const source = `---
title: Review the release plan together
---

# Release plan

Alpha owner: ready.

Beta owner: ready.

An existing proposal {++must survive++}{#s1} without being accepted.

Keep the {==existing context==}{>>This original comment must remain attached.<<}{#c1}.

## Validation

1. Review both independent proposals.
2. Keep the discussion attached to its original proposal.

---
comments:
  c1:
    by: AI
    at: "2026-11-22T12:00:00.000Z"
suggestions:
  s1:
    by: AI
    at: "2026-11-22T12:00:00.000Z"
`;
  const base = draft(source);
  const incoming = source
    .replace("Beta owner: ready.", "Beta owner: ready. {++Agent-b++}{#s2}")
    .replace(
      "suggestions:\n",
      'suggestions:\n  s2:\n    by: AI\n    at: "2026-11-22T12:05:00.000Z"\n',
    );
  const adopted = adoptRevisionDisk(base, incoming, schema);
  expect(adopted).not.toBeNull();
  if (!adopted) throw new Error("Independent disk feedback must be adoptable");
  const items = extractRoughdraftReviewIndex(adopted.markdown).items;
  expect(
    items
      .filter((item) => item.kind === "suggestion")
      .map((item) => ({
        id: item.id,
        text: item.replacementText ?? item.text,
      })),
  ).toEqual([
    { id: "s2", text: "Agent-b" },
    { id: "s1", text: "must survive" },
  ]);
  expect(adopted.reviewComments).toEqual(base.reviewComments);
  expect(adopted.markdown).toContain("{#c1}");
  expect(adopted.outdatedSuggestions ?? []).toEqual([]);

  const local = draft(
    source
      .replace(
        "Alpha owner: ready.",
        "Alpha owner: ready. {++Alpha-a-continued++}{#s2}",
      )
      .replace(
        "suggestions:\n",
        'suggestions:\n  s2:\n    by: user\n    at: "2026-11-26T20:34:49.865Z"\n',
      ),
  );
  const merged = mergeReviewDrafts(base, local, adopted, {
    server: false,
    budgetMs: 100,
  });
  expect(merged.status).toBe("merged");
  expect(merged.idRemap).toEqual({ s2: "s3" });
  if (merged.status !== "merged")
    throw new Error("Distinct new proposals must merge independently");
  expect(
    extractRoughdraftReviewIndex(merged.draft.markdown)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => ({
        id: item.id,
        text: item.replacementText ?? item.text,
      })),
  ).toEqual([
    { id: "s3", text: "Alpha-a-continued" },
    { id: "s2", text: "Agent-b" },
    { id: "s1", text: "must survive" },
  ]);
  expect(merged.draft.reviewComments).toEqual(base.reviewComments);
});

test("idle disk edits detach displaced saved comments but retain unrelated proposals", () => {
  const base = draft(
    "Alpha {==target==}{>>Feedback.<<}{#c1} Omega.\n\nSaved {++proposal++}{#s1}.\n",
  );
  const incoming = "Alpha rewritten Omega.\n\nSaved .\n";
  const result = adoptRevisionDisk(base, incoming, schema);
  expect(result).not.toBeNull();
  expect(result?.markdown).toContain("rewritten");
  expect(result?.markdown).toContain("proposal");
  expect(result?.outdatedSuggestions ?? []).toHaveLength(0);

  expect(
    result?.reviewComments.find((comment) => comment.id === "c1"),
  ).toMatchObject({
    scope: "document",
    originalQuote: "target",
    content: "Feedback.",
  });
  expect(result?.cleanMarkdown).toBe(incoming);
});

test("a disk rewrite through a saved proposal retains it as outdated feedback", () => {
  const base = draft(
    'A {~~old~>new~~}{id="s1" by="AI" at="2026-01-01T12:00:00.000Z"} ending.\n',
  );
  const result = adoptRevisionDisk(base, "A agent wording ending.\n", schema);
  expect(result?.outdatedSuggestions).toEqual([
    {
      id: "s1",
      originalText: "old",
      proposedText: "new",
      reason: expect.any(String),
      authorType: "ai",
      authorId: null,
      createdAt: "2026-01-01T12:00:00.000Z",
    },
  ]);
  expect(result?.markdown).not.toContain("{#s1}");
  expect(result?.cleanMarkdown).toBe("A agent wording ending.\n");
});

test("file insertion exactly at an ambiguous pending insertion edge waits instead of guessing", () => {
  const base = draft("A {++proposal++}{#s1}B.\n");
  expect(adoptRevisionDisk(base, "A extraB.\n", schema)).toBeNull();
  const forced = adoptRevisionDisk(base, "A extraB.\n", schema, true);
  expect(forced?.cleanMarkdown).toBe("A extraB.\n");
  expect(forced?.outdatedSuggestions).toHaveLength(1);
});

test("disk-authored feedback with colliding IDs retains committed feedback and unrelated proposals", () => {
  const base = draft(
    "First {==saved==}{>>Browser feedback.<<}{#c1}.\n\nMiddle.\n\nLast {++saved proposal++}{#s1}.\n",
  );
  const incoming =
    "First saved.\n\nMiddle {==agent==}{>>Agent feedback.<<}{#c1} {++agent proposal++}{#s1}.\n\nLast .\n";
  const result = adoptRevisionDisk(base, incoming, schema);
  expect(result).not.toBeNull();
  expect(result?.reviewComments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "c1", content: "Browser feedback." }),
      expect.objectContaining({ id: "c2", content: "Agent feedback." }),
    ]),
  );
  expect(result?.markdown).toContain("saved proposal");
  expect(result?.markdown).toContain("agent proposal");
  if (!result) throw new Error("Expected disk feedback to be adopted");
  const parsed = criticMarkdownToEditorState(result.markdown);
  expect(
    [...suggestionPositions(schema.nodeFromJSON(parsed.doc)).keys()].sort(),
  ).toEqual(["s1", "s2"]);
});

test("a disk update preserves inline feedback before its sidecar has first materialized", () => {
  const base = {
    ...draft("An {==original quote==}{>>Imported note.<<}{#c1}.\n"),
    reviewComments: [],
  };
  const result = adoptRevisionDisk(base, "An agent rewrite.\n", schema);
  expect(result?.reviewComments).toEqual([
    expect.objectContaining({
      id: "c1",
      content: "Imported note.",
      scope: "document",
      originalQuote: "original quote",
      detachedReason: expect.any(String),
    }),
  ]);
});

test("an annotated maintained file accepts independent disk prose edits while retaining all feedback", () => {
  const markdown = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const base = draft(markdown);
  const disk = markdown
    .replace("planting schedule", "garden schedule")
    .replace("lighting schedule", "lantern schedule");
  const result = adoptRevisionDisk(base, disk, schema);
  expect(result).not.toBeNull();
  expect(result?.markdown).toContain("garden schedule");
  expect(result?.markdown).toContain("lantern schedule");
  expect(result?.reviewComments).toHaveLength(base.reviewComments.length);
  expect(result?.outdatedSuggestions ?? []).toHaveLength(0);
  if (!result) throw new Error("Expected the disk update to map");
  const local = draft(
    markdown.replace("planting schedule", "orchard schedule"),
  );
  const merged = mergeReviewDrafts(base, local, result, {
    server: false,
    budgetMs: 250,
  });
  expect(merged.status).toBe("conflict");
  expect(merged.conflicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "text",
        local: expect.stringContaining("orchard"),
        incoming: expect.stringContaining("garden"),
      }),
    ]),
  );
});
