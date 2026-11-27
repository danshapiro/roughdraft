import { expect, test, vi } from "vitest";
import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
  scanRoughdraftReview,
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

test.each([
  "\n",
  "\r\n",
])("scanning ordinary reading distance does not inspect each character through every delimiter branch (%j)", (newline) => {
  let markdown = source(1_000, newline);
  const end = markdown.lastIndexOf(`${newline}---${newline}`);
  markdown =
    markdown.slice(0, end) +
    `${newline}Unfinished {++addition and {~~substitution.${newline}` +
    markdown.slice(end);
  const actual = scanRoughdraftReview(markdown);
  const comment = "{==this anchor==}{>>Keep this discussion.<<}{#c1}";
  const suggestion = "{++proposed wording++}{#s1}";
  expect(actual.items.map((item) => item.id)).toEqual(["c1", "s1"]);
  expect(actual.ranges).toEqual(
    [comment, suggestion].map((raw) => ({
      from: markdown.indexOf(raw),
      to: markdown.indexOf(raw) + raw.length,
    })),
  );
  for (const item of actual.items) {
    const marker =
      item.kind === "comment"
        ? "{>>Keep this discussion."
        : "{++proposed wording";
    const offset = markdown.indexOf(marker);
    expect(item).toMatchObject({
      offset,
      line: markdown.slice(0, offset).split("\n").length,
      column: offset - markdown.lastIndexOf("\n", offset - 1),
    });
  }
  // Count character reads, not elapsed time. Native methods still read the real
  // string; the independent primitive-string assertions above protect output.
  let reads = 0;
  const metered = new Proxy(Object(markdown), {
    get(target, key) {
      if (typeof key === "string" && key[0] >= "0" && key[0] <= "9") reads++;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as string;
  expect(scanRoughdraftReview(metered)).toEqual(actual);
  expect(
    reads,
    "one full line-index pass is required; ordinary text should bypass repeated delimiter branches",
  ).toBeLessThanOrEqual(markdown.length * 2);
});
