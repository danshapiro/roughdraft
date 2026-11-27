import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/publication-recovery/", import.meta.url),
);
let root: string;
let host: ReturnType<typeof createApp>;
function start() {
  return createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "comparisons"),
    staticDirPath: root,
  });
}
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  host = start();
});
afterEach(() => {
  host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

for (const kind of ["foreign", "legacy-save", "legacy-apply"] as const) {
  test.each([
    1000, 31_000,
  ])(`${kind} publication reports age without recovering on a read, and explicit recovery never replays a file write (age=%s)`, async (age) => {
    const target = path.join(root, "source.md");
    const original = "The current file.\n";
    const submitted = "The unpublished submitted document.\n";
    fs.writeFileSync(target, original);
    const opened = await request(host.app)
      .post("/api/comparisons/document")
      .send({ targetPath: target, autosave: target });
    expect(opened.status).toBe(201);
    const id = opened.body.id;
    const state = (await request(host.app).get(`/api/comparisons/${id}/state`))
      .body;
    const filename = path.join(root, "comparisons", `${id}.json`);
    const review = JSON.parse(fs.readFileSync(filename, "utf8"));
    const complete = {
      markdown: submitted,
      cleanMarkdown: submitted,
      decisions: {},
      reviewComments: [
        {
          id: "c1",
          changeId: "document",
          content: "Unpublished feedback",
          createdAt: "2026-11-26T12:00:00.000Z",
        },
      ],
    };
    if (kind === "foreign")
      review.pendingPublication = {
        owner: "another-installation",
        processInstance: "stopped-process",
        startedAt: Date.now() - age,
        operation: {
          operationId: "stopped-publication",
          pageInstanceId: "stopped-page",
          operationSequence: 1,
          operationContext: state.operationContext,
        },
        draft: complete,
        path: target,
        expectedDisk: state.disk,
        writeFile: true,
        reason: "sync",
      };
    else if (kind === "legacy-save")
      review.pendingSave = {
        path: target,
        draft: { markdown: submitted, cleanMarkdown: submitted, decisions: {} },
        reviewComments: complete.reviewComments,
      };
    else
      review.pendingApply = {
        outputHash: "not-the-current-file",
        completion: {
          fileWritten: true,
          targetPath: target,
          accepted: 1,
          reverted: 0,
          completedAt: "2026-11-26T12:00:00.000Z",
        },
      };
    fs.writeFileSync(filename, JSON.stringify(review));
    const modified = new Date(Date.now() - age);
    fs.utimesSync(filename, modified, modified);
    host.dispose();
    host = start();
    const bytes = fs.readFileSync(filename, "utf8");
    const reading = await request(host.app).get(`/api/comparisons/${id}/state`);
    expect(reading.status).toBe(200);
    expect(fs.readFileSync(filename, "utf8")).toBe(bytes);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(reading.body.publishing.recoverable).toBe(age >= 30_000);
    if (age < 30_000) {
      expect(reading.body.publishing.retryAfter).toBeGreaterThan(0);
      expect(reading.body.publishing.retryAfter).toBeLessThanOrEqual(30_000);
      return;
    }
    const recovered = await request(host.app)
      .post(`/api/comparisons/${id}/recover`)
      .send({});
    expect(recovered.status).toBe(200);
    expect(recovered.body.state.publishing).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    if (kind === "foreign") {
      expect(recovered.body.status).toBe("rejected");
      const checkpoint = await request(host.app).get(
        `/api/comparisons/${id}/checkpoints/${recovered.body.checkpointId}`,
      );
      expect(checkpoint.body.workingDraft).toEqual(complete);
    } else if (kind === "legacy-save") {
      expect(recovered.body.state.draft.markdown).toBe(submitted);
      expect(recovered.body.state.draft.reviewComments).toEqual(
        complete.reviewComments,
      );
    }
    const again = await request(host.app)
      .post(`/api/comparisons/${id}/recover`)
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.state.publishing).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });
}
