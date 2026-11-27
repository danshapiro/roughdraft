import fs from "node:fs";
import path from "node:path";
import * as rfm from "@roughdraft/rfm";
import { extractRoughdraftReviewIndex, type SyncDraft } from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { cleanRevisionNode } from "./revision-clean-cache";
import { adoptRevisionDisk } from "./revision-disk-adoption";
import { cleanRevisionMarkdown } from "./revision-markdown";
import { serializeRevisionNode } from "./revision-review-cache";
import { RevisionSource } from "./revision-source";

vi.mock("./critic-markup", { spy: true });
// These cases protect output and serialization work, not elapsed time. Keep a
// real merge's own clock fixed while it runs, so a descheduled worker cannot
// spend its 100 ms allowance. Parsing and source-spelling fallbacks retain real
// clocks. Separate 99/100/101 ms cases and browser runs protect timing behavior.
beforeEach(() => {
  const merge = rfm.mergeReviewDrafts;
  vi.spyOn(rfm, "mergeReviewDrafts").mockImplementation((...args) => {
    const now = performance.now();
    const date = Date.now();
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(now);
    const wall = vi.spyOn(Date, "now").mockReturnValue(date);
    try {
      return merge(...args);
    } finally {
      wall.mockRestore();
      monotonic.mockRestore();
    }
  });
});
afterEach(() => vi.restoreAllMocks());

function largeReview() {
  const fixture = fs.readFileSync(
    path.resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const endmatter = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 750 },
    (_, index) =>
      `Unchanged section ${index + 1}. This paragraph provides real reading distance while the two pages keep their independent edits and feedback.`,
  ).join("\n\n");
  return `${fixture.slice(0, endmatter)}\n\n${padding}\n\nLive owner A: unchanged.\n\nLive owner B: unchanged.\n${fixture.slice(endmatter)}`;
}

test("an independent outside edit on the maintained 100 KiB review adopts without repeatedly serializing the unchanged document", () => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const original = largeReview();
  const markdown = original.replace(
    "Live owner A: unchanged.",
    "Live owner A: unchanged. Warmup.",
  );
  const parsed = criticMarkdownToEditorState(markdown);
  const review: SyncDraft = {
    markdown,
    // This is the settled browser serializer's actual accepted baseline from
    // the diagnosed flow; source-backed disk projection can retain separators.
    cleanMarkdown: cleanRevisionMarkdown(markdown),
    decisions: {},
    reviewed: [],
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: comment.parentCommentId ?? "document",
    })),
  };
  const incoming = original.replace(
    "Live owner B: unchanged.",
    "Live owner B: updated by the agent.",
  );
  const serialized = vi.mocked(editorStateToCriticMarkdown);
  serialized.mockClear();
  const result = adoptRevisionDisk(review, incoming, schema, false, {
    path: "/practice.md",
    markdown: original,
  });
  const paddingCount = (node: { text?: string; content?: unknown[] }): number =>
    Number(Boolean(node.text?.startsWith("Unchanged section "))) +
    (node.content ?? []).reduce<number>(
      (total, child) => total + paddingCount(child as typeof node),
      0,
    );
  const largestSerializedPadding = Math.max(
    0,
    ...serialized.mock.calls.map(([doc]) => paddingCount(doc)),
  );
  expect(
    largestSerializedPadding,
    "unchanged paragraphs should use the existing immutable-block serializers",
  ).toBeLessThanOrEqual(1);
  expect(
    result && "status" in result ? result.status : result,
    result && "reason" in result ? result.reason : undefined,
  ).toBe("merged");
  if (!result || !("status" in result) || result.status !== "merged")
    throw new Error("Independent disk text must make progress");
  expect(result.draft.markdown).toContain("Live owner A: unchanged. Warmup.");
  expect(result.draft.markdown).toContain(
    "Live owner B: updated by the agent.",
  );
  const proposals = (value: string) =>
    extractRoughdraftReviewIndex(value)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => item.id)
      .sort();
  expect(proposals(result.draft.markdown)).toEqual(proposals(original));
  expect(result.draft.reviewComments).toHaveLength(14);
  expect(result.draft.outdatedSuggestions ?? []).toEqual([]);
}, 60000);

