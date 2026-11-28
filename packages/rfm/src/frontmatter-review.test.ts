import { expect, test } from "vitest";
import { cleanRoughdraftMarkdown, extractRoughdraftReviewIndex } from "./index";

test("only explicitly registered frontmatter feedback is projected; literal YAML examples remain exact", () => {
  const source =
    "---\r\ntitle: {~~Old~>New~~}{#s1}\r\nexample: '{++literal++}'\r\nowner: {==Dan==}{>><<}{#c1}\r\n---\r\n\r\nBody.\r\n\r\n---\r\ncomments:\r\n  c1:\r\n    by: user\r\n    at: 2026-11-28T01:00:00.000Z\r\n    body: Discuss the title\r\n    frontmatterAnchor: true\r\nsuggestions:\r\n  s1:\r\n    by: user\r\n    at: 2026-11-28T01:00:00.000Z\r\n    frontmatterAnchor: true\r\n";
  expect(cleanRoughdraftMarkdown(source)).toBe(
    "---\r\ntitle: Old\r\nexample: '{++literal++}'\r\nowner: Dan\r\n---\r\n\r\nBody.\r\n",
  );
  const index = extractRoughdraftReviewIndex(source);
  expect(index.items.map((item) => item.id)).toEqual(["s1", "c1"]);
  expect(index.diagnostics).toEqual([]);
});

test("a pending YAML proposal merges with an independent body edit without parsing review markup as YAML", async () => {
  const { mergeReviewDrafts } = await import("./index");
  const clean = "---\ntitle: Old\n---\n\nBody.\n";
  const annotation =
    "---\ntitle: {~~Old~>New~~}{#s1}\n---\n\nBody.\n\n---\nsuggestions:\n  s1:\n    by: user\n    at: 2026-11-28T01:00:00.000Z\n    frontmatterAnchor: true\n";
  const draft = (markdown: string) => ({
    markdown,
    cleanMarkdown: cleanRoughdraftMarkdown(markdown),
    decisions: {},
    reviewComments: [],
  });
  const result = mergeReviewDrafts(
    draft(clean),
    draft(annotation),
    draft(clean.replace("Body.", "Agent changed this body.")),
    { server: true, budgetMs: 1000 },
  );
  expect(result.status).toBe("merged");
  expect(result.draft.markdown).toBe(
    annotation.replace("Body.", "Agent changed this body."),
  );
  expect(result.draft.cleanMarkdown).toBe(
    clean.replace("Body.", "Agent changed this body."),
  );
});

test("browser collision renumbering reserves literal YAML IDs without reinterpreting their examples", async () => {
  const { mergeReviewDrafts } = await import("./index");
  const clean =
    "---\ntitle: Old\nexample: '{++literal++}{#s2}'\n---\n\nBody.\n";
  const local =
    clean.replace("Old", "Old{++ local++}{#s1}") +
    "\n---\nsuggestions:\n  s1:\n    by: user\n    at: 2026-11-28T01:00:00.000Z\n    frontmatterAnchor: true\n";
  const incoming =
    clean.replace("Body.", "Body.{++ remote++}{#s1}") +
    "\n---\nsuggestions:\n  s1:\n    by: AI\n    at: 2026-11-28T01:00:00.000Z\n";
  const draft = (markdown: string) => ({
    markdown,
    cleanMarkdown: cleanRoughdraftMarkdown(markdown),
    decisions: {},
    reviewComments: [],
  });
  const result = mergeReviewDrafts(
    draft(clean),
    draft(local),
    draft(incoming),
    { budgetMs: 1000 },
  );
  expect(result.status).toBe("merged");
  expect(result.idRemap?.s1).toBe("s3");
  expect(result.draft.markdown).toContain("example: '{++literal++}{#s2}'");
  expect(cleanRoughdraftMarkdown(result.draft.markdown)).toBe(clean);
  expect(
    extractRoughdraftReviewIndex(result.draft.markdown)
      .items.map((item) => item.id)
      .sort(),
  ).toEqual(["s1", "s3"]);
});
