import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/publication-journal-cost/", import.meta.url),
);
let root: string;
let target: string;
let host: ReturnType<typeof createApp>;
const text = Array.from(
  { length: 1200 },
  (_, index) =>
    `Paragraph ${index}: retain the complete document and feedback without writing its publication identity twice.`,
).join("\n\n");
function start() {
  return createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "reviews"),
    staticDirPath: root,
  });
}
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  target = path.join(root, "source.md");
  fs.writeFileSync(target, text);
  host = start();
});
afterEach(() => {
  vi.restoreAllMocks();
  host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
async function prepare(copy: boolean) {
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  expect(opened.status).toBe(201);
  const state = (
    await request(host.app).get(`/api/comparisons/${opened.body.id}/state`)
  ).body;
  const markdown = text.replace("Paragraph 0", "Edited paragraph 0");
  const draft = {
    ...state.draft,
    markdown,
    cleanMarkdown: markdown,
    reviewComments: [
      {
        id: "c1",
        changeId: "document",
        content: "Retain complete feedback with the typed document",
        createdAt: "2026-11-26T12:00:00.000Z",
      },
    ],
  };
  const destination = copy ? path.join(root, "separate.md") : target;
  const operation = {
    operationId: "publication",
    pageInstanceId: "page",
    operationSequence: 1,
    operationContext: state.operationContext,
  };
  return {
    state,
    draft,
    destination,
    operation,
    route: `/api/comparisons/${state.review.id}/${copy ? "copy" : "reconcile"}`,
    body: copy
      ? {
          ...operation,
          generation: 1,
          workingDraft: draft,
          path: destination,
          relativeLinksAcknowledged: true,
          uiDrafts: { reply: "Private unfinished reply" },
        }
      : {
          ...operation,
          expectedRevision: state.revision,
          baseRevision: state.revision,
          baseSignature: state.signature,
          base: state.draft,
          draft,
          expectedDisk: {
            path: state.disk.path,
            version: state.disk.version,
            hash: state.disk.hash,
          },
          localGeneration: 1,
          reason: "sync",
          writeFile: true,
        },
  };
}

test.each([
  false,
  true,
])("a 100 KiB publication stores its pending and completed review without a third review rewrite (copy=%s)", async (copy) => {
  const flow = await prepare(copy);
  const renamed = vi.spyOn(fs, "renameSync");
  const saved = await request(host.app).post(flow.route).send(flow.body);
  expect(saved.body.status).toBe("committed");
  expect(saved.body.state.draft).toEqual(flow.draft);
  expect(fs.readFileSync(flow.destination, "utf8")).toBe(
    flow.draft.cleanMarkdown,
  );
  const reviewFile = path.join(
    root,
    "reviews",
    `${saved.body.state.review.id}.json`,
  );
  expect(
    renamed.mock.calls.filter(([, destination]) => destination === reviewFile)
      .length,
  ).toBeLessThanOrEqual(2);
});

test.each([
  "valid",
  "wrong-path",
  "wrong-review",
  "wrong-operation",
  "wrong-page",
  "wrong-sequence",
  "wrong-inode",
  "missing-record",
  "missing-witness",
  "replaced-file",
  "unavailable-result",
  "in-place-identity",
  "legacy-review-identity",
] as const)("restart uses a matching durable operation witness and respects previously saved review identities (%s)", async (damage) => {
  const flow = await prepare(false);
  const rename = fs.renameSync.bind(fs);
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    rename(from, to);
    if (to === flow.destination)
      throw Object.assign(new Error("Stopped after file publication"), {
        code: "EIO",
      });
  });
  const stopped = await request(host.app).post(flow.route).send(flow.body);
  expect(stopped.body.status).toBe("publishing");
  vi.restoreAllMocks();

  const operationFile = path.join(
    root,
    "reviews",
    "operations",
    "publication.json",
  );
  const record = JSON.parse(fs.readFileSync(operationFile, "utf8"));
  const reviewFile = path.join(root, "reviews", `${record.reviewId}.json`);
  const review = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
  const witness = record.publicationWitness;
  expect(witness).toBeTruthy();
  delete review.pendingPublication.publishedIdentity;
  if (damage === "in-place-identity")
    review.pendingPublication.publishedIdentity = {
      device: witness.device,
      inode: witness.inode,
      inPlace: true,
    };
  if (damage === "legacy-review-identity")
    review.pendingPublication.publishedIdentity = {
      device: witness.device,
      inode: witness.inode,
      inPlace: false,
      witnessPath: witness.path,
    };
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  if (damage === "wrong-path" || damage === "legacy-review-identity")
    witness.path = path.join(root, "unrelated");
  if (damage === "wrong-review") record.reviewId = "another-review";
  if (damage === "wrong-operation")
    record.operation.operationId = "another-operation";
  if (damage === "wrong-page") record.operation.pageInstanceId = "another-page";
  if (damage === "wrong-sequence") record.operation.operationSequence++;
  if (damage === "wrong-inode") witness.inode++;
  if (damage === "unavailable-result")
    record.resultPayload = {
      file: `publication.${"a".repeat(64)}.json.gz`,
      sha256: "a".repeat(64),
      bytes: 1,
      storedBytes: 1,
      encoding: "gzip",
    };
  if (damage === "missing-record") fs.unlinkSync(operationFile);
  else fs.writeFileSync(operationFile, JSON.stringify(record));
  if (damage === "missing-witness") fs.unlinkSync(witness.path);
  if (damage === "replaced-file") {
    fs.unlinkSync(flow.destination);
    fs.writeFileSync(flow.destination, flow.draft.cleanMarkdown);
  }
  host.dispose();
  host = start();
  const recovered = await request(host.app)
    .post(`/api/comparisons/${review.id}/recover`)
    .send({});
  // Automatic owner recovery can settle the interrupted operation before
  // explicit Recover runs. Read its exact recorded outcome in either case.
  expect(recovered.status).toBe(200);
  const outcome = await request(host.app).get(
    "/api/comparisons/operations/publication",
  );
  if (damage === "valid" || damage === "legacy-review-identity") {
    expect(outcome.body.status).toBe("committed");
    expect(outcome.body.state.draft).toEqual(flow.draft);
  } else {
    expect(outcome.body.status).not.toBe("committed");
    const preserved = recovered.body.state.review.recoveryCheckpoints.find(
      (entry: { reason: string }) =>
        entry.reason === "Publication stopped before its file was verified",
    );
    expect(preserved).toBeTruthy();
    const checkpoint = await request(host.app).get(
      `/api/comparisons/${review.id}/checkpoints/${preserved.id}`,
    );
    expect(checkpoint.body.workingDraft).toEqual(flow.draft);
  }
  expect(fs.readFileSync(flow.destination, "utf8")).toBe(
    flow.draft.cleanMarkdown,
  );
  expect(
    fs.readdirSync(root).filter((name) => name.endsWith(".publication")),
  ).toEqual([]);
});
