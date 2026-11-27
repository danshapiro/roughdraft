import * as rfm from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { adoptRevisionDisk } from "./revision-disk-adoption";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import { RevisionSource } from "./revision-source";

const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
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
    reviewed: [],
  };
}
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

test("a new disk proposal ID collision merges with continued canonical browser typing", () => {
  const base = draft(source);
  const disk = source
    .replace("Beta owner: ready.", "Beta owner: ready. {++Agent-b++}{#s2}")
    .replace(
      "suggestions:\n",
      'suggestions:\n  s2:\n    by: AI\n    at: "2026-11-22T12:05:00.000Z"\n',
    );
  const localSource = source
    .replace(
      "Alpha owner: ready.",
      "Alpha owner: ready. {++Alpha-a-continued++}{#s2}",
    )
    .replace(
      "suggestions:\n",
      'suggestions:\n  s2:\n    by: user\n    at: "2026-11-27T06:58:46.535Z"\n',
    );
  const parsed = criticMarkdownToEditorState(localSource);
  const local = draft(editorStateToCriticMarkdown(parsed.doc, parsed.comments));
  const adoption = adoptRevisionDisk(base, disk, schema, false, {
    path: "/practice.md",
    markdown: source,
  });
  expect(adoption && "status" in adoption ? adoption.status : adoption).toBe(
    "merged",
  );
  if (!adoption || !("status" in adoption) || adoption.status !== "merged")
    throw new Error("Disk feedback must be independently adoptable");
  const result = rfm.mergeReviewDrafts(base, local, adoption.draft, {
    server: false,
  });
  expect(result.conflicts).toEqual([]);
  expect(result.status).toBe("merged");
  expect(result.idRemap).toEqual({ s2: "s3" });
  expect(result.draft.markdown).toContain("Alpha-a-continued");
  expect(result.draft.markdown).toContain("Agent-b");
  expect(result.draft.markdown).toContain("{++must survive++}{#s1}");
});