test("live paragraph reuse avoids reserializing warmed reading distance without importing buffered suggestions or private comments", () => {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const original = largeReview();
  const markdown = original.replace(
    "Live owner A: unchanged.",
    "Live owner A: unchanged. Warmup.",
  );
  const parsed = criticMarkdownToEditorState(markdown);
  const comments = [...parsed.comments.values()].map((comment) => ({
    ...comment,
    changeId: comment.parentCommentId ?? "document",
  }));
  const review: SyncDraft = {
    markdown,
    cleanMarkdown: cleanRevisionMarkdown(markdown),
    decisions: {},
    reviewed: [],
    reviewComments: comments,
  };
  const liveSource = markdown.replace(
    "Live owner A: unchanged. Warmup.",
    'Live owner A: unchanged. Warmup. Buffered text {++New local suggestion++}{id="s13" by="user" at="2026-11-27T10:00:00.000Z"}',
  );
  const liveParsed = criticMarkdownToEditorState(liveSource);
  let live = EditorState.create({
    schema,
    doc: schema.nodeFromJSON({
      ...liveParsed.doc,
      attrs: {
        sourceMetadata: {
          markdown: liveSource,
          frontmatter: liveParsed.frontmatter,
          endmatter: liveParsed.endmatter,
        },
      },
    }),
  });
  let privateAt = -1;
  live.doc.descendants((node, position) => {
    if (
      privateAt < 0 &&
      node.isText &&
      node.text?.startsWith("Unchanged section 1.")
    )
      privateAt = position;
  });
  expect(privateAt).toBeGreaterThan(0);
  live = live.apply(
    live.tr.addMark(
      privateAt,
      privateAt + 9,
      schema.marks.commentRef.create({ commentIds: ["private-new-comment"] }),
    ),
  );
  serializeRevisionNode(live.doc, liveParsed.comments, {
    frontmatter: liveParsed.frontmatter,
    endmatter: liveParsed.endmatter,
  });
  cleanRevisionNode(live.doc);
  const before = live.doc.toJSON();
  const incoming = original.replace(
    "Live owner B: unchanged.",
    'Live owner B: updated by the agent. {++Agent proposal++}{id="s13" by="AI" at="2026-11-22T12:05:00.000Z"}',
  );
  const serialize = vi.mocked(editorStateToCriticMarkdown);
  serialize.mockClear();
  const result = adoptRevisionDisk(
    review,
    incoming,
    schema,
    false,
    { path: "/practice.md", markdown: original },
    live.doc,
  );
  const paddingCount = (node: { text?: string; content?: unknown[] }): number =>
    Number(Boolean(node.text?.startsWith("Unchanged section "))) +
    (node.content ?? []).reduce<number>(
      (total, child) => total + paddingCount(child as typeof node),
      0,
    );
  const serializedParagraphs = serialize.mock.calls.reduce(
    (total, [doc]) => total + paddingCount(doc),
    0,
  );
  expect(
    serializedParagraphs,
    "only the one private-marked paragraph needs source reparsing; other reading blocks are immutable",
  ).toBeLessThanOrEqual(2);
  expect(result && "status" in result ? result.status : result).toBe("merged");
  if (!result || !("status" in result) || result.status !== "merged")
    throw new Error("Expected independent source adoption");
  expect(result.draft.markdown).toContain("Live owner A: unchanged. Warmup.");
  expect(result.draft.markdown).not.toContain("Buffered text");
  expect(result.draft.markdown).not.toContain("New local suggestion");
  expect(result.draft.markdown).not.toContain("private-new-comment");
  const proposal = extractRoughdraftReviewIndex(
    result.draft.markdown,
  ).items.find((item) => item.id === "s13");
  expect(proposal).toMatchObject({
    text: "Agent proposal",
    author: "AI",
    createdAt: "2026-11-22T12:05:00.000Z",
  });
  expect(live.doc.toJSON()).toEqual(before);
  expect(result).toEqual(
    adoptRevisionDisk(review, incoming, schema, false, {
      path: "/practice.md",
      markdown: original,
    }),
  );
}, 60000);
