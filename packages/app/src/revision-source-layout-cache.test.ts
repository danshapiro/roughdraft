import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Extension, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { afterEach, expect, test, vi } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
import {
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import { editableMarkdownOptions } from "./revision-markdown";
import { prepareRevisionDraft } from "./revision-prepare";
import { publicRevisionNode } from "./revision-private-comments";
import { parseRemoteRevision } from "./revision-remote-source";
import { rebaseRemoteTransaction } from "./revision-remote-steps";
import { serializeRevisionNode } from "./revision-review-cache";
import { RevisionSource } from "./revision-source";

const lexed = vi.hoisted(() => [] as string[]);
vi.mock("marked", async (load) => {
  const actual = await load<typeof import("marked")>();
  return {
    ...actual,
    Marked: class extends actual.Marked {
      constructor(...args: ConstructorParameters<typeof actual.Marked>) {
        super(...args);
        const original = this.lexer.bind(this);
        this.lexer = (...input: Parameters<typeof original>) => {
          lexed.push(input[0]);
          return original(...input);
        };
      }
    },
  };
});
vi.mock("./revision-remote-source", { spy: true });
afterEach(() => {
  lexed.length = 0;
});

function schema() {
  return getSchema([
    ...createEditorExtensions(""),
    RevisionSource,
    Extension.create({
      name: "layoutHistory",
      addGlobalAttributes: () => [
        {
          types: ["doc"],
          attributes: { kept: { default: [] }, reviewed: { default: [] } },
        },
      ],
    }),
  ]);
}
function initial(markdown: string, model = schema()) {
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  return {
    parsed,
    state: EditorState.create({
      doc: model.nodeFromJSON({
        ...parsed.doc,
        attrs: {
          ...parsed.doc.attrs,
          sourceMetadata: {
            markdown,
            frontmatter: parsed.frontmatter,
            endmatter: parsed.endmatter,
            identityGeneration: 7,
          },
        },
      }),
    }),
  };
}
function append(state: EditorState, owner: string, text: string) {
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent.startsWith(owner))
      at = pos + node.nodeSize - 1;
  });
  if (at < 0) throw new Error(`Missing native input target ${owner}`);
  return state.apply(state.tr.insertText(text, at));
}
function fullLexedCharacters() {
  return lexed.reduce(
    (total, source) => total + (source.length > 100_000 ? source.length : 0),
    0,
  );
}

test.each([
  "LF",
  "CRLF",
] as const)("a prepared large target reuses only its lexical layout through serialized and buffered native typing (%s)", (lineEndings) => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const end = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 750 },
    (_, index) =>
      `Unchanged ${lineEndings} section ${index + 1}. This paragraph provides real reading distance while the two pages retain independent edits and private feedback.`,
  ).join("\n\n");
  const source = `${fixture.slice(0, end)}\n\n${padding}\n\nLayout owner A: unchanged.\n\nLayout owner B: unchanged.\n${fixture.slice(end)}`;
  expect(source.length).toBeGreaterThan(100_000);
  const { parsed, state: original } = initial(source);
  let live = original;
  for (const [id, decision, oldText, newText] of [
    ["s10", "accept", "", "deliberately clear"],
    ["s11", "reject", "keep the comment history", ""],
  ] as const) {
    const tr = live.tr;
    applySuggestionDecisions(tr, [id], decision);
    live = live.apply(
      recordReviewedChange(
        tr,
        { decision, oldText, newText },
        suggestionDetail(live.doc, id),
      ),
    );
  }
  let anchor = -1;
  live.doc.descendants((node, pos) => {
    if (node.isText && node.text === "Layout owner A: unchanged.") anchor = pos;
  });
  expect(anchor).toBeGreaterThan(0);
  live = live.apply(
    live.tr.addMark(
      anchor,
      anchor + 6,
      live.schema.marks.commentRef.create({ commentIds: ["c-private"] }),
    ),
  );
  const comments = new Map(parsed.comments);
  comments.set("c-private", {
    id: "c-private",
    content: "",
    createdAt: "2026-11-27T12:00:00.000Z",
  });
  const privateIds = new Set(["c-private"]);
  const options = {
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
  };
  const publicSource = serializeRevisionNode(
    live.doc,
    comments,
    options,
    privateIds,
  );
  const candidate = {
    markdown: publicSource
      .replace("Layout owner B: unchanged.", "Layout owner B: incoming. 🦋")
      .replace(/\r?\n/g, lineEndings === "CRLF" ? "\r\n" : "\n"),
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: comment.parentCommentId ?? "document",
    })),
    reviewed: reviewedChanges(live.doc),
  };
  const base = EditorState.create({
    doc: publicRevisionNode(live.doc, privateIds),
  });
  lexed.length = 0;
  vi.mocked(parseRemoteRevision).mockClear();
  const prepared = prepareRevisionDraft(candidate, live);
  const expected = vi.mocked(parseRemoteRevision).mock.results.at(-1)
    ?.value as ReturnType<typeof parseRemoteRevision>;
  const prepareLexed = fullLexedCharacters();
  expect(prepared).not.toBeNull();
  expect(prepareLexed).toBeGreaterThan(100_000);
  live = append(live, "Layout owner A:", " Serialized typing.");
  const serialized = serializeRevisionNode(
    live.doc,
    comments,
    options,
    privateIds,
  );
  expect(serialized).toContain("Serialized typing.");
  live = append(live, "Layout owner A:", " Buffered typing.");
  const before = live.doc.toJSON();
  const selection = live.selection.toJSON();
  lexed.length = 0;
  const started = performance.now();
  const target = parseRemoteRevision(candidate.markdown, live);
  const targetMs = performance.now() - started;
  const repeatedLexed = fullLexedCharacters();
  process.stdout.write(
    `${JSON.stringify({ severity: "info", event: "source-layout-reuse", lineEndings, sourceCharacters: candidate.markdown.length, prepareLexed, repeatedLexed, targetMs })}\n`,
  );
  expect(target.doc.toJSON()).toEqual(expected.doc.toJSON());
  expect(target.comments).toEqual(expected.comments);
  expect(target.frontmatter).toBe(expected.frontmatter);
  expect(target.endmatter).toBe(expected.endmatter);
  expect(live.doc.toJSON()).toEqual(before);
  expect(live.selection.toJSON()).toEqual(selection);
  const transaction = rebaseRemoteTransaction(base, live, target.doc);
  expect(transaction).not.toBeNull();
  if (!transaction)
    throw new Error("Independent native and remote input must map");
  const applied = live.apply(transaction);
  expect(applied.doc.textContent).toContain(
    "Layout owner A: unchanged. Serialized typing. Buffered typing.",
  );
  expect(applied.doc.textContent).toContain("Layout owner B: incoming. 🦋");
  expect(applied.doc.attrs.sourceMetadata).toEqual(
    live.doc.attrs.sourceMetadata,
  );
  expect(reviewedChanges(applied.doc)).toEqual(reviewedChanges(live.doc));
  for (const entry of reviewedChanges(applied.doc))
    expect(reopenReviewedChange(applied, entry.id)).not.toBeNull();
  expect(JSON.stringify(applied.doc.toJSON())).toContain("c-private");
  const publicResult = serializeRevisionNode(
    applied.doc,
    comments,
    options,
    privateIds,
  );
  expect(publicResult).not.toContain("c-private");
  expect(publicResult).toContain("{#c1}");
  expect(publicResult).toContain("{#s1}");
  expect(repeatedLexed).toBe(0);
}, 15_000);

