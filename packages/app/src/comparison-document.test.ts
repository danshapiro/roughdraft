import type { JSONContent } from "@tiptap/core";
import { generateHTML } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { buildComparisonDocument } from "./comparison-document";
import type {
  ComparisonReviewData,
  ComparisonSegment,
} from "./comparison-types";
import { createEditorExtensions } from "./editor-extensions";

function review(
  parts: Array<Partial<ComparisonSegment> & { before: string; after?: string }>,
): ComparisonReviewData {
  let oldStart = 1;
  let newStart = 1;
  const segments = parts.map((part, index): ComparisonSegment => {
    const after = part.after ?? part.before;
    const segment: ComparisonSegment = {
      id: `123-change-${index}`,
      kind: part.before === after ? "equal" : "change",
      before: part.before,
      after,
      oldStart,
      newStart,
      decision: part.before === after ? "after" : "pending",
      comment: "",
      ...part,
    };
    oldStart += (segment.before.match(/\n/g) ?? []).length;
    newStart += (segment.after.match(/\n/g) ?? []).length;
    return segment;
  });
  return {
    id: "review-1",
    revision: 1,
    mode: "proposal",
    title: "Instructions",
    beforeLabel: "Before",
    afterLabel: "After",
    targetPath: "/project/AGENTS.md",
    beforeText: segments.map((segment) => segment.before).join(""),
    afterText: segments.map((segment) => segment.after).join(""),
    segments,
    comment: "",
    status: "open",
    targetChanged: false,
    completion: null,
  };
}

function nodes(doc: JSONContent): JSONContent[] {
  return [doc, ...(doc.content ?? []).flatMap(nodes)];
}

function text(doc: JSONContent) {
  return nodes(doc)
    .map((node) => node.text ?? "")
    .join("");
}

function html(doc: JSONContent) {
  return generateHTML(doc, createEditorExtensions(""));
}

function changedText(doc: JSONContent) {
  return nodes(doc)
    .filter((node) => node.marks?.some((mark) => mark.type === "criticChange"))
    .map((node) => node.text ?? "");
}

function projectedText(doc: JSONContent, side: "before" | "after"): string {
  const change = doc.marks?.find((mark) => mark.type === "criticChange");
  if (
    (side === "before" &&
      ["addition", "substitution-new"].includes(change?.attrs?.kind)) ||
    (side === "after" &&
      ["deletion", "substitution-old"].includes(change?.attrs?.kind))
  )
    return "";
  return (
    doc.text ??
    (doc.content ?? []).map((child) => projectedText(child, side)).join("")
  );
}

