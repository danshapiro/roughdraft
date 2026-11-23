// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  cleanRevisionDocument,
  cleanRevisionMarkdown,
  createSourceSpellingPreserver,
} from "./revision-markdown";

describe("Markdown written or exported from a review", () => {
  it("keeps original wording until suggestions are kept", () => {
    expect(
      cleanRevisionMarkdown(
        "# Notes\n\nKeep {--this--} and {~~old~>new~~}{++ extra++}. {>>Feedback<<}\n",
      ),
    ).toBe("# Notes\nKeep this and old.\n");
  });

  it("preserves exact clean source and unrelated Markdown metadata", () => {
    const clean = "---\r\nname: example\r\n---\r\n\r\n* one\r\n* two";
    expect(cleanRevisionMarkdown(clean)).toBe(clean);
    expect(
      cleanRevisionMarkdown(
        "# Notes\n\n{++new++}{#s1}Old\n\n---\nother: true\nsuggestions:\n  s1:\n    by: User\n    at: 2026-11-18T00:00:00Z\n",
      ),
    ).toBe("# Notes\nOld\n\n---\nother: true\n");
  });
  it("excludes a pending multi-block change without losing adjacent text or metadata", () => {
    const source =
      '---\nname: example\n---\n\nUnchanged lead {~~Original first.\n\n- Original feature~>Proposed first.\n\n- Proposed feature~~}{#s24} unchanged tail.\n\nEdited neighbor.\n\n---\nother: true\nsuggestions:\n  s24:\n    by: AI\n    at: "2026-11-19T05:13:01.272Z"\n';
    const expected = criticMarkdownToEditorState(
      "---\nname: example\n---\n\nUnchanged lead Original first.\n\n- Original feature unchanged tail.\n\nEdited neighbor.\n",
    );
    expect(cleanRevisionMarkdown(source)).toBe(
      `${editorStateToCriticMarkdown(expected.doc, new Map()).trimEnd()}\n\n---\nother: true\n`,
    );
  });

  it("omits an unkept suggestion consisting only of a fenced code block", () => {
    expect(
      cleanRevisionMarkdown(
        "Start.\n\n{++```js\nconst proposed = 1;\n```++}\n\nEnd.\n",
      ),
    ).toBe("Start.\n\nEnd.\n");
  });
});

describe("preserving original Markdown when saving comparison choices", () => {
  it("keeps the original line endings and list markers when applying distant wording changes", () => {
    const original =
      "# Notes\r\n\r\n* Red apple\r\n* Leave this line.\r\n* Green pear\r\n";
    const canonical =
      "# Notes\n- Red apple\n- Leave this line.\n- Green pear\n";
    const preserve = createSourceSpellingPreserver(original, canonical);

    expect(preserve(canonical)).toBe(original);
    expect(
      preserve(
        canonical
          .replace("Red apple", "Blue plum")
          .replace("Green pear", "Fig"),
      ),
    ).toBe("# Notes\r\n\r\n* Blue plum\r\n* Leave this line.\r\n* Fig\r\n");
  });

  it("declines to apply a change across source it cannot map safely", () => {
    const preserve = createSourceSpellingPreserver(
      "* Keep wording\n",
      "- Keep wording\n",
    );
    expect(preserve("Keep wording\n")).toBeNull();
  });

  it("keeps unrelated source spelling when a paragraph rewrite exhausts the detailed diff", () => {
    const opening = "a".repeat(2_200);
    const rewritten = "b".repeat(2_200);
    const original = `# Notes\r\n\r\n* Keep this marker.\r\n\r\n${opening}\r\n\r\nFooter.\r\n`;
    const canonical = `# Notes\n- Keep this marker.\n\n${opening}\n\nFooter.\n`;
    const preserve = createSourceSpellingPreserver(original, canonical);

    expect(preserve(canonical.replace(opening, rewritten))).toBe(
      original.replace(opening, rewritten),
    );
  }, 15_000);

  it("maps CRLF inside a broad replacement without consuming neighboring source", () => {
    const opening = `${"a".repeat(1_100)}\n${"a".repeat(1_100)}`;
    const rewritten = opening.replaceAll("a", "b");
    const canonical = `- Keep this marker.\n\n${opening}\n\nFooter.\n`;
    const original = `* Keep this marker.\r\n\r\n${opening.replaceAll("\n", "\r\n")}\r\n\r\nFooter.\r\n`;

    expect(
      createSourceSpellingPreserver(
        original,
        canonical,
      )(canonical.replace(opening, rewritten)),
    ).toBe(original.replaceAll("a".repeat(1_100), "b".repeat(1_100)));
  });

  it("consumes complete CRLF pairs when joining lines", () => {
    expect(
      createSourceSpellingPreserver("A\r\n\r\nB\r\n", "A\n\nB\n")("A B\n"),
    ).toBe("A B\r\n");
  });

  it("keeps spelling between distant edits when both detailed comparisons time out", () => {
    const original =
      "Old lead.\r\n\r\n* Keep __this__ marker.\r\n\r\nOld tail.\r\n";
    const canonical = "Old lead.\n- Keep **this** marker.\n\nOld tail.\n";
    const preserve = createSourceSpellingPreserver(original, canonical);
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 100));
    try {
      expect(preserve(canonical.replaceAll("Old", "New"))).toBe(
        original.replaceAll("Old", "New"),
      );
    } finally {
      now.mockRestore();
    }
  });
});

