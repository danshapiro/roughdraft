import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { describe, expect, test } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  createCriticComment,
  createCriticChange,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { cleanRevisionDocument } from "./revision-markdown";
import { structuralSuggestion } from "./structural-suggestions";
import { applySuggestionDecisions } from "./review-decisions";
import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
} from "@roughdraft/rfm";

const schema = getSchema(createEditorExtensions(""));
function parse(source: string) {
  const parsed = criticMarkdownToEditorState(source);
  return { ...parsed, node: schema.nodeFromJSON(parsed.doc) };
}

describe("frontmatter uses the document editing surface", () => {
  test("frontmatter is selectable document text and edits share document undo", () => {
    const original =
      "---\r\ntitle: Original\r\nlabels: [one, two]\r\n---\r\n\r\nBody.\n";
    const parsed = parse(original);
    expect(parsed.node.firstChild?.type.name).toBe("yamlFrontmatter");
    expect(parsed.node.textContent).toContain("title: Original");
    let state = EditorState.create({ doc: parsed.node, plugins: [history()] });
    const at = state.doc.textContent.indexOf("Original") + 1;
    state = state.apply(
      state.tr.insertText("Updated", at, at + "Original".length),
    );
    const changed = editorStateToCriticMarkdown(
      state.doc.toJSON(),
      parsed.comments,
    );
    expect(changed).toBe(original.replace("Original", "Updated"));
    expect(
      undo(state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(true);
    expect(
      editorStateToCriticMarkdown(state.doc.toJSON(), parsed.comments),
    ).toBe(original);
  });

  test("suggestions and comments on YAML survive reload and clean export excludes pending text", () => {
    const original = "---\ntitle: Original\n---\n\nBody.\n";
    const parsed = parse(original);
    expect(parsed.node.firstChild?.type.name).toBe("yamlFrontmatter");
    let state = EditorState.create({ doc: parsed.node });
    const at = state.doc.textContent.indexOf("Original") + 1;
    const suggestion = createCriticChange("addition", {
      changeId: "s1",
      createdAt: "2026-11-28T01:00:00.000Z",
    });
    const comment = createCriticComment({
      id: "c1",
      content: "Discuss the document title.",
      createdAt: "2026-11-28T01:00:00.000Z",
    });
    const tr = state.tr.insertText(" proposed", at + 8);
    tr.addMark(
      at,
      at + 8,
      schema.marks.commentRef.create({ commentIds: [comment.id] }),
    );
    tr.addMark(at + 8, at + 17, schema.marks.criticChange.create(suggestion));
    state = state.apply(tr);
    const comments = new Map([[comment.id, comment]]);
    const review = editorStateToCriticMarkdown(state.doc.toJSON(), comments);
    const restored = parse(review);
    expect(restored.comments.get("c1")?.content).toBe(comment.content);
    expect(restored.node.firstChild?.textContent).toContain(
      "Original proposed",
    );
    expect(
      restored.node
        .toJSON()
        .content?.[0].content?.some((node) =>
          node.marks?.some((mark) => mark.type === "criticChange"),
        ),
    ).toBe(true);
    expect(cleanRevisionDocument(restored.node.toJSON())).toBe(original);
    expect(cleanRoughdraftMarkdown(review)).toBe(original);
  });

  test.each([
    "\n",
    "\r\n",
  ])("a multiline YAML proposal stays inline and accepts or reverts with exact %j spelling", (newline) => {
    const original = `${["---", "title: Original", "---", "", ""].join(newline)}Body.\n`;
    const parsed = parse(original);
    const before = EditorState.create({ doc: parsed.node });
    const at =
      before.doc.textContent.indexOf("Original") + "Original".length + 1;
    const after = before.apply(before.tr.insertText("\nowner: Dan", at));
    const proposed = structuralSuggestion(before, after);
    const reviewState = after.apply(proposed.transaction);
    expect(reviewState.doc.firstChild?.type.name).toBe("yamlFrontmatter");
    const serialized = editorStateToCriticMarkdown(
      reviewState.doc.toJSON(),
      new Map(),
    );
    const reloaded = parse(serialized);
    expect(cleanRevisionDocument(reloaded.doc)).toBe(original);
    expect(cleanRoughdraftMarkdown(serialized)).toBe(original);
    for (const decision of ["accept", "reject"] as const) {
      const tr = EditorState.create({ doc: reloaded.node }).tr;
      expect(applySuggestionDecisions(tr, [proposed.changeId], decision)).toBe(
        true,
      );
      expect(editorStateToCriticMarkdown(tr.doc.toJSON(), new Map())).toBe(
        decision === "accept"
          ? original.replace("Original", `Original${newline}owner: Dan`)
          : original,
      );
    }
  });

  test("a YAML-only insertion survives refresh without a comment registry", () => {
    const parsed = parse("---\ntitle: Plan\n---\n\nBody.\n");
    const initial = EditorState.create({ doc: parsed.node });
    const at = initial.doc.textContent.indexOf("Plan") + 5;
    const tr = initial.tr.insertText(" proposal", at);
    tr.addMark(
      at,
      at + 9,
      schema.marks.criticChange.create(
        createCriticChange("addition", {
          changeId: "s1",
          createdAt: "2026-11-28T01:00:00.000Z",
        }),
      ),
    );
    const review = editorStateToCriticMarkdown(tr.doc.toJSON(), new Map());
    const reloaded = parse(review);
    expect(reloaded.endmatter).toContain("frontmatterAnchor: true");
    expect(cleanRevisionDocument(reloaded.doc)).toBe(
      "---\ntitle: Plan\n---\n\nBody.\n",
    );
  });

  test("unannotated YAML punctuation and invalid intermediate values stay literal and exact", () => {
    const source =
      "---\ntitle: [unfinished\nexample: '{++literal++}'\npath: C:\\work\\plan\nquoted: '**plain** _yaml_ `literal`'\n---\n\nBody.\n";
    const parsed = parse(source);
    expect(parsed.node.firstChild?.type.name).toBe("yamlFrontmatter");
    expect(parsed.comments.size).toBe(0);
    expect(editorStateToCriticMarkdown(parsed.doc, parsed.comments)).toBe(
      source,
    );
  });
});

test("literal YAML review references reserve their IDs before a new proposal or comment is allocated", async () => {
  const { documentProposalIdentities, literalFrontmatterReviewIds } =
    await import("./revision-proposal-identities");
  const source =
    "---\ntitle: Old\nproposalExample: '{++literal++}{#s1}'\ncommentExample: '{==literal==}{>>note<<}{#c1}'\n---\n\nBody.\n";
  const parsed = parse(source);
  const change = createCriticChange("addition", undefined, {
    existingChanges: documentProposalIdentities(parsed.node, true),
  });
  expect(change.changeId).toBe("s2");
  const comment = createCriticComment(
    { content: "Real header comment." },
    {
      existingComments: literalFrontmatterReviewIds(parsed.node).map((id) => ({
        id,
      })),
    },
  );
  expect(comment.id).toBe("c2");
  const state = EditorState.create({ doc: parsed.node });
  const title = state.doc.textContent.indexOf("Old") + 1;
  const tr = state.tr.insertText(" proposed", title + 3);
  tr.addMark(title + 3, title + 12, schema.marks.criticChange.create(change));
  tr.addMark(
    title,
    title + 3,
    schema.marks.commentRef.create({ commentIds: [comment.id] }),
  );
  const review = editorStateToCriticMarkdown(
    tr.doc.toJSON(),
    new Map([[comment.id, comment]]),
  );
  const restored = parse(review);
  expect(restored.comments.size).toBe(1);
  expect(
    extractRoughdraftReviewIndex(review)
      .items.map((item) => item.id)
      .sort(),
  ).toEqual(["c2", "s2"]);
  expect(cleanRevisionDocument(restored.doc)).toBe(source);
  expect(cleanRoughdraftMarkdown(review)).toBe(source);
});

test("YAML comments retain literal braces and backslashes in the document and agent quote", () => {
  const source = "---\npath: 'C:\\work\\{literal}'\n---\n\nBody.\n";
  const parsed = parse(source);
  const state = EditorState.create({ doc: parsed.node });
  const quote = "C:\\work\\{literal}";
  const from = state.doc.textContent.indexOf(quote) + 1;
  const comment = createCriticComment({
    id: "c1",
    content: "Keep this literal path.",
  });
  const tr = state.tr.addMark(
    from,
    from + quote.length,
    schema.marks.commentRef.create({ commentIds: [comment.id] }),
  );
  const review = editorStateToCriticMarkdown(
    tr.doc.toJSON(),
    new Map([[comment.id, comment]]),
  );
  expect(cleanRevisionDocument(parse(review).doc)).toBe(source);
  expect(cleanRoughdraftMarkdown(review)).toBe(source);
  expect(extractRoughdraftReviewIndex(review).items[0].anchorText).toBe(quote);
});
