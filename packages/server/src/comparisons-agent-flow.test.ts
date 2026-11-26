import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.js";

// These API tests use actual files and a fresh store on each request to protect
// the agent/browser persistence boundary as well as autosave's write policy.
describe("agent-configured review sessions", () => {
  let root: string;
  let oldFile: string;
  let newFile: string;
  const before = "# Product policy\r\n\r\nPrevious wording";
  const after = "# Product policy\r\n\r\nProposed wording";
  const comment = {
    id: "document-comment",
    changeId: "document",
    content: "Please clarify this sentence.",
    createdAt: "2026-11-21T18:00:00.000Z",
    scope: "document",
  };
  const api = () =>
    request(
      createApp({
        homeDir: root,
        comparisonsDir: path.join(root, "comparisons"),
        staticDirPath: root,
      }).app,
    );
  const compare = (extra = {}) =>
    api()
      .post("/api/comparisons")
      .send({
        mode: "compare",
        editor: "unified",
        beforePath: oldFile,
        afterPath: newFile,
        ...extra,
      });
  const open = (extra = {}) =>
    api()
      .post("/api/comparisons/document")
      .send({
        targetPath: oldFile,
        ...extra,
      });

  beforeEach(() => {
    const temporary = fileURLToPath(
      new URL("../../../.test-tmp/", import.meta.url),
    );
    fs.mkdirSync(temporary, { recursive: true });
    root = fs.mkdtempSync(path.join(temporary, "agent-review-"));
    oldFile = path.join(root, "Old.md");
    newFile = path.join(root, "New.md");
    fs.writeFileSync(oldFile, before);
    fs.writeFileSync(newFile, after);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists a readable title and version labels separately from source paths", async () => {
    const created = await compare({
      title: "Review the laser product page's service descriptions",
      beforeLabel: "Current page",
      afterLabel: "Proposed service descriptions",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: "Review the laser product page's service descriptions",
      beforeLabel: "Current page",
      afterLabel: "Proposed service descriptions",
      beforePath: oldFile,
      afterPath: newFile,
      handoff: "chat",
      autosave: "none",
      destinationPath: null,
    });
    expect(
      (await api().get(`/api/comparisons/${created.body.id}`)).body,
    ).toEqual(created.body);
  });

  it.each([
    "old",
    "new",
  ] as const)("preselects the %s input without rewriting it and saves only to that file", async (side) => {
    const destination = side === "old" ? oldFile : newFile;
    const seed = side === "old" ? before : after;
    const inode = fs.statSync(destination).ino;
    const created = await compare({ autosave: destination });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      autosave: destination,
      destinationPath: destination,
      baseVersion: side,
      savedText: seed,
      draft: { markdown: seed, decisions: {} },
    });
    expect(fs.statSync(destination).ino).toBe(inode);
    const saved = await api()
      .post(`/api/comparisons/${created.body.id}/save`)
      .send({
        revision: created.body.revision,
        markdown: "# Edited policy",
        decisions: {},
      });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(destination, "utf8")).toBe("# Edited policy");
    expect(fs.readFileSync(side === "old" ? newFile : oldFile, "utf8")).toBe(
      side === "old" ? after : before,
    );
  });

  it.each([
    { selected: undefined, expected: "new", text: after },
    { selected: "old", expected: "old", text: before },
  ])("seeds a new autosave copy from $expected", async ({
    selected,
    expected,
    text,
  }) => {
    const output = path.join(root, "Reviewed.md");
    const created = await compare({ autosave: output, autosaveBase: selected });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      autosave: output,
      destinationPath: output,
      baseVersion: expected,
      savedText: text,
    });
    expect(fs.readFileSync(output, "utf8")).toBe(text);
    expect(fs.readFileSync(oldFile, "utf8")).toBe(before);
    expect(fs.readFileSync(newFile, "utf8")).toBe(after);
  });

  it("refuses an unrelated existing autosave destination without changing its contents", async () => {
    const output = path.join(root, "Unrelated.md");
    fs.writeFileSync(output, "Someone else's work");
    const created = await compare({ autosave: output });
    expect(created.status).toBe(409);
    expect(fs.readFileSync(output, "utf8")).toBe("Someone else's work");
    expect(fs.readFileSync(oldFile, "utf8")).toBe(before);
    expect(fs.readFileSync(newFile, "utf8")).toBe(after);
    expect(
      fs.existsSync(path.join(root, "comparisons"))
        ? fs
            .readdirSync(path.join(root, "comparisons"))
            .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        : [],
    ).toEqual([]);
  });

  it("creates a clean autosave copy of annotated source while keeping suggestions and comments in the review", async () => {
    const annotated = [
      "# Plan",
      "",
      "Use {~~old~>new~~}{#s1} wording.",
      "",
      "{==This sentence==}{>>Clarify for beginners.<<}{#c1}",
      "",
      "`{++literal++}`",
      "",
      "---",
      "other: true",
      "comments:",
      "  c1:",
      "    by: User",
      "    at: 2026-11-21T18:00:00.000Z",
      "  c2:",
      "    body: Keep this reply too.",
      "    by: AI",
      "    at: 2026-11-21T18:01:00.000Z",
      "    re: c1",
      "suggestions:",
      "  s1:",
      "    by: AI",
      "    at: 2026-11-21T18:00:00.000Z",
      "",
    ].join("\n");
    fs.writeFileSync(newFile, annotated);
    const output = path.join(root, "Clean reviewed copy.md");
    const created = await compare({ autosave: output });
    expect(created.status).toBe(201);
    const clean =
      "# Plan\n\nUse old wording.\n\nThis sentence\n\n`{++literal++}`\n\n---\nother: true\n";
    expect(fs.readFileSync(output, "utf8")).toBe(clean);
    expect(fs.readFileSync(newFile, "utf8")).toBe(annotated);
    expect(created.body).toMatchObject({
      draft: { markdown: annotated, cleanMarkdown: clean, decisions: {} },
      reviewComments: [
        { id: "c1", content: "Clarify for beginners." },
        { id: "c2", content: "Keep this reply too.", parentCommentId: "c1" },
      ],
    });
    const reread = await api().get(`/api/comparisons/${created.body.id}`);
    expect(reread.body.draft.markdown).toBe(annotated);
    expect(reread.body.reviewComments).toEqual(created.body.reviewComments);
  });

  it("keeps a no-autosave document's edits, decisions, suggestions and comments without sending feedback", async () => {
    const created = await open({ autosave: "none" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      autosave: "none",
      destinationPath: null,
      handoff: "chat",
    });
    const route = `/api/comparisons/${created.body.id}`;
    const draft = {
      markdown: "# Edited policy\n\n{++Pending suggestion++}",
      cleanMarkdown: "# Edited policy",
      decisions: { reviewed: "kept" },
    };
    const updated = await api()
      .post(`${route}/draft`)
      .send({
        revision: created.body.revision,
        ...draft,
        reviewComments: [comment],
      });
    expect(updated.status).toBe(200);
    expect((await api().get(route)).body).toMatchObject({
      draft,
      reviewComments: [comment],
      status: "open",
      feedback: null,
      autosave: "none",
      destinationPath: null,
    });
    expect(fs.readFileSync(oldFile, "utf8")).toBe(before);
    expect((await open({ autosave: "none" })).body).toMatchObject({
      id: created.body.id,
      draft,
      reviewComments: [comment],
    });
  });

  it("updates explicit invocation metadata when reopening a document without losing its draft", async () => {
    const created = await open();
    const route = `/api/comparisons/${created.body.id}`;
    await api()
      .post(`${route}/draft`)
      .send({
        revision: created.body.revision,
        markdown: "Unfinished document",
        decisions: {},
        reviewComments: [comment],
      });
    const reopened = await open({
      title: "Review how the laser product warranty works",
      handoff: "button",
      autosave: "none",
    });
    expect(reopened.status).toBe(201);
    expect(reopened.body).toMatchObject({
      id: created.body.id,
      title: "Review how the laser product warranty works",
      handoff: "button",
      autosave: "none",
      destinationPath: null,
      draft: { markdown: "Unfinished document" },
      reviewComments: [comment],
    });
    expect(fs.readFileSync(oldFile, "utf8")).toBe(before);
  });

  it("copies the current document draft to a new autosave path and preserves its review through detach and rebind", async () => {
    const created = await open();
    const route = `/api/comparisons/${created.body.id}`;
    const draft = {
      markdown: "Current text\n\n{++Pending suggestion++}",
      cleanMarkdown: "Current text",
      decisions: { reviewed: "kept" },
    };
    const updated = await api()
      .post(`${route}/draft`)
      .send({
        revision: created.body.revision,
        ...draft,
        reviewComments: [comment],
      });
    expect(updated.status).toBe(200);
    const output = path.join(root, "Review copy.md");
    const copied = await open({ autosave: output });
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({
      id: created.body.id,
      autosave: output,
      destinationPath: output,
      draft,
      reviewComments: [comment],
    });
    expect(fs.readFileSync(output, "utf8")).toBe(draft.cleanMarkdown);
    expect(fs.readFileSync(oldFile, "utf8")).toBe(before);
    const detached = await open({ targetPath: output, autosave: "none" });
    expect(detached.body.id).toBe(created.body.id);
    const rebound = await open({ targetPath: output, autosave: output });
    expect(rebound.status).toBe(201);
    expect(rebound.body).toMatchObject({
      id: created.body.id,
      autosave: output,
      destinationPath: output,
      draft,
      reviewComments: [comment],
    });
    expect((await open()).body.id).not.toBe(created.body.id);
    expect(fs.readFileSync(output, "utf8")).toBe(draft.cleanMarkdown);
  });

  it("honors button handoff and treats existing persisted sessions as button handoff", async () => {
    const created = await compare({ handoff: "button", autosave: "none" });
    expect(created.status).toBe(201);
    expect(created.body.handoff).toBe("button");
    const filename = path.join(root, "comparisons", `${created.body.id}.json`);
    const legacy = JSON.parse(fs.readFileSync(filename, "utf8"));
    delete legacy.handoff;
    delete legacy.autosave;
    fs.writeFileSync(filename, JSON.stringify(legacy));
    expect(
      (await api().get(`/api/comparisons/${created.body.id}`)).body,
    ).toMatchObject({
      handoff: "button",
      autosave: "none",
    });
  });

  it("switches an existing review to button handoff without losing work or accepting stale transitions", async () => {
    const created = await compare();
    const route = `/api/comparisons/${created.body.id}`;
    const draft = { markdown: "Edited review", decisions: { change: "kept" } };
    const updated = await api()
      .post(`${route}/draft`)
      .send({
        revision: created.body.revision,
        ...draft,
        reviewComments: [comment],
      });
    expect(updated.status).toBe(200);
    const stale = await api().post(`${route}/handoff`).send({
      revision: created.body.revision,
      handoff: "button",
    });
    expect(stale.status).toBe(409);
    expect((await api().get(route)).body).toMatchObject({
      handoff: "chat",
      draft,
    });
    const configured = await api().post(`${route}/handoff`).send({
      revision: updated.body.revision,
      handoff: "button",
    });
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({
      handoff: "button",
      draft,
      reviewComments: [comment],
    });
    const filename = path.join(root, "comparisons", `${created.body.id}.json`);
    const persisted = fs.readFileSync(filename, "utf8");
    expect((await api().get(`${route}/watch`)).body).toEqual(configured.body);
    expect(fs.readFileSync(filename, "utf8")).toBe(persisted);
    expect(fs.readFileSync(oldFile, "utf8")).toBe(before);
  });

  it("preserves a stale tab's full review in a discoverable no-file recovery without mutating its source review", async () => {
    const created = await compare({ autosave: newFile });
    const route = `/api/comparisons/${created.body.id}`;
    const updated = await api().post(`${route}/draft`).send({
      revision: created.body.revision,
      markdown: "The other tab's persisted review",
      decisions: {},
    });
    expect(updated.status).toBe(200);
    const filename = path.join(root, "comparisons", `${created.body.id}.json`);
    const originalRecord = fs.readFileSync(filename, "utf8");
    const draft = {
      markdown: "My review\n\n{++Keep this pending suggestion++}",
      cleanMarkdown: "My review",
      decisions: { reviewed: "kept" },
    };
    const reply = {
      ...comment,
      id: "reply",
      parentCommentId: comment.id,
      content: "Reply from the stale tab",
    };
    const recovered = await api()
      .post(`${route}/fork`)
      .send({
        revision: created.body.revision,
        autosave: "none",
        baseVersion: "old",
        ...draft,
        reviewComments: [comment, reply],
      });
    expect(recovered.status).toBe(201);
    expect(recovered.body.id).not.toBe(created.body.id);
    expect(recovered.body).toMatchObject({
      autosave: "none",
      destinationPath: null,
      savedPath: null,
      handoff: "chat",
      baseVersion: "old",
      draft,
      reviewComments: [comment, reply],
    });
    const reread = await api().get(route);
    expect(reread.body).toMatchObject({
      id: created.body.id,
      draft: { markdown: "The other tab's persisted review" },
      recoveredReviews: [recovered.body],
    });
    expect(
      (await api().get(`/api/comparisons/${recovered.body.id}`)).body,
    ).toEqual(recovered.body);
    expect(fs.readFileSync(filename, "utf8")).toBe(originalRecord);
    expect(fs.readFileSync(oldFile, "utf8")).toBe(before);
    expect(fs.readFileSync(newFile, "utf8")).toBe(after);
  });

  it("explicit no-file recovery overrides supplied file paths and expands recoveries only one level", async () => {
    const original = await compare();
    const recover = (id: string, markdown: string) =>
      api()
        .post(`/api/comparisons/${id}/fork`)
        .send({
          autosave: "none",
          path: oldFile,
          expectedVersion: "an obsolete version",
          markdown,
          decisions: {},
          reviewComments: [comment],
        });
    const child = await recover(original.body.id, "First recovered draft");
    expect(child.status).toBe(201);
    const grandchild = await recover(child.body.id, "Another recovered draft");
    expect(grandchild.status).toBe(201);
    const parentRead = await api().get(`/api/comparisons/${original.body.id}`);
    expect(parentRead.body.recoveredReviews).toHaveLength(2);
    expect(parentRead.body.recoveredReviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: child.body.id,
          draft: { markdown: "First recovered draft", decisions: {} },
        }),
        expect.objectContaining({
          id: grandchild.body.id,
          draft: { markdown: "Another recovered draft", decisions: {} },
        }),
      ]),
    );
    expect(
      parentRead.body.recoveredReviews.every(
        (review: Record<string, unknown>) => !review.recoveredReviews,
      ),
    ).toBe(true);
    const childRead = await api().get(`/api/comparisons/${child.body.id}`);
    expect(childRead.body.recoveredReviews[0].id).toBe(grandchild.body.id);
    expect(fs.readFileSync(oldFile, "utf8")).toBe(before);
  });

  it.each([
    "changed",
    "removed",
  ])("keeps the source version guard when a detached source is %s", async (change) => {
    const created = await open();
    const detached = await open({ autosave: "none" });
    expect(detached.body.id).toBe(created.body.id);
    const route = `/api/comparisons/${created.body.id}`;
    const updated = await api().post(`${route}/draft`).send({
      revision: detached.body.revision,
      markdown: "Unfinished review",
      decisions: {},
    });
    expect(updated.status).toBe(200);
    if (change === "removed") fs.unlinkSync(oldFile);
    else fs.writeFileSync(oldFile, "External edit");
    const rebound = await open({ autosave: oldFile });
    expect(rebound.status).toBe(409);
    expect((await api().get(route)).body).toMatchObject({
      autosave: "none",
      destinationPath: null,
      draft: { markdown: "Unfinished review" },
    });
    if (change === "removed") expect(fs.existsSync(oldFile)).toBe(false);
    else expect(fs.readFileSync(oldFile, "utf8")).toBe("External edit");
  });

  it.each([
    { autosave: "relative.md" },
    { autosave: "/somewhere/file.txt" },
    { autosave: false },
    { handoff: "email" },
    { autosaveBase: "other" },
  ])("rejects an invalid launch policy: %j", async (options) => {
    expect((await compare(options)).status).toBe(400);
  });
});
