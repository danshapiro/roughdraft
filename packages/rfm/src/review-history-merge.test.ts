import { describe, expect, it } from "vitest";
import { mergeReviewDrafts, reviewDraftSignature } from "./review-merge.js";
import type { SyncDraft, SyncHistory } from "./review-sync.js";

function history(delta = 0): SyncHistory {
  return {
    id: "decision-1",
    decision: "accept",
    oldText: "Old",
    newText: "New",
    inverse: [
      {
        stepType: "replace",
        from: 40 + delta,
        to: 43 + delta,
        slice: { content: [{ type: "text", text: "Old" }] },
      },
    ],
    guard: {
      from: 40 + delta,
      to: 43 + delta,
      slice: { content: [{ type: "text", text: "New" }] },
    },
  };
}
const draft = (markdown: string, reviewed = [history()]): SyncDraft => ({
  markdown,
  cleanMarkdown: markdown,
  decisions: {},
  reviewComments: [],
  reviewed,
});
const original = "Alpha unchanged.\n\nBeta unchanged.\n\nUse New.\n";
const base = () => draft(original);
const local = () =>
  draft(original.replace("Alpha", "Alpha local"), [history(6)]);
const incoming = () =>
  draft(original.replace("Beta", "Beta peer"), [history(5)]);

describe("History meaning and derived positions", () => {
  it.each([
    false,
    true,
  ])("merges independent edits above one decision without coordinate conflicts (server=%s)", (server) => {
    const before = [base(), local(), incoming()] as const;
    const snapshot = structuredClone(before);
    const result = mergeReviewDrafts(...before, { server, budgetMs: 1000 });

    expect(result.status).toBe("merged");
    expect(result.conflicts).toEqual([]);
    expect(result.draft.markdown).toBe(
      "Alpha local unchanged.\n\nBeta peer unchanged.\n\nUse New.\n",
    );
    expect(result.draft.reviewed).toHaveLength(1);
    expect(result.draft.reviewed?.[0]).toMatchObject({
      ...history(),
      stale: true,
      staleReason: "needs-remap",
      originSignature: reviewDraftSignature(before[0]),
    });
    expect(before).toEqual(snapshot);
  });

  it("retains permanent staleness while merging an unrelated positional update", () => {
    const left = local();
    left.reviewed = [
      { ...history(6), stale: true, staleReason: "edited-passage" },
    ];
    const result = mergeReviewDrafts(base(), left, incoming());
    expect(result.status).toBe("merged");
    expect(result.draft.reviewed?.[0]).toMatchObject({
      stale: true,
      staleReason: "edited-passage",
    });
  });

  it("allows reopening a decision while another page only remaps its positions", () => {
    const left = base();
    left.reviewed = [];
    const result = mergeReviewDrafts(base(), left, incoming());
    expect(result.status).toBe("merged");
    expect(result.draft.reviewed ?? []).toEqual([]);
  });

  it("still guards competing changes to the decision's actual text", () => {
    const left = local();
    const right = incoming();
    left.reviewed = [{ ...history(6), newText: "Local replacement" }];
    right.reviewed = [{ ...history(5), newText: "Peer replacement" }];
    const result = mergeReviewDrafts(base(), left, right);
    expect(result.status).toBe("conflict");
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "history",
          label: "history:decision-1.newText",
        }),
      ]),
    );
  });

  it("still guards deleting a decision against changing its meaning", () => {
    const left = base();
    left.reviewed = [];
    const right = incoming();
    right.reviewed = [{ ...history(5), decision: "reject" }];
    expect(mergeReviewDrafts(base(), left, right).status).toBe("conflict");
  });
});
