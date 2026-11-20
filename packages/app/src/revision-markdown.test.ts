// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  cleanRevisionMarkdown,
  createSourceSpellingPreserver,
} from "./revision-markdown";

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

describe("preserving original Markdown when saving comparison choices", () => {
  it("keeps the original line endings and list markers when applying distant wording changes", () => {
    const original =
      "# Notes\r\n\r\n* Red apple\r\n* Leave this line.\r\n* Green pear\r\n";
    const canonical =
      "# Notes\n- Red apple\n- Leave this line.\n- Green pear\n";
    const preserve = createSourceSpellingPreserver(original, canonical);

    expect(preserve(canonical)).toBe(original);
    expect(
      preserve(
        canonical
          .replace("Red apple", "Blue plum")
          .replace("Green pear", "Fig"),
      ),
    ).toBe("# Notes\r\n\r\n* Blue plum\r\n* Leave this line.\r\n* Fig\r\n");
  });

  it("declines to apply a change across source it cannot map safely", () => {
    const preserve = createSourceSpellingPreserver(
      "* Keep wording\n",
      "- Keep wording\n",
    );
    expect(preserve("Keep wording\n")).toBeNull();
  });
});