test("a cached lexical body cannot carry a previous schema's legacy timestamp or live attributes", () => {
  const markdown =
    "Lexical timestamp context.\n\nA {++legacy proposal++}{#s1}.\n";
  const make = (date: string) => {
    const { state } = initial(markdown);
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      for (const mark of node.marks)
        if (mark.type.name === "criticChange")
          tr.removeMark(pos, pos + node.nodeSize, mark).addMark(
            pos,
            pos + node.nodeSize,
            mark.type.create({ ...mark.attrs, createdAt: date }),
          );
    });
    return state.apply(tr);
  };
  const first = make("2026-01-01T00:00:00.000Z");
  parseRemoteRevision(markdown, first);
  const second = make("2026-02-02T00:00:00.000Z");
  const before = second.doc.toJSON();
  const next = parseRemoteRevision(markdown, second);
  const dates: string[] = [];
  next.doc.descendants((node) => {
    for (const mark of node.marks)
      if (mark.type.name === "criticChange") dates.push(mark.attrs.createdAt);
  });
  expect(dates).toEqual(["2026-02-02T00:00:00.000Z"]);
  expect(next.doc.type.schema).toBe(second.schema);
  expect(next.doc.attrs.sourceMetadata).toBeNull();
  expect(second.doc.toJSON()).toEqual(before);
});

test.each([
  [
    "A [reference][link].\n\n[link]: ./old.md\n",
    "A [reference][link].\n\n[link]: ./new.md\n",
  ],
  [
    "A note[^n].\n\n[^n]: Old definition.\n",
    "A note[^n].\n\n[^n]: New definition.\n",
  ],
  ["```text\nold\n\n\n# literal\n```\n", "```text\nnew\n\n\n# literal\n```\n"],
  [
    "---\ntitle: Original\n---\n\nBody.\n",
    "---\ntitle: Changed\n---\n\nBody.\n",
  ],
])("lexical reuse keeps global and literal source context current: %j", (before, changed) => {
  const { state } = initial(before);
  parseRemoteRevision(before, state);
  for (const markdown of [changed, changed.replace(/\n/g, "\r\n"), before]) {
    const actual = parseRemoteRevision(markdown, state);
    const expected = criticMarkdownToEditorState(
      markdown,
      editableMarkdownOptions,
    );
    expect(actual.doc.toJSON()).toEqual(
      state.schema.nodeFromJSON(expected.doc).toJSON(),
    );
    expect(actual.comments).toEqual(expected.comments);
    expect(actual.frontmatter).toBe(expected.frontmatter);
    expect(actual.endmatter).toBe(expected.endmatter);
  }
});

test("old lexical bodies are evicted by both entry count and retained source size", () => {
  const state = EditorState.create({ schema: schema() });
  const small = "Lexical retention probe.\n";
  parseRemoteRevision(small, state);
  lexed.length = 0;
  parseRemoteRevision(small, state);
  expect(lexed.filter((source) => source === small)).toHaveLength(0);
  for (let index = 0; index < 10; index++)
    parseRemoteRevision(`Lexical small pressure ${index}.\n`, state);
  lexed.length = 0;
  parseRemoteRevision(small, state);
  expect(lexed.filter((source) => source === small)).toHaveLength(1);
  const large = `Lexical large probe. ${"Stable source words. ".repeat(14000)}\n`;
  parseRemoteRevision(large, state);
  lexed.length = 0;
  parseRemoteRevision(large, state);
  expect(fullLexedCharacters()).toBe(0);
  for (let index = 0; index < 3; index++)
    parseRemoteRevision(
      `Lexical large pressure ${index}. ${"Stable source words. ".repeat(14000)}\n`,
      state,
    );
  lexed.length = 0;
  parseRemoteRevision(large, state);
  expect(fullLexedCharacters()).toBeGreaterThan(100_000);
}, 15_000);
