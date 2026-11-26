import { describe, expect, it } from "vitest";
import { extractRoughdraftReviewIndex } from "./index.js";
import {
  mergeReviewDrafts,
  renumberReviewDraft,
  reviewDraftSignature,
  sameReviewDraft,
} from "./review-merge.js";
import type { SyncDraft } from "./review-sync.js";

const draft = (
  markdown: string,
  extra: Partial<SyncDraft> = {},
): SyncDraft => ({
  markdown,
  cleanMarkdown: markdown,
  decisions: {},
  reviewComments: [],
  ...extra,
});
const comment = (id: string, content: string) => ({
  id,
  changeId: "document",
  content,
  createdAt: "2026-11-26T12:00:00.000Z",
});
const proposal = (body: string, id: string) =>
  `${body}\n\n---\nsuggestions:\n  ${id}:\n    by: AI\n    at: "2026-11-26T12:00:00.000Z"\n`;

describe("review three-way reconciliation", () => {
  it("materializes the same undated original comment once using its committed import date", () => {
    const markdown = "{==Text==}{>>An imported comment<<}{#c1}\n";
    const base = draft(markdown);
    const left = {
      ...comment("c1", "An imported comment"),
      createdAt: "2026-11-26T12:00:01.000Z",
    };
    const right = { ...left, createdAt: "2026-11-26T12:00:00.000Z" };
    const result = mergeReviewDrafts(
      base,
      draft(markdown, { reviewComments: [left] }),
      draft(markdown, { reviewComments: [right] }),
    );
    expect(result.status).toBe("merged");
    expect(result.idRemap).toBeUndefined();
    expect(result.draft.reviewComments).toEqual([right]);
  });

  it("keeps an explicitly changed date on imported feedback as a metadata conflict", () => {
    const markdown =
      '{==Text==}{>>An imported comment<<}{#c1}\n\n---\ncomments:\n  c1:\n    at: "2026-11-26T12:00:00.000Z"\n';
    const base = draft(markdown, {
      reviewComments: [comment("c1", "An imported comment")],
    });
    const local = draft(markdown.replace("12:00:00", "12:00:01"), {
      reviewComments: [
        { ...base.reviewComments[0], createdAt: "2026-11-26T12:00:01.000Z" },
      ],
    });
    const incoming = draft(markdown.replace("12:00:00", "12:00:02"), {
      reviewComments: [
        { ...base.reviewComments[0], createdAt: "2026-11-26T12:00:02.000Z" },
      ],
    });
    expect(mergeReviewDrafts(base, local, incoming).status).toBe("conflict");
  });

  it.each([
    false,
    true,
  ])("conflicts when one side removes an inline comment that the other edits (reverse=%s)", (reverse) => {
    const base = draft("{==Text==}{>>Original<<}{#c1}\n", {
      cleanMarkdown: "Text\n",
    });
    const removed = draft("Text\n");
    const edited = draft("{==Text==}{>>Revised<<}{#c1}\n", {
      cleanMarkdown: "Text\n",
    });
    const result = mergeReviewDrafts(
      base,
      reverse ? edited : removed,
      reverse ? removed : edited,
    );
    expect(result.status).toBe("conflict");
  });

  it("preserves both independent edits and exact untouched CRLF spelling", () => {
    const base = draft("* First paragraph.\r\n\r\nSecond paragraph.\r\n");
    const local = draft(base.markdown.replace("First", "Local"));
    const incoming = draft(base.markdown.replace("Second", "Incoming"));
    const result = mergeReviewDrafts(base, local, incoming);
    expect(result.status).toBe("merged");
    expect(result.draft.markdown).toBe(
      "* Local paragraph.\r\n\r\nIncoming paragraph.\r\n",
    );
    expect(result.draft.cleanMarkdown).toBe(result.draft.markdown);
  });

  it("merges edits to separate words in the same paragraph", () => {
    const result = mergeReviewDrafts(
      draft("The red fox sees a blue bird.\n"),
      draft("The green fox sees a blue bird.\n"),
      draft("The red fox sees a yellow bird.\n"),
    );
    expect(result.status).toBe("merged");
    expect(result.draft.markdown).toBe("The green fox sees a yellow bird.\n");
  });

  it("resolves only overlaps and retains independent work on both sides", () => {
    const base = draft("Color is red.\n\nFirst stays.\n\nSecond stays.\n");
    const local = draft(
      base.markdown
        .replace("red", "green")
        .replace("First stays", "Local addition"),
    );
    const incoming = draft(
      base.markdown
        .replace("red", "blue")
        .replace("Second stays", "Incoming addition"),
    );
    const pending = mergeReviewDrafts(base, local, incoming);
    expect(pending.status).toBe("conflict");
    expect(pending.conflicts).toHaveLength(1);
    expect(pending.draft.markdown).toContain("Local addition");
    expect(pending.draft.markdown).toContain("Incoming addition");
    const resolved = mergeReviewDrafts(base, local, incoming, {
      resolution: "incoming",
    });
    expect(resolved.status).toBe("merged");
    expect(resolved.signature).toBe(pending.signature);
    expect(resolved.draft.markdown).toBe(
      "Color is blue.\n\nLocal addition.\n\nIncoming addition.\n",
    );
  });

  it("merges YAML by key while preserving untouched quotes, comments and spacing", () => {
    const original =
      '---\ntitle: "Keep quotes"  # keep comment\ncount: 1\nstatus: open\n---\n\nText.\n';
    const result = mergeReviewDrafts(
      draft(original),
      draft(original.replace("count: 1", "count: 2")),
      draft(original.replace("status: open", "status: ready")),
    );
    expect(result.status).toBe("merged");
    expect(result.draft.markdown).toBe(
      original
        .replace("count: 1", "count: 2")
        .replace("status: open", "status: ready"),
    );
  });

  it("keeps two comments and a reply when each side appended at the same point", () => {
    const base = draft("Text.\n");
    const result = mergeReviewDrafts(
      base,
      draft(base.markdown, { reviewComments: [comment("c1", "Local")] }),
      draft(base.markdown, {
        reviewComments: [
          comment("c2", "Incoming"),
          { ...comment("c3", "Reply"), parentCommentId: "c2" },
        ],
      }),
    );
    expect(result.status).toBe("merged");
    expect(result.draft.reviewComments.map((entry) => entry.id)).toEqual([
      "c2",
      "c3",
      "c1",
    ]);
  });

  it("never server-renumbers a simultaneous new suggestion", () => {
    const base = draft("First.\n\nSecond.\n");
    const local = draft(
      proposal("First {++local++}{#s13}.\n\nSecond.", "s13"),
      { cleanMarkdown: base.markdown },
    );
    const incoming = draft(
      proposal("First.\n\nSecond {++incoming++}{#s13}.", "s13"),
      { cleanMarkdown: base.markdown },
    );
    const result = mergeReviewDrafts(base, local, incoming, { server: true });
    expect(result.status).toBe("client-merge-required");
    expect(result.draft).toEqual(local);
    expect(result.idRemap).toBeUndefined();
  });

  it("browser-renumbers new suggestions and independently merges endmatter entries", () => {
    const base = draft("First.\n\nSecond.\n");
    const local = draft(proposal("First {++local++}{#s13}.\n\nSecond.", "s13"));
    const incoming = draft(
      proposal("First.\n\nSecond {++incoming++}{#s13}.", "s13"),
    );
    const result = mergeReviewDrafts(base, local, incoming, { server: false });
    expect(result.status).toBe("merged");
    expect(result.idRemap).toEqual({ s13: "s14" });
    const index = extractRoughdraftReviewIndex(result.draft.markdown);
    expect(index.items.map((item) => [item.id, item.text])).toEqual([
      ["s14", "local"],
      ["s13", "incoming"],
    ]);
    expect(
      index.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
  });

  it("renumbers parsed references and sidecar targets without rewriting literal examples", () => {
    const source =
      '{==Text==}{>>Local<<}{#c5}\n\n`{#c5}`\n\n```md\n{++example++}{#s13}\n```\n\n---\ncomments:\n  c5:\n    by: AI\n    at: "2026-11-26T12:00:00.000Z"\n  c6:\n    body: Reply\n    re: c5\n    by: AI\n    at: "2026-11-26T12:00:00.000Z"\n';
    const result = renumberReviewDraft(
      draft(source, {
        reviewComments: [
          comment("c5", "Local"),
          { ...comment("c6", "Reply"), parentCommentId: "c5" },
        ],
        decisions: { c5: "kept" },
      }),
      { c5: "c7" },
    );
    expect(result.markdown).toContain("{>>Local<<}{#c7}");
    expect(result.markdown).toContain("`{#c5}`");
    expect(result.markdown).toContain("{++example++}{#s13}");
    expect(result.markdown).toContain("re: c7");
    expect(result.markdown).toContain("  c7:");
    expect(result.reviewComments[1].parentCommentId).toBe("c7");
    expect(result.decisions).toEqual({ c7: "kept" });
  });

  it("canonical signatures normalize nullable fields and object-key order", () => {
    const a = draft("Text", {
      decisions: { s1: "kept", s2: "kept" },
      reviewComments: [comment("c1", "Hi")],
    });
    const b = draft("Text", {
      decisions: { s2: "kept", s1: "kept" },
      reviewComments: [
        { ...comment("c1", "Hi"), parentCommentId: null, authorId: null },
      ],
    });
    expect(sameReviewDraft(a, b)).toBe(true);
    expect(reviewDraftSignature(a)).toBe(reviewDraftSignature(b));
    expect(reviewDraftSignature(draft("Different"))).not.toBe(
      reviewDraftSignature(a),
    );
  });

  it("never guesses clean text for an unsupported browser projection", () => {
    const base = draft("First.\n\nSecond.\n", {
      cleanMarkdown: "Browser baseline",
    });
    const local = { ...base, markdown: "Local.\n\nSecond.\n" };
    const incoming = { ...base, markdown: "First.\n\nIncoming.\n" };
    expect(
      mergeReviewDrafts(base, local, incoming, { server: true }).status,
    ).toBe("client-merge-required");
    expect(
      mergeReviewDrafts(base, local, incoming, { server: false }).draft
        .cleanMarkdown,
    ).toBeUndefined();
    expect(
      mergeReviewDrafts(base, local, incoming, {
        projectedCleanMarkdown: "Browser result",
      }).draft.cleanMarkdown,
    ).toBe("Browser result");
  });

  it("preflights large server inputs and an exhausted budget", () => {
    const large = draft("unchanged\n".repeat(10_000));
    expect(
      mergeReviewDrafts(large, large, large, { server: true }).status,
    ).toBe("client-merge-required");
    expect(
      mergeReviewDrafts(draft("a"), draft("b"), draft("c"), { budgetMs: 0 })
        .status,
    ).toBe("client-merge-required");
  });

  it.each([
    false,
    true,
  ])("keeps an explicitly added null YAML value distinct from a missing key (reverse=%s)", (reverse) => {
    const base = draft("---\na: 1\n---\nText.\n");
    const added = draft(base.markdown.replace("a: 1", "a: 1\nadded: null"));
    const edited = draft(base.markdown.replace("a: 1", "a: 2"));
    const result = mergeReviewDrafts(
      base,
      reverse ? edited : added,
      reverse ? added : edited,
    );
    expect(result.status).toBe("merged");
    expect(result.draft.markdown).toContain("added: null");
    expect(result.draft.markdown).toContain("a: 2");
  });

  it("deduplicates an identical new comment across API nullable normalization", () => {
    const base = draft("Text.");
    const local = { ...base, reviewComments: [comment("c5", "Same")] };
    const incoming = {
      ...base,
      reviewComments: [
        { ...comment("c5", "Same"), parentCommentId: null, authorId: null },
      ],
    };
    const result = mergeReviewDrafts(base, local, incoming);
    expect(result.status).toBe("merged");
    expect(result.idRemap).toBeUndefined();
    expect(result.draft.reviewComments).toHaveLength(1);
  });

  it("keeps both independent threads attached to the same selected passage", () => {
    const registry = (id: string, text: string) =>
      `{==Text==}{>>${text}<<}{#${id}}.\n\n---\ncomments:\n  ${id}:\n    by: AI\n    at: "2026-11-26T12:00:00.000Z"\n`;
    const result = mergeReviewDrafts(
      draft("Text.\n"),
      draft(registry("c1", "Local")),
      draft(registry("c2", "Incoming")),
    );
    expect(result.status).toBe("merged");
    const items = extractRoughdraftReviewIndex(result.draft.markdown).items;
    expect(items.map((item) => item.id).sort()).toEqual(["c1", "c2"]);
    expect(items.every((item) => item.anchorText === "Text")).toBe(true);
    expect(result.draft.markdown.match(/\{==Text==\}/g)).toHaveLength(1);
  });

  it("keeps a real comment edit/delete conflict while merging an unrelated reply", () => {
    const before = comment("c1", "Original");
    const base = draft("Text.", { reviewComments: [before] });
    const result = mergeReviewDrafts(
      base,
      { ...base, reviewComments: [] },
      {
        ...base,
        reviewComments: [
          { ...before, content: "Edited" },
          { ...comment("c2", "Reply"), parentCommentId: "c1" },
        ],
      },
    );
    expect(result.status).toBe("conflict");
    expect(result.conflicts.some((item) => item.kind === "comment")).toBe(true);
    expect(result.draft.reviewComments.some((item) => item.id === "c2")).toBe(
      true,
    );
  });

  it("marks shifted History as needing browser validation without clearing genuine staleness", () => {
    const change = {
      id: "decision-1",
      decision: "accept" as const,
      oldText: "Old",
      newText: "New",
      inverse: [],
      guard: { from: 1, to: 4, slice: {} },
    };
    const base = draft("New.\n", { reviewed: [change] });
    const incoming = draft("Prefix.\n\nNew.\n", { reviewed: [change] });
    const result = mergeReviewDrafts(base, base, incoming);
    expect(result.draft.reviewed?.[0]).toMatchObject({
      stale: true,
      staleReason: "needs-remap",
      originSignature: expect.any(String),
    });
    const alreadyStale = {
      ...change,
      stale: true,
      staleReason: "edited-passage",
    };
    const stale = mergeReviewDrafts(
      { ...base, reviewed: [alreadyStale] },
      { ...base, reviewed: [alreadyStale] },
      { ...incoming, reviewed: [alreadyStale] },
    );
    expect(stale.draft.reviewed?.[0].staleReason).toBe("edited-passage");
  });

  it("does not invalidate conflict confirmation for an unrelated incoming edit", () => {
    const base = draft("red\n\nKeep.\n");
    const local = draft("green\n\nKeep.\n");
    const first = mergeReviewDrafts(base, local, draft("blue\n\nKeep.\n"));
    const next = mergeReviewDrafts(
      base,
      local,
      draft("blue\n\nIndependent.\n"),
    );
    expect(first.status).toBe("conflict");
    expect(next.status).toBe("conflict");
    expect(next.signature).toBe(first.signature);
    expect(next.draft.markdown).toContain("Independent");
  });

  it("preserves malformed metadata for explicit recovery instead of normalizing it", () => {
    const local = draft("---\nbroken: [\n---\nText.\n");
    const result = mergeReviewDrafts(
      draft("Text.\n"),
      local,
      draft("Incoming.\n"),
    );
    expect(result.status).toBe("client-merge-required");
    expect(result.draft).toEqual(local);
  });

  it("rewrites references inside serialized History source snapshots and marks", () => {
    const markdown =
      '{++Local++}{#s13}\n\n---\nsuggestions:\n  "s13":\n    by: AI\n    at: "2026-11-26T12:00:00.000Z"\n';
    const snapshot = {
      content: [
        {
          type: "text",
          text: "literal s13",
          marks: [
            {
              type: "criticChange",
              attrs: { changeId: "s13", commentIds: ["c5"] },
            },
          ],
        },
      ],
      attrs: {
        sourceMetadata: {
          markdown,
          sourceSpelling: markdown,
          sourceComments: [comment("c5", "Local")],
        },
      },
    };
    const before = draft(markdown, {
      reviewed: [
        {
          id: "decision-1",
          decision: "accept",
          oldText: "Before",
          newText: "Local",
          inverse: [{ stepType: "replace", slice: snapshot }],
          guard: { from: 0, to: 5, slice: snapshot },
          keptId: "s13",
          keptIds: ["s13"],
          metadata: {
            before: {
              frontmatter: null,
              endmatter: '---\nsuggestions:\n  "s13":\n    by: AI\n',
            },
            after: { frontmatter: null, endmatter: null },
          },
        },
      ],
    });
    const next = renumberReviewDraft(before, { s13: "s14", c5: "c7" });
    const stored = JSON.stringify(next.reviewed);
    expect(stored).toContain('"changeId":"s14"');
    expect(stored).toContain('"commentIds":["c7"]');
    expect(stored).toContain('"id":"c7"');
    expect(stored).toContain("{#s14}");
    expect(stored).toContain("literal s13");
    expect(stored).not.toContain('"keptId":"s13"');
    expect(next.markdown).toContain('  "s14":');
  });

  it("preserves legacy metadata spelling while renumbering its parsed ID", () => {
    const source =
      "Read {>>local<<}{@id:c5;by:AI;at:2026-11-26T12:00:00.000Z@}.\n";
    const next = renumberReviewDraft(draft(source), { c5: "c6" });
    expect(next.markdown).toBe(source.replace("id:c5", "id:c6"));
    expect(extractRoughdraftReviewIndex(next.markdown).items[0].id).toBe("c6");
  });

  it("does not rewrite unsupported legacy suggestion syntax as a parsed reference", () => {
    const source =
      "Add {++local++}{@id:s13;by:AI;at:2026-11-26T12:00:00.000Z@}.\n";
    expect(
      extractRoughdraftReviewIndex(source).diagnostics.some(
        (item) => item.severity === "error",
      ),
    ).toBe(true);
    expect(renumberReviewDraft(draft(source), { s13: "s14" }).markdown).toBe(
      source,
    );
  });
});
