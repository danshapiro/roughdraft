import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import {
  decodeBrowserRecovery,
  encodeBrowserRecovery,
} from "./revision-browser-recovery";
import { cleanRevisionSourceMarkdown } from "./revision-markdown";
import type {
  BrowserRecovery,
  PendingOperation,
  RevisionDraft,
} from "./revision-session";

function largeRecovery(): BrowserRecovery {
  const fixture = readFileSync(
    resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const endmatter = fixture.lastIndexOf("\n---\n");
  const padding = Array.from(
    { length: 1000 },
    (_, index) =>
      `Stable paragraph ${index}: the release plan and its review stay intact while independent writers type.`,
  ).join("\n\n");
  const markdown = `${fixture.slice(0, endmatter)}\n\n${padding}\n\nLive owner A: unchanged.\n\nLive owner B: unchanged.\n${fixture.slice(endmatter)}`;
  const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
  const base: RevisionDraft = {
    markdown: crlf(markdown),
    cleanMarkdown: crlf(cleanRevisionSourceMarkdown(markdown)),
    decisions: {},
    reviewComments: [
      {
        id: "c13",
        changeId: "document",
        content: "Saved comment with literal {++text++} and 👩🏽‍💻.",
        createdAt: "2026-11-26T12:00:00.000Z",
      },
    ],
  };
  const edit = (a: string, b: string): RevisionDraft => ({
    ...base,
    markdown: base.markdown
      .replace("A: unchanged.", `A: unchanged.${a}`)
      .replace("B: unchanged.", `B: unchanged.${b}`),
    cleanMarkdown: base.cleanMarkdown
      ?.replace("A: unchanged.", `A: unchanged.${a}`)
      .replace("B: unchanged.", `B: unchanged.${b}`),
  });
  const current = edit(" Local 👨🏽‍💻", " Peer");
  const sent = edit(" First local", "");
  const operation: PendingOperation = {
    operation: {
      operationId: "ordinary-save",
      pageInstanceId: "page",
      operationSequence: 1,
      operationContext: { owner: "server", epoch: "run", acceptUntil: 1 },
    },
    reviewId: "review",
    draft: sent,
    base,
    editorBase: edit("", " First peer"),
    generation: 2,
    kind: "reconcile",
  };
  return {
    version: 2,
    pageInstanceId: "page",
    aliveAt: 1,
    revision: 1,
    generation: 3,
    draft: current,
    base,
    operation,
    copyOperation: {
      ...operation,
      operation: { ...operation.operation, operationId: "copy-save" },
      kind: "copy",
      draft: edit(" Local 👨🏽‍💻", " Peer copy"),
      base: structuredClone(base),
      editorBase: current,
    },
    uiDrafts: {
      comments: {
        c13: {
          value: 'Private draft.\r\nKeep literal {"ready":true} and 👩🏽‍💻.',
          original: base.reviewComments[0].content,
          editing: true,
        },
      },
      suggestion: {
        value: "Unsubmitted suggestion\r\n\twith exact whitespace.",
      },
    },
  };
}

test("one pair of document strings fits near-identical pending recovery snapshots within the storage quota without losing either operation or private UI", () => {
  const record = largeRecovery();
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  expect(bytes(record.draft.markdown)).toBeGreaterThan(100 * 1024);
  const limit =
    bytes(record.draft.markdown) +
    bytes(record.draft.cleanMarkdown ?? "") +
    16 * 1024;
  let stored = "";
  const save = (raw: string) => {
    if (bytes(raw) > limit)
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    stored = raw;
  };
  expect(() => save(encodeBrowserRecovery(record))).not.toThrow();
  expect(JSON.parse(stored).draft.markdown).toBe(record.draft.markdown);
  expect(decodeBrowserRecovery(stored)).toEqual(record);
});

test("near-identical recovery snapshots skip shared source runs without inspecting every UTF16 unit", () => {
  const record = largeRecovery();
  const charCodeAt = String.prototype.charCodeAt;
  let inspected = 0;
  const spy = vi
    .spyOn(String.prototype, "charCodeAt")
    .mockImplementation(function (this: string, index) {
      inspected++;
      return charCodeAt.call(this, index);
    });
  let stored: string;
  try {
    stored = encodeBrowserRecovery(record);
  } finally {
    spy.mockRestore();
  }
  expect(decodeBrowserRecovery(stored)).toEqual(record);
  expect(
    inspected,
    "repeated recovery anchors should compare shared runs with native string equality",
  ).toBeLessThan(record.draft.markdown.length);
});

test.each([
  { name: "empty", before: "", after: "" },
  { name: "insertion", before: "", after: "Inserted text." },
  { name: "deletion", before: "Removed text.", after: "" },
  { name: "literal short source", before: "short", after: "different" },
  {
    name: "identical source without overlapping suffix",
    before: "x".repeat(2048),
    after: "x".repeat(2048),
    patch: { prefix: 2048, suffix: 0, text: "" },
  },
  {
    name: "surrogate pair across a chunk boundary",
    before: `${"x".repeat(1023)}😀${"y".repeat(1024)}`,
    after: `${"x".repeat(1023)}😃${"y".repeat(1024)}`,
    patch: { prefix: 1024, suffix: 1024, text: "\ude00" },
  },
  {
    name: "common suffix after a changed surrogate",
    before: `😀${"y".repeat(2048)}`,
    after: `😃${"y".repeat(2048)}`,
    patch: { prefix: 1, suffix: 2048, text: "\ude00" },
  },
  {
    name: "changed surrogate at the end",
    before: `${"x".repeat(2048)}😀`,
    after: `${"x".repeat(2048)}😃`,
    patch: { prefix: 2049, suffix: 0, text: "\ude00" },
  },
])("recovery deltas retain exact UTF16 boundaries: $name", ({
  before,
  after,
  patch,
}) => {
  const draft = (markdown: string): RevisionDraft => ({
    markdown,
    cleanMarkdown: markdown,
    decisions: {},
    reviewComments: [],
  });
  const record: BrowserRecovery = {
    version: 2,
    pageInstanceId: "boundary-probe",
    aliveAt: 1,
    revision: 1,
    draft: draft(after),
    base: draft(before),
  };
  const stored = encodeBrowserRecovery(record);
  const wire = JSON.parse(stored);
  expect(wire.snapshots[0].markdownDelta).toEqual(
    patch ? { anchor: "current", ...patch } : undefined,
  );
  expect(decodeBrowserRecovery(stored)).toEqual(record);
});

function patchedWire() {
  const current = {
    markdown: "abcdef👩🏽‍💻\r\n",
    cleanMarkdown: "ABCDEF\r\n",
    decisions: {},
    reviewComments: [],
  };
  const operation = {
    operation: {
      operationId: "ordinary",
      pageInstanceId: "page",
      operationSequence: 1,
      operationContext: { owner: "server", epoch: "run", acceptUntil: 1 },
    },
    reviewId: "review",
    generation: 1,
    kind: "reconcile",
    draft: 0,
    base: -1,
    editorBase: 0,
  };
  return {
    version: 3,
    pageInstanceId: "page",
    aliveAt: 1,
    revision: 1,
    draft: current,
    base: 0,
    stringBases: { cleanMarkdown: "Clean baseline\r\n" },
    snapshots: [
      {
        decisions: {},
        reviewComments: [],
        markdownDelta: {
          anchor: "current",
          prefix: 3,
          suffix: 2,
          text: "changed👨🏽‍💻",
        },
        cleanMarkdownDelta: {
          anchor: "base",
          prefix: 1,
          suffix: 2,
          text: "accepted",
        },
      },
    ],
    operation,
    copyOperation: {
      ...operation,
      kind: "copy",
      operation: { ...operation.operation, operationId: "copy" },
      draft: -1,
      base: 0,
    },
    uiDrafts: {
      comments: {
        c1: {
          value: "Exact private\r\ndraft",
          original: "Saved",
          editing: true,
        },
      },
    },
  };
}

test("direct literal patches restore both operation slots once with exact Unicode and CRLF", () => {
  const decoded = decodeBrowserRecovery(JSON.stringify(patchedWire()));
  expect(decoded?.base.markdown).toBe("abcchanged👨🏽‍💻\r\n");
  expect(decoded?.base.cleanMarkdown).toBe("Caccepted\r\n");
  expect(decoded?.operation?.draft).toEqual(decoded?.base);
  expect(decoded?.copyOperation?.draft).toEqual(decoded?.draft);
  expect(decoded?.operation?.operation.operationId).toBe("ordinary");
  expect(decoded?.copyOperation?.operation.operationId).toBe("copy");
  expect(decoded?.uiDrafts).toEqual(patchedWire().uiDrafts);
});

test.each([
  2, 3,
])("literal version %s recovery remains readable with both operation slots", (version) => {
  const current = {
    markdown: "Current 🦋.\r\n",
    cleanMarkdown: "Current 🦋.\r\n",
    decisions: {},
    reviewComments: [],
  };
  const base = {
    ...current,
    markdown: "Before.\r\n",
    cleanMarkdown: "Before.\r\n",
  };
  const operation: PendingOperation = {
    operation: {
      operationId: "old-save",
      pageInstanceId: "page",
      operationSequence: 1,
      operationContext: { owner: "server", epoch: "run", acceptUntil: 1 },
    },
    reviewId: "review",
    draft: base,
    base,
    editorBase: base,
    kind: "reconcile",
    generation: 1,
  };
  const record: BrowserRecovery = {
    version: 2,
    pageInstanceId: "page",
    aliveAt: 1,
    revision: 1,
    draft: current,
    base,
    operation,
    copyOperation: {
      ...operation,
      kind: "copy",
      operation: { ...operation.operation, operationId: "old-copy" },
      draft: current,
    },
    uiDrafts: patchedWire().uiDrafts,
  };
  const wire =
    version === 2
      ? record
      : {
          ...record,
          version: 3,
          draft: {
            ...current,
            cleanMarkdown: undefined,
            cleanEqualsMarkdown: true,
          },
          base: 0,
          snapshots: [
            { ...base, cleanMarkdown: undefined, cleanEqualsMarkdown: true },
          ],
          operation: { ...operation, draft: 0, base: 0, editorBase: 0 },
          copyOperation: {
            ...record.copyOperation,
            draft: -1,
            base: 0,
            editorBase: 0,
          },
        };
  expect(decodeBrowserRecovery(JSON.stringify(wire))).toEqual(record);
});

test.each([
  ["negative prefix", { anchor: "current", prefix: -1, suffix: 0, text: "" }],
  [
    "fractional prefix",
    { anchor: "current", prefix: 0.5, suffix: 0, text: "" },
  ],
  [
    "overlapping ranges",
    { anchor: "current", prefix: 999, suffix: 999, text: "" },
  ],
  [
    "non-text insertion",
    { anchor: "current", prefix: 0, suffix: 0, text: null },
  ],
  ["unknown anchor", { anchor: "other", prefix: 0, suffix: 0, text: "" }],
  [
    "recursive snapshot reference",
    { anchor: "snapshot:0", prefix: 0, suffix: 0, text: "" },
  ],
  [
    "additional reference field",
    { anchor: "current", prefix: 0, suffix: 0, text: "", reference: 0 },
  ],
  ["missing literal base", { anchor: "base", prefix: 0, suffix: 0, text: "" }],
] as const)("malformed recovery is refused safely: %s", (_name, patch) => {
  const wire = patchedWire();
  (wire.snapshots[0] as Record<string, unknown>).markdownDelta = patch;
  expect(decodeBrowserRecovery(JSON.stringify(wire))).toBeNull();
});

test("a current literal cannot depend on itself through a patch", () => {
  const wire = patchedWire();
  Object.assign(wire.draft, {
    markdownDelta: { anchor: "current", prefix: 0, suffix: 0, text: "" },
  });
  expect(decodeBrowserRecovery(JSON.stringify(wire))).toBeNull();
});

test("patches cannot replace literal anchors or refer outside the bounded snapshot set", () => {
  const wire = patchedWire();
  Object.assign(wire.stringBases, {
    markdown: { anchor: "base", prefix: 0, suffix: 0, text: "" },
  });
  expect(decodeBrowserRecovery(JSON.stringify(wire))).toBeNull();
  const outside = patchedWire();
  outside.operation.draft = 999;
  expect(decodeBrowserRecovery(JSON.stringify(outside))).toBeNull();
  const oversized = patchedWire();
  oversized.snapshots = Array.from(
    { length: 10_000 },
    () => oversized.snapshots[0],
  );
  expect(decodeBrowserRecovery(JSON.stringify(oversized))).toBeNull();
});
