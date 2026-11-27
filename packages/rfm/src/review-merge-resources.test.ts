import { expect, test, vi } from "vitest";
import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
} from "./index.js";

function source(paragraphs: number, newline: string) {
  return [
    "---",
    "title: Preserve the code scopes",
    "---",
    "",
    "# Review",
    "",
    "Local owner: unchanged.",
    "",
    "Peer owner: unchanged.",
    "",
    "Read {==this anchor==}{>>Keep this discussion.<<}{#c1} and {++proposed wording++}{#s1}.",
    "",
    ...Array.from(
      { length: paragraphs },
      (_, index) =>
        `Reading paragraph ${index + 1}. Ordinary unchanged words retain their exact spelling.`,
    ).flatMap((paragraph) => [paragraph, ""]),
    "Inline `{++literal++}` stays literal; the ~ symbol is ordinary text.",
    "",
    "Escaped \\{++literal++\\} also stays literal.",
    "",
    "````markdown",
    "{>>literal comment<<}{#literal}",
    "```text",
    "{++literal addition++}",
    "```",
    "````",
    "",
    "> > ~~~markdown",
    "> > {++quoted literal++}{#quoted}",
    "> > ~~~",
    "",
    "- ```markdown",
    "  {++list literal++}{#list}",
    "  ```",
    "",
    "---",
    "comments:",
    "  c1:",
    "    by: AI",
    '    at: "2026-11-22T12:00:00.000Z"',
    "suggestions:",
    "  s1:",
    "    by: AI",
    '    at: "2026-11-22T12:00:00.000Z"',
    "",
  ].join(newline);
}

test.each([
  "\n",
  "\r\n",
])("ordinary reading distance does not allocate a fresh fence parser for every line (%j)", (newline) => {
  const compare = (paragraphs: number) => {
    const original = source(paragraphs, newline);
    const draft = (markdown: string) => ({
      markdown,
      cleanMarkdown: cleanRoughdraftMarkdown(markdown),
      decisions: {},
      reviewComments: [],
    });
    const base = draft(original);
    const local = draft(
      original.replace("Local owner: unchanged.", "Local owner: mine."),
    );
    const incoming = draft(
      original.replace("Peer owner: unchanged.", "Peer owner: theirs."),
    );
    let allocations = 0;
    vi.stubGlobal(
      "RegExp",
      new Proxy(RegExp, {
        construct(target, args) {
          allocations++;
          return Reflect.construct(target, args);
        },
        apply(target, receiver, args) {
          allocations++;
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    try {
      const result = mergeReviewDrafts(base, local, incoming);
      const comparisonAllocations = allocations;
      const expected = original
        .replace("Local owner: unchanged.", "Local owner: mine.")
        .replace("Peer owner: unchanged.", "Peer owner: theirs.");
      expect(result.status).toBe("merged");
      expect(result.draft.markdown).toBe(expected);
      expect(result.draft.cleanMarkdown).toBe(
        cleanRoughdraftMarkdown(expected),
      );
      expect(
        extractRoughdraftReviewIndex(result.draft.markdown).items.map(
          (item) => item.id,
        ),
      ).toEqual(["c1", "s1"]);
      for (const literal of [
        "`{++literal++}`",
        "\\{++literal++\\}",
        "{++quoted literal++}{#quoted}",
        "{++list literal++}{#list}",
      ])
        expect(result.draft.cleanMarkdown).toContain(literal);
      return comparisonAllocations;
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const short = compare(1);
  const long = compare(1_000);
  expect(
    long,
    "unchanged prose should not create additional fence-parser regular expressions",
  ).toBeLessThanOrEqual(short + 20);
});
