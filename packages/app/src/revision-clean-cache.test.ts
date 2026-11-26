import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test, vi } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import {
  cleanRevisionNode,
  cleanSourceFromNode,
  projectCleanRevisionNode,
} from "./revision-clean-cache";
import {
  cleanRevisionDocument,
  cleanRevisionSourceMarkdown,
  editableMarkdownOptions,
} from "./revision-markdown";
import { projectAcceptedDocument } from "./revision-projection";
import { RevisionSource } from "./revision-source";

const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
vi.mock("./revision-projection", { spy: true });
function doc(markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  return schema.nodeFromJSON({
    ...parsed.doc,
    attrs: {
      sourceMetadata: {
        markdown,
        frontmatter: parsed.frontmatter,
        endmatter: parsed.endmatter,
      },
    },
  });
}

test.each([
  "First paragraph.\n\nSecond paragraph.\n",
  "# Heading\n\n- First\n- Second\n\n```text\nalpha\n\n```\n",
  "Lead {~~old\n\nparagraph~>new\n\nparagraph~~}{#s1} tail.\n\nUntouched.\n",
  "---\ntitle: Review\n---\n\n{==Anchor==}{>>Comment.<<}{#c1}\n\n---\ncomments:\n  c1:\n    by: user\n    at: 2026-01-01T00:00:00.000Z\nother: preserved\n",
])("block-cached clean projection matches the complete editor projection for %s", (markdown) => {
  const current = doc(markdown);
  expect(cleanRevisionNode(current)).toBe(
    cleanRevisionDocument(current.toJSON()),
  );
  expect(
    projectCleanRevisionNode(current).content.eq(
      projectAcceptedDocument(current).doc.content,
    ),
  ).toBe(true);
});

test("the maintained complex review has the same block-cached accepted projection", () => {
  const markdown = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const current = doc(markdown);
  expect(cleanRevisionNode(current)).toBe(
    cleanRevisionDocument(current.toJSON()),
  );
  expect(
    projectCleanRevisionNode(current).content.eq(
      projectAcceptedDocument(current).doc.content,
    ),
  ).toBe(true);
});

test("typing in a long annotated review projects only its changed model fragment", () => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const endmatter = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 750 },
    (_, index) => `Unchanged paragraph ${index + 1}.`,
  ).join("\n\n");
  const markdown = `${fixture.slice(0, endmatter)}\n\n${padding}\n\nLive owner A: unchanged.\n${fixture.slice(endmatter)}`;
  const current = doc(markdown);
  cleanRevisionNode(current);
  projectCleanRevisionNode(current);
  const state = EditorState.create({ doc: current });
  let at = -1;
  current.descendants((node, pos) => {
    if (
      node.type.name === "paragraph" &&
      node.textContent.startsWith("Live owner A:")
    )
      at = pos + node.nodeSize - 1;
  });
  expect(at).toBeGreaterThan(0);
  const next = state.apply(state.tr.insertText(" Local typing", at)).doc;
  vi.mocked(projectAcceptedDocument).mockClear();
  const projected = projectCleanRevisionNode(next);
  expect(
    vi
      .mocked(projectAcceptedDocument)
      .mock.calls.every(([fragment]) => fragment.content.size < 1000),
  ).toBe(true);
  expect(projected.content.eq(projectAcceptedDocument(next).doc.content)).toBe(
    true,
  );
});

test("the existing model projects source spelling identically to reparsing the complex fixture", () => {
  const markdown = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const current = doc(markdown);
  expect(
    cleanSourceFromNode(
      markdown,
      current,
      criticMarkdownToEditorState(markdown, editableMarkdownOptions).comments,
    ),
  ).toBe(cleanRevisionSourceMarkdown(markdown));
});