describe("precise rendered differences", () => {
  it("shows a paragraph once and marks only its replaced word", () => {
    const model = buildComparisonDocument(
      review([
        {
          before: "Please read old guidance before running tests.\n",
          after: "Please read new guidance before running tests.\n",
        },
      ]),
    );
    expect(model.doc.content).toHaveLength(1);
    expect(text(model.doc)).toBe(
      "Please read oldnew guidance before running tests.",
    );
    expect(changedText(model.doc)).toEqual(["old", "new"]);
    expect(model.blockHighlights).toEqual([]);
    expect(model.suggestions).toMatchObject([
      { oldText: "old", newText: "new" },
    ]);
  });

  it("keeps unchanged list items single and unmarked inside a linked group", () => {
    const model = buildComparisonDocument(
      review([
        {
          before: "- First unchanged\n- Read old guidance\n- Last unchanged\n",
          after: "- First unchanged\n- Read new guidance\n- Last unchanged\n",
        },
      ]),
    );
    expect(
      nodes(model.doc).filter((node) => node.type === "bulletList"),
    ).toHaveLength(1);
    expect(
      nodes(model.doc).filter((node) => node.type === "listItem"),
    ).toHaveLength(3);
    expect(text(model.doc).match(/First unchanged/g)).toHaveLength(1);
    expect(changedText(model.doc)).toEqual(["old", "new"]);
    expect(model.blockHighlights).toEqual([]);
    expect(model.suggestions[0].oldText).toBe("old");
  });

  it("keeps unchanged table cells single and unmarked", () => {
    const model = buildComparisonDocument(
      review([
        {
          before:
            "| Key | Value |\n| --- | --- |\n| stable | same |\n| next | old |\n",
          after:
            "| Key | Value |\n| --- | --- |\n| stable | same |\n| next | new |\n",
        },
      ]),
    );
    expect(
      nodes(model.doc).filter((node) => node.type === "table"),
    ).toHaveLength(1);
    expect(
      nodes(model.doc).filter((node) => node.type === "tableCell"),
    ).toHaveLength(4);
    expect(text(model.doc).match(/stable/g)).toHaveLength(1);
    expect(changedText(model.doc)).toEqual(["old", "new"]);
    expect(model.blockHighlights).toEqual([]);
  });

  it("retains both formatting alternatives without duplicating unchanged words", () => {
    const model = buildComparisonDocument(
      review([
        {
          before: "Keep **important** words.\n",
          after: "Keep *important* words.\n",
        },
      ]),
    );
    expect(model.doc.content).toHaveLength(1);
    expect(text(model.doc)).toBe("Keep importantimportant words.");
    expect(changedText(model.doc)).toEqual(["important", "important"]);
    expect(model.suggestions[0].oldText).toContain("bold");
    expect(model.suggestions[0].newText).toContain("italic");
    expect(model.blockHighlights).toEqual([]);
  });

  it("shows changed link targets explicitly while retaining unchanged context once", () => {
    const model = buildComparisonDocument(
      review([
        {
          before: "Read [the guide](https://old.test) before starting.\n",
          after: "Read [the guide](https://new.test) before starting.\n",
        },
      ]),
    );
    expect(model.doc.content).toHaveLength(1);
    expect(text(model.doc)).toBe("Read the guidethe guide before starting.");
    expect(model.suggestions[0].oldText).toContain("https://old.test");
    expect(model.suggestions[0].newText).toContain("https://new.test");
    expect(model.blockHighlights).toEqual([]);
    expect(html(model.doc)).toContain('href="https://old.test"');
    expect(html(model.doc)).toContain('href="https://new.test"');
  });

  it("keeps source-only changes reviewable when their rendered formatting is identical", () => {
    const model = buildComparisonDocument(
      review([
        {
          before: "Use **care**.\n",
          after: "Use __care__.\n",
        },
      ]),
    );
    expect(text(model.doc).replaceAll("\u2060", "")).toBe("Use care.");
    expect(model.suggestions).toHaveLength(1);
    expect(
      `${model.suggestions[0].oldText} ${model.suggestions[0].newText}`,
    ).toMatch(/source|formatting/i);
    expect(changedText(model.doc).every((value) => value === "\u2060")).toBe(
      true,
    );
  });
});

