import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Extension, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { marked } from "marked";
import { afterEach, expect, test, vi } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { normalizeBlockSpacing } from "./markdown";
import { applySuggestionDecisions } from "./review-decisions";
import { suggestionDetail } from "./revision-bulk";
import { cleanRevisionNode } from "./revision-clean-cache";
import {
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import {
  cleanRevisionDocument,
  editableMarkdownOptions,
} from "./revision-markdown";
import { suggestionPositions } from "./revision-projection";
import { serializeRevisionNode } from "./revision-review-cache";
import { RevisionSource } from "./revision-source";

afterEach(() => vi.restoreAllMocks());

test("repeating the real large-editor serialization and clean projection avoids lexing the unchanged document again", () => {
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
  const markdown = `${fixture.slice(0, endmatter)}\n\n${padding}\n\nNormalization owner: stable.\n${fixture.slice(endmatter)}`;
  expect(markdown.length).toBeGreaterThan(100 * 1024);
  const schema = getSchema([
    ...createEditorExtensions(""),
    RevisionSource,
    Extension.create({
      name: "normalizationHistory",
      addGlobalAttributes: () => [
        {
          types: ["doc"],
          attributes: { kept: { default: [] }, reviewed: { default: [] } },
        },
      ],
    }),
  ]);
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  const metadata = {
    markdown,
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
  };
  let state = EditorState.create({
    doc: schema.nodeFromJSON({
      ...parsed.doc,
      attrs: { ...parsed.doc.attrs, sourceMetadata: metadata },
    }),
  });
  for (const [id, decision, oldText, newText] of [
    ["s10", "accept", "", "deliberately clear"],
    ["s11", "reject", "keep the comment history", ""],
  ] as const) {
    const detail = suggestionDetail(state.doc, id);
    const tr = state.tr;
    applySuggestionDecisions(tr, [id], decision);
    state = state.apply(
      recordReviewedChange(tr, { decision, oldText, newText }, detail),
    );
  }
  let ownerAt = -1;
  state.doc.descendants((node, pos) => {
    if (node.isText && node.text === "Normalization owner: stable.")
      ownerAt = pos;
  });
  expect(ownerAt).toBeGreaterThan(0);
  state = state.apply(
    state.tr.addMark(
      ownerAt,
      ownerAt + 13,
      schema.marks.commentRef.create({ commentIds: ["c999"] }),
    ),
  );
  const comments = new Map(parsed.comments);
  comments.set("c999", {
    id: "c999",
    content: "",
    createdAt: "2026-11-27T12:00:00.000Z",
    authorType: "user",
  });
  const privateIds = new Set(["c999"]);
  const options = {
    frontmatter: metadata.frontmatter,
    endmatter: metadata.endmatter,
  };
  const lexer = vi.spyOn(marked, "lexer");
  const fullLexedBytes = () =>
    lexer.mock.calls.reduce(
      (total, [source]) =>
        total + (source.length > 100_000 ? source.length : 0),
      0,
    );
  const read = () => ({
    markdown: serializeRevisionNode(state.doc, comments, options, privateIds),
    clean: cleanRevisionNode(state.doc),
  });
  const before = state.doc.toJSON();
  const started = performance.now();
  const first = read();
  const coldMs = performance.now() - started;
  const coldBytes = fullLexedBytes();
  lexer.mockClear();
  const repeatedAt = performance.now();
  const repeated = read();
  const repeatedMs = performance.now() - repeatedAt;
  const repeatedBytes = fullLexedBytes();
  process.stdout.write(
    `${JSON.stringify({ severity: "info", event: "normalization-large-editor", characters: markdown.length, coldBytes, repeatedBytes, coldMs, repeatedMs })}\n`,
  );
  expect(repeated).toEqual(first);
  expect(first.markdown).not.toContain("c999");
  expect(first.markdown).toContain("{#c1}");
  expect(first.markdown).toContain("{#s1}");
  expect(first.clean).toBe(cleanRevisionDocument(state.doc.toJSON()));
  expect(state.doc.toJSON()).toEqual(before);
  expect(reviewedChanges(state.doc)).toHaveLength(2);
  for (const entry of reviewedChanges(state.doc)) {
    const reopen = reopenReviewedChange(state, entry.id);
    expect(reopen).not.toBeNull();
    if (!reopen)
      throw new Error("The real History decision must remain reopenable");
    const reopened = state.apply(reopen);
    expect(
      suggestionPositions(reopened.doc).has(entry.newText ? "s10" : "s11"),
    ).toBe(true);
  }
  expect(coldBytes).toBeGreaterThan(100_000);
  expect(repeatedBytes).toBe(0);

  state = state.apply(
    state.tr.insertText(
      " Native typing.",
      ownerAt + "Normalization owner: stable.".length,
    ),
  );
  lexer.mockClear();
  const typed = read();
  expect(typed.markdown).toContain(
    "Normalization owner: stable. Native typing.",
  );
  expect(typed.clean).toContain("Normalization owner: stable. Native typing.");
  expect(fullLexedBytes()).toBeGreaterThan(100_000);
  lexer.mockClear();
  expect(read()).toEqual(typed);
  expect(fullLexedBytes()).toBe(0);

  let codeAt = -1;
  state.doc.descendants((node, pos) => {
    if (codeAt < 0 && node.type.name === "codeBlock") codeAt = pos + 1;
  });
  expect(codeAt).toBeGreaterThan(0);
  state = state.apply(state.tr.insertText("// Newly changed code.\n", codeAt));
  const changedCode = read();
  expect(changedCode.markdown).toContain("// Newly changed code.");
  expect(changedCode.clean).toContain("// Newly changed code.");
  expect(read()).toEqual(changedCode);
  options.frontmatter = "---\ntitle: Changed global metadata\n---\n";
  const updatedYaml = criticMarkdownToEditorState(options.frontmatter).doc
    .content?.[0];
  if (updatedYaml?.type !== "yamlFrontmatter")
    throw new Error("Expected editable YAML metadata");
  state = state.apply(
    state.tr
      .replaceWith(
        0,
        state.doc.firstChild?.nodeSize ?? 0,
        schema.nodeFromJSON(updatedYaml),
      )
      .setDocAttribute("sourceMetadata", {
        ...metadata,
        frontmatter: options.frontmatter,
      }),
  );
  const changedMetadata = read();
  expect(changedMetadata.markdown).toContain("title: Changed global metadata");
  expect(changedMetadata.markdown).not.toContain(
    "title: Roughdraft editing and comment review",
  );
  expect(changedMetadata.markdown).toContain("// Newly changed code.");
  expect(changedMetadata.clean).toContain("title: Changed global metadata");
  expect(changedMetadata.clean).toContain("// Newly changed code.");
});

test("normalization reuses only exact source, preserving CRLF and literal code", () => {
  const tail = `${"Preserved cache fixture text. ".repeat(60)}\n`;
  const source =
    "# Cache source\n\nOutside.\n\n\n```text\n# literal heading\n\n\nKeep these blank lines.\n```\n\nLast.\n" +
    tail;
  const expected =
    "# Cache source\nOutside.\n\n```text\n# literal heading\n\n\nKeep these blank lines.\n```\n\nLast.\n" +
    tail;
  expect(normalizeBlockSpacing(source)).toBe(expected);
  expect(normalizeBlockSpacing(source)).toBe(expected);
  const crlf = source.replaceAll("\n", "\r\n");
  expect(normalizeBlockSpacing(crlf)).toBe(crlf);
  expect(normalizeBlockSpacing(source)).toBe(expected);
  const changed = source.replace("literal heading", "changed literal heading");
  expect(normalizeBlockSpacing(changed)).toBe(
    expected.replace("literal heading", "changed literal heading"),
  );
});

test("normalization drops old sources after both many small entries and a few large entries", () => {
  const lexer = vi.spyOn(marked, "lexer");
  const small = `# Entry retention probe\n\n${"Small entry prose. ".repeat(80)}\n`;
  const expected = normalizeBlockSpacing(small);
  lexer.mockClear();
  expect(normalizeBlockSpacing(small)).toBe(expected);
  expect(lexer).not.toHaveBeenCalled();
  for (let index = 0; index < 64; index++)
    normalizeBlockSpacing(
      `# Entry pressure ${index}\n\n${"Small entry prose. ".repeat(80)}\n`,
    );
  lexer.mockClear();
  expect(normalizeBlockSpacing(small)).toBe(expected);
  expect(lexer).toHaveBeenCalledOnce();
  const large = `# Character retention probe\n\n${"Bounded prose. ".repeat(8000)}\n`;
  const largeExpected = normalizeBlockSpacing(large);
  lexer.mockClear();
  expect(normalizeBlockSpacing(large)).toBe(largeExpected);
  expect(lexer).not.toHaveBeenCalled();
  for (let index = 0; index < 12; index++)
    normalizeBlockSpacing(
      `# Character pressure ${index}\n\n${"Bounded prose. ".repeat(8000)}\n`,
    );
  lexer.mockClear();
  expect(normalizeBlockSpacing(large)).toBe(largeExpected);
  expect(lexer).toHaveBeenCalledOnce();
});
