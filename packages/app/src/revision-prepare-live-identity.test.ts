import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { expect, test, vi } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import {
  cleanRevisionNode,
  projectCleanRevisionNode,
} from "./revision-clean-cache";
import {
  cleanRevisionSourceMarkdown,
  createSourceSpellingPreserver,
  editableMarkdownOptions,
} from "./revision-markdown";
import { prepareRevisionDraft } from "./revision-prepare";
import { projectAcceptedDocument } from "./revision-projection";
import { serializeRevisionNode } from "./revision-review-cache";
import { RevisionSource } from "./revision-source";
import { RevisionSpellingProof } from "./revision-spelling-proof";

vi.mock("./revision-projection", { spy: true });

test.each([
  "cold parser",
  "initialized editor",
] as const)("preparing a large candidate reuses the live editor's unchanged projection blocks (%s)", (phase) => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const endmatter = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 750 },
    (_, index) =>
      `Unchanged section ${index + 1}. This paragraph provides real reading distance while the two pages keep their independent edits and feedback.`,
  ).join("\n\n");
  const markdown = `${fixture.slice(0, endmatter)}\n\n${padding}\n\nPeer owner: unchanged.\n${fixture.slice(endmatter)}`;
  expect(Buffer.byteLength(markdown)).toBeGreaterThan(100 * 1024);
  const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  const doc = schema.nodeFromJSON({
    ...parsed.doc,
    attrs: {
      ...parsed.doc.attrs,
      sourceMetadata: {
        markdown,
        frontmatter: parsed.frontmatter,
        endmatter: parsed.endmatter,
      },
    },
  });
  const live = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 2),
  });
  const before = doc.toJSON();
  if (phase === "initialized editor") {
    const canonical = serializeRevisionNode(doc, parsed.comments, {
      frontmatter: parsed.frontmatter,
      endmatter: parsed.endmatter,
    });
    createSourceSpellingPreserver(markdown, canonical);
    new RevisionSpellingProof().matches(markdown, doc, live);
    new RevisionSpellingProof().matches(
      cleanRevisionSourceMarkdown(markdown),
      projectCleanRevisionNode(doc),
      live,
    );
  }
  cleanRevisionNode(doc);
  vi.mocked(projectAcceptedDocument).mockClear();
  const candidate = {
    markdown: markdown.replace(
      "Peer owner: unchanged.",
      "Peer owner: incoming edit.",
    ),
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: comment.parentCommentId ?? "document",
    })),
  };
  const started = performance.now();
  const prepared = prepareRevisionDraft(candidate, live);
  const durationMs = performance.now() - started;
  const projectedPositions = vi
    .mocked(projectAcceptedDocument)
    .mock.calls.reduce((total, [fragment]) => total + fragment.content.size, 0);
  process.stdout.write(
    `${JSON.stringify({
      severity: "info",
      event: "detached-candidate-live-cache",
      phase,
      bytes: Buffer.byteLength(markdown),
      durationMs,
      projectedPositions,
    })}\n`,
  );

  expect(prepared?.cleanMarkdown).toBe(
    cleanRevisionSourceMarkdown(candidate.markdown),
  );
  expect(prepared?.cleanMarkdown).toContain("Peer owner: incoming edit.");
  expect(prepared?.cleanMarkdown).not.toContain(
    "The release supports offline review",
  );
  expect(prepared?.reviewComments).toEqual(candidate.reviewComments);
  expect(live.doc).toBe(doc);
  expect(live.doc.toJSON()).toEqual(before);
  expect(live.selection.toJSON()).toEqual({ type: "text", anchor: 2, head: 2 });
  expect(projectedPositions).toBeLessThan(2000);
}, 15_000);
