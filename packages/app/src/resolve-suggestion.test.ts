import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { splitYamlDocumentMetadata } from "./markdown";
import { resolveSuggestionSource } from "./resolve-suggestion";

const at = "2026-11-19T05:13:01.272Z";

function metadata(id: string, parent?: string) {
  return `{id="${id}" by="AI" at="${at}"${parent ? ` re="${parent}"` : ""}}`;
}

describe("source-preserving suggestion decisions", () => {
  const original =
    "Old first paragraph.\n\nOld second paragraph.\n\n## Features\n\n- Old one\n- Old two";
  const replacement =
    "New first paragraph.\n\nNew second paragraph.\n\n## Features\n\n- New one\n- New two";
  const prefix =
    "# Keep spacing\n\n\nIntroduction with  two spaces.  \nNext line.\n\n";
  const suffix = "\n\n\n## Unrelated\n\n* Keep this marker\n* And this one\n\n";

  it.each([
    "accept",
    "reject",
  ] as const)("%s preserves both the chosen multiline substitution and unrelated source bytes", (decision) => {
    const input = `${prefix}{~~${original}~>${replacement}~~}${metadata("s24")}${suffix}`;

    expect(resolveSuggestionSource(input, "s24", decision)).toBe(
      `${prefix}${decision === "accept" ? replacement : original}${suffix}`,
    );
  });

  it.each([
    { kind: "addition", open: "{++", close: "++}", keep: "accept" },
    { kind: "deletion", open: "{--", close: "--}", keep: "reject" },
  ] as const)("resolves a multiline $kind while preserving surrounding bytes", (change) => {
    const input = `${prefix}${change.open}${original}${change.close}${metadata("s24")}${suffix}`;

    for (const decision of ["accept", "reject"] as const) {
      expect(resolveSuggestionSource(input, "s24", decision)).toBe(
        `${prefix}${decision === change.keep ? original : ""}${suffix}`,
      );
    }
  });

  it("returns the serializer fallback for an unknown or editor-generated identity", () => {
    const input = `Unrelated {++known++}${metadata("s24")}.\n`;

    expect(resolveSuggestionSource(input, "missing", "accept")).toBeNull();
    expect(
      resolveSuggestionSource("Anonymous {++new text++}.\n", "s1", "accept"),
    ).toBeNull();
  });

  it("returns the serializer fallback when the requested suggestion identity is repeated", () => {
    const input = `{++First++}${metadata("s24")} and {--Second--}${metadata("s24")}\n`;

    expect(resolveSuggestionSource(input, "s24", "accept")).toBeNull();
    expect(resolveSuggestionSource(input, "s24", "reject")).toBeNull();
  });

  it("ignores same-ID suggestions in inline and fenced code when finding the real item", () => {
    const examples = [
      `Inline example: \`{++literal++}${metadata("s24")}\`.`,
      "",
      "```md",
      `{~~Literal old\n\nLiteral second~>Literal new~~}${metadata("s24")}`,
      "```",
      "",
    ].join("\n");
    const input = `${examples}Actual {~~old~>new~~}${metadata("s24")} here.\n`;

    expect(resolveSuggestionSource(input, "s24", "accept")).toBe(
      `${examples}Actual new here.\n`,
    );
    expect(resolveSuggestionSource(examples, "s24", "accept")).toBeNull();
  });

  it("removes attached recursive replies while retaining unrelated review items exactly", () => {
    const removedBefore = `{>>Nested reply before the suggestion.<<}${metadata("c2", "c1")}`;
    const removedAfter = `{>>Why this change?<<}${metadata("c1", "s24")}{>>A deeper reply.<<}${metadata("c3", "c2")}`;
    const unrelated = `{==Unrelated anchor==}{>>Keep this comment.<<}${metadata("c9")}{>>Keep this reply.<<}${metadata("c10", "c9")}\n\nOther {++suggestion++}${metadata("s25")}{>>Keep this suggestion reply.<<}${metadata("c11", "s25")}`;
    const input = `Before ${removedBefore}\n\n{~~old~>new~~}${metadata("s24")}${removedAfter}\n\n${unrelated}\n`;

    expect(resolveSuggestionSource(input, "s24", "accept")).toBe(
      `Before \n\nnew\n\n${unrelated}\n`,
    );
  });

  it("uses the editor fallback for a related reply with an independent text anchor", () => {
    const input = `{++new++}${metadata("s24")}\n\n{==Separate anchor==}{>>Why?<<}${metadata("c1", "s24")}\n`;

    expect(resolveSuggestionSource(input, "s24", "accept")).toBeNull();
  });

  it("cleans resolved YAML metadata while preserving frontmatter and unrelated metadata", () => {
    const frontmatter =
      "---\r\ntitle: Preserve this exactly\r\nnotes: 's24 is an example identifier'\r\n---\r\n\r\n";
    const body =
      "# Heading\n\n\n{~~old\n\nparagraph~>new\n\nparagraph~~}{#s24}\n\nKeep {++the other suggestion++}{#s25}.\n\n";
    const endmatter = [
      "---",
      "# Keep this YAML note.",
      "comments:",
      "  c1:",
      "    body: Resolve this reply.",
      "    by: AI",
      `    at: "${at}"`,
      "    re: s24",
      "  c2:",
      "    body: Resolve the nested reply.",
      "    by: AI",
      `    at: "${at}"`,
      "    re: c1",
      "  c9:",
      "    body: Keep the independent document comment.",
      "    by: Nora",
      `    at: "${at}"`,
      "  c10:",
      "    body: Keep its reply.",
      "    by: AI",
      `    at: "${at}"`,
      "    re: c9",
      "suggestions:",
      "  s24:",
      "    by: AI",
      `    at: "${at}"`,
      "  s25:",
      "    by: Nora",
      `    at: "${at}"`,
      "custom:",
      "  release: 's24 must stay in this value'",
      "  enabled: true",
      "",
    ].join("\n");
    const output = resolveSuggestionSource(
      `${frontmatter}${body}${endmatter}`,
      "s24",
      "accept",
    );

    expect(output).not.toBeNull();
    expect(
      output?.startsWith(
        `${frontmatter}# Heading\n\n\nnew\n\nparagraph\n\nKeep {++the other suggestion++}{#s25}.\n\n---\n`,
      ),
    ).toBe(true);
    const parts = splitYamlDocumentMetadata(output ?? "");
    expect(parts.frontmatter).toBe(frontmatter);
    expect(parts.body).toBe(
      "# Heading\n\n\nnew\n\nparagraph\n\nKeep {++the other suggestion++}{#s25}.\n",
    );
    expect(parts.endmatter).toContain("# Keep this YAML note.");
    expect(
      parseYaml((parts.endmatter ?? "").replace(/^---[^\n]*\n/, "")),
    ).toEqual({
      comments: {
        c9: { body: "Keep the independent document comment.", by: "Nora", at },
        c10: { body: "Keep its reply.", by: "AI", at, re: "c9" },
      },
      suggestions: { s25: { by: "Nora", at } },
      custom: { release: "s24 must stay in this value", enabled: true },
    });
  });

  it("removes empty review endmatter after resolving its last suggestion and reply", () => {
    const input = [
      "{++new text++}{#s24}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Remove this reply too.",
      "    by: AI",
      `    at: "${at}"`,
      "    re: s24",
      "suggestions:",
      "  s24:",
      "    by: AI",
      `    at: "${at}"`,
      "",
    ].join("\n");

    expect(resolveSuggestionSource(input, "s24", "accept")).toBe(
      "new text\n\n",
    );
  });
  it("resolves canonical suggestions-only endmatter without requiring a comments section", () => {
    const input = [
      "{~~old text~>new text~~}{#s24}",
      "",
      "---",
      "suggestions:",
      "  s24:",
      "    by: AI",
      `    at: "${at}"`,
      "",
    ].join("\n");

    expect(resolveSuggestionSource(input, "s24", "accept")).toBe(
      "new text\n\n",
    );
    expect(resolveSuggestionSource(input, "s24", "reject")).toBe(
      "old text\n\n",
    );
  });

  it("resolves legacy suggestion metadata with comments-only endmatter and keeps independent comments", () => {
    const body = `{++new text++}${metadata("s24")}\n\n`;
    const endmatter = [
      "---",
      "comments:",
      "  c1:",
      "    body: Remove the suggestion reply.",
      "    by: AI",
      `    at: "${at}"`,
      "    re: s24",
      "  c9:",
      "    body: Keep the independent document comment.",
      "    by: Nora",
      `    at: "${at}"`,
      "",
    ].join("\n");
    const output = resolveSuggestionSource(
      `${body}${endmatter}`,
      "s24",
      "accept",
    );

    expect(output?.startsWith("new text\n\n---\n")).toBe(true);
    const { endmatter: remaining } = splitYamlDocumentMetadata(output ?? "");
    expect(parseYaml((remaining ?? "").replace(/^---[^\n]*\n/, ""))).toEqual({
      comments: {
        c9: { body: "Keep the independent document comment.", by: "Nora", at },
      },
    });
  });

  it.each([
    `{++\u2060++}${metadata("s24")}`,
    `{~~Original paragraph.~>\u2060~~}${metadata("s24")}`,
    `{~~\u2060~>Replacement paragraph.~~}${metadata("s24")}`,
  ])("uses the editor serializer for an inserted-paragraph sentinel in %s", (input) => {
    expect(resolveSuggestionSource(input, "s24", "accept")).toBeNull();
    expect(resolveSuggestionSource(input, "s24", "reject")).toBeNull();
  });
});

