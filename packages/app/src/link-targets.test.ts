import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createEditorExtensions } from "./editor-extensions";

describe("managed link targets", () => {
  it("keeps keyboard links stable without spontaneous edits or DOM replacement", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    let updates = 0;
    const editor = new Editor({
      element,
      extensions: createEditorExtensions(""),
      content: '<h2>Details</h2><p><a href="/?path=Next.md">Next</a></p>',
      onUpdate: () => {
        updates++;
      },
    });
    try {
      const link = editor.view.dom.querySelector("a"); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
      if (!link) throw new Error("The editor must render its link");
      const before = editor.getJSON();
      expect(link.tabIndex).toBe(0);
      editor.commands.setTextSelection(3);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(editor.view.dom.querySelector("a")).toBe(link); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
      expect(link.isConnected).toBe(true);
      expect(link.tabIndex).toBe(0);
      expect(editor.view.dom.querySelector("h2")?.id).toBe("details"); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
      expect(editor.getJSON()).toEqual(before);
      expect(updates).toBe(0);
    } finally {
      editor.destroy();
      element.remove();
    }
  });

  it("updates unique heading targets after silent comparison replacements without saving them", () => {
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: "<h2>Before</h2>",
    });
    try {
      editor.commands.setContent(
        '<h2>Details</h2><h2>Details</h2><h2>Details-1</h2><p><a href="#details">Section</a></p>',
        { emitUpdate: false },
      );
      const headings = [...editor.view.dom.querySelectorAll("h2")]; // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
      expect(headings.map((heading) => heading.id)).toEqual([
        "details",
        "details-1",
        "details-1-1",
      ]);
      expect(editor.view.dom.querySelector("a")?.tabIndex).toBe(0); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
      expect(editor.getHTML()).not.toContain('id="details');
    } finally {
      editor.destroy();
    }
  });
});
