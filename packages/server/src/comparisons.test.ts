import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import type { Comparison, ComparisonSegment } from "./comparisons.js";

describe("file comparison reviews", () => {
  let root: string;
  let target: string;
  const before = "# Policy\r\n\r\nold first\r\nunchanged\r\nold last";
  const after = "# Policy\r\n\r\nnew first\r\nunchanged\r\nnew last";
  const api = (documentRoot?: string) =>
    createApp({
      assetRoot: documentRoot,
      homeDir: root,
      comparisonsDir: path.join(root, "comparisons"),
      staticDirPath: root,
    }).app;
  const changes = (review: Comparison) =>
    review.segments.filter(
      (segment: ComparisonSegment) => segment.kind === "change",
    );
  const create = (mode = "proposal", extra = {}) =>
    request(api())
      .post("/api/comparisons")
      .send({
        mode,
        targetPath: target,
        beforeText: before,
        afterText: after,
        ...extra,
      });
  const explicitlyRecover = async (route: string) => {
    const recovered = await request(api()).post(`${route}/recover`).send({});
    expect(recovered.status).toBe(200);
    return request(api()).get(route);
  };
  const checkpointDraft = async (route: string) => {
    const state = await request(api()).get(`${route}/state`);
    const checkpoint = state.body.review.recoveryCheckpoints[0];
    expect(checkpoint).toBeDefined();
    const read = await request(api()).get(
      `${route}/checkpoints/${checkpoint.id}`,
    );
    expect(read.status).toBe(200);
    return read.body.workingDraft;
  };
  const chooseOriginal = async () => {
    const review = (await create("proposal", { editor: "unified" })).body;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/base`)
      .send({ revision: review.revision, choice: "old" });
    expect(selected.status).toBe(200);
    return selected.body;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-comparison-"));
    target = path.join(root, "AGENTS.md");
    fs.writeFileSync(target, before, { mode: 0o640 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts a comparison unbound and binds the selected unchanged input without writing", async () => {
    const candidate = path.join(root, "Candidate.md");
    fs.writeFileSync(candidate, after);
    const review = (
      await create("proposal", { editor: "unified", afterPath: candidate })
    ).body;
    const route = `/api/comparisons/${review.id}`;
    expect(review).toMatchObject({
      destinationPath: null,
      baseOptions: { old: target, new: candidate },
    });
    const originalInode = fs.statSync(target).ino;
    const selected = await request(api()).post(`${route}/base`).send({
      revision: review.revision,
      choice: "old",
      markdown: "# Annotated old version",
      cleanMarkdown: before,
      decisions: {},
    });
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({
      baseVersion: "old",
      destinationPath: target,
      savedText: before,
      draft: { markdown: "# Annotated old version" },
      targetChanged: false,
    });
    expect(fs.statSync(target).ino).toBe(originalInode);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const conflicting = await request(api()).post(`${route}/base`).send({
      revision: review.revision,
      choice: "new",
    });
    expect(conflicting.status).toBe(409);
    expect(fs.readFileSync(candidate, "utf8")).toBe(after);
  });

  it("rejects edited or inline-only input paths and seeds a fresh copy without overwriting files", async () => {
    const historical = path.join(root, "Historical.md");
    fs.writeFileSync(historical, before);
    fs.writeFileSync(target, after);
    const review = (await create("applied", { editor: "unified" })).body;
    const route = `/api/comparisons/${review.id}`;
    const select = (fields: object) =>
      request(api())
        .post(`${route}/base`)
        .send({
          revision: review.revision,
          ...fields,
        });
    expect(review).toMatchObject({ baseOptions: { old: null, new: target } });
    expect((await select({ choice: "old" })).status).toBe(400);
    fs.writeFileSync(target, "An external version");
    expect((await select({ choice: "new" })).status).toBe(409);
    expect((await select({ choice: "copy", path: historical })).status).toBe(
      409,
    );
    const output = path.join(root, "New base.md");
    const copied = await select({ choice: "copy", path: output });
    expect(copied.status).toBe(200);
    expect(copied.body).toMatchObject({
      baseVersion: "old",
      destinationPath: output,
      savedText: before,
    });
    expect(fs.readFileSync(output, "utf8")).toBe(before);
    expect(fs.readFileSync(historical, "utf8")).toBe(before);
    expect(fs.readFileSync(target, "utf8")).toBe("An external version");
  });

  it("allows a distinct old Markdown file as the base of an applied review", async () => {
    const oldFile = path.join(root, "Previous.md");
    fs.writeFileSync(oldFile, before);
    fs.writeFileSync(target, after);
    const review = (
      await create("applied", {
        editor: "unified",
        beforePath: oldFile,
      })
    ).body;
    expect(review.baseOptions).toEqual({ old: oldFile, new: target });
    const inode = fs.statSync(oldFile).ino;
    const chosen = await request(api())
      .post(`/api/comparisons/${review.id}/base`)
      .send({
        revision: review.revision,
        choice: "old",
      });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({
      baseVersion: "old",
      destinationPath: oldFile,
      savedText: before,
    });
    expect(fs.statSync(oldFile).ino).toBe(inode);
    expect(fs.readFileSync(target, "utf8")).toBe(after);
    const aliased = path.join(root, "Alias.md");
    fs.symlinkSync(target, aliased);
    const sameFile = (
      await create("applied", {
        editor: "unified",
        beforePath: aliased,
        beforeText: after,
      })
    ).body;
    expect(sameFile.baseOptions).toEqual({ old: null, new: target });
  });

  it("forks a stale tab's text, comments and selected reference without rebinding the original review", async () => {
    const stale = await chooseOriginal();
    const app = request(api());
    const route = `/api/comparisons/${stale.id}`;
    const contact = (id: string, content: string) => ({
      id,
      changeId: "document",
      content,
      createdAt: "2026-11-19T12:00:00.000Z",
      scope: "document",
    });
    const currentComment = contact("fresh", "Newer tab review");
    const updated = await app.post(`${route}/save`).send({
      revision: stale.revision,
      markdown: "Newer tab on disk",
      decisions: {},
      reviewComments: [currentComment],
    });
    expect(updated.status).toBe(200);
    const savedReview = (await app.get(route)).body;
    const inode = fs.statSync(target).ino;
    const copy = path.join(root, "Stale copy.md");
    const inspected = await app
      .get(`${route}/destination`)
      .query({ path: copy });
    const staleComment = contact(
      "stale",
      "Keep only the stale tab comment on this copy",
    );
    const submission = {
      revision: stale.revision,
      path: inspected.body.path,
      expectedVersion: inspected.body.version,
      baseVersion: "new",
      markdown: "Stale tab\n\n{++pending++}",
      cleanMarkdown: "Stale tab",
      decisions: { kept: "kept" },
      reviewComments: [staleComment],
    };
    const forked = await app.post(`${route}/fork`).send(submission);
    expect(forked.status).toBe(201);
    expect(forked.body.id).not.toBe(stale.id);
    const copyReview = await app.get(`/api/comparisons/${forked.body.id}`);
    expect(copyReview.body).toMatchObject({
      mode: "proposal",
      beforeText: before,
      afterText: after,
      beforeLabel: savedReview.beforeLabel,
      afterLabel: savedReview.afterLabel,
      baseVersion: "new",
      destinationPath: copy,
      savedText: "Stale tab",
      draft: {
        markdown: submission.markdown,
        cleanMarkdown: submission.cleanMarkdown,
        decisions: submission.decisions,
      },
      reviewComments: [staleComment],
      feedback: null,
      status: "open",
    });
    expect((await app.get(route)).body).toEqual(savedReview);
    expect(fs.statSync(target).ino).toBe(inode);
    expect(fs.readFileSync(target, "utf8")).toBe("Newer tab on disk");
    expect(fs.readFileSync(copy, "utf8")).toBe("Stale tab");

    // Creating or saving a copy is not a handoff. Only a new Send action
    // reaches the original watcher, even through a fresh server instance.
    expect((await app.get(`${route}/watch`)).body).toEqual(savedReview);
    const sent = await app
      .post(`/api/comparisons/${forked.body.id}/send`)
      .send({
        ...submission,
        revision: copyReview.body.revision,
        comment: "Feedback for the waiting agent",
      });
    expect(sent.status).toBe(200);
    const restarted = request(api());
    expect((await restarted.get(`${route}/watch`)).body).toMatchObject({
      id: forked.body.id,
      feedback: {
        comment: "Feedback for the waiting agent",
        destinationPath: copy,
        saved: true,
      },
    });
    expect((await restarted.get(route)).body).toEqual(savedReview);
    expect(fs.readFileSync(target, "utf8")).toBe("Newer tab on disk");
  });

  it("rejects forks to the active file or to a copy changed since inspection", async () => {
    const review = await chooseOriginal();
    const app = request(api());
    const route = `/api/comparisons/${review.id}`;
    const alias = path.join(root, "Alias.md");
    fs.symlinkSync(target, alias);
    const copy = path.join(root, "Copy.md");
    const output = (await app.get(`${route}/destination`).query({ path: copy }))
      .body;
    fs.writeFileSync(copy, "Somebody else's copy");
    const body = { markdown: "My version", decisions: {} };
    expect(
      (await app.post(`${route}/fork`).send({ ...body, path: copy })).status,
    ).toBe(400);
    expect(
      (
        await app.post(`${route}/fork`).send({
          ...body,
          path: copy,
          expectedVersion: output.version,
        })
      ).status,
    ).toBe(409);
    for (const active of [target, alias]) {
      expect(
        (
          await app.post(`${route}/fork`).send({
            ...body,
            path: active,
            expectedVersion: review.baseVersion,
          })
        ).status,
      ).toBe(409);
    }
    const bad = await app.post(`${route}/fork`).send({
      ...body,
      path: path.join(root, "Bad side.md"),
      expectedVersion: null,
      baseVersion: "other",
    });
    expect(bad.status).toBe(400);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(fs.readFileSync(copy, "utf8")).toBe("Somebody else's copy");
    expect((await app.get(route)).body).toEqual(review);
  });

  it.each([
    false,
    true,
  ])("creates an empty base preserving review work (prior interruption: %s)", async (interrupted) => {
    const opened = await request(api())
      .post("/api/comparisons/document")
      .send({});
    expect(opened.status).toBe(201);
    const route = `/api/comparisons/${opened.body.id}`;
    const output = path.join(root, "Untitled.md");
    const proposed = "{++proposed paragraph++}";
    const comment = {
      id: "comment",
      changeId: "document",
      createdAt: "2026-11-19T12:00:00.000Z",
      content: "Keep the conversation with the new file.",
      scope: "document",
    };
    const createBase = (revision: number) =>
      request(api())
        .post(`${route}/base`)
        .send({
          revision,
          choice: "copy",
          path: output,
          markdown: proposed,
          cleanMarkdown: "",
          decisions: {},
          reviewComments: [comment],
        });
    let revision = opened.body.revision;
    if (interrupted) {
      vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("new file publish interrupted"), {
          code: "EIO",
        });
      });
      expect((await createBase(revision)).status).toBe(500);
      expect(fs.existsSync(output)).toBe(false);
      const recovered = await explicitlyRecover(route);
      expect(recovered.body).toMatchObject({
        destinationPath: null,
        draft: null,
        reviewComments: [],
      });
      expect(await checkpointDraft(route)).toMatchObject({
        markdown: proposed,
        cleanMarkdown: "",
        reviewComments: [comment],
      });
      revision = recovered.body.revision;
    }
    const copied = await createBase(revision);
    expect(copied.status).toBe(200);
    expect(copied.body).toMatchObject({
      destinationPath: output,
      savedPath: output,
      savedText: "",
      draft: { markdown: proposed, cleanMarkdown: "" },
      reviewComments: [comment],
    });
    expect(fs.readFileSync(output, "utf8")).toBe("");
    const reopened = await request(api())
      .post("/api/comparisons/document")
      .send({ targetPath: output });
    expect(reopened.body).toMatchObject({
      id: opened.body.id,
      draft: { markdown: proposed },
      reviewComments: [comment],
    });
    const rejected = await request(api())
      .post(`${route}/save`)
      .send({
        revision: copied.body.revision,
        markdown: "",
        cleanMarkdown: "",
        decisions: {},
        reviewComments: [comment],
      });
    expect(rejected.status).toBe(200);
    expect(fs.readFileSync(output, "utf8")).toBe("");
    expect((await request(api()).get(route)).body).toMatchObject({
      draft: { markdown: "", cleanMarkdown: "" },
      reviewComments: [comment],
    });
  });

  it("confines hosted sidecar sources and destinations to the document root", async () => {
    const documentRoot = path.join(root, "documents");
    const outsideDir = path.join(root, "documents-other");
    fs.mkdirSync(documentRoot);
    fs.mkdirSync(outsideDir);
    const inside = path.join(documentRoot, "Inside.md");
    const outside = path.join(outsideDir, "Outside.md");
    const symlink = path.join(documentRoot, "Link.md");
    const directoryLink = path.join(documentRoot, "Other");
    fs.writeFileSync(inside, before);
    fs.writeFileSync(outside, "outside document");
    fs.symlinkSync(outside, symlink);
    fs.symlinkSync(outsideDir, directoryLink);
    const hosted = request(api(documentRoot));
    const reads = vi.spyOn(fs, "readFileSync");
    for (const targetPath of [outside, symlink]) {
      const opened = await hosted
        .post("/api/comparisons/document")
        .send({ targetPath });
      expect(opened.status).toBe(403);
      const compared = await hosted.post("/api/comparisons").send({
        mode: "compare",
        editor: "unified",
        beforePath: inside,
        afterPath: targetPath,
      });
      expect(compared.status).toBe(403);
    }
    expect(reads.mock.calls.some(([filename]) => filename === outside)).toBe(
      false,
    );
    reads.mockRestore();
    const opened = await hosted
      .post("/api/comparisons/document")
      .send({ targetPath: inside });
    expect(opened.status).toBe(201);
    const route = `/api/comparisons/${opened.body.id}`;
    const escaped = path.join(directoryLink, "New.md");
    expect(
      (await hosted.get(`${route}/destination`).query({ path: escaped }))
        .status,
    ).toBe(403);
    const saved = await hosted.post(`${route}/save`).send({
      revision: opened.body.revision,
      path: escaped,
      expectedVersion: null,
      markdown: "copy",
      decisions: {},
    });
    expect(saved.status).toBe(403);
    expect(fs.existsSync(path.join(outsideDir, "New.md"))).toBe(false);
    expect(fs.readFileSync(inside, "utf8")).toBe(before);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside document");
  });

  it("recovers an editable draft without writing and saves only accepted Markdown", async () => {
    const review = await chooseOriginal();
    const route = `/api/comparisons/${review.id}`;
    const payload = {
      markdown: "# Draft\r\n\r\n{++pending++}",
      cleanMarkdown: "# Draft\r\n",
      decisions: { "kept-content": "kept" },
    };
    const recovered = await request(api())
      .post(`${route}/draft`)
      .send({ revision: review.revision, ...payload });
    expect(recovered.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect((await request(api()).get(route)).body).toMatchObject({
      draft: payload,
      savedText: before,
      savedPath: target,
    });
    const saved = await request(api())
      .post(`${route}/save`)
      .send({ revision: recovered.body.revision, ...payload });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      status: "open",
      draft: payload,
      beforeText: before,
      afterText: after,
      destinationPath: target,
      savedPath: target,
      savedText: payload.cleanMarkdown,
      targetChanged: false,
      completion: null,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(payload.cleanMarkdown);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("guards Save As against existing and newly created files and keeps the reference frozen", async () => {
    const review = (
      await request(api()).post("/api/comparisons").send({
        mode: "compare",
        editor: "unified",
        beforeText: before,
        afterText: after,
      })
    ).body;
    const route = `/api/comparisons/${review.id}`;
    const output = path.join(root, "Third file.md");
    const payload = {
      revision: review.revision,
      path: output,
      markdown: after,
      decisions: {},
    };
    const inspect = () =>
      request(api()).get(`${route}/destination`).query({ path: output });
    expect((await inspect()).body).toEqual({
      path: output,
      version: null,
      markdown: null,
    });
    fs.writeFileSync(output, "another author's file");
    expect(
      (
        await request(api())
          .post(`${route}/save`)
          .send({ ...payload, expectedVersion: null })
      ).status,
    ).toBe(409);
    const version = (await inspect()).body.version;
    expect(
      (await request(api()).post(`${route}/save`).send(payload)).status,
    ).toBe(400);
    expect(fs.readFileSync(output, "utf8")).toBe("another author's file");
    const result = await request(api())
      .post(`${route}/save`)
      .send({ ...payload, expectedVersion: version });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      mode: "compare",
      targetPath: null,
      beforeText: before,
      afterText: after,
      destinationPath: output,
      savedText: after,
    });
    expect(fs.readFileSync(output, "utf8")).toBe(after);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const separate = path.join(root, "New.md");
    const created = await request(api())
      .post(`${route}/save`)
      .send({
        ...payload,
        revision: result.body.revision,
        path: separate,
        expectedVersion: null,
      });
    expect(created.status).toBe(200);
    expect(fs.readFileSync(separate, "utf8")).toBe(after);
  });

  it("protects externally changed files while preserving drafts, and sends frozen feedback without applying it", async () => {
    const review = await chooseOriginal();
    const route = `/api/comparisons/${review.id}`;
    const initial = { markdown: "first draft", decisions: {} };
    fs.writeFileSync(target, "external work");
    const recovered = await request(api())
      .post(`${route}/draft`)
      .send({ revision: review.revision, ...initial });
    expect(recovered.body).toMatchObject({
      draft: initial,
      targetChanged: true,
    });
    const inspected = await request(api()).get(`${route}/destination`);
    expect(inspected.body.markdown).toBe("external work");
    const overwrite = await request(api())
      .post(`${route}/save`)
      .send({
        revision: recovered.body.revision,
        ...initial,
        path: target,
        expectedVersion: inspected.body.version,
      });
    expect(overwrite.status).toBe(409);
    const sent = await request(api())
      .post(`${route}/send`)
      .send({
        revision: recovered.body.revision,
        ...initial,
        comment: "unsaved review",
      });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      status: "completed",
      completion: { fileWritten: false },
      feedback: {
        draft: initial,
        reference: { label: "After", markdown: after },
        destinationPath: target,
        saved: false,
        comment: "unsaved review",
      },
    });
    const updated = await request(api()).post(`${route}/draft`).send({
      revision: sent.body.revision,
      markdown: "later draft",
      decisions: {},
    });
    expect(updated.status).toBe(200);
    expect(updated.body.feedback).toEqual(sent.body.feedback);
    expect(fs.readFileSync(target, "utf8")).toBe("external work");
  });

  it("reopens ordinary drafts by source path and creates independent untitled documents", async () => {
    const createDocument = (targetPath?: string) =>
      request(api()).post("/api/comparisons/document").send({ targetPath });
    const opened = await createDocument(target);
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({
      editor: "unified",
      mode: "document",
      afterText: before,
      destinationPath: target,
    });
    const route = `/api/comparisons/${opened.body.id}`;
    const durable = await request(api()).post(`${route}/draft`).send({
      revision: opened.body.revision,
      markdown: "working document",
      decisions: {},
    });
    expect(durable.status).toBe(200);
    expect((await createDocument(target)).body).toMatchObject({
      id: opened.body.id,
      draft: { markdown: "working document" },
    });
    const blank = await createDocument();
    expect(blank.body).toMatchObject({
      mode: "document",
      destinationPath: null,
      afterText: "",
    });
    expect((await createDocument()).body.id).not.toBe(blank.body.id);
  });

  it.each([
    { name: "a clean edit", annotation: "", keepReview: false },
    {
      name: "a pending suggestion",
      annotation: "\n\n{++pending++}",
      keepReview: true,
    },
  ])("recognizes an external change after $name", async ({
    annotation,
    keepReview,
  }) => {
    const app = request(api());
    const open = () =>
      app.post("/api/comparisons/document").send({ targetPath: target });
    const source = await open();
    const markdown = before.replaceAll("\r\n", "\n") + annotation;
    const saved = await app
      .post(`/api/comparisons/${source.body.id}/save`)
      .send({
        revision: source.body.revision,
        markdown,
        cleanMarkdown: before,
        decisions: {},
      });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    fs.writeFileSync(target, "external revision");
    const reopened = await open();
    expect(reopened.status).toBe(201);
    if (keepReview) {
      expect(reopened.body).toMatchObject({
        id: source.body.id,
        draft: { markdown },
        targetChanged: true,
      });
    } else {
      expect(reopened.body.id).toBe(source.body.id);
      expect(reopened.body).toMatchObject({
        draft: { markdown: "external revision" },
        savedText: "external revision",
        targetChanged: false,
      });
    }
  });

  it("opens the Save As review by its new name and keeps the original and displaced reviews separate", async () => {
    const app = request(api());
    const open = (targetPath: string) =>
      app.post("/api/comparisons/document").send({ targetPath });
    const copy = path.join(root, "Copy.md");
    fs.writeFileSync(copy, after);
    const [source, previous] = await Promise.all([open(target), open(copy)]);
    const route = `/api/comparisons/${source.body.id}`;
    const contact = {
      id: "comment",
      changeId: "document",
      content: "This follows the copy.",
      createdAt: "2026-11-19T12:00:00.000Z",
      scope: "document",
    };
    const version = (
      await app.get(`${route}/destination`).query({ path: copy })
    ).body.version;
    const inode = fs.statSync(copy).ino;
    const saved = await app.post(`${route}/save`).send({
      revision: source.body.revision,
      path: copy,
      expectedVersion: version,
      markdown: after,
      decisions: {},
      reviewComments: [contact],
    });
    expect(saved.status).toBe(200);
    expect(fs.statSync(copy).ino).toBe(inode);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect((await open(copy)).body).toMatchObject({
      id: source.body.id,
      destinationPath: copy,
      reviewComments: [contact],
    });
    const reopenedSource = await open(target);
    expect(reopenedSource.body.id).not.toBe(source.body.id);
    expect(reopenedSource.body).toMatchObject({
      savedText: before,
      reviewComments: [],
    });
    expect(
      (await app.get(`/api/comparisons/${previous.body.id}`)).body,
    ).toMatchObject({
      id: previous.body.id,
      destinationPath: copy,
      reviewComments: [],
    });
  });

  it("keeps proposal sidecars separate from opening the same filename", async () => {
    const app = request(api());
    const review = await chooseOriginal();
    const copy = path.join(root, "Proposed copy.md");
    const saved = await app.post(`/api/comparisons/${review.id}/save`).send({
      revision: review.revision,
      path: copy,
      expectedVersion: null,
      markdown: after,
      decisions: {},
    });
    expect(saved.status).toBe(200);
    const opened = await app
      .post("/api/comparisons/document")
      .send({ targetPath: copy });
    expect(opened.body.id).not.toBe(review.id);
    expect(opened.body).toMatchObject({ mode: "document", savedText: after });
  });

  it("opens the moved review by its new name even after an interrupted Save As", async () => {
    const app = request(api());
    const open = (targetPath: string) =>
      app.post("/api/comparisons/document").send({ targetPath });
    const source = await open(target);
    const route = `/api/comparisons/${source.body.id}`;
    const copy = path.join(root, "Recovered copy.md");
    const link = fs.linkSync.bind(fs);
    const rename = fs.renameSync.bind(fs);
    let published = false;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      link(from, to);
      if (to === copy) published = true;
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (published)
        throw Object.assign(new Error("save bookkeeping interrupted"), {
          code: "EIO",
        });
      rename(from, to);
    });
    const saved = await app.post(`${route}/save`).send({
      revision: source.body.revision,
      path: copy,
      expectedVersion: null,
      markdown: after,
      decisions: {},
    });
    expect(saved.status).toBe(500);
    vi.restoreAllMocks();
    const inode = fs.statSync(copy).ino;
    await explicitlyRecover(route);
    const recovered = await open(copy);
    expect(recovered.body).toMatchObject({
      id: source.body.id,
      destinationPath: copy,
      savedText: after,
      targetChanged: false,
    });
    expect(fs.statSync(copy).ino).toBe(inode);
    expect((await open(target)).body.id).not.toBe(source.body.id);
  });

  it("retains filename ownership when a Save As stopped before replacing the destination", async () => {
    const app = request(api());
    const open = (targetPath: string) =>
      app.post("/api/comparisons/document").send({ targetPath });
    const copy = path.join(root, "Existing.md");
    fs.writeFileSync(copy, after);
    const [source, previous] = await Promise.all([open(target), open(copy)]);
    const route = `/api/comparisons/${source.body.id}`;
    const version = (
      await app.get(`${route}/destination`).query({ path: copy })
    ).body.version;
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === copy)
        throw Object.assign(new Error("file replacement interrupted"), {
          code: "EIO",
        });
      rename(from, to);
    });
    const saved = await app.post(`${route}/save`).send({
      revision: source.body.revision,
      path: copy,
      expectedVersion: version,
      markdown: "my changed draft",
      decisions: {},
    });
    expect(saved.status).toBe(500);
    vi.restoreAllMocks();
    await explicitlyRecover(route);
    expect((await open(copy)).body.id).toBe(previous.body.id);
    expect((await open(target)).body).toMatchObject({
      id: source.body.id,
      destinationPath: target,
      draft: null,
    });
    expect(await checkpointDraft(route)).toMatchObject({
      markdown: "my changed draft",
    });
    expect(fs.readFileSync(copy, "utf8")).toBe(after);
  });

  it("recovers a successful Save after an interrupted record update without replaying it", async () => {
    const review = await chooseOriginal();
    const route = `/api/comparisons/${review.id}`;
    const rename = fs.renameSync.bind(fs);
    let targetRenamed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (targetRenamed)
        throw Object.assign(new Error("record update failed"), { code: "EIO" });
      rename(source, destination);
      if (destination === target) targetRenamed = true;
    });
    const payload = {
      revision: review.revision,
      markdown: after,
      decisions: {},
    };
    expect(
      (await request(api()).post(`${route}/save`).send(payload)).status,
    ).toBe(500);
    expect(fs.readFileSync(target, "utf8")).toBe(after);
    vi.restoreAllMocks();
    const recovered = await explicitlyRecover(route);
    expect(recovered.body).toMatchObject({
      status: "open",
      savedText: after,
      draft: { markdown: after },
      targetChanged: false,
    });
    fs.writeFileSync(target, "newer text");
    expect(
      (await request(api()).post(`${route}/save`).send(payload)).status,
    ).toBe(409);
    expect(fs.readFileSync(target, "utf8")).toBe("newer text");
  });

  it("preserves the complete draft in recovery without overwriting the externally changed file", async () => {
    const review = await chooseOriginal();
    const route = `/api/comparisons/${review.id}`;
    const rename = fs.renameSync.bind(fs);
    let targetRenamed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (targetRenamed)
        throw Object.assign(new Error("record update failed"), { code: "EIO" });
      rename(source, destination);
      if (destination === target) targetRenamed = true;
    });
    expect(
      (
        await request(api())
          .post(`${route}/save`)
          .send({ revision: review.revision, markdown: after, decisions: {} })
      ).status,
    ).toBe(500);
    vi.restoreAllMocks();
    fs.writeFileSync(target, "newer text");
    const recovered = await explicitlyRecover(route);
    expect(recovered.body).toMatchObject({
      status: "open",
      savedText: before,
      draft: { markdown: before },
      targetChanged: true,
    });
    expect(await checkpointDraft(route)).toMatchObject({ markdown: after });
    expect(fs.readFileSync(target, "utf8")).toBe("newer text");
  });

  it("persists choices separately and only applies selected proposed blocks, preserving exact bytes and mode", async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.body.targetChanged).toBe(false);
    const blocks = changes(created.body);
    expect(blocks).toHaveLength(2);
    const selected = await request(api())
      .post(`/api/comparisons/${created.body.id}/decisions`)
      .send({
        revision: created.body.revision,
        comment: "Please preserve spacing",
        decisions: [
          { id: blocks[0].id, decision: "after", comment: "yes" },
          { id: blocks[1].id, decision: "before" },
        ],
      });
    expect(selected.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const reloaded = await request(api()).get(
      `/api/comparisons/${created.body.id}`,
    );
    expect(reloaded.body.comment).toBe("Please preserve spacing");
    expect(changes(reloaded.body)[0].comment).toBe("yes");
    const applied = await request(api())
      .post(`/api/comparisons/${created.body.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    expect(applied.body.completion).toMatchObject({
      fileWritten: true,
      targetPath: target,
      accepted: 1,
      reverted: 0,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(
      before.replace("old first", "new first"),
    );
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("keeps or reverts already-applied blocks without writing during selection", async () => {
    fs.writeFileSync(target, after);
    const review = (await create("applied")).body;
    const blocks = changes(review);
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: [
          { id: blocks[0].id, decision: "after" },
          { id: blocks[1].id, decision: "before" },
        ],
      });
    expect(selected.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe(after);
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    expect(applied.body.completion).toMatchObject({
      accepted: 1,
      reverted: 1,
      fileWritten: true,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(
      before.replace("old first", "new first"),
    );
  });

  it("blocks an unfinished selection and finishes without applying or changing the file", async () => {
    const review = (await create()).body;
    const incomplete = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: review.revision });
    expect(incomplete.status).toBe(409);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const finished = await request(api())
      .post(`/api/comparisons/${review.id}/complete`)
      .send({ revision: review.revision });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({
      status: "completed",
      completion: { fileWritten: false },
    });
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("rejects stale browser revisions without losing saved choices", async () => {
    const review = (await create()).body;
    const block = changes(review)[0];
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: [{ id: block.id, decision: "after" }],
      });
    expect(selected.status).toBe(200);
    const stale = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: [{ id: block.id, decision: "before" }],
      });
    expect(stale.status).toBe(409);
    const persisted = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(changes(persisted.body)[0].decision).toBe("after");
  });

  it("blocks newer destination edits, retains decisions, and refreshes explicitly", async () => {
    const review = (await create()).body;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block: ComparisonSegment) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const newer = `new heading\r\n${before}`;
    fs.writeFileSync(target, newer);
    const stale = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(stale.status).toBe(409);
    expect(fs.readFileSync(target, "utf8")).toBe(newer);
    const persisted = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(persisted.body.targetChanged).toBe(true);
    expect(
      changes(persisted.body).every(
        (block: ComparisonSegment) => block.decision === "after",
      ),
    ).toBe(true);
    const refreshed = await request(api())
      .post(`/api/comparisons/${review.id}/refresh`)
      .send({ revision: selected.body.revision });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.beforeText).toBe(newer);
    expect(refreshed.body.afterText).toBe(after);
    expect(refreshed.body.targetChanged).toBe(false);
    expect(
      changes(refreshed.body).filter(
        (block: ComparisonSegment) =>
          block.before === "old last" && block.after === "new last",
      )[0].decision,
    ).toBe("after");
    expect(
      changes(refreshed.body).some(
        (block: ComparisonSegment) => block.decision === "pending",
      ),
    ).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(newer);
  });

  it("never writes comparisons and converts only to an explicitly matching destination", async () => {
    const created = await create("compare", { targetPath: undefined });
    expect(created.status).toBe(201);
    const review = created.body;
    expect(review.targetPath).toBeNull();
    expect(
      (
        await request(api())
          .post(`/api/comparisons/${review.id}/apply`)
          .send({ revision: review.revision })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(api())
          .post(`/api/comparisons/${review.id}/decisions`)
          .send({
            revision: review.revision,
            decisions: [{ id: changes(review)[0].id, decision: "after" }],
          })
      ).status,
    ).toBe(400);
    const converted = await request(api())
      .post(`/api/comparisons/${review.id}/convert`)
      .send({ revision: review.revision, targetPath: target });
    expect(converted.status).toBe(201);
    expect(converted.body).toMatchObject({
      mode: "proposal",
      targetPath: target,
      status: "open",
    });
    expect(converted.body.id).not.toBe(review.id);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    fs.writeFileSync(target, "newer");
    expect(
      (
        await request(api())
          .post(`/api/comparisons/${review.id}/convert`)
          .send({ revision: review.revision, targetPath: target })
      ).status,
    ).toBe(409);
  });

  it("does not replay an applied write after restart or overwrite subsequent edits", async () => {
    const review = (await create()).body;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block: ComparisonSegment) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    fs.writeFileSync(target, "later independent edit");
    const repeated = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(repeated.status).toBe(200);
    expect(repeated.body.completion).toEqual(applied.body.completion);
    expect(fs.readFileSync(target, "utf8")).toBe("later independent edit");
  });

  it("reads source paths once and does not normalize an unchanged comparison", async () => {
    const candidate = path.join(root, "candidate.md");
    fs.writeFileSync(candidate, after);
    const created = await request(api())
      .post("/api/comparisons")
      .send({ mode: "proposal", targetPath: target, afterPath: candidate });
    expect(created.status).toBe(201);
    fs.writeFileSync(candidate, "replaced candidate");
    expect(
      (await request(api()).get(`/api/comparisons/${created.body.id}`)).body
        .afterText,
    ).toBe(after);
    const identical = await create("compare", {
      targetPath: undefined,
      afterText: before,
    });
    expect(identical.status).toBe(201);
    expect(changes(identical.body)).toHaveLength(0);
    expect(
      identical.body.segments
        .map((segment: ComparisonSegment) => segment.before)
        .join(""),
    ).toBe(before);
  });

  it("rejects invalid modes, nonexistent files, traversal IDs and mismatched targets with clear errors", async () => {
    expect((await create("wrong")).status).toBe(400);
    expect((await create("applied")).status).toBe(409);
    expect((await create("compare")).status).toBe(400);
    expect(
      (
        await request(api())
          .post("/api/comparisons")
          .send({
            mode: "proposal",
            targetPath: path.join(root, "missing.md"),
            afterText: "hi",
          })
      ).status,
    ).toBe(400);
    expect((await request(api()).get("/api/comparisons/unknown")).status).toBe(
      404,
    );
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });
  it("rejects EBUSY atomic publication without altering the mounted original", async () => {
    const review = (await create("proposal", { afterText: "# Short" }))
      .body as Comparison;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const inode = fs.statSync(target).ino;
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === target)
        throw Object.assign(new Error("Device or resource busy"), {
          code: "EBUSY",
        });
      rename(source, destination);
    });
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(500);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(fs.statSync(target).ino).toBe(inode);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("recovers a completed write after a failed completion-record save without repeating it", async () => {
    const review = (await create()).body as Comparison;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const rename = fs.renameSync.bind(fs);
    let targetRenamed = false;
    let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (targetRenamed && !failed) {
        failed = true;
        throw Object.assign(
          new Error("Simulated completion-record disk error"),
          { code: "EIO" },
        );
      }
      rename(source, destination);
      if (destination === target) targetRenamed = true;
    });
    const interrupted = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(interrupted.status).toBe(500);
    expect(fs.readFileSync(target, "utf8")).toBe(after);
    vi.restoreAllMocks();
    const recovered = await explicitlyRecover(`/api/comparisons/${review.id}`);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      status: "applied",
      completion: { fileWritten: true, accepted: 2 },
    });
    fs.writeFileSync(target, "later edit after crash");
    const retried = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(retried.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe("later edit after crash");
  });

  it("reports a no-op apply without rewriting the target and keeps comments independent of decisions", async () => {
    const review = (await create()).body as Comparison;
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block) => ({
          id: block.id,
          decision: "before",
        })),
      });
    const commented = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: selected.body.revision,
        decisions: [{ id: changes(review)[0].id, comment: "Skip this" }],
      });
    expect(changes(commented.body)[0]).toMatchObject({
      decision: "before",
      comment: "Skip this",
    });
    const stat = fs.statSync(target);
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: commented.body.revision });
    expect(applied.status).toBe(200);
    expect(applied.body.completion).toMatchObject({
      fileWritten: false,
      accepted: 0,
    });
    expect(fs.statSync(target).ino).toBe(stat.ino);
    expect(fs.statSync(target).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("preserves BOM, Unicode, blank lines and an empty replacement without serialization", async () => {
    const unusual = "\ufeff# Café  \r\n\r\n  tab\tend";
    fs.writeFileSync(target, unusual);
    const review = (
      await create("proposal", { beforeText: unusual, afterText: "" })
    ).body as Comparison;
    expect(review.beforeText).toBe(unusual);
    const selected = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        decisions: changes(review).map((block) => ({
          id: block.id,
          decision: "after",
        })),
      });
    const applied = await request(api())
      .post(`/api/comparisons/${review.id}/apply`)
      .send({ revision: selected.body.revision });
    expect(applied.status).toBe(200);
    expect(fs.readFileSync(target)).toEqual(Buffer.alloc(0));
  });

  it("persists native comment threads separately through reload, refresh and completion", async () => {
    const review = (await create()).body as Comparison;
    const anchor = changes(review)[0].id;
    const comments = [
      {
        id: "comment-one",
        changeId: anchor,
        content: "Explain this",
        createdAt: "2026-11-11T12:00:00.000Z",
        authorType: "user",
        parentCommentId: anchor,
      },
      {
        id: "comment-reply",
        changeId: anchor,
        content: "A reply",
        createdAt: "2026-11-11T12:01:00.000Z",
        authorType: "ai",
        authorId: "agent",
        parentCommentId: "comment-one",
      },
    ];
    const saved = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({
        revision: review.revision,
        reviewComments: comments,
        decisions: [{ id: anchor, comment: "Older inline feedback" }],
      });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const reloaded = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(reloaded.body.reviewComments).toEqual(comments);

    // The original anchor disappears when another editor changes that source block.
    const newer = before.replace("old first", "another edit");
    fs.writeFileSync(target, newer);
    const refreshed = await request(api())
      .post(`/api/comparisons/${review.id}/refresh`)
      .send({ revision: saved.body.revision });
    expect(refreshed.status).toBe(200);
    expect(
      changes(refreshed.body).some((segment) => segment.id === anchor),
    ).toBe(false);
    expect(refreshed.body.reviewComments).toEqual(
      expect.arrayContaining(comments),
    );
    expect(refreshed.body.reviewComments).toContainEqual(
      expect.objectContaining({
        id: `legacy:${anchor}`,
        changeId: anchor,
        content: "Older inline feedback",
        scope: "document",
      }),
    );
    const edited = (
      refreshed.body.reviewComments as Comparison["reviewComments"]
    ).map((comment) => ({
      ...comment,
      content: `${comment.content} updated`,
    }));
    const updated = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({ revision: refreshed.body.revision, reviewComments: edited });
    expect(updated.status).toBe(200);
    const completed = await request(api())
      .post(`/api/comparisons/${review.id}/complete`)
      .send({ revision: updated.body.revision });
    expect(completed.status).toBe(200);
    const finished = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(finished.body.reviewComments).toEqual(edited);
    expect(fs.readFileSync(target, "utf8")).toBe(newer);
  });

  it("rejects invalid or stale native comments without saving partial choices", async () => {
    const review = (await create()).body as Comparison;
    const anchor = changes(review)[0].id;
    const comment = {
      id: "comment-one",
      changeId: anchor,
      content: "Feedback",
      createdAt: "2026-11-11T12:00:00.000Z",
      parentCommentId: anchor,
    };
    for (const invalid of [
      null,
      {},
      [{ ...comment, changeId: "missing" }],
      [{ ...comment, content: 3 }],
      [{ ...comment, authorType: "other" }],
      [comment, comment],
    ]) {
      const rejected = await request(api())
        .post(`/api/comparisons/${review.id}/decisions`)
        .send({
          revision: review.revision,
          reviewComments: invalid,
          decisions: [{ id: anchor, decision: "after" }],
        });
      expect(rejected.status).toBe(400);
    }
    const unchanged = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(unchanged.body.revision).toBe(review.revision);
    expect(changes(unchanged.body)[0].decision).toBe("pending");
    const saved = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({ revision: review.revision, reviewComments: [comment] });
    expect(saved.status).toBe(200);
    const stale = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({ revision: review.revision, reviewComments: [] });
    expect(stale.status).toBe(409);
    const reloaded = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(reloaded.body.reviewComments).toEqual([comment]);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("loads pre-threaded-review records and can save native feedback", async () => {
    const review = (await create()).body as Comparison;
    const filename = path.join(root, "comparisons", `${review.id}.json`);
    const legacy = JSON.parse(fs.readFileSync(filename, "utf8"));
    delete legacy.reviewComments;
    fs.writeFileSync(filename, JSON.stringify(legacy));
    const loaded = await request(api()).get(`/api/comparisons/${review.id}`);
    expect(loaded.body.reviewComments).toEqual([]);
    const comments = [
      {
        id: "new-comment",
        changeId: changes(review)[0].id,
        content: "Still works",
        createdAt: new Date().toISOString(),
      },
    ];
    const saved = await request(api())
      .post(`/api/comparisons/${review.id}/decisions`)
      .send({ revision: loaded.body.revision, reviewComments: comments });
    expect(saved.status).toBe(200);
    expect(saved.body.reviewComments).toEqual(comments);
  });
});
