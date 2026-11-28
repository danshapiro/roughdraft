import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.js";

describe("persisted reviewed changes", () => {
  let root: string;
  let filename: string;
  const reviewed = [
    {
      id: "reference-first",
      frontmatterInContent: true,
      decision: "accept",
      oldText: "old",
      newText: "new",
      inverse: [],
      guard: {
        from: 1,
        to: 4,
        slice: { content: [{ type: "text", text: "new" }] },
      },
      keptId: "reference-first",
      keptIds: ["reference-first", "reference-related"],
    },
    {
      id: "suggestion-second",
      decision: "reject",
      oldText: "original",
      newText: "proposal",
      inverse: [
        {
          stepType: "replace",
          from: 6,
          to: 14,
          slice: { content: [{ type: "text", text: "proposal" }] },
        },
      ],
      guard: { from: 6, to: 14, slice: null },
      stale: true,
    },
    {
      id: "metadata-third",
      decision: "reject",
      oldText: "title: Old",
      newText: "title: New",
      inverse: [],
      guard: { from: 0, to: 0, slice: null },
      keptId: "document-metadata",
      metadata: {
        before: { frontmatter: "---\ntitle: Old\n---\n\n", endmatter: null },
        after: {
          frontmatter: "---\ntitle: New\n---\n\n",
          endmatter: "---\ncategory: plan\n",
        },
      },
    },
  ];
  const draft = {
    markdown: "new\n\noriginal",
    cleanMarkdown: "new\n\noriginal",
    decisions: { "reference-first": "kept" },
    reviewed,
  };
  // A new application per request exercises persistence across process state,
  // without starting a server or relying on a shared in-memory store.
  const api = () =>
    request(
      createApp({
        homeDir: root,
        comparisonsDir: path.join(root, "comparisons"),
        staticDirPath: root,
      }).app,
    );
  const create = (autosave = "none") =>
    api()
      .post("/api/comparisons/document")
      .send({ targetPath: filename, autosave });

  beforeEach(() => {
    const temporary = fileURLToPath(
      new URL("../../../.test-tmp/", import.meta.url),
    );
    fs.mkdirSync(temporary, { recursive: true });
    root = fs.mkdtempSync(path.join(temporary, "reviewed-changes-"));
    filename = path.join(root, "document.md");
    fs.writeFileSync(filename, "Initial text");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    "draft",
    "save",
    "send",
  ])("retains accepted and rejected change records through %s and a fresh app read", async (action) => {
    const created = await create(action === "save" ? filename : "none");
    expect(created.status).toBe(201);
    const route = `/api/comparisons/${created.body.id}`;
    const updated = await api()
      .post(`${route}/${action}`)
      .send({ revision: created.body.revision, ...draft });
    expect(updated.status).toBe(200);
    expect(updated.body.draft).toEqual(draft);
    const reopened = await api().get(route);
    expect(reopened.status).toBe(200);
    expect(reopened.body.draft).toEqual(draft);
    if (action === "send") expect(reopened.body.feedback.draft).toEqual(draft);
    expect(fs.readFileSync(filename, "utf8")).toBe(
      action === "save" ? draft.cleanMarkdown : "Initial text",
    );
  });

  it("preserves the complete decision records in a detached recovered review", async () => {
    const created = await create();
    const originalRoute = `/api/comparisons/${created.body.id}`;
    const recovered = await api()
      .post(`${originalRoute}/fork`)
      .send({ revision: created.body.revision, autosave: "none", ...draft });
    expect(recovered.status).toBe(201);
    expect(recovered.body.draft).toEqual(draft);
    const read = await api().get(`/api/comparisons/${recovered.body.id}`);
    expect(read.body.draft).toEqual(draft);
    const original = await api().get(originalRoute);
    expect(original.body.recoveredReviews[0].draft).toEqual(draft);
    expect(original.body.draft).toEqual(created.body.draft);
    expect(fs.readFileSync(filename, "utf8")).toBe("Initial text");
  });

  it.each([
    { reviewed: {} },
    { reviewed: [null] },
    { reviewed: [{ ...reviewed[0], decision: "pending" }] },
    { reviewed: [{ ...reviewed[0], inverse: [null] }] },
    { reviewed: [{ ...reviewed[0], guard: { from: -1, to: 4, slice: null } }] },
    { reviewed: [{ ...reviewed[0], guard: { from: 4, to: 1, slice: null } }] },
    {
      reviewed: [{ ...reviewed[0], guard: { from: 1.5, to: 4, slice: null } }],
    },
    { reviewed: [{ ...reviewed[0], stale: "yes" }] },
    { reviewed: [{ ...reviewed[0], frontmatterInContent: "yes" }] },
    { reviewed: [{ ...reviewed[2], metadata: null }] },
    { reviewed: [{ ...reviewed[2], metadata: { before: {}, after: {} } }] },
    {
      reviewed: [
        {
          ...reviewed[2],
          metadata: {
            before: { frontmatter: 1, endmatter: null },
            after: { frontmatter: null, endmatter: null },
          },
        },
      ],
    },
  ])("rejects malformed recovery records without replacing saved work: %j", async (invalid) => {
    const created = await create();
    const route = `/api/comparisons/${created.body.id}`;
    const rejected = await api()
      .post(`${route}/draft`)
      .send({ revision: created.body.revision, ...draft, ...invalid });
    expect(rejected.status).toBe(400);
    expect((await api().get(route)).body).toEqual(created.body);
  });

  it("keeps older draft requests without reviewed records compatible", async () => {
    const created = await create();
    const legacy = { markdown: "Edited text", decisions: {} };
    const updated = await api()
      .post(`/api/comparisons/${created.body.id}/draft`)
      .send({ revision: created.body.revision, ...legacy });
    expect(updated.status).toBe(200);
    expect(updated.body.draft).toEqual(legacy);
  });
});
