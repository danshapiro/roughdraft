import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.js";

describe("live review reads", () => {
  const temporaryParent = fileURLToPath(
    new URL("../../../.test-tmp/a0-backend/", import.meta.url),
  );
  let root: string;

  beforeEach(() => {
    fs.mkdirSync(temporaryParent, { recursive: true });
    root = fs.mkdtempSync(path.join(temporaryParent, "read-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    "",
    "/watch",
    "/destination",
  ])("does not recover another process's pending save during GET %s", async (suffix) => {
    const target = path.join(root, "working.md");
    const original = "# Original\n\nThe writer has not published yet.\n";
    fs.writeFileSync(target, original);
    const directory = path.join(root, "comparisons");
    const app = createApp({
      homeDir: root,
      comparisonsDir: directory,
      staticDirPath: root,
    }).app;
    const created = await request(app)
      .post("/api/comparisons/document")
      .send({ targetPath: target, autosave: target });
    expect(created.status).toBe(201);
    const filename = path.join(directory, `${created.body.id}.json`);
    const record = JSON.parse(fs.readFileSync(filename, "utf8"));
    // This is the durable state between publishDraft's intent save and
    // Markdown publication. A reader cannot know that the writer crashed.
    record.pendingSave = {
      path: target,
      draft: {
        markdown: "# Work in flight\n\nThe writer will publish this next.\n",
        decisions: {},
      },
      reviewComments: [],
    };
    fs.writeFileSync(filename, `${JSON.stringify(record)}\n`);
    const pendingBytes = fs.readFileSync(filename, "utf8");

    const read = await request(app).get(
      `/api/comparisons/${created.body.id}${suffix}`,
    );

    expect(read.status).toBe(200);
    expect(fs.readFileSync(filename, "utf8")).toBe(pendingBytes);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });
});
