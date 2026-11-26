import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { expect, test, vi } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { editableMarkdownOptions } from "./revision-markdown";
import { serializeRevisionNode } from "./revision-review-cache";
import { RevisionSource } from "./revision-source";

const schema = getSchema([...createEditorExtensions(""), RevisionSource]);

test("unsubmitted empty comment targets stay out of serialized review drafts", () => {
  const source =
    "A {==private anchor==}{>>Pending root<<}{#c1}.\n\nAn {++addition++}{#s1}.\n\n---\ncomments:\n  c2:\n    body: Pending reply\n    re: s1\n";
  const value = parsed(source);
  const comments = new Map(
    [...value.comments].map(([id, comment]) => [
      id,
      { ...comment, content: "" },
    ]),
  );
  const serialized = serializeRevisionNode(
    value.node,
    comments,
    value.options,
    new Set(["c1", "c2"]),
  );
  expect(serialized).not.toContain("{#c1}");
  expect(serialized).not.toContain("c2:");
  expect(serialized).toContain("A private anchor.");
  expect(serialized).toContain("{++addition++}{#s1}");
  expect(comments.size).toBe(2);
  const legacy = serializeRevisionNode(value.node, comments, value.options);
  expect(legacy).toContain("{#c1}");
  expect(legacy).toContain("c2:");
  const saved = new Map(comments);
  const root = saved.get("c1");
  if (!root) throw new Error("Missing private root fixture");
  saved.set("c1", { ...root, content: "Submitted exactly once" });
  const published = serializeRevisionNode(
    value.node,
    saved,
    value.options,
    new Set(["c1", "c2"]),
  );
  expect(
    extractRoughdraftReviewIndex(published).items.filter(
      (item) => item.id === "c1",
    ),
  ).toHaveLength(1);
  expect(published).toContain("Submitted exactly once");
  expect(published).not.toContain("c2:");
});

test("excluding a known private target preserves legacy blanks and literal identity examples", () => {
  const value = parsed(
    "A {==private==}{>>Draft<<}{#c1} and {==legacy==}{>>Empty saved thread<<}{#c2}.\n\nLiteral `{>>example<<}{#c1}` stays code.\n",
  );
  const comments = new Map(
    [...value.comments].map(([id, comment]) => [
      id,
      { ...comment, content: "" },
    ]),
  );
  const next = serializeRevisionNode(
    value.node,
    comments,
    value.options,
    new Set(["c1"]),
  );
  expect(next).toContain("{==legacy==}{>><<}");
  expect(next).toContain("`{>>example<<}{#c1}`");
  expect(
    extractRoughdraftReviewIndex(next).items.map((item) => item.id),
  ).toEqual(["c2"]);
});
function parsed(markdown: string) {
  const result = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  return {
    ...result,
    node: schema.nodeFromJSON(result.doc),
    options: { frontmatter: result.frontmatter, endmatter: result.endmatter },
  };
}
test.each([
  "Plain.\n\n# Heading\n\n- One\n- Two\n",
  "{==A **formatted** comment==}{>>Note<<}{#c1}\n\nMiddle.\n\n{==Same thread==}{>>Note<<}{#c1}\n",
  "Lead {~~old\n\nparagraph~>new\n\nparagraph~~}{#s1} tail.\n\nUntouched.\n",
  "```yaml\n---\nkey: value\n```\n\n---\n",
  "Notes[^a].\n\n[^a]: First paragraph.\n\n    Second paragraph.\n",
])("cached review serialization preserves full codec output for %s", (markdown) => {
  const value = parsed(markdown);
  expect(serializeRevisionNode(value.node, value.comments, value.options)).toBe(
    editorStateToCriticMarkdown(
      value.node.toJSON(),
      value.comments,
      value.options,
    ),
  );
});
test("one plain paragraph edit in a long annotated document serializes only the changed block", () => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const marker = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 750 },
    (_, index) =>
      `Unchanged paragraph ${index}. Keep the document and feedback readable.`,
  ).join("\n\n");
  const source = `${fixture.slice(0, marker)}\n\n${padding}\n${fixture.slice(marker)}`;
  const value = parsed(source);
  serializeRevisionNode(value.node, value.comments, value.options);
  const state = EditorState.create({ schema, doc: value.node });
  const changed = state.tr.insertText(" typed", state.doc.content.size - 1).doc;
  const spy = vi.spyOn(DOMSerializer.prototype, "serializeFragment");
  const output = serializeRevisionNode(changed, value.comments, value.options);
  const serialized = spy.mock.calls.reduce(
    (sum, [fragment]) => sum + fragment.size,
    0,
  );
  spy.mockRestore();
  expect(output).toBe(
    editorStateToCriticMarkdown(
      changed.toJSON(),
      value.comments,
      value.options,
    ),
  );
  expect(serialized).toBeLessThan(2000);
});

test.each([
  "{~~\n![old](old.png)\n~>\n![new](roughdraftplaceholder0z.png)\n~~}{#s1}\n\nLast.\n",
  "![image](roughdraftplaceholder1z.png)\n\n{++proposal++}{#s1}\n\nLast.\n",
  "{~~![old](old.png)~>![new](roughdraftplaceholder0z.png)~~}{#s1}\n\nLast.\n",
])("cache placeholders cannot rewrite a legitimate image destination in %s", (markdown) => {
  const value = parsed(markdown);
  expect(serializeRevisionNode(value.node, value.comments, value.options)).toBe(
    editorStateToCriticMarkdown(
      value.node.toJSON(),
      value.comments,
      value.options,
    ),
  );
});
