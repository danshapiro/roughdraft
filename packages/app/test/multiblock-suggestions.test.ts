import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  criticMarkdownHasReviewRail,
  criticMarkdownToEditorState,
  criticMarkdownToRenderedHtml,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";

const at = "2026-11-19T05:13:01.272Z";
const metadata = `{id="s24" by="AI" at="${at}"}`;
const original =
  "Original first paragraph.\n\nOriginal second paragraph.\n\n## Original features\n\n- Original one\n- Original two";
const replacement =
  "Proposed first paragraph.\n\nProposed second paragraph.\n\n## Proposed features\n\n- Proposed one\n- Proposed two";
const substitution = `{~~${original}~>${replacement}~~}${metadata}`;

function rendered(markdown: string) {
  const result = criticMarkdownToRenderedHtml(markdown);
  const element = document.createElement("div");
  element.innerHTML = result.html;
  return { ...result, element };
}

function textOf(element: Element, selector: string) {
  return [...element.querySelectorAll(selector)].map((node) =>
    node.textContent?.trim(),
  );
}

function paragraphsOutsideLists(element: Element) {
  return [...element.querySelectorAll("p")] // selector-check-ignore: actual Markdown block semantics are the behavior under test.
    .filter((node) => !node.closest("li"))
    .map((node) => node.textContent?.trim());
}