it.each([
  "Alpha\n\nbeta gamma.",
  "Alpha  \nbeta gamma.",
])("resolving a framed native block proposal removes framing but preserves actual breaks: %s", (replacement) => {
  const source = `{~~\nAlpha beta gamma.\n~>\n${replacement}\n~~}${metadata("s24")}\n`;
  expect(resolveSuggestionSource(source, "s24", "reject")).toBe(
    "Alpha beta gamma.\n",
  );
  expect(resolveSuggestionSource(source, "s24", "accept")).toBe(
    `${replacement}\n`,
  );
});

it.each([
  "accept",
  "reject",
] as const)("%s of a framed code proposal preserves code newlines, literal markers and unrelated source bytes", (decision) => {
  const oldCode = "```md\n\n  {~~old~>new~~}\n\n```";
  const newCode = "```md\n\n\t{++added++}\n\n```";
  const prefix = "* Preserve this source marker\n\n\n";
  const suffix = "\n\n\nUnrelated tail.\n";
  const source = `${prefix}{~~\n${oldCode}\n~>\n${newCode}\n~~}${metadata("s24")}${suffix}`;
  expect(resolveSuggestionSource(source, "s24", decision)).toBe(
    `${prefix}${decision === "accept" ? newCode : oldCode}${suffix}`,
  );
});

it("source decision framing handles CRLF without changing real line endings", () => {
  const before = "First\r\n\r\nSecond";
  const after = "Revised\r\n\r\nSecond";
  const source = `{~~\r\n${before}\r\n~>\r\n${after}\r\n~~}${metadata("s24")}\r\n`;
  expect(resolveSuggestionSource(source, "s24", "reject")).toBe(
    `${before}\r\n`,
  );
  expect(resolveSuggestionSource(source, "s24", "accept")).toBe(`${after}\r\n`);
});
