import { expect, test } from "vitest";
import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
} from "./index";

for (const literal of [
  String.raw`\{>>literal comment<<}`,
  String.raw`\{++literal addition++}`,
  String.raw`\{--literal deletion--}`,
  String.raw`\{~~old~>new~~}`,
]) {
  test(`escaped Markdown review openers remain plain text: ${literal}`, () => {
    const markdown = `Keep ${literal} here.\n`;
    expect(extractRoughdraftReviewIndex(markdown).items).toEqual([]);
    expect(cleanRoughdraftMarkdown(markdown)).toBe(markdown);
    expect(validateRoughdraftMarkdown(markdown).summary).toMatchObject({
      comments: 0,
      suggestions: 0,
    });
  });
}

for (const count of [0, 1, 2, 3, 4]) {
  test(`backslash parity before review openers follows Markdown: ${count}`, () => {
    const slash = "\\".repeat(count);
    const markdown = `${slash}{++new++}{id="s1" by="user" at="2026-01-01T00:00:00.000Z"}\n`;
    const literal = count % 2 === 1;
    expect(extractRoughdraftReviewIndex(markdown).items).toHaveLength(
      literal ? 0 : 1,
    );
    expect(validateRoughdraftMarkdown(markdown).summary.suggestions).toBe(
      literal ? 0 : 1,
    );
    expect(cleanRoughdraftMarkdown(markdown)).toBe(
      literal ? markdown : `${slash}\n`,
    );
  });
}

test("an empty anchored placeholder hydrates its YAML body once with its original location", () => {
  const markdown =
    'Read {==guidance==}{>><<}{#c1} carefully.\n\n---\ncomments:\n  c1:\n    body: "Explain <<} and \\\\paths in {~~old~>new~~}."\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n';
  const result = extractRoughdraftReviewIndex(markdown);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    id: "c1",
    anchorText: "guidance",
    text: String.raw`Explain <<} and \paths in {~~old~>new~~}.`,
    line: 1,
  });
  expect(validateRoughdraftMarkdown(markdown)).toMatchObject({
    ok: true,
    summary: { comments: 1 },
  });
  expect(cleanRoughdraftMarkdown(markdown)).toBe("Read guidance carefully.\n");
});

test("YAML body hydration does not hide duplicate inline declarations", () => {
  const markdown =
    '{==first==}{>>First<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"} {==second==}{>>Second<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}\n\n---\ncomments:\n  c1:\n    body: "Text <<} safely"\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n';
  expect(
    validateRoughdraftMarkdown(markdown).errors.some(
      (error) => error.code === "duplicate-id",
    ),
  ).toBe(true);
});

test("repeated compact references describe one logical comment while conflicting bodies remain errors", () => {
  const metadata =
    '\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n';
  const consistent =
    "{==bravo ==}{>>Feedback<<}{#c1}{==charlie==}{>>Feedback<<}{#c1}" +
    metadata;
  expect(validateRoughdraftMarkdown(consistent)).toMatchObject({
    ok: true,
    summary: { comments: 1 },
  });
  expect(extractRoughdraftReviewIndex(consistent).items).toMatchObject([
    { id: "c1", text: "Feedback", anchorText: "bravo charlie" },
  ]);
  expect(extractRoughdraftReviewIndex(consistent).items).toHaveLength(1);
  const conflict = consistent.replace(
    "{==charlie==}{>>Feedback<<}",
    "{==charlie==}{>>Different feedback<<}",
  );
  expect(
    validateRoughdraftMarkdown(conflict).errors.some(
      (error) => error.code === "duplicate-id",
    ),
  ).toBe(true);
  expect(extractRoughdraftReviewIndex(conflict).items).toHaveLength(2);
});
