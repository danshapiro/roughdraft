import { describe, expect, it } from "vitest";
import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
} from "./index.js";
import type { SyncDraft } from "./review-sync.js";

const draft = (markdown: string): SyncDraft => ({
  markdown,
  cleanMarkdown: cleanRoughdraftMarkdown(markdown),
  decisions: {},
  reviewComments: [],
});

describe("separate fragments of one discussion", () => {
  it.each([
    "\n",
    "\r\n",
  ])("merges independent paragraphs between two same-ID anchors (%j)", (newline) => {
    const source = [
      "---",
      "title: A release discussion with separate selected passages",
      "---",
      "",
      "{==First passage==}{>>One discussion across two passages.<<}{#c1}",
      "",
      "Peer owner: unchanged.",
      "",
      "Local owner: unchanged.",
      "",
      "{==Last passage==}{>>One discussion across two passages.<<}{#c1}",
      "",
      "An existing {++proposal++}{#s1} must remain pending.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: AI",
      '    at: "2026-11-26T12:00:00.000Z"',
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-11-26T12:00:00.000Z"',
      "",
    ].join(newline);
    const result = mergeReviewDrafts(
      draft(source),
      draft(source.replace("Local owner: unchanged.", "Local owner: mine.")),
      draft(source.replace("Peer owner: unchanged.", "Peer owner: theirs.")),
    );

    expect(result.status).toBe("merged");
    expect(result.conflicts).toEqual([]);
    expect(result.draft.markdown).toBe(
      source
        .replace("Local owner: unchanged.", "Local owner: mine.")
        .replace("Peer owner: unchanged.", "Peer owner: theirs."),
    );
    const items = extractRoughdraftReviewIndex(result.draft.markdown).items;
    expect(items.find((item) => item.id === "c1")).toMatchObject({
      text: "One discussion across two passages.",
      anchorText: "First passageLast passage",
    });
    expect(items.filter((item) => item.id === "s1")).toHaveLength(1);
    expect(result.draft.cleanMarkdown).not.toContain("proposal");
  });
});