describe("suggestions spanning Markdown blocks", () => {
  it("renders both complete sides of one substitution with real headings and lists", () => {
    const { element, changes } = rendered(substitution);

    expect(changes.size).toBe(1);
    expect(changes.get("s24")).toMatchObject({
      changeId: "s24",
      authorType: "ai",
      createdAt: at,
    });
    expect(paragraphsOutsideLists(element)).toEqual([
      "Original first paragraph.",
      "Original second paragraph.",
      "Proposed first paragraph.",
      "Proposed second paragraph.",
    ]);
    expect(textOf(element, "h2")).toEqual([
      "Original features",
      "Proposed features",
    ]);
    expect(element.querySelectorAll("ul")).toHaveLength(2); // selector-check-ignore: actual Markdown block semantics are the behavior under test.
    expect(textOf(element, "li")).toEqual([
      "Original one",
      "Original two",
      "Proposed one",
      "Proposed two",
    ]);
    expect(element.textContent).not.toMatch(/\{~~|~>|~~\}|id="s24"/);
    for (const [kind, label] of [
      ["substitution-old", "Original"],
      ["substitution-new", "Proposed"],
    ]) {
      const marked = textOf(
        element,
        `[data-critic-change-id="s24"][data-critic-change-kind="${kind}"]`,
      );
      expect(marked).toEqual([
        `${label} first paragraph.`,
        `${label} second paragraph.`,
        `${label} features`,
        `${label} one`,
        `${label} two`,
      ]);
    }
  });

  it("saves and reopens one complete substitution with its identity and both sides", () => {
    const parsed = criticMarkdownToEditorState(substitution);
    const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);
    const reopened = rendered(output);

    expect(output.match(/\{~~/g)).toHaveLength(1);
    expect(output.match(/~>/g)).toHaveLength(1);
    expect(output.match(/~~\}/g)).toHaveLength(1);
    expect(output.match(/id="s24"/g)).toHaveLength(1);
    expect(output).toContain(metadata);
    expect(reopened.changes.size).toBe(1);
    expect(textOf(reopened.element, "h2")).toEqual([
      "Original features",
      "Proposed features",
    ]);
    expect(textOf(reopened.element, "li")).toEqual([
      "Original one",
      "Original two",
      "Proposed one",
      "Proposed two",
    ]);
    expect(reopened.element.textContent).not.toMatch(/\{~~|~>|~~\}/);
  });

  it.each([
    "accept",
    "reject",
  ] as const)("%s resolves the entire substitution without empty headings or lists", (decision) => {
    const input = `Unrelated introduction.\n\n${substitution}\n\nUnrelated conclusion.\n`;
    const parsed = criticMarkdownToEditorState(input);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: parsed.doc,
    });
    try {
      expect(
        decision === "accept"
          ? editor.commands.acceptCriticChange("s24")
          : editor.commands.rejectCriticChange("s24"),
      ).toBe(true);
      const output = editorStateToCriticMarkdown(
        editor.getJSON(),
        parsed.comments,
      );
      const reopened = rendered(output);
      const chosen = decision === "accept" ? "Proposed" : "Original";
      const discarded = decision === "accept" ? "Original" : "Proposed";

      expect(reopened.changes.size).toBe(0);
      expect(paragraphsOutsideLists(reopened.element)).toEqual([
        "Unrelated introduction.",
        `${chosen} first paragraph.`,
        `${chosen} second paragraph.`,
        "Unrelated conclusion.",
      ]);
      expect(textOf(reopened.element, "h2")).toEqual([`${chosen} features`]);
      expect(reopened.element.querySelectorAll("ul")).toHaveLength(1); // selector-check-ignore: actual Markdown block semantics are the behavior under test.
      expect(textOf(reopened.element, "li")).toEqual([
        `${chosen} one`,
        `${chosen} two`,
      ]);
      expect(output).not.toContain(discarded);
      expect(output).not.toMatch(/\{~~|~>|~~\}|s24/);
    } finally {
      editor.destroy();
    }
  });

  it.each([
    { open: "{++", close: "++}", kind: "addition", keep: "accept" },
    { open: "{--", close: "--}", kind: "deletion", keep: "reject" },
  ] as const)("resolves a multiline $kind as one whole block group", (change) => {
    const input = `Introduction.\n\n${change.open}${original}${change.close}${metadata}\n\nConclusion.\n`;
    for (const decision of ["accept", "reject"] as const) {
      const parsed = criticMarkdownToEditorState(input);
      const editor = new Editor({
        extensions: createEditorExtensions(""),
        content: parsed.doc,
      });
      try {
        if (decision === "accept") editor.commands.acceptCriticChange("s24");
        else editor.commands.rejectCriticChange("s24");
        const output = editorStateToCriticMarkdown(
          editor.getJSON(),
          parsed.comments,
        );
        const reopened = rendered(output);
        const keeping = decision === change.keep;
        expect(reopened.changes.size).toBe(0);
        expect(textOf(reopened.element, "h2")).toEqual(
          keeping ? ["Original features"] : [],
        );
        expect(textOf(reopened.element, "li")).toEqual(
          keeping ? ["Original one", "Original two"] : [],
        );
        expect(reopened.element.textContent).toContain("Introduction.");
        expect(reopened.element.textContent).toContain("Conclusion.");
        expect(output).not.toMatch(/\{\+\+|\+\+\}|\{--|--\}|s24/);
      } finally {
        editor.destroy();
      }
    }
  });

  it("preserves an attached suggestion reply and its nested reply on save/reopen", () => {
    const input = `${substitution}{>>Why these changes?<<}{id="c1" by="Nora" at="${at}" re="s24"}{>>They match the new setup.<<}{id="c2" by="AI" at="${at}" re="c1"}\n`;
    const parsed = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);
    const reopened = criticMarkdownToEditorState(output);

    expect(reopened.comments.get("c1")).toMatchObject({
      content: "Why these changes?",
      authorId: "Nora",
      parentCommentId: "s24",
      createdAt: at,
    });
    expect(reopened.comments.get("c2")).toMatchObject({
      content: "They match the new setup.",
      authorType: "ai",
      parentCommentId: "c1",
    });
    expect(output.match(/Why these changes\?/g)).toHaveLength(1);
    expect(output.match(/They match the new setup\./g)).toHaveLength(1);
  });

  it("preserves YAML-backed suggestion metadata and replies on save/reopen", () => {
    const input = [
      `{~~${original}~>${replacement}~~}{#s24}`,
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Why these changes?",
      "    by: Nora",
      `    at: "${at}"`,
      "    re: s24",
      "suggestions:",
      "  s24:",
      "    by: AI",
      `    at: "${at}"`,
      "",
    ].join("\n");
    const parsed = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);
    const reopened = rendered(output);

    expect(output.match(/\{#s24\}/g)).toHaveLength(1);
    expect(reopened.changes.get("s24")).toMatchObject({
      authorType: "ai",
      createdAt: at,
    });
    expect(reopened.comments.get("c1")).toMatchObject({
      content: "Why these changes?",
      parentCommentId: "s24",
      authorId: "Nora",
    });
    expect(textOf(reopened.element, "h2")).toEqual([
      "Original features",
      "Proposed features",
    ]);
  });

  it("keeps multiline suggestion examples literal inside fenced code", () => {
    const example = `{~~First paragraph.\n\nSecond paragraph.~>New first paragraph.\n\nNew second paragraph.~~}${metadata}`;
    const input = `\`\`\`md\n${example}\n\`\`\`\n`;
    const parsed = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);
    const reopened = rendered(output);

    expect(criticMarkdownHasReviewRail(input)).toBe(false);
    expect(reopened.changes.size).toBe(0);
    expect(reopened.comments.size).toBe(0);
    expect(textOf(reopened.element, "pre code")).toEqual([example]);
    expect(reopened.element.querySelectorAll("h2, ul")).toHaveLength(0); // selector-check-ignore: actual Markdown block semantics are the behavior under test.
    expect(output).toBe(input);
  });

  it.each([
    { label: "same line", code: `{++first line\nsecond line++}${metadata}` },
    {
      label: "a subsequent line",
      code: `Literal example:\n{++first line\nsecond line++}${metadata}`,
    },
  ])("keeps a multiline suggestion example literal in an inline code span starting on $label", ({
    code,
  }) => {
    const input = `Use \`${code}\` as an example.\n`;
    const { element, changes } = rendered(input);
    const expectedCode = code.replaceAll("\n", " ");

    expect(criticMarkdownHasReviewRail(input)).toBe(false);
    expect(changes.size).toBe(0);
    expect(textOf(element, "code")).toEqual([expectedCode]);
    expect(element.textContent).toBe(`Use ${expectedCode} as an example.\n`);
  });
  describe.each([
    {
      ending: "paragraph",
      old: "Original first paragraph.\n\nOriginal final paragraph.",
      next: "Proposed first paragraph.\n\nProposed final paragraph.",
    },
    {
      ending: "list item",
      old: original,
      next: replacement,
    },
  ])("suggestion with a partial first paragraph and final $ending", (fixture) => {
    const lead = "Unchanged lead ";
    const tail = " unchanged tail.";
    const input = `${lead}{~~${fixture.old}~>${fixture.next}~~}${metadata}${tail}\n\nNext block.\n`;

    it("parses and reopens without exposing markers or moving unchanged text into the suggestion", () => {
      const parsed = criticMarkdownToEditorState(input);
      const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);

      for (const markdown of [input, output]) {
        const { element, changes } = rendered(markdown);
        expect(changes.size).toBe(1);
        expect(changes.has("s24")).toBe(true);
        expect(element.textContent).not.toMatch(/\{~~|~>|~~\}|id="s24"/);
        expect(element.textContent?.match(/Unchanged lead/g)).toHaveLength(1);
        expect(element.textContent?.match(/unchanged tail\./g)).toHaveLength(1);
        expect(element.textContent).toContain("Original first paragraph.");
        expect(element.textContent).toContain("Proposed first paragraph.");
      }
      expect(output.startsWith(`${lead}{~~`)).toBe(true);
      expect(output).toContain(`~~}${metadata}${tail}`);
      expect(output.match(/\{~~/g)).toHaveLength(1);
    });

    it.each([
      "accept",
      "reject",
    ] as const)("%s joins the unchanged prefix and suffix to the chosen first and last blocks", (decision) => {
      const parsed = criticMarkdownToEditorState(input);
      const editor = new Editor({
        extensions: createEditorExtensions(""),
        content: parsed.doc,
      });
      try {
        expect(
          decision === "accept"
            ? editor.commands.acceptCriticChange("s24")
            : editor.commands.rejectCriticChange("s24"),
        ).toBe(true);
        const output = editorStateToCriticMarkdown(
          editor.getJSON(),
          parsed.comments,
        );
        const { element, changes } = rendered(output);
        const chosen = decision === "accept" ? "Proposed" : "Original";

        expect(changes.size).toBe(0);
        expect(output).not.toMatch(/\{~~|~>|~~\}|s24/);
        expect(paragraphsOutsideLists(element)).toEqual(
          fixture.ending === "paragraph"
            ? [
                `${lead}${chosen} first paragraph.`,
                `${chosen} final paragraph.${tail}`,
                "Next block.",
              ]
            : [
                `${lead}${chosen} first paragraph.`,
                `${chosen} second paragraph.`,
                "Next block.",
              ],
        );
        expect(textOf(element, "li")).toEqual(
          fixture.ending === "list item"
            ? [`${chosen} one`, `${chosen} two${tail}`]
            : [],
        );
      } finally {
        editor.destroy();
      }
    });
  });
});
