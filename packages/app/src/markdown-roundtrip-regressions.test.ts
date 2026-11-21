import { describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";

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

  it("preserves code block whitespace through an unrelated rich text edit", () => {
    const input = "```text\n# Heading example\n\nBody\n\n\nMore\n```\n";
    const state = criticMarkdownToEditorState(input);
    state.doc.content?.push({ type: "paragraph", content: [{ type: "text", text: "An unrelated edit." }] });
    const saved = editorStateToCriticMarkdown(state.doc, state.comments);

    expect(criticMarkdownToEditorState(saved).doc.content?.[0]).toEqual(
      state.doc.content?.[0],
    );
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
    expect(criticMarkdownToEditorState(roundTrip(input)).doc).toEqual(original.doc);
  });

  it("preserves absolute link and image paths", () => {
    const input = "[Absolute draft](/home/user/draft.md)\n\n![Absolute image](/home/user/image.png)\n";
    expect(roundTrip(input)).toBe(input);
  });

  it.each([4, 5, 6])("preserves level %i headings", (level) => {
    const input = `${"#".repeat(level)} A heading\n`;
    const state = criticMarkdownToEditorState(input);
    expect(state.doc.content?.[0]).toMatchObject({ type: "heading", attrs: { level } });
    expect(roundTrip(input)).toBe(input);
  });
});
