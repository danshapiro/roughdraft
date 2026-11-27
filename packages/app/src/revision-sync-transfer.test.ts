import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanRoughdraftMarkdown } from "@roughdraft/rfm";
import { expect, test } from "vitest";
import { transferSyncResponse } from "../../server/src/comparison-sync-transfer";
import type { ComparisonReviewData } from "./comparison-types";
import {
  receiveSyncResponse,
  receiveSyncState,
} from "./revision-sync-transfer";

const review = {
  id: "review",
  beforeText: "Exact original.\r\n",
  afterText: "Exact revised.\r\n",
  segments: [{ id: "original-change" }],
  revision: 1,
  destinationPath: "/original.md",
} as unknown as ComparisonReviewData;
const draft = {
  markdown: "New working text.\n",
  cleanMarkdown: "New working text.\n",
  decisions: {},
  reviewComments: [{ id: "c1", content: "Saved feedback" }],
};

test("compact updates retain frozen references while replacing mutable feedback and file guards", () => {
  const received = receiveSyncState(
    {
      reviewFormat: "compact-v1",
      review: {
        id: "review",
        revision: 2,
        destinationPath: "/moved.md",
        savedText: "Exact saved file.\r\n",
      },
      draft,
      revision: 2,
      disk: { path: "/moved.md", version: "latest" },
      diskTextFromReview: true,
      signature: "latest",
    },
    review,
  );
  expect(received.review.beforeText).toBe(review.beforeText);
  expect(received.review.afterText).toBe(review.afterText);
  expect(received.review.segments).toBe(review.segments);
  expect(received.review.destinationPath).toBe("/moved.md");
  expect(received.review.revision).toBe(2);
  expect(received.review.reviewComments).toEqual(draft.reviewComments);
  expect(received.review.draft).toEqual(draft);
  expect(received.disk?.version).toBe("latest");
  expect(received.disk?.text).toBe("Exact saved file.\r\n");
});

test("a compact update cannot reuse another review's frozen references", () => {
  expect(() =>
    receiveSyncState(
      {
        reviewFormat: "compact-v1",
        review: { id: "another-review" },
        draft,
      },
      review,
    ),
  ).toThrow(/different review/i);
});

test("full old-server and new-copy states remain self-contained", () => {
  const full = {
    review: { ...review, id: "copy", beforeText: "Copy original" },
    draft,
  };
  expect(receiveSyncState(full, review)).toBe(full);
});

test("a compact update cannot replace changed references with stale ones", () => {
  expect(() =>
    receiveSyncState(
      {
        reviewFormat: "compact-v1",
        review: { id: review.id, referenceVersion: "different-reference" },
        draft,
      },
      { ...review, referenceVersion: "original-reference" },
    ),
  ).toThrow(/references changed/i);
});

const previous = {
  ...review,
  referenceVersion: "frozen-reference",
  savedText: "An older saved file.\n",
};
function fullState(
  savedText: string | null | undefined,
  diskText: string | null,
) {
  return {
    review: {
      ...previous,
      revision: 2,
      editor: "unified",
      savedText,
      draft,
      reviewComments: draft.reviewComments,
      outdatedSuggestions: [],
    },
    draft,
    revision: 2,
    signature: "current",
    registryGeneration: "current-registry",
    operationContext: { owner: "owner", epoch: "epoch", acceptUntil: 1000 },
    disk: {
      path: "/original.md",
      version: "version-2",
      hash: "hash-2",
      availability: "available",
      text: diskText,
    },
  };
}
function v2Packet(
  full: ReturnType<typeof fullState>,
  savedTextFromDraft: boolean,
  diskTextFromReview: boolean,
) {
  const {
    beforeText: _before,
    afterText: _after,
    segments: _segments,
    draft: _draft,
    reviewComments: _comments,
    outdatedSuggestions: _outdated,
    ...mutable
  } = full.review;
  return JSON.parse(
    JSON.stringify({
      ...full,
      review: savedTextFromDraft
        ? { ...mutable, savedText: undefined }
        : mutable,
      reviewFormat: "compact-v2",
      ...(savedTextFromDraft ? { savedTextFromDraft: true } : {}),
      disk: diskTextFromReview ? { ...full.disk, text: undefined } : full.disk,
      ...(diskTextFromReview ? { diskTextFromReview: true } : {}),
    }),
  );
}
function withoutTransferFlags(received: ReturnType<typeof receiveSyncState>) {
  const {
    reviewFormat: _format,
    savedTextFromDraft: _saved,
    diskTextFromReview: _disk,
    ...state
  } = received as ReturnType<typeof receiveSyncState> & {
    reviewFormat?: string;
    savedTextFromDraft?: boolean;
    diskTextFromReview?: boolean;
  };
  return state;
}

test.each([
  "both aliases",
  "source drift",
  "different saved text",
  "undefined saved text",
  "null saved text",
] as const)("compact-v2 restores the complete state without borrowing an old save: %s", (scenario) => {
  const saved =
    scenario === "different saved text"
      ? "The actual earlier saved file.\r\n"
      : scenario === "undefined saved text"
        ? undefined
        : scenario === "null saved text"
          ? null
          : draft.cleanMarkdown;
  const diskText =
    scenario === "source drift" ? "New on-disk contents.\r\n" : (saved ?? null);
  const full = fullState(saved, diskText);
  const packet = v2Packet(
    full,
    saved === draft.cleanMarkdown,
    typeof saved === "string" && diskText === saved,
  );
  const before = JSON.stringify(packet);
  const received = receiveSyncState(packet, previous);
  expect(withoutTransferFlags(received)).toEqual(
    JSON.parse(JSON.stringify(full)),
  );
  expect(received.review.savedText).toBe(saved);
  expect(received.disk?.text).toBe(diskText);
  expect(received.review.beforeText).toBe(previous.beforeText);
  expect(received.review.segments).toBe(previous.segments);
  expect(JSON.stringify(packet)).toBe(before);
  const serverWire = JSON.parse(
    JSON.stringify(
      transferSyncResponse(
        full,
        previous.id,
        previous.referenceVersion,
        "compact-v2",
      ),
    ),
  );
  expect(withoutTransferFlags(receiveSyncState(serverWire, previous))).toEqual(
    JSON.parse(JSON.stringify(full)),
  );
});

