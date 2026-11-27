import { describe, expect, it } from "vitest";
import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
} from "./index";

describe("clean source projection", () => {
  it("keeps original wording while omitting pending edits and inline feedback", () => {
    expect(
      cleanRoughdraftMarkdown(
        "Keep {--this--} and {~~old~>new~~}{++ addition++}. {==Anchor==}{>>Feedback<<}\n",
      ),
    ).toBe("Keep this and old. Anchor\n");
  });

  it("preserves source spelling and markup examples inside code and frontmatter", () => {
    const source =
      "---\r\nexample: '{++literal++}'\r\n---\r\n\r\n* Example `{~~old~>new~~}`\r\n\r\n```md\r\n{>>Literal feedback<<}\r\n{++Literal addition++}\r\n```\r\n\r\nUse {~~old~>new~~} wording.";
    expect(cleanRoughdraftMarkdown(source)).toBe(
      source.replace("Use {~~old~>new~~}", "Use old"),
    );
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps the complete clean document after frontmatter when code contains a compact review example (%j)", (newline) => {
    const source = [
      "---",
      "title: Review plan",
      "---",
      "",
      "# Release plan",
      "",
      "Keep the [setup reference][setup] and note[^review].",
      "",
      "````markdown",
      "{==literal highlight==}{>>literal comment<<}{#literal-comment}",
      "{++literal addition++} {~~old~>new~~}",
      "````",
      "",
      '[setup]: https://example.com "Setup"',
      "",
      "[^review]: Preserve this **complete note**.",
      "",
      "    Its second paragraph also stays.",
      "",
    ].join(newline);

    expect(cleanRoughdraftMarkdown(source)).toBe(source);
    expect(extractRoughdraftReviewIndex(source).items).toEqual([]);
    expect(validateRoughdraftMarkdown(source).diagnostics).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("still projects real review endmatter after frontmatter (%j)", (newline) => {
    const frontmatter = ["---", "title: Review plan", "---", ""].join(newline);
    const source = `${frontmatter}${newline}Use {~~old~>new~~}{#s1} wording.${newline}${newline}---${newline}suggestions:${newline}  s1:${newline}    by: AI${newline}    at: "2026-11-22T12:00:00.000Z"${newline}`;

    expect(cleanRoughdraftMarkdown(source)).toBe(
      `${frontmatter}${newline}Use old wording.${newline}`,
    );
    expect(extractRoughdraftReviewIndex(source).items).toEqual([
      expect.objectContaining({ id: "s1", kind: "suggestion", author: "AI" }),
    ]);
    expect(validateRoughdraftMarkdown(source).diagnostics).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("still reports malformed review endmatter after frontmatter (%j)", (newline) => {
    const source = [
      "---",
      "title: Review plan",
      "---",
      "",
      "Discuss {==this==}{>>Feedback<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1: [unterminated {#c1}",
      "",
    ].join(newline);

    expect(validateRoughdraftMarkdown(source).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-endmatter-yaml" }),
      ]),
    );
    expect(cleanRoughdraftMarkdown(source)).toBe(
      ["---", "title: Review plan", "---", "", "Discuss this.", ""].join(
        newline,
      ),
    );
  });

  it("keeps unrelated endmatter and removes review entries", () => {
    const source =
      "Text {++proposed++}{#s1}\n\n---\nother: true\nsuggestions:\n  s1:\n    by: AI\n    at: 2026-11-21T18:00:00.000Z\ncomments:\n  c1:\n    body: Feedback\n    by: User\n    at: 2026-11-21T18:00:00.000Z\n";
    expect(cleanRoughdraftMarkdown(source)).toBe("Text \n\n---\nother: true\n");
  });

  it("restores original multi-block Markdown and omits pending block additions", () => {
    const source =
      "Lead.\n\n{~~Old paragraph.\n\n- Old feature~>New paragraph.\n\n- New feature~~}\n\n{++```js\nproposed();\n```++}\n\nTail.\n";
    expect(cleanRoughdraftMarkdown(source)).toBe(
      "Lead.\n\nOld paragraph.\n\n- Old feature\n\n\n\nTail.\n",
    );
  });
});
