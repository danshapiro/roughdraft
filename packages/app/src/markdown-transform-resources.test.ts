import { marked } from "marked";
import { afterEach, expect, test, vi } from "vitest";
import {
  normalizeBlockSpacing,
  protectRichTextRoundTripMarkdown,
} from "./markdown";

afterEach(() => vi.restoreAllMocks());

test("LF spacing normalization does not allocate an identity offset for every source character", () => {
  const padding = "Ordinary unchanged prose.\n\n".repeat(1000);
  const markdown =
    "# Offset resource\n\nOutside.\n\n\n```text\n# literal heading\n\n\nKeep this gap.\n```\n\n" +
    padding;
  const expected =
    "# Offset resource\nOutside.\n\n```text\n# literal heading\n\n\nKeep this gap.\n```\n\n" +
    padding;
  const push = Array.prototype.push;
  let numericOffsets = 0;
  Array.prototype.push = function (...values) {
    numericOffsets += values.filter(
      (value) => typeof value === "number",
    ).length;
    return push.apply(this, values);
  };
  let actual: string;
  try {
    actual = normalizeBlockSpacing(markdown);
  } finally {
    Array.prototype.push = push;
  }
  expect(actual).toBe(expected);
  expect(
    numericOffsets,
    "LF source positions are already identical to lexer positions",
  ).toBeLessThan(1000);
});

test.each([
  "\n",
  "\r\n",
  "\r",
])("spacing and round-trip protection retain nested code and link context (%j)", (newline) => {
  const source = [
    "# Source boundaries",
    "",
    "Read [the reference][r] and `literal  code`.",
    "",
    "",
    "> ```text",
    "> # literal heading",
    ">",
    ">",
    "> Keep quoted spacing.",
    "> ```",
    "",
    "- List `literal`.",
    "",
    "    # indented literal",
    "",
    "    End of literal.",
    "",
    "~~~text",
    "# fenced literal",
    "",
    "",
    "Keep fenced spacing.",
    "~~~",
    "",
    '[r]: ./next.md "A reference"',
    "",
  ].join(newline);
  const expected =
    newline === "\n"
      ? source
          .replace("# Source boundaries\n\n", "# Source boundaries\n")
          .replace("`literal  code`.\n\n\n", "`literal  code`.\n\n")
      : source;
  expect(normalizeBlockSpacing(source)).toBe(expected);
  const protectedSource = protectRichTextRoundTripMarkdown(source);
  if (newline === "\r") {
    // Keep the existing lone-CR preprocessing outcome. This performance
    // change only bypasses identity offsets for LF; it does not repair CR.
    expect(protectedSource).toBe(
      [
        "> ```text",
        "> # literal heading",
        ">",
        ">",
        "> Keep quoted spacing.",
        "> ```",
      ].join(newline) +
        [
          "~~~text",
          "# fenced literal",
          "",
          "",
          "Keep fenced spacing.",
          "~~~",
        ].join(newline),
    );
    return;
  }
  expect(protectedSource).toContain("[r]: ./next.md");
  expect(protectedSource).toContain(
    ["~~~text", "# fenced literal", "", "", "Keep fenced spacing.", "~~~"].join(
      newline,
    ),
  );
  expect(protectedSource).toContain("`literal  code`");
  expect(protectedSource).toContain(
    [
      "> ```text",
      "> # literal heading",
      ">",
      ">",
      "> Keep quoted spacing.",
      "> ```",
    ].join(newline),
  );
});

test("side-effect-only Markdown literal walks do not accumulate callback results", () => {
  const source = [
    "# Token resources",
    "",
    "| Value |",
    "| --- |",
    "| `two  spaces` |",
    "",
    "- Item `list  literal`.",
    "",
    "  ```text",
    "  # literal heading",
    "",
    "",
    "  Keep this gap.",
    "  ```",
    "",
  ].join("\n");
  const walk = vi.spyOn(marked, "walkTokens");
  expect(normalizeBlockSpacing(source)).toBe(
    source.replace("# Token resources\n\n", "# Token resources\n"),
  );
  expect(walk.mock.results.length).toBeGreaterThan(0);
  expect(walk.mock.results.every((result) => !result.value.length)).toBe(true);
});