test("compact-v2 falls back to literal Markdown when a clean projection is absent", () => {
  const full = fullState(
    "Literal unprojected source.\r\n",
    "Literal unprojected source.\r\n",
  );
  full.draft = {
    ...draft,
    markdown: "Literal unprojected source.\r\n",
    cleanMarkdown: undefined,
  } as typeof draft;
  const packet = v2Packet(full, true, true);
  const received = receiveSyncState(packet, previous);
  expect(received.review.savedText).toBe("Literal unprojected source.\r\n");
  expect(received.disk?.text).toBe(received.review.savedText);
});

test.each([
  "missing draft",
  "missing source",
  "missing Markdown only",
  "missing feedback",
  "conflicting saved text",
  "missing disk",
  "conflicting disk",
] as const)("compact-v2 rejects an incomplete or inconsistent alias: %s", (scenario) => {
  const packet = v2Packet(
    fullState(draft.cleanMarkdown, draft.cleanMarkdown),
    true,
    true,
  );
  if (scenario === "missing draft") delete packet.draft;
  if (scenario === "missing source") {
    delete packet.draft.markdown;
    delete packet.draft.cleanMarkdown;
  }
  if (scenario === "missing Markdown only") delete packet.draft.markdown;
  if (scenario === "missing feedback") delete packet.draft.reviewComments;
  if (scenario === "conflicting saved text")
    packet.review.savedText = "Different actual saved text.";
  if (scenario === "missing disk") packet.disk = null;
  if (scenario === "conflicting disk")
    packet.disk.text = "Different actual disk text.";
  expect(() => receiveSyncState(packet, previous)).toThrow(
    /incomplete|inconsistent/i,
  );
});

test.each([
  "wrong review",
  "changed references",
] as const)("compact-v2 keeps its frozen-reference guards: %s", (scenario) => {
  const packet = v2Packet(
    fullState(draft.cleanMarkdown, draft.cleanMarkdown),
    true,
    true,
  );
  if (scenario === "wrong review") packet.review.id = "another-review";
  else packet.review.referenceVersion = "changed-reference";
  expect(() => receiveSyncState(packet, previous)).toThrow(
    /different review|references changed/i,
  );
});

test("a real server-encoded v2 packet removes only duplicate saved text and round-trips through JSON", () => {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const metadataAt = fixture.lastIndexOf("\n---\n");
  const markdown =
    `${fixture.slice(0, metadataAt)}\n${"Unchanged reading distance for the maintained review.\n\n".repeat(2000)}${fixture.slice(metadataAt)}`.replaceAll(
      "\n",
      "\r\n",
    );
  const source = cleanRoughdraftMarkdown(markdown);
  const full = fullState(source, source);
  full.draft = { ...draft, markdown, cleanMarkdown: source };
  full.review = { ...full.review, draft: full.draft };
  const before = JSON.stringify(full);
  const v1 = JSON.parse(
    JSON.stringify(
      transferSyncResponse(
        full,
        previous.id,
        previous.referenceVersion,
        "compact-v1",
      ),
    ),
  );
  const v2 = JSON.parse(
    JSON.stringify(
      transferSyncResponse(
        full,
        previous.id,
        previous.referenceVersion,
        "compact-v2",
      ),
    ),
  );
  expect(v1.reviewFormat).toBe("compact-v1");
  expect(v1.review.savedText).toBe(source);
  expect(v2.reviewFormat).toBe("compact-v2");
  expect(v2.savedTextFromDraft).toBe(true);
  expect(v2.review.savedText).toBeUndefined();
  expect(withoutTransferFlags(receiveSyncState(v1, previous))).toEqual(full);
  expect(withoutTransferFlags(receiveSyncState(v2, previous))).toEqual(full);
  expect(JSON.stringify(v1).length - JSON.stringify(v2).length).toBeGreaterThan(
    source.length,
  );
  process.stdout.write(
    `${JSON.stringify({ severity: "info", event: "compact-v2-wire", sourceBytes: Buffer.byteLength(source), v1Bytes: Buffer.byteLength(JSON.stringify(v1)), v2Bytes: Buffer.byteLength(JSON.stringify(v2)) })}\n`,
  );
  expect(JSON.stringify(full)).toBe(before);
});

test("old-server full responses and a lost copy result remain self-contained under the new negotiation", () => {
  const full = fullState("Copy contents.\r\n", "Copy contents.\r\n");
  full.review = {
    ...full.review,
    id: "saved-copy",
    beforeText: "Copy original.\r\n",
    afterText: "Copy final.\r\n",
  };
  const result = {
    status: "committed",
    savedPath: "/copies/separate.md",
    reviewUrl: "/?comparison=saved-copy",
    state: full,
  };
  const wire = JSON.parse(
    JSON.stringify(
      transferSyncResponse(
        result,
        previous.id,
        previous.referenceVersion,
        "compact-v2",
      ),
    ),
  );
  expect(wire.state.reviewFormat).toBeUndefined();
  expect(receiveSyncResponse(wire, previous)).toEqual(result);
  expect(
    receiveSyncResponse(JSON.parse(JSON.stringify(full)), previous),
  ).toEqual(full);
});
