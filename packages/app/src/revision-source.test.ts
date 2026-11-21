import { getSchema } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import {
  replaceRevisionSource,
  RevisionSource,
  revisionSourceMetadata,
  mergeSourceHistoryComments,
  sameSourceContent,
} from "./revision-source";

function sourceState(markdown: string) {
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const parsed = criticMarkdownToEditorState(markdown);
  return EditorState.create({
    schema,
    doc: schema.nodeFromJSON({
      ...parsed.doc,
      attrs: {
        sourceMetadata: {
          markdown,
          frontmatter: parsed.frontmatter,
          endmatter: parsed.endmatter,
        },
      },
    }),
    plugins: [history()],
  });
}

test("source history preserves later replies and later edits to an existing comment", () => {
  const original = {
    id: "c1",
    content: "Original",
    createdAt: "2026-01-01T00:00:00.000Z",
    authorType: "user" as const,
  };
  const sourceEdit = { ...original, content: "Source edit" };
  const reply = {
    ...original,
    id: "c2",
    content: "Later reply",
    parentCommentId: "c1",
  };
  const current = new Map([
    ["c1", sourceEdit],
    ["c2", reply],
  ]);
  const undone = mergeSourceHistoryComments([sourceEdit], [original], current);
  expect(undone.get("c1")?.content).toBe("Original");
  expect(undone.get("c2")).toEqual(reply);
  current.set("c1", { ...original, content: "Later UI edit" });
  expect(
    mergeSourceHistoryComments([sourceEdit], [original], current).get("c1")
      ?.content,
  ).toBe("Later UI edit");
  expect(
    mergeSourceHistoryComments(
      [original],
      [],
      new Map([
        ["c1", original],
        ["c2", reply],
      ]),
    ).has("c1"),
  ).toBe(true);
});

test("a final typing paragraph does not prevent restoring exact list source", () => {
  const state = sourceState("* item\n");
  const withTypingLine = state.tr.insert(
    state.doc.content.size,
    state.schema.nodes.paragraph.create(),
  ).doc;
  expect(sameSourceContent(state.doc, withTypingLine)).toBe(true);
  expect(
    sameSourceContent(sourceState("* different\n").doc, withTypingLine),
  ).toBe(false);
});

test("editing a source passage retains mapped positions in surrounding unchanged text", () => {
  const original =
    "First unchanged.\n\nEdit this paragraph.\n\nLast unchanged.\n";
  const state = sourceState(original);
  const lastParagraph =
    state.doc.content.size - (state.doc.lastChild?.nodeSize ?? 0);
  const update = replaceRevisionSource(
    state,
    original.replace("this", "only this"),
  );
  const next = state.apply(update.transaction);
  expect(next.doc.textContent).toContain("Edit only this paragraph.");
  expect(update.transaction.mapping.map(1)).toBe(1);
  expect(update.transaction.mapping.map(lastParagraph)).toBe(lastParagraph + 5);
});

test("source-only YAML changes and exact source spelling participate in undo and redo", () => {
  const original = "---\ntitle: Original\n---\n\nA paragraph.\n";
  const changed = "---\ntitle: Revised\n---\n\nA paragraph.\n";
  let state = sourceState(original);
  state = state.apply(replaceRevisionSource(state, changed).transaction);
  expect(revisionSourceMetadata(state.doc)?.markdown).toBe(changed);
  expect(revisionSourceMetadata(state.doc)?.frontmatter).toContain("Revised");
  expect(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  ).toBe(true);
  expect(revisionSourceMetadata(state.doc)?.markdown).toBe(original);
  expect(revisionSourceMetadata(state.doc)?.frontmatter).toContain("Original");
  expect(
    redo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  ).toBe(true);
  expect(revisionSourceMetadata(state.doc)?.markdown).toBe(changed);
});

test("typing beside a suggestion does not replace its generated creation date", () => {
  const original = "Use {~~old~>new~~} wording.\n";
  const state = sourceState(original);
  const changes = (doc: typeof state.doc) => {
    const dates: string[] = [];
    doc.descendants((node) => {
      for (const mark of node.marks) {
        if (mark.type.name === "criticChange") dates.push(mark.attrs.createdAt);
      }
    });
    return dates;
  };
  const before = changes(state.doc);
  const next = state.apply(
    replaceRevisionSource(state, `${original}\nMore text.`).transaction,
  );
  expect(before.length).toBeGreaterThan(0);
  expect(changes(next.doc)).toEqual(before);
});
