import { describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { toHtml } from "./markdown";

function roundTrip(input: string) {
  const state = criticMarkdownToEditorState(input);
  return editorStateToCriticMarkdown(state.doc, state.comments, {
    frontmatter: state.frontmatter,
    endmatter: state.endmatter,
  });
}

describe("rich text Markdown preservation", () => {
  it.each([
    "```html\n<details>\n<summary>Example</summary>\nBody\n</details>\n```\n",
    "```html\n<!-- a literal source comment -->\n```\n",
    "~~~html\n<details>\n<summary>Example</summary>\nBody\n</details>\n~~~\n",
  ])("keeps HTML examples literal inside code fences: %s", (input) => {
    const original = criticMarkdownToEditorState(input);
    const reloaded = criticMarkdownToEditorState(roundTrip(input));

    expect(original.doc.content?.[0]?.type).toBe("codeBlock");
    expect(original.doc.content?.[0]?.content?.[0]?.text).toBe(
      input.split("\n").slice(1, -2).join("\n"),
    );
    expect(reloaded.doc).toEqual(original.doc);
  });

  it("preserves HTML in indented code and nested fenced examples", () => {
    const indented = "    <!-- a literal source comment -->\n";
    const nested =
      "- Example:\n\n  ```html\n  <!-- a literal source comment -->\n  ```\n";
    for (const input of [indented, nested]) {
      const state = criticMarkdownToEditorState(input);
      expect(JSON.stringify(state.doc)).toContain(
        "<!-- a literal source comment -->",
      );
      expect(JSON.stringify(state.doc)).not.toContain(
        "data-markdown-raw-block",
      );
      expect(criticMarkdownToEditorState(roundTrip(input)).doc).toEqual(
        state.doc,
      );
    }
  });

  it("keeps reference definitions after code blocks and preserves CRLF code contents", () => {
    const reference =
      "```text\nExample\n```\n\n[Reference][target]\n\n[target]: /home/user/target.md\n";
    const saved = roundTrip(reference);
    const link = criticMarkdownToEditorState(
      saved,
    ).doc.content?.[1]?.content?.[0]?.marks?.find(
      (mark) => mark.type === "link",
    );
    expect(link?.attrs?.href).toBe("/home/user/target.md");

    const crlf =
      "```html\r\n<!-- literal -->\r\n\r\n\r\n# example\r\n\r\nText\r\n```\r\n";
    const state = criticMarkdownToEditorState(crlf);
    expect(state.doc.content?.[0]?.content?.[0]?.text).toBe(
      "<!-- literal -->\n\n\n# example\n\nText",
    );
    expect(criticMarkdownToEditorState(roundTrip(crlf)).doc).toEqual(state.doc);
  });

  it("preserves code block whitespace through an unrelated rich text edit", () => {
    const input = "```text\n# Heading example\n\nBody\n\n\nMore\n```\n";
    const state = criticMarkdownToEditorState(input);
    state.doc.content?.push({
      type: "paragraph",
      content: [{ type: "text", text: "An unrelated edit." }],
    });
    const saved = editorStateToCriticMarkdown(state.doc, state.comments);

    expect(criticMarkdownToEditorState(saved).doc.content?.[0]).toEqual(
      state.doc.content?.[0],
    );
  });

  it("preserves literal punctuation in fenced code with review anchors", () => {
    const input =
      '```ts\nconst foo_bar = "{==a[0] * b==}{>>check<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z"}";\n```\n';
    const original = criticMarkdownToEditorState(input);
    const saved = roundTrip(input);

    expect(saved).toBe(input);
    expect(criticMarkdownToEditorState(saved).doc).toEqual(original.doc);
  });

  it.each([
    "- Use `example`\n\n  <!-- retain source note -->\n",
    "- Use `example`\n\n  <details>\n  <summary>More</summary>\n\n  Secret body\n\n  </details>\n",
  ])("preserves protected HTML beside inline code in a list: %s", (input) => {
    expect(roundTrip(input)).toBe(input);
  });

  it("preserves sibling HTML and literal code inside the same list", () => {
    const input =
      "- Example:\n\n  ```html\n  <!-- literal in code -->\n  # Example\n\n\n  Body\n  ```\n\n  <!-- retained sibling -->\n";
    const saved = roundTrip(input);
    expect(saved).toContain("<!-- retained sibling -->");
    expect(criticMarkdownToEditorState(saved).doc).toEqual(
      criticMarkdownToEditorState(input).doc,
    );
  });

  it("keeps an inline HTML comment after inline code inside its original paragraph", () => {
    const input = "Start `x`<!-- hidden -->\nend.\n";
    const rendered = document.createElement("div");
    rendered.innerHTML = toHtml(input);
    expect(Array.from(rendered.children, (element) => element.tagName)).toEqual(
      ["P"],
    );

    const original = criticMarkdownToEditorState(input);
    const withoutComment = criticMarkdownToEditorState("Start `x`\nend.\n");
    expect(original.doc).toEqual(withoutComment.doc);
    expect(criticMarkdownToEditorState(roundTrip(input)).doc).toEqual(
      original.doc,
    );
  });

  it("preserves a whole escaped-pipe table containing inline code", () => {
    const input = "| A | B |\n| --- | --- |\n| a\\|b | `x` |\n";

    expect(roundTrip(input)).toBe(input);
  });

  it("preserves indented source after a list item containing inline code", () => {
    const input =
      "- Use `example`\n\n    code block\n    second line\n\nAfter\n";

    expect(roundTrip(input)).toBe(input);
  });

  it.each([
    "The literal \\*word\\* is documented.\n",
    "Use \\[label\\](target) as literal text.\n",
    "Literal \\`code\\` and \\_underscores\\_.\n",
    "\\# This is a paragraph, not a heading.\n",
    "1\\. This is a paragraph, not a list.\n",
    "A literal \\\\ backslash.\n",
  ])("preserves literal Markdown punctuation: %s", (input) => {
    const original = criticMarkdownToEditorState(input);
    expect(criticMarkdownToEditorState(roundTrip(input)).doc).toEqual(
      original.doc,
    );
  });

  it("preserves absolute link and image paths", () => {
    const input =
      "[Absolute draft](/home/user/draft.md)\n\n![Absolute image](/home/user/image.png)\n";
    expect(roundTrip(input)).toBe(input);
  });

  it.each([4, 5, 6])("preserves level %i headings", (level) => {
    const input = `${"#".repeat(level)} A heading\n`;
    const state = criticMarkdownToEditorState(input);
    expect(state.doc.content?.[0]).toMatchObject({
      type: "heading",
      attrs: { level },
    });
    expect(roundTrip(input)).toBe(input);
  });
});
