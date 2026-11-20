// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { cleanRevisionMarkdown } from "./revision-markdown";

describe("Markdown written or exported from a review", () => {
  it("keeps original wording until suggestions are kept", () => {
    expect(
      cleanRevisionMarkdown(
        "# Notes\n\nKeep {--this--} and {~~old~>new~~}{++ extra++}. {>>Feedback<<}\n",
      ),
    ).toBe("# Notes\nKeep this and old.\n");
  });

  it("preserves exact clean source and unrelated Markdown metadata", () => {
    const clean = "---\r\nname: example\r\n---\r\n\r\n* one\r\n* two";
    expect(cleanRevisionMarkdown(clean)).toBe(clean);
    expect(
      cleanRevisionMarkdown(
        "# Notes\n\n{++new++}{#s1}Old\n\n---\nother: true\nsuggestions:\n  s1:\n    by: User\n    at: 2026-11-18T00:00:00Z\n",
      ),
    ).toBe("# Notes\nOld\n\n---\nother: true\n");
  });
  it("excludes a pending multi-block change without losing adjacent text or metadata", () => {
    const source =
      '---\nname: example\n---\n\nUnchanged lead {~~Original first.\n\n- Original feature~>Proposed first.\n\n- Proposed feature~~}{#s24} unchanged tail.\n\nEdited neighbor.\n\n---\nother: true\nsuggestions:\n  s24:\n    by: AI\n    at: "2026-11-19T05:13:01.272Z"\n';
    const expected = criticMarkdownToEditorState(
      "---\nname: example\n---\n\nUnchanged lead Original first.\n\n- Original feature unchanged tail.\n\nEdited neighbor.\n",
    );
    expect(cleanRevisionMarkdown(source)).toBe(
      `${editorStateToCriticMarkdown(expected.doc, new Map()).trimEnd()}\n\n---\nother: true\n`,
    );
  });

  it("omits an unkept suggestion consisting only of a fenced code block", () => {
    expect(
      cleanRevisionMarkdown(
        "Start.\n\n{++```js\nconst proposed = 1;\n```++}\n\nEnd.\n",
      ),
    ).toBe("Start.\n\nEnd.\n");
  });
});
