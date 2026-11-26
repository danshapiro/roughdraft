import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeReviewDrafts } from "@roughdraft/rfm";
import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/checkpoint-resolution/", import.meta.url),
);
let root: string;
let host: ReturnType<typeof createApp>;
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  host = createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "comparisons"),
    staticDirPath: root,
  });
});
afterEach(() => {
  host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

test.each([
  "local",
  "incoming",
] as const)("a successful %s resolution resolves its covered checkpoints while retaining unsubmitted private feedback", async (choice) => {
  const target = path.join(root, "practice.md");
  const original =
    "The planting schedule is ready.\n\nThe lighting schedule is ready.\n";
  fs.writeFileSync(target, original);
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  const base = (
    await request(host.app).get(`/api/comparisons/${opened.body.id}/state`)
  ).body;
  const route = `/api/comparisons/${base.review.id}`;
  const payload = (id: string, page: string, word: string, sequence = 1) => ({
    operationId: id,
    pageInstanceId: page,
    operationSequence: sequence,
    operationContext: base.operationContext,
    expectedRevision: base.revision,
    baseRevision: base.revision,
    baseSignature: base.signature,
    base: base.draft,
    draft: {
      ...base.draft,
      markdown: original.replace("planting", word),
      cleanMarkdown: original.replace("planting", word),
    },
    expectedDisk: base.disk,
    localGeneration: 1,
    reason: "sync",
    writeFile: true,
  });
  const first = await request(host.app)
    .post(`${route}/reconcile`)
    .send(payload("peer-write", "peer", "orchard"));
  expect(first.body.status).toBe("committed");
  const overlap = await request(host.app)
    .post(`${route}/reconcile`)
    .send(payload("local-overlap", "local", "garden"));
  expect(["conflict", "client-merge-required", "base-unavailable"]).toContain(
    overlap.body.status,
  );
  const local = payload("local-overlap", "local", "garden").draft;
  const latest = overlap.body.state;
  const semantic = mergeReviewDrafts(base.draft, local, latest.draft, {
    server: false,
    budgetMs: 1000,
  });
  if (semantic.status !== "conflict")
    throw new Error("The fixture must contain the inspected passage conflict");
  const browserResolved = mergeReviewDrafts(base.draft, local, latest.draft, {
    server: false,
    budgetMs: 1000,
    resolution: choice,
  });
  if (browserResolved.status !== "merged")
    throw new Error("The inspected choice must resolve the fixture");
  const checkpointIds: string[] = [];
  const privateUi = {
    comments: {
      c1: {
        value: "Unique unsubmitted private feedback",
        original: "",
        editing: true,
      },
    },
  };
  for (const [id, value, uiDrafts] of [
    ["local", original.replace("planting", "garden"), {}],
    ["incoming", original.replace("planting", "orchard"), {}],
    ["private", original.replace("planting", "garden"), privateUi],
  ] as const) {
    const saved = await request(host.app)
      .post(`${route}/checkpoint`)
      .send({
        pageInstanceId: "local",
        recoveryId: `covered-${id}`,
        conflictId: `covered-${id}`,
        generation: 1,
        workingDraft: { ...base.draft, markdown: value, cleanMarkdown: value },
        uiDrafts,
        reason: "Before resolving overlapping changes",
      });
    expect(saved.status).toBe(200);
    checkpointIds.push(saved.body.checkpointId);
  }
  const resolved = await request(host.app)
    .post(`${route}/reconcile`)
    .send({
      ...payload("explicit-resolution", "local", "garden", 2),
      ...(overlap.body.status !== "conflict"
        ? {
            expectedRevision: latest.revision,
            baseRevision: latest.revision,
            baseSignature: latest.signature,
            base: latest.draft,
            draft: browserResolved.draft,
            reservationToken: overlap.body.reservation?.token,
          }
        : {}),
      reason: "resolve",
      expectedDisk: overlap.body.state.disk,
      resolution: {
        choice,
        signature: semantic.signature,
        checkpointIds,
      },
    });
  expect(resolved.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toContain(
    choice === "local" ? "garden schedule" : "orchard schedule",
  );
  const current = (await request(host.app).get(`${route}/state`)).body;
  const checkpoints = current.review.recoveryCheckpoints as Array<{
    id: string;
    resolvedAt?: string;
  }>;
  expect(
    checkpoints.find((entry) => entry.id === checkpointIds[0])?.resolvedAt,
  ).toBeTruthy();
  expect(
    checkpoints.find((entry) => entry.id === checkpointIds[1])?.resolvedAt,
  ).toBeTruthy();
  expect(
    checkpoints.find((entry) => entry.id === checkpointIds[2])?.resolvedAt,
  ).toBeUndefined();
  const retained = await request(host.app).get(
    `${route}/checkpoints/${checkpointIds[2]}`,
  );
  expect(retained.body.uiDrafts).toEqual(privateUi);
});