it("formatted clean projection uses the live accepted document without turning split review formatting into a file edit", () => {
  const comment = { type: "commentRef", attrs: { commentIds: ["c1"] } };
  const bold = { type: "bold" };
  const sourceMetadata = {
    frontmatter: "---\ntitle: Preserve this YAML\n---\n\n",
    endmatter:
      '---\nother: true\ncomments:\n  c1:\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n    body: Keep this note.\n',
  };
  const original = {
    type: "doc",
    attrs: { sourceMetadata },
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Alpha beta", marks: [comment, bold] }],
      },
    ],
  };
  const change = {
    type: "criticChange",
    attrs: {
      kind: "addition",
      changeId: "s1",
      authorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const proposed = {
    ...original,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Alpha ", marks: [comment, bold] },
          { type: "text", text: "New ", marks: [comment, bold, change] },
          { type: "text", text: "beta", marks: [comment, bold] },
        ],
      },
    ],
  };
  const clean = cleanRevisionDocument(proposed);
  expect(clean).toBe(cleanRevisionDocument(original));
  expect(clean).toContain("**Alpha beta**");
  expect(clean).toContain("title: Preserve this YAML");
  expect(clean).toContain("other: true");
  expect(clean).not.toContain("Keep this note.");
  expect(clean).not.toContain("New");
});

it("a pending-only hydrated update preserves its stored accepted source while actual edits and Keep regenerate it", () => {
  const comment = { type: "commentRef", attrs: { commentIds: ["c1"] } };
  const bold = { type: "bold" };
  const change = {
    type: "criticChange",
    attrs: {
      kind: "addition",
      changeId: "s1",
      authorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const original = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Alpha beta", marks: [comment, bold] }],
      },
    ],
  };
  const pending = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Alpha ", marks: [comment, bold] },
          { type: "text", text: "New ", marks: [comment, bold, change] },
          { type: "text", text: "beta", marks: [comment, bold] },
        ],
      },
    ],
  };
  const comments = new Map([
    [
      "c1",
      {
        id: "c1",
        content: "Keep this note.",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  ]);
  const baseline = {
    markdown: editorStateToCriticMarkdown(pending, comments),
    cleanMarkdown: cleanRevisionDocument(original),
  };
  const hydrated = criticMarkdownToEditorState(baseline.markdown).doc;
  expect(cleanRevisionDocument(hydrated, baseline)).toBe("**Alpha beta**\n");
  expect(
    cleanRevisionDocument(
      criticMarkdownToEditorState("Changed words.\n").doc,
      baseline,
    ),
  ).toBe("Changed words.\n");
  const kept = structuredClone(hydrated);
  for (const node of kept.content?.[0].content ?? [])
    node.marks = node.marks?.filter((mark) => mark.type !== "criticChange");
  expect(cleanRevisionDocument(kept, baseline)).toContain("New");
  expect(
    cleanRevisionDocument(
      {
        ...hydrated,
        attrs: {
          sourceMetadata: {
            frontmatter: "---\ntitle: Changed\n---\n\n",
            endmatter: null,
          },
        },
      },
      baseline,
    ),
  ).toContain("title: Changed");
});
