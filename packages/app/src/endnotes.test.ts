import { generateHTML } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { toHtml, toMarkdown } from "./markdown";

const definition =
  "[^source]: A **clear** note with [Next](./Next.md).\n\n    A second paragraph.\n";
const markdown =
  "Body[^source] and again[^source]. `[^literal]` and \\[^escaped].\n\n" +
  definition;

describe("Markdown endnotes", () => {
  it("renders repeated references and formatted paragraphs while keeping code and escapes literal", () => {
    const element = document.createElement("div");
    element.innerHTML = toHtml(markdown);
    expect(element.querySelectorAll("a[data-endnote-ref]")).toHaveLength(2); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    const definitions = element.querySelectorAll("[data-endnote-definition]"); // selector-check-ignore: semantic output
    expect(definitions).toHaveLength(1);
    const boldNote = element.querySelector(".endnote-body strong"); // selector-check-ignore: semantic output
    expect(boldNote?.textContent).toBe("clear");
    expect(element.querySelectorAll(".endnote-body p")).toHaveLength(2); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    expect(element.querySelector("code")?.textContent).toBe("[^literal]"); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    expect(
      element.querySelector(".endnote-backlink")?.getAttribute("href"), // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    ).toBe(`#${element.querySelector("a[data-endnote-ref]")?.id}`); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
  });

  it("preserves original definitions and references through the actual editor schema", () => {
    const parsed = criticMarkdownToEditorState(markdown);
    const saved = editorStateToCriticMarkdown(parsed.doc, parsed.comments);
    expect(saved).toContain(definition);
    expect(saved.match(/\[\^source\](?!:)/g)).toHaveLength(2);
    expect(saved).toContain("`[^literal]`");
    expect(saved).not.toContain("endnote-");
    const html = generateHTML(parsed.doc, createEditorExtensions(""));
    expect(html).toContain('aria-label="Endnote 1"');
    expect(html).toContain('class="endnote-body"');
  });

  it("serializes edits to an endnote body as a multiline Markdown definition", () => {
    const element = document.createElement("div");
    element.innerHTML = toHtml(markdown);
    const strong = element.querySelector(".endnote-body strong"); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    if (!strong) throw new Error("Expected formatted note body");
    strong.textContent = "edited";
    const saved = toMarkdown(element.innerHTML);
    expect(saved).toContain(
      "[^source]: A **edited** note with [Next](./Next.md).",
    );
    expect(saved).toContain("    A second paragraph.");
    expect(saved.match(/\[\^source\]:/g)).toHaveLength(1);
  });

  it("keeps undefined notes and fenced samples literal and resolves Unicode labels safely", () => {
    const element = document.createElement("div");
    element.innerHTML = toHtml(
      "Undefined[^missing].\n\n```md\n[^code]: literal\n```\n\nNamed[^café].\n\n[^café]: Note.\n",
    );
    expect(element.querySelectorAll("a[data-endnote-ref]")).toHaveLength(1); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    expect(element.textContent).toContain("Undefined[^missing]");
    const code = element.querySelector("code"); // selector-check-ignore: literal code output
    expect(code?.textContent).toContain("[^code]: literal");
    const href = element
      .querySelector("a[data-endnote-ref]") // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
      ?.getAttribute("href");
    if (!href) throw new Error("Expected an endnote destination");
    expect(element.querySelector(href)).not.toBeNull(); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    expect(toMarkdown(element.innerHTML)).toContain("[^café]: Note.");
  });

  it("numbers defined notes by reference order without counting missing notes", () => {
    const element = document.createElement("div");
    element.innerHTML = toHtml(
      "Missing[^missing]. First[^second], then[^first], repeated[^second].\n\n[^first]: First definition.\n[^second]: Second definition.\n",
    );
    expect(
      Array.from(
        element.querySelectorAll("[data-endnote-ref]"), // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
        (node) => node.textContent,
      ),
    ).toEqual(["1", "2", "1"]);
    expect(
      element
        .querySelector('[data-endnote-definition="first"]') // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
        ?.getAttribute("data-endnote-number"),
    ).toBe("2");
    expect(
      element
        .querySelector('[data-endnote-definition="second"]') // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
        ?.getAttribute("data-endnote-number"),
    ).toBe("1");
  });

  it("preserves multiline notes with lists, CRLF input, case-insensitive labels and defined-before-use notes", () => {
    const input =
      "[^Evidence]: A **useful** note.\r\n\r\n    - One\r\n    - Two\r\n\r\nBody[^evidence].\r\n";
    const parsed = criticMarkdownToEditorState(input);
    const element = document.createElement("div");
    element.innerHTML = generateHTML(parsed.doc, createEditorExtensions(""));
    expect(element.querySelector("[data-endnote-ref]")?.textContent).toBe("1"); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    expect(element.querySelectorAll(".endnote-body li")).toHaveLength(2); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
    const saved = editorStateToCriticMarkdown(parsed.doc, parsed.comments);
    expect(saved).toContain("[^Evidence]: A **useful** note.");
    expect(saved).toContain("    - One");
    expect(saved).toContain("Body[^evidence].");
  });
});
