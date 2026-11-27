import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ComparisonStore } from "./comparisons.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/delayed-checkpoints/", import.meta.url),
);
const feedback = "Keep my private feedback until I explicitly submit it.";
const privateUi = {
  comments: {
    c13: { value: feedback, original: "", editing: true },
  },
};
let root: string;
let store: ComparisonStore;
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  store = new ComparisonStore(path.join(root, "comparisons"), {
    homeDir: root,
  });
});
afterEach(() => {
  store.watchers.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(submitFeedback = true) {
  const target = path.join(root, "practice.md");
  const markdown = "The footer before submitting feedback.\n";
  fs.writeFileSync(target, markdown);
  const review = store.openDocument({ targetPath: target, autosave: target });
  const base = store.state(review.id);
  const submitted = {
    ...base.draft,
    reviewComments: submitFeedback
      ? [
          {
            id: "c13",
            changeId: "document",
            content: feedback,
            createdAt: "2026-11-22T12:00:00.000Z",
          },
        ]
      : [],
  };
  const checkpointRequest = (generation: number, uiDrafts: object) => ({
    pageInstanceId: "page",
    recoveryId: "file-wait",
    generation,
    automaticWait: true,
    workingDraft: submitted,
    uiDrafts,
  });
  const initial = store.checkpoint(review.id, {
    ...checkpointRequest(2, privateUi),
    workingDraft: base.draft,
  });
  // Capture generation 6 while its request is still in flight. The save below
  // reaches the server before this newer snapshot of the same episode does.
  const delayedRequest = checkpointRequest(6, { comments: {} });
  const result = store.reconcile(review.id, {
    operationId: "cover-private-feedback",
    operationSequence: 1,
    pageInstanceId: "page",
    operationContext: base.operationContext,
    expectedRevision: base.revision,
    baseRevision: base.revision,
    baseSignature: base.signature,
    base: base.draft,
    draft: submitted,
    expectedDisk: base.disk
      ? {
          path: base.disk.path,
          version: base.disk.version,
          hash: base.disk.hash,
        }
      : null,
    localGeneration: 6,
    reason: "sync",
    writeFile: false,
    coveredCheckpoint: {
      recoveryId: "file-wait",
      pageInstanceId: "page",
      generation: 6,
    },
  });
  expect(result.status).toBe("committed");
  const entry = () =>
    store
      .state(review.id)
      .review.recoveryCheckpoints?.find(
        (value) => value.id === initial.checkpointId,
      );
  return { review, target, initial, delayedRequest, entry };
}

test.each([
  false,
  true,
])("a delayed newer snapshot cannot reopen an episode already covered by the save, including after restart: %s", (restart) => {
  const f = fixture();
  const resolvedAt = f.entry()?.resolvedAt;
  expect(resolvedAt).toEqual(expect.any(String));
  const snapshot = store.readCheckpoint(f.review.id, f.initial.checkpointId);
  if (restart) {
    store.watchers.close();
    store = new ComparisonStore(path.join(root, "comparisons"), {
      homeDir: root,
    });
  }
  store.checkpoint(f.review.id, f.delayedRequest);
  expect(f.entry()?.resolvedAt).toBe(resolvedAt);
  // The snapshot's own generation and contents describe what was captured.
  expect(f.entry()?.generation).toBe(2);
  expect(store.readCheckpoint(f.review.id, f.initial.checkpointId)).toEqual(
    snapshot,
  );
  expect(store.state(f.review.id).draft.reviewComments[0]?.content).toBe(
    feedback,
  );
  expect(fs.readFileSync(f.target, "utf8")).not.toContain(feedback);
});

test("a strictly newer generation with new private feedback remains recoverable", () => {
  const f = fixture();
  expect(f.entry()?.resolvedAt).toEqual(expect.any(String));
  const latestUi = {
    comments: {
      c14: {
        value: "This new private feedback was never submitted.",
        original: "",
        editing: true,
      },
    },
  };
  store.checkpoint(f.review.id, {
    ...f.delayedRequest,
    generation: 7,
    uiDrafts: latestUi,
  });
  expect(f.entry()?.resolvedAt).toBeUndefined();
  expect(f.entry()?.generation).toBe(7);
  expect(
    store.readCheckpoint(f.review.id, f.initial.checkpointId),
  ).toMatchObject({ uiDrafts: latestUi });
});

test("a covering save cannot retire unique unsubmitted feedback from the episode's first snapshot", () => {
  const f = fixture(false);
  expect(f.entry()?.resolvedAt).toBeUndefined();
  store.checkpoint(f.review.id, f.delayedRequest);
  expect(f.entry()?.resolvedAt).toBeUndefined();
  expect(f.entry()?.generation).toBe(6);
  expect(
    store.readCheckpoint(f.review.id, f.initial.checkpointId),
  ).toMatchObject({ entryUiDrafts: privateUi, uiDrafts: { comments: {} } });
  expect(store.state(f.review.id).draft.reviewComments).toEqual([]);
});

test("the coverage fence belongs only to the saved page and recovery episode", () => {
  const f = fixture();
  expect(f.entry()?.resolvedAt).toEqual(expect.any(String));
  const another = store.checkpoint(f.review.id, {
    ...f.delayedRequest,
    recoveryId: "another-file-wait",
    uiDrafts: privateUi,
  });
  expect(another.checkpointId).not.toBe(f.initial.checkpointId);
  const entry = store
    .state(f.review.id)
    .review.recoveryCheckpoints?.find(
      (value) => value.id === another.checkpointId,
    );
  expect(entry?.resolvedAt).toBeUndefined();
  expect(store.readCheckpoint(f.review.id, another.checkpointId)).toMatchObject(
    {
      uiDrafts: privateUi,
    },
  );
});
