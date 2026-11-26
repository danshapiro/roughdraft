import { describe, expect, it } from "vitest";
import { extractRoughdraftReviewIndex, scanRoughdraftReview } from "./index.js";

describe("full-context review fragments", () => {
  it.each([
    "\n",
    "\r\n",
  ])("retains separate compact fragments and ignores literal examples (%j)", (newline) => {
    const first = "{==First==}{>>One discussion.<<}{#c1}";
    const last = "{==Last==}{>>One discussion.<<}{#c1}";
    const proposal = "{++Pending proposal++}{#s1}";
    const source = [
      "---",
      "title: Preserve Markdown context",
      "---",
      "",
      first,
      "",
      "An unrelated paragraph between the two selected passages.",
      "",
      "`{++Inline literal++}{#literal1}`",
      "",
      "\\{++Escaped literal++}{#literal2}",
      "",
      "```md",
      "{++Fenced literal++}{#literal3}",
      "```",
      "",
      "> ~~~md",
      "> {++Quoted fenced literal++}{#literal4}",
      "> ~~~",
      "",
      last,
      "",
      proposal,
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: AI",
      '    at: "2026-11-26T12:00:00.000Z"',
      "  c2:",
      "    body: Metadata-only reply.",
      "    re: c1",
      "    by: user",
      '    at: "2026-11-26T12:01:00.000Z"',
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-11-26T12:02:00.000Z"',
      "",
    ].join(newline);
    const scan = scanRoughdraftReview(source);

    expect(scan.ranges.map(({ from, to }) => source.slice(from, to))).toEqual([
      first,
      last,
      proposal,
    ]);
    expect(scan.items.map((item) => item.id)).toEqual(["c1", "s1", "c2"]);
    expect(scan.items[0]).toMatchObject({
      anchorText: "FirstLast",
      text: "One discussion.",
      author: "AI",
      createdAt: "2026-11-26T12:00:00.000Z",
    });
    expect(scan.items[2]).toMatchObject({
      kind: "reply",
      parentId: "c1",
      text: "Metadata-only reply.",
      offset: scan.items[2].endOffset,
    });
    expect(extractRoughdraftReviewIndex(source).items).toEqual(scan.items);
    expect(extractRoughdraftReviewIndex(source).diagnostics).toEqual([]);
  });

  it("keeps full public diagnostics for malformed review metadata", () => {
    const index = extractRoughdraftReviewIndex("{++An undated proposal++}\n");
    expect(index.items).toMatchObject([
      { kind: "suggestion", text: "An undated proposal" },
    ]);
    expect(index.diagnostics.map((item) => item.code)).toEqual([
      "missing-metadata-id",
      "missing-metadata-by",
      "missing-metadata-at",
    ]);
  });
});
