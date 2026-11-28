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

test.each([
  "",
  "example: '{++literal++}'\npath: 'C:\\work'\n",
])("a proposal deleting the entire YAML block preserves YAML, literal examples and spacing (%j)", (extra) => {
  const source = `---\ntitle: Original\n${extra}---\n\nBody.\n`;
  const parsed = parse(source);
  const before = EditorState.create({ doc: parsed.node });
  const after = before.apply(
    before.tr.delete(0, before.doc.firstChild?.nodeSize ?? 0),
  );
  const proposal = structuralSuggestion(before, after);
  const reviewed = after.apply(proposal.transaction);
  const serialized = editorStateToCriticMarkdown(
    reviewed.doc.toJSON(),
    new Map(),
  );
  const reloaded = parse(serialized);
  expect(cleanRevisionDocument(reloaded.doc)).toBe(source);
  expect(cleanRoughdraftMarkdown(serialized)).toBe(source);
  const tr = EditorState.create({ doc: reloaded.node }).tr;
  expect(applySuggestionDecisions(tr, [proposal.changeId], "reject")).toBe(
    true,
  );
  expect(editorStateToCriticMarkdown(tr.doc.toJSON(), new Map())).toBe(source);
});

test("mixed internal YAML line endings stay exact across reload and a field edit", () => {
  const source =
    "---\r\ntitle: Original\nowner: Dan\r\nlabels: [one, two]\r\n---\r\n\r\nBody.\n";
  const parsed = parse(source);
  expect(editorStateToCriticMarkdown(parsed.doc, parsed.comments)).toBe(source);
  const state = EditorState.create({ doc: parsed.node });
  const at = state.doc.firstChild?.textContent.indexOf("Original") ?? -1;
  const changed = state.tr.insertText("Updated", at + 1, at + 9).doc;
  expect(editorStateToCriticMarkdown(changed.toJSON(), parsed.comments)).toBe(
    source.replace("Original", "Updated"),
  );
});

test("a YAML proposal containing literal review delimiters reloads without creating stray IDs", () => {
  const source = "---\ntitle: Original\n---\n\nBody.\n";
  const parsed = parse(source);
  const state = EditorState.create({ doc: parsed.node });
  const addition = " {++literal++}";
  const at = state.doc.firstChild?.content.size ?? 0;
  const from = at + 1;
  const tr = state.tr.insertText(addition, from);
  tr.addMark(
    from,
    from + addition.length,
    schema.marks.criticChange.create(
      createCriticChange("addition", { changeId: "s1" }),
    ),
  );
  const review = editorStateToCriticMarkdown(tr.doc.toJSON(), new Map());
  const restored = parse(review);
  expect(restored.node.firstChild?.textContent).toBe(
    `title: Original${addition}`,
  );
  expect(cleanRevisionDocument(restored.doc)).toBe(source);
  expect(cleanRoughdraftMarkdown(review)).toBe(source);
});

test.each([
  "deletion",
  "substitution-old",
] as const)("literal YAML %s payloads preserve accepted bytes and decoded agent quotes", (kind) => {
  const oldText = "{++literal++}{#s1} C:\\work ~> boundary";
  const newText = "{--new example--} C:\\updated ~> wording";
  const source = `---\nvalue: '${oldText}'\n---\n\nBody.\n`;
  const parsed = parse(source);
  const state = EditorState.create({ doc: parsed.node });
  const from = (state.doc.firstChild?.textContent.indexOf(oldText) ?? -1) + 1;
  const change = createCriticChange(kind, { changeId: "s2" });
  const tr = state.tr.addMark(
    from,
    from + oldText.length,
    schema.marks.criticChange.create(change),
  );
  if (kind === "substitution-old") {
    tr.insertText(newText, from + oldText.length);
    tr.addMark(
      from + oldText.length,
      from + oldText.length + newText.length,
      schema.marks.criticChange.create({ ...change, kind: "substitution-new" }),
    );
  }
  const review = editorStateToCriticMarkdown(tr.doc.toJSON(), new Map());
  const restored = parse(review);
  expect(restored.node.firstChild?.textContent).toBe(
    `value: '${oldText}${kind === "substitution-old" ? newText : ""}'`,
  );
  expect(cleanRevisionDocument(restored.doc)).toBe(source);
  expect(cleanRoughdraftMarkdown(review)).toBe(source);
  const [item] = extractRoughdraftReviewIndex(review).items;
  expect(item.id).toBe("s2");
  expect(kind === "substitution-old" ? item.originalText : item.text).toBe(
    oldText,
  );
  if (kind === "substitution-old") expect(item.replacementText).toBe(newText);
  const accepted = EditorState.create({ doc: restored.node }).tr;
  expect(applySuggestionDecisions(accepted, ["s2"], "accept")).toBe(true);
  expect(editorStateToCriticMarkdown(accepted.doc.toJSON(), new Map())).toBe(
    source.replace(oldText, kind === "substitution-old" ? newText : ""),
  );
});

test("a proposed entire YAML insertion keeps the original file clean and accepts the exact framed header", () => {
  const original = "Body.\n";
  const complete =
    "---\ntitle: Original\nexample: '{++literal++}'\n---\n\nBody.\n";
  const before = EditorState.create({ doc: parse(original).node });
  const proposedDoc = parse(complete).node;
  const yaml = proposedDoc.firstChild;
  if (!yaml) throw new Error("The proposed header must be present");
  const after = before.apply(before.tr.insert(0, yaml));
  const suggestion = structuralSuggestion(before, after);
  const state = after.apply(suggestion.transaction);
  const review = editorStateToCriticMarkdown(state.doc.toJSON(), new Map());
  const restored = parse(review);
  expect(cleanRevisionDocument(restored.doc)).toBe(original);
  expect(cleanRoughdraftMarkdown(review)).toBe(original);
  const accepted = EditorState.create({ doc: restored.node }).tr;
  expect(
    applySuggestionDecisions(accepted, [suggestion.changeId], "accept"),
  ).toBe(true);
  expect(editorStateToCriticMarkdown(accepted.doc.toJSON(), new Map())).toBe(
    complete,
  );
});

test("a commented YAML deletion decodes literal braces and backslashes exactly once", () => {
  const path = "C:\\work\\{literal}";
  const source = `---\npath: '${path}'\n---\n\nBody.\n`;
  const parsed = parse(source);
  const state = EditorState.create({ doc: parsed.node });
  const from = (state.doc.firstChild?.textContent.indexOf(path) ?? -1) + 1;
  const comment = createCriticComment({
    id: "c1",
    content: "Keep this path available for review.",
  });
  const change = createCriticChange("deletion", { changeId: "s1" });
  const tr = state.tr.addMark(
    from,
    from + path.length,
    schema.marks.commentRef.create({ commentIds: [comment.id] }),
  );
  tr.addMark(
    from,
    from + path.length,
    schema.marks.criticChange.create(change),
  );
  const review = editorStateToCriticMarkdown(
    tr.doc.toJSON(),
    new Map([[comment.id, comment]]),
  );
  const restored = parse(review);
  expect(restored.node.firstChild?.textContent).toBe(`path: '${path}'`);
  expect(cleanRevisionDocument(restored.doc)).toBe(source);
  expect(cleanRoughdraftMarkdown(review)).toBe(source);
  const index = extractRoughdraftReviewIndex(review);
  expect(index.items.find((item) => item.id === comment.id)?.anchorText).toBe(
    path,
  );
  expect(index.items.find((item) => item.id === change.changeId)?.text).toBe(
    path,
  );
  expect(index.diagnostics).toEqual([]);
});