describe("rendered comparison document", () => {
  it("uses native headings, paragraphs and change marks with persisted IDs", () => {
    const input = review([
      { before: "# Instructions\n\n" },
      { before: "Read the guide.\n", after: "Read the **updated** guide.\n" },
    ]);
    const model = buildComparisonDocument(input);
    expect(html(model.doc)).toContain("<h1>Instructions</h1>");
    expect(
      nodes(model.doc).some((node) =>
        node.marks?.some((mark) => mark.type === "bold"),
      ),
    ).toBe(true);
    expect(model.groups).toEqual([
      { id: "123-change-1", segmentIds: ["123-change-1"], decision: "pending" },
    ]);
    expect(model.suggestions).toMatchObject([
      {
        changeId: "123-change-1",
        oldText: "",
        newText: "updated",
        kind: "addition",
      },
    ]);
    const marks = nodes(model.doc)
      .flatMap((node) => node.marks ?? [])
      .filter((mark) => mark.type === "criticChange");
    expect(new Set(marks.map((mark) => mark.attrs?.changeId))).toEqual(
      new Set(["123-change-1"]),
    );
    expect(new Set(marks.map((mark) => mark.attrs?.kind))).toEqual(
      new Set(["addition"]),
    );
    expect(projectedText(model.doc, "before")).toBe(
      "InstructionsRead the guide.",
    );
    expect(projectedText(model.doc, "after")).toBe(
      "InstructionsRead the updated guide.",
    );
    expect(text(model.doc)).not.toContain("**");
  });

  it("links changes inside one list without breaking its complete native structure", () => {
    const input = review([
      { before: "# Checklist\n\n- First\n" },
      { before: "- Old second\n", after: "- New second\n" },
      { before: "- Shared third\n" },
      { before: "- Old fourth\n", after: "- New fourth\n" },
      { before: "\nSeparate paragraph.\n" },
    ]);
    const model = buildComparisonDocument(input);
    expect(model.groups).toEqual([
      {
        id: "123-change-1",
        segmentIds: ["123-change-1", "123-change-3"],
        decision: "pending",
      },
    ]);
    expect(model.suggestions[0].sourceChangeCount).toBe(2);
    expect(
      nodes(model.doc).filter((node) => node.type === "bulletList"),
    ).toHaveLength(1);
    expect(
      nodes(model.doc).filter((node) => node.type === "listItem"),
    ).toHaveLength(4);
    expect(changedText(model.doc)).toEqual(["Old", "New", "Old", "New"]);
    expect(model.blockHighlights).toEqual([]);
    expect(text(model.doc).match(/Separate paragraph/g)).toHaveLength(1);
  });

  it("keeps table headers and multiple changed rows in one native decision group", () => {
    const input = review([
      { before: "| Name | Value |\n| --- | --- |\n" },
      { before: "| First | old |\n", after: "| First | new |\n" },
      { before: "| Shared | same |\n" },
      { before: "| Last | old |\n", after: "| Last | new |\n" },
    ]);
    const model = buildComparisonDocument(input);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0].segmentIds).toEqual([
      "123-change-1",
      "123-change-3",
    ]);
    expect(
      nodes(model.doc).filter((node) => node.type === "table"),
    ).toHaveLength(1);
    expect(
      nodes(model.doc).filter((node) => node.type === "tableHeader"),
    ).toHaveLength(2);
    expect(changedText(model.doc)).toEqual(["old", "new", "old", "new"]);
    expect(model.blockHighlights).toEqual([]);
    expect(html(model.doc)).toContain("<table");
    expect(text(model.doc)).not.toContain("| --- |");
  });

  it("keeps fenced and inline CriticMarkup examples literal while highlighting the real comparison", () => {
    const input = review([
      { before: "# Examples\n\n```md\n" },
      { before: "{++literal old++}\n", after: "{++literal new++}\n" },
      { before: "```\n\nUse `{--literal--}` as an example.\n" },
    ]);
    const model = buildComparisonDocument(input);
    expect(
      nodes(model.doc).filter((node) => node.type === "codeBlock"),
    ).toHaveLength(1);
    expect(projectedText(model.doc, "before")).toContain("{++literal old++}");
    expect(projectedText(model.doc, "after")).toContain("{++literal new++}");
    expect(changedText(model.doc)).toEqual(["old", "new"]);
    expect(text(model.doc)).toContain("{--literal--}");
    expect(model.suggestions.map((item) => item.changeId)).toEqual([
      "123-change-1",
    ]);
  });

  it("cuts between independent blocks only where both versions have a safe boundary", () => {
    const input = review([
      { before: "# First\n\n" },
      { before: "Old one.\n", after: "New one.\n" },
      { before: "\n# Second\n\n" },
      { before: "Old two.\n", after: "New two.\n" },
    ]);
    const model = buildComparisonDocument(input);
    expect(model.groups.map((group) => group.segmentIds)).toEqual([
      ["123-change-1"],
      ["123-change-3"],
    ]);
    expect(
      nodes(model.doc).filter((node) => node.type === "heading"),
    ).toHaveLength(2);
  });

  it("hides reviewed markup by default and can reveal it without changing source decisions", () => {
    const input = review([
      { before: "Old.\n", after: "New.\n", decision: "after" },
    ]);
    const frozen = JSON.stringify(input);
    const chosen = buildComparisonDocument(input);
    expect(text(chosen.doc)).toBe("New.");
    expect(chosen.suggestions).toEqual([]);
    expect(
      nodes(chosen.doc)
        .flatMap((node) => node.marks ?? [])
        .some((mark) => mark.type === "criticChange"),
    ).toBe(false);
    const shown = buildComparisonDocument(input, { showReviewed: true });
    expect(text(shown.doc)).toContain("Old.");
    expect(text(shown.doc)).toContain("New.");
    expect(shown.suggestions).toMatchObject([
      { changeId: "123-change-0", reviewStatus: "Accepted" },
    ]);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("preserves mixed saved choices and comments when grouped changes render selected content", () => {
    const input = review([
      { before: "- Start\n" },
      {
        before: "- Old one\n",
        after: "- New one\n",
        decision: "after",
        comment: "Keep this improvement",
      },
      { before: "- Shared\n" },
      {
        before: "- Old two\n",
        after: "- New two\n",
        decision: "before",
        comment: "Retain the old wording",
      },
    ]);
    input.reviewComments = [
      {
        id: "thread-1",
        content: "Question",
        createdAt: "2026-11-11T00:00:00Z",
        parentCommentId: "123-change-3",
        changeId: "123-change-3",
      },
      {
        id: "reply-1",
        content: "Answer",
        createdAt: "2026-11-11T00:01:00Z",
        parentCommentId: "thread-1",
        changeId: "123-change-3",
      },
    ];
    const frozen = JSON.stringify(input);
    const model = buildComparisonDocument(input);
    expect(model.groups[0].decision).toBe("mixed");
    expect(text(model.doc)).toContain("New one");
    expect(text(model.doc)).toContain("Old two");
    expect(text(model.doc)).not.toContain("Old one");
    expect(text(model.doc)).not.toContain("New two");
    expect(model.suggestions).toEqual([]);
    expect(model.comments.get("legacy:123-change-1")?.content).toBe(
      "Keep this improvement",
    );
    expect(model.comments.get("legacy:123-change-3")?.parentCommentId).toBe(
      "123-change-1",
    );
    expect(model.comments.get("thread-1")?.parentCommentId).toBe(
      "123-change-1",
    );
    expect(model.comments.get("reply-1")?.parentCommentId).toBe("thread-1");
    expect(
      nodes(model.doc)
        .flatMap((node) => node.marks ?? [])
        .some((mark) => mark.type === "commentRef"),
    ).toBe(true);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("makes formatting-only changes visible using the rendered old and new nodes", () => {
    const input = review([
      { before: "Guidance\n", after: "## **Guidance**\n" },
    ]);
    const model = buildComparisonDocument(input);
    expect(model.suggestions).toHaveLength(1);
    expect(model.doc.content?.map((node) => node.type)).toEqual([
      "paragraph",
      "heading",
    ]);
    expect(
      nodes(model.doc).some((node) =>
        node.marks?.some((mark) => mark.type === "bold"),
      ),
    ).toBe(true);
    expect(model.blockHighlights).toHaveLength(2);
  });

  it("anchors image and horizontal-rule changes even when neither side has text", () => {
    const input = review([{ before: "![Diagram](old.png)\n", after: "***\n" }]);
    const model = buildComparisonDocument(input, {
      resolveFileUrl: (path) => `/asset/${path}`,
    });
    expect(model.suggestions).toHaveLength(1);
    expect(
      nodes(model.doc).some(
        (node) => node.type === "image" && node.attrs?.src === "/asset/old.png",
      ),
    ).toBe(true);
    expect(
      nodes(model.doc).some((node) => node.type === "horizontalRule"),
    ).toBe(true);
    expect(model.blockHighlights).toHaveLength(2);
    expect(model.blockHighlights[0]).toMatchObject({
      from: 0,
      to: 1,
      changeId: "123-change-0",
      kind: "substitution-old",
    });
    expect(model.blockHighlights[1]).toMatchObject({
      from: 1,
      to: 2,
      changeId: "123-change-0",
      kind: "substitution-new",
    });
    expect(html(model.doc)).toContain("<hr>");
  });

  it("resolves reference links from their full snapshot outside a rendered unit", () => {
    const input = review([
      { before: "# Links\n\n" },
      {
        before: "Read [old text][guide].\n",
        after: "Read [new text][guide].\n",
      },
      { before: '\n[guide]: https://example.com/guide "Reference"\n' },
    ]);
    const model = buildComparisonDocument(input);
    const links = nodes(model.doc)
      .flatMap((node) => node.marks ?? [])
      .filter((mark) => mark.type === "link");
    expect(links.length).toBeGreaterThan(0);
    expect(
      links.every(
        (mark) =>
          mark.attrs?.href === "https://example.com/guide" &&
          mark.attrs?.title === "Reference",
      ),
    ).toBe(true);
    expect(changedText(model.doc)).toEqual(["old", "new"]);
    expect(projectedText(model.doc, "before")).toBe("LinksRead old text.");
    expect(projectedText(model.doc, "after")).toBe("LinksRead new text.");
    expect(text(model.doc)).not.toContain("[guide]");
  });

  it("shows frontmatter and review endmatter changes instead of silently removing them", () => {
    const input = review([
      { before: "---\ntitle: Old\n---\n\n", after: "---\ntitle: New\n---\n\n" },
      { before: "# Shared body\n" },
      {
        before:
          "\n---\ncomments:\n  c1:\n    body: Old feedback\n    by: user\n    at: 2026-11-11T00:00:00Z\n",
        after:
          "\n---\ncomments:\n  c1:\n    body: New feedback\n    by: user\n    at: 2026-11-11T00:00:00Z\n",
      },
    ]);
    const model = buildComparisonDocument(input);
    expect(model.groups).toHaveLength(2);
    expect(model.suggestions).toHaveLength(2);
    expect(projectedText(model.doc, "before")).toContain("title: Old");
    expect(projectedText(model.doc, "after")).toContain("title: New");
    expect(projectedText(model.doc, "before")).toContain("Old feedback");
    expect(projectedText(model.doc, "after")).toContain("New feedback");
    expect(changedText(model.doc)).toEqual(["Old", "New", "Old", "New"]);
    expect(
      nodes(model.doc).filter((node) => node.type === "codeBlock"),
    ).toHaveLength(2);
    expect(
      nodes(model.doc).filter((node) => node.type === "heading"),
    ).toHaveLength(1);
  });

  it("shows definition-only changes and compare-mode decisions without mutating CRLF source", () => {
    const input = review([
      { before: "# Links\r\n\r\nRead [guide].\r\n\r\n" },
      {
        before: "[guide]: https://old.test",
        after: "[guide]: https://new.test",
        decision: "after",
      },
    ]);
    input.mode = "compare";
    const frozen = JSON.stringify(input);
    const model = buildComparisonDocument(input);
    expect(model.suggestions).toHaveLength(1);
    expect(projectedText(model.doc, "before")).toContain("https://old.test");
    expect(projectedText(model.doc, "after")).toContain("https://new.test");
    expect(changedText(model.doc)).toEqual(["old", "new"]);
    expect(nodes(model.doc).some((node) => node.type === "codeBlock")).toBe(
      true,
    );
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("keeps historical comment threads reachable when their source change no longer exists", () => {
    const input = review([{ before: "# Current instructions\n" }]);
    input.reviewComments = [
      {
        id: "legacy:removed-change",
        changeId: "removed-change",
        content: "Historical feedback",
        createdAt: "2026-11-11T00:00:00Z",
        parentCommentId: "removed-change",
        scope: "document",
      },
      {
        id: "historical-reply",
        changeId: "removed-change",
        content: "Preserved answer",
        createdAt: "2026-11-11T00:01:00Z",
        parentCommentId: "legacy:removed-change",
      },
    ];
    const model = buildComparisonDocument(input);
    expect(model.comments.get("legacy:removed-change")).toMatchObject({
      content: "Historical feedback",
      scope: "document",
    });
    expect(model.comments.get("historical-reply")).toMatchObject({
      content: "Preserved answer",
      parentCommentId: "legacy:removed-change",
    });
    const anchored = nodes(model.doc)
      .flatMap((node) => node.marks ?? [])
      .filter((mark) => mark.type === "commentRef")
      .flatMap((mark) => mark.attrs?.commentIds ?? []);
    expect(anchored).toContain("legacy:removed-change");
    expect(anchored).toContain("historical-reply");
    expect(model.suggestions).toEqual([]);
  });

  it("keeps a comment anchor when rejecting an image insertion leaves no rendered text", () => {
    const input = review([
      {
        before: "",
        after: "![Diagram](diagram.png)\n",
        decision: "before",
        comment: "Use the diagram later",
      },
    ]);
    const model = buildComparisonDocument(input);
    expect(model.suggestions).toEqual([]);
    expect(model.comments.get("legacy:123-change-0")?.content).toBe(
      "Use the diagram later",
    );
    expect(
      nodes(model.doc)
        .flatMap((node) => node.marks ?? [])
        .some(
          (mark) =>
            mark.type === "commentRef" &&
            mark.attrs?.commentIds?.includes("legacy:123-change-0"),
        ),
    ).toBe(true);
    expect(nodes(model.doc).some((node) => node.type === "image")).toBe(false);
  });

  it("merges comparison comment anchors with existing native source comments", () => {
    const input = review([
      {
        before:
          "{==Original==}{>>Existing comment<<}{#c1}\n\n---\ncomments:\n  c1:\n    by: user\n    at: 2026-11-11T00:00:00Z\n",
        after:
          "{==Updated==}{>>Existing comment<<}{#c1}\n\n---\ncomments:\n  c1:\n    by: user\n    at: 2026-11-11T00:00:00Z\n",
        comment: "Comparison feedback",
      },
    ]);
    const model = buildComparisonDocument(input);
    const anchored = nodes(model.doc).filter(
      (node) => node.text === "Updated",
    )[0];
    const commentMarks =
      anchored.marks?.filter((mark) => mark.type === "commentRef") ?? [];
    expect(commentMarks).toHaveLength(1);
    expect(commentMarks[0].attrs?.commentIds).toEqual(
      expect.arrayContaining(["c1", "legacy:123-change-0"]),
    );
  });

  it("retains existing decisions in the visible versions of a partly reviewed linked group", () => {
    const input = review([
      { before: "- First\n" },
      {
        before: "- Old accepted\n",
        after: "- New accepted\n",
        decision: "after",
      },
      { before: "- Shared\n" },
      { before: "- Old pending\n", after: "- New pending\n" },
    ]);
    const model = buildComparisonDocument(input);
    expect(model.groups[0].decision).toBe("mixed");
    expect(model.suggestions).toHaveLength(1);
    expect(text(model.doc)).not.toContain("Old accepted");
    expect(text(model.doc)).toContain("New accepted");
    expect(projectedText(model.doc, "before")).toContain("Old pending");
    expect(projectedText(model.doc, "after")).toContain("New pending");
    expect(changedText(model.doc)).toEqual(["Old", "New"]);
    const shown = buildComparisonDocument(input, { showReviewed: true });
    expect(projectedText(shown.doc, "before")).toContain("Old accepted");
  });
});
