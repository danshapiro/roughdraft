import { getSchema, type JSONContent } from "@tiptap/core";
import { TableMap } from "@tiptap/pm/tables";
import { describe, expect, it } from "vitest";
import { createEditorExtensions } from "./editor-extensions";
import { criticMarkdownToEditorState } from "./critic-markup";
import { diffRenderedComparison } from "./rendered-comparison-diff";

const change = {
  changeId: "persisted-group",
  kind: "substitution-old" as const,
  authorType: "ai" as const,
  createdAt: "2026-11-11T00:00:00Z",
};

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function nodes(content: JSONContent[]): JSONContent[] {
  return content.flatMap((node) => [node, ...nodes(node.content ?? [])]);
}

function markedText(content: JSONContent[]) {
  return nodes(content)
    .filter((node) => node.marks?.some((mark) => mark.type === "criticChange"))
    .map((node) => node.text);
}

function validDocument(content: JSONContent[]) {
  const doc = getSchema(createEditorExtensions("")).nodeFromJSON({
    type: "doc",
    content,
  });
  expect(() => doc.check()).not.toThrow();
  return doc;
}

function table(cellType = "tableHeader", cellAttrs = {}): JSONContent {
  return {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          { type: cellType, attrs: cellAttrs, content: [paragraph("First")] },
          { type: "tableHeader", content: [paragraph("Second")] },
        ],
      },
      {
        type: "tableRow",
        content: ["Keep left", "Keep right"].map((text, index) => ({
          type: "tableCell",
          ...(index === 0 ? { attrs: cellAttrs } : {}),
          content: [paragraph(text)],
        })),
      },
    ],
  };
}

