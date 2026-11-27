import { expect, test } from "vitest";
import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
} from "./index.js";
import type { SyncDraft } from "./review-sync.js";

const draft = (markdown: string): SyncDraft => ({
  markdown,
  cleanMarkdown: cleanRoughdraftMarkdown(markdown),
  decisions: {},
  reviewComments: [],
});

test.each([
  [
    "fenced code trailing space",
    "```text\ncode \n```\n\n",
    "```text\ncode\n```\n\n",
    "code \n",
  ],
  ["two-space hard break", "Lead.  \n", "Lead.\n", "Lead.  \n"],
])("%s remains meaningful when comparing simultaneous new attachments", (_name, localPrefix, incomingPrefix, preserved) => {
  const annotate = (prefix: string) => `${prefix}Existing {++shared++}{#s1}.

---
suggestions:
  s1:
    by: AI
    at: "2026-11-22T12:00:00.000Z"
`;
  const local = draft(annotate(localPrefix));
  const incoming = draft(annotate(incomingPrefix));
  const result = mergeReviewDrafts(draft("Existing.\n"), local, incoming, {
    server: false,
    budgetMs: 100,
  });
  expect(result.idRemap).toEqual({ s1: "s2" });
  expect(result.status).not.toBe("client-merge-required");
  expect(result.draft.markdown).toContain("{#s2}");
  expect(cleanRoughdraftMarkdown(result.draft.markdown)).toContain(preserved);
});

test.each([
  false,
  true,
])("a document-wide YAML note keeps its identity through an unrelated final paragraph edit (reply=%s)", (withReply) => {
  const body = "First paragraph.\n\nLast paragraph.\n";
  const registry = `
---
comments:
  c1:
    body: A document-wide note.
    by: AI
    at: "2026-11-22T12:00:00.000Z"
${withReply ? '  c2:\n    body: A reply to the document-wide note.\n    re: c1\n    by: AI\n    at: "2026-11-22T12:01:00.000Z"\n' : ""}`;
  const incoming = draft(body + registry);
  const local = draft(
    body.replace("Last paragraph", "Revised final paragraph") + registry,
  );
  const result = mergeReviewDrafts(draft(body), local, incoming, {
    server: false,
    budgetMs: 100,
  });
  expect(result.status).toBe("merged");
  expect(result.idRemap).toBeUndefined();
  const items = extractRoughdraftReviewIndex(result.draft.markdown).items;
  expect(items.map((item) => item.id)).toEqual(
    withReply ? ["c1", "c2"] : ["c1"],
  );
  expect(items.find((item) => item.id === "c1")?.text).toBe(
    "A document-wide note.",
  );
  if (withReply)
    expect(items.find((item) => item.id === "c2")).toMatchObject({
      text: "A reply to the document-wide note.",
      parentId: "c1",
    });
  expect(result.draft.markdown).toContain("Revised final paragraph");
});

test.each([
  ["proposal", "Existing {++shared++}{#s1}", "s1"],
  ["comment", "{==Existing==}{>>shared<<}{#c1}", "c1"],
])("complete frontmatter and nearby review references preserve one shared %s attachment", (_kind, shared, id) => {
  const original = `---
title: Review release proposals
---

# Release plan

Alpha owner: ready.

Beta owner: ready.

${shared}.

---
${id.startsWith("s") ? "suggestions" : "comments"}:
  ${id}:
    by: AI
    at: "2026-11-22T12:00:00.000Z"
`;
  const before = draft(cleanRoughdraftMarkdown(original));
  const incoming = draft(original);
  const updated = original.replace(
    "Beta owner: ready.",
    "Beta owner: ready. {++Agent-b++}{#s2}",
  );
  const agentEntry = '  s2:\n    by: AI\n    at: "2026-11-22T12:05:00.000Z"\n';
  const local = draft(
    id.startsWith("s")
      ? updated.replace("suggestions:\n", `suggestions:\n${agentEntry}`)
      : `${updated}suggestions:\n${agentEntry}`,
  );
  const result = mergeReviewDrafts(before, local, incoming, {
    server: false,
    budgetMs: 100,
  });
  expect(result.status).toBe("merged");
  expect(result.idRemap).toBeUndefined();
  const items = extractRoughdraftReviewIndex(result.draft.markdown).items;
  expect(items.filter((item) => item.id === id)).toHaveLength(1);
  expect(items.find((item) => item.id === id)?.text).toBe("shared");
  expect(items.find((item) => item.id === "s2")?.text).toBe("Agent-b");
  expect(result.draft.markdown).toContain("title: Review release proposals");
});
