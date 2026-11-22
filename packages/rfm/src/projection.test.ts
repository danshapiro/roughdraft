import { describe, expect, it } from "vitest";
import { cleanRoughdraftMarkdown } from "./index";

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