describe("native rendered structure alignment", () => {
  it("measures note references as inline atoms when highlighting later inserted content", () => {
    const reference: JSONContent = {
      type: "endnoteReference",
      attrs: { label: "source", number: 1, occurrence: 1 },
    };
    const before: JSONContent = {
      type: "paragraph",
      content: [
        { type: "text", text: "See" },
        reference,
        { type: "text", text: " context" },
      ],
    };
    const after: JSONContent = {
      ...before,
      content: [
        { type: "text", text: "See" },
        reference,
        { type: "hardBreak" },
        { type: "text", text: " context" },
      ],
    };
    const result = diffRenderedComparison([before], [after], change);
    const doc = validDocument(result.content);
    const breakPosition: number[] = [];
    doc.descendants((node, position) => {
      if (node.type.name === "hardBreak") breakPosition.push(position);
    });
    expect(result.blockHighlights).toEqual([
      {
        from: breakPosition[0],
        to: breakPosition[0] + 1,
        kind: "addition",
        changeId: change.changeId,
      },
    ]);
  });

  it("describes changed note references and preserves their separate identity", () => {
    const previous: JSONContent = {
      type: "paragraph",
      content: [
        { type: "text", text: "See" },
        {
          type: "endnoteReference",
          attrs: { label: "old", number: 1, occurrence: 1 },
        },
      ],
    };
    const next: JSONContent = {
      type: "paragraph",
      content: [
        { type: "text", text: "See" },
        {
          type: "endnoteReference",
          attrs: { label: "new", number: 2, occurrence: 1 },
        },
      ],
    };
    const result = diffRenderedComparison([previous], [next], change);
    expect(
      nodes(result.content)
        .filter((node) => node.type === "endnoteReference")
        .map((node) => node.attrs?.label),
    ).toEqual(["old", "new"]);
    expect(result.oldText).toContain("Endnote 1");
    expect(result.newText).toContain("Endnote 2");
    const doc = validDocument(result.content);
    for (const highlight of result.blockHighlights)
      expect(doc.nodeAt(highlight.from)?.type.name).toBe("endnoteReference");
  });

  it("diffs note-body prose without exposing serialized rendering metadata", () => {
    const parse = (word: string) =>
      criticMarkdownToEditorState(
        `Text[^source].\n\n[^source]: The ${word} note.\n`,
      ).doc.content ?? [];
    const result = diffRenderedComparison(parse("old"), parse("new"), change);
    expect(markedText(result.content)).toEqual(["old", "new"]);
    expect(result.oldText).toBe("old");
    expect(result.newText).toBe("new");
    expect(
      nodes(result.content).filter((node) => node.type === "endnoteDefinition"),
    ).toHaveLength(1);
    validDocument(result.content);
  });

  it("keeps one definition per label when replacing all of its prose", () => {
    const parse = (label: string, body: string) =>
      criticMarkdownToEditorState(`[^${label}]: ${body}\n`).doc.content ?? [];
    const result = diffRenderedComparison(
      parse("source", "Almonds bananas cherries."),
      parse("source", "Doors windows roofs."),
      change,
    );
    expect(
      nodes(result.content).filter((node) => node.type === "endnoteDefinition"),
    ).toHaveLength(1);
    const projection = (excluded: string[]) =>
      nodes(result.content)
        .filter(
          (node) =>
            node.type === "text" &&
            !node.marks?.some(
              (mark) =>
                mark.type === "criticChange" &&
                excluded.includes(mark.attrs?.kind),
            ),
        )
        .map((node) => node.text)
        .join("");
    expect(projection(["addition", "substitution-new"])).toBe(
      "Almonds bananas cherries.",
    );
    expect(projection(["deletion", "substitution-old"])).toBe(
      "Doors windows roofs.",
    );
    validDocument(result.content);
    const relabeled = diffRenderedComparison(
      parse("old", "Same note."),
      parse("new", "Same note."),
      change,
    );
    expect(
      nodes(relabeled.content)
        .filter((node) => node.type === "endnoteDefinition")
        .map((node) => node.attrs?.label),
    ).toEqual(["old", "new"]);
    validDocument(relabeled.content);
  });

  it("merges a changed paragraph when another paragraph is inserted beside it", () => {
    const result = diffRenderedComparison(
      [paragraph("Please read old guidance before starting.")],
      [
        paragraph("Please read new guidance before starting."),
        paragraph("An additional note."),
      ],
      change,
    );
    expect(result.content).toHaveLength(2);
    expect(markedText(result.content)).toEqual([
      "old",
      "new",
      "An additional note.",
    ]);
    const doc = validDocument(result.content);
    expect(result.blockHighlights).toEqual([
      {
        from: doc.child(0).nodeSize,
        to: doc.content.size,
        kind: "addition",
        changeId: change.changeId,
      },
    ]);
  });

  it("keeps list insertion and deletion inside one valid list", () => {
    const list = (items: string[]): JSONContent => ({
      type: "bulletList",
      content: items.map((item) => ({
        type: "listItem",
        content: [paragraph(item)],
      })),
    });
    const result = diffRenderedComparison(
      [list(["Keep first", "Remove middle", "Keep last"])],
      [list(["Keep first", "Keep last", "Add final"])],
      change,
    );
    expect(result.content).toHaveLength(1);
    expect(
      nodes(result.content).filter((node) => node.type === "listItem"),
    ).toHaveLength(4);
    expect(markedText(result.content)).toEqual(["Remove middle", "Add final"]);
    expect(result.oldText).toBe("Remove middle");
    expect(result.newText).toBe("Add final");
    validDocument(result.content);
  });

  it("keeps repeated unchanged words unmarked", () => {
    const result = diffRenderedComparison(
      [paragraph("test test old test test")],
      [paragraph("test test new test test")],
      change,
    );
    expect(markedText(result.content)).toEqual(["old", "new"]);
    expect(validDocument(result.content).textContent).toBe(
      "test test oldnew test test",
    );
    expect(result.blockHighlights).toEqual([]);
  });

  it("preserves the navigation decoration for an inserted hard break", () => {
    const result = diffRenderedComparison(
      [paragraph("Keep context")],
      [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Keep" },
            { type: "hardBreak" },
            { type: "text", text: " context" },
          ],
        },
      ],
      change,
    );
    expect(result.content).toHaveLength(1);
    expect(markedText(result.content)).toEqual([]);
    expect(result.blockHighlights).toEqual([
      { from: 5, to: 6, kind: "addition", changeId: change.changeId },
    ]);
    expect(result.newText).toMatch(/break/i);
    validDocument(result.content);
  });

  it("describes a changed code language while keeping its unchanged text single", () => {
    const result = diffRenderedComparison(
      [
        {
          type: "codeBlock",
          attrs: { language: "js" },
          content: [{ type: "text", text: "run()" }],
        },
      ],
      [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "run()" }],
        },
      ],
      change,
    );
    expect(result.content).toHaveLength(1);
    expect(markedText(result.content)).toEqual([]);
    expect(result.oldText).toContain('language="js"');
    expect(result.newText).toContain('language="ts"');
    expect(result.blockHighlights).toHaveLength(1);
    expect(validDocument(result.content).textContent).toBe("run()");
  });

  it("retains complete unrelated replacement paragraphs", () => {
    const result = diffRenderedComparison(
      [paragraph("Almonds bananas cherries.")],
      [paragraph("Doors windows roofs.")],
      change,
    );
    expect(result.content).toHaveLength(2);
    expect(markedText(result.content)).toEqual([
      "Almonds bananas cherries.",
      "Doors windows roofs.",
    ]);
    expect(result.blockHighlights).toHaveLength(2);
    validDocument(result.content);
  });

  it("keeps complete tables when a header changes to a normal cell", () => {
    const result = diffRenderedComparison(
      [table()],
      [table("tableCell")],
      change,
    );
    expect(result.content).toHaveLength(2);
    const doc = validDocument(result.content);
    doc.forEach((node) => {
      const map = TableMap.get(node);
      expect(map.problems).toBeNull();
      expect(map.width).toBe(2);
    });
    expect(result.blockHighlights).toHaveLength(2);
  });

  it("keeps cell attribute alternatives in separate coherent table grids", () => {
    const result = diffRenderedComparison(
      [table("tableHeader", { colwidth: [120] })],
      [table("tableHeader", { colwidth: [240] })],
      change,
    );
    expect(result.content).toHaveLength(2);
    const doc = validDocument(result.content);
    expect(doc.child(0).firstChild?.firstChild?.attrs.colwidth).toEqual([120]);
    expect(doc.child(1).firstChild?.firstChild?.attrs.colwidth).toEqual([240]);
    expect(result.oldText).toContain("120");
    expect(result.newText).toContain("240");
    doc.forEach((node) => {
      expect(TableMap.get(node).problems).toBeNull();
    });
  });

  it("keeps inserted columns in complete before and after table grids", () => {
    const previous = table();
    const next = table();
    for (const row of next.content ?? [])
      row.content?.push({
        type: "tableCell",
        content: [paragraph("Added column")],
      });
    const result = diffRenderedComparison([previous], [next], change);
    expect(result.content).toHaveLength(2);
    const doc = validDocument(result.content);
    expect(TableMap.get(doc.child(0)).width).toBe(2);
    expect(TableMap.get(doc.child(1)).width).toBe(3);
    doc.forEach((node) => {
      expect(TableMap.get(node).problems).toBeNull();
    });
  });
});
