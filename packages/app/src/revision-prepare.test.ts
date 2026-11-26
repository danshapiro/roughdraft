import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import {
  cleanRevisionSourceMarkdown,
  editableMarkdownOptions,
} from "./revision-markdown";
import { prepareRevisionDraft } from "./revision-prepare";
import type { RevisionDraft } from "./revision-session";
import { RevisionSource } from "./revision-source";

const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
test("detached preparation projects the complete annotated candidate without reflecting it into newer editor input", () => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const parsed = criticMarkdownToEditorState(fixture, editableMarkdownOptions);
  const original = schema.nodeFromJSON(parsed.doc);
  const live = EditorState.create({
    doc: original,
    selection: TextSelection.create(original, 2),
  });
  const tr = live.tr.insertText("Buffered newer typing ", 2);
  tr.setSelection(TextSelection.create(tr.doc, 5));
  const newer = live.apply(tr);
  const candidate: RevisionDraft = {
    markdown: fixture.replace("planting schedule", "candidate schedule"),
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: "document",
    })),
    reviewed: [],
  };
  const before = structuredClone(candidate);
  const liveDoc = newer.doc;
  const selection = newer.selection.toJSON();
  const prepared = prepareRevisionDraft(candidate, newer);
  expect(prepared?.markdown).toBe(candidate.markdown);
  expect(prepared?.cleanMarkdown).toBe(
    cleanRevisionSourceMarkdown(candidate.markdown),
  );
  expect(prepared?.cleanMarkdown).toContain("candidate schedule");
  expect(prepared?.cleanMarkdown).not.toContain("Buffered newer typing");
  expect(prepared?.reviewComments).toEqual(candidate.reviewComments);
  expect(candidate).toEqual(before);
  expect(newer.doc).toBe(liveDoc);
  expect(newer.selection.toJSON()).toEqual(selection);
});

test("detached preparation recomputes the candidate projection and retains metadata and source link bytes", () => {
  const markdown =
    '---\r\ntitle: Exact\r\n---\r\n\r\nAn {~~old~>new~~}{#s1} [image guide](./linked%20document.md).\r\n\r\n---\r\nsuggestions:\r\n  s1:\r\n    by: AI\r\n    at: "2026-11-26T12:00:00.000Z"\r\n';
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  const state = EditorState.create({ doc: schema.nodeFromJSON(parsed.doc) });
  const prepared = prepareRevisionDraft(
    {
      markdown,
      cleanMarkdown: "Incorrect earlier projection",
      decisions: {},
      reviewComments: [],
    },
    state,
  );
  expect(prepared?.cleanMarkdown).toBe(cleanRevisionSourceMarkdown(markdown));
  expect(prepared?.cleanMarkdown).toContain("title: Exact");
  expect(prepared?.cleanMarkdown).toContain(
    "[image guide](./linked%20document.md)",
  );
  expect(prepared?.cleanMarkdown).not.toContain("{~~");
});
