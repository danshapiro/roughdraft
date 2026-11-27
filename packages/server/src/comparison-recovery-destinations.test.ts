import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/recovery-destinations/", import.meta.url),
);
let root: string;
let host: ReturnType<typeof createApp>;
const folders: string[] = [];
const original = "# Review\r\n\r\nKeep this phrase.\r\n";
function start(options: { projectDir?: string; assetRoot?: string } = {}) {
  return createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "comparisons"),
    staticDirPath: root,
    ...options,
  });
}
beforeEach(() => {
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  host = start();
});
afterEach(() => {
  vi.restoreAllMocks();
  host.dispose();
  for (const directory of folders.splice(0))
    if (fs.existsSync(directory)) fs.chmodSync(directory, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});
function folder(name: string) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  folders.push(directory);
  return directory;
}
async function open(target: string, autosave = target, fields = {}) {
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave, ...fields });
  expect(opened.status).toBe(201);
  const state = await request(host.app).get(
    `/api/comparisons/${opened.body.id}/state`,
  );
  expect(state.status).toBe(200);
  return state.body;
}
async function missing(autosave = true) {
  const target = path.join(root, "source.md");
  fs.writeFileSync(target, original);
  const base = await open(target, autosave ? target : "none");
  fs.unlinkSync(target);
  let current = base;
  await vi.waitFor(async () => {
    current = (
      await request(host.app).get(`/api/comparisons/${base.review.id}/state`)
    ).body;
    expect(current.disk.availability).toBe("missing");
  });
  return { target, base, current };
}
function recreateBody(
  base: Awaited<ReturnType<typeof missing>>["base"],
  target: string,
  id = "recreate",
) {
  const markdown = `${original.replace("this", "{~~this~>proposed~~}{#s1}")}\r\nLocal detail.\r\n`;
  const cleanMarkdown = `${original}\r\nLocal detail.\r\n`;
  return {
    operationId: id,
    pageInstanceId: "page",
    operationSequence: 1,
    operationContext: base.operationContext,
    expectedRevision: base.revision,
    baseRevision: base.revision,
    baseSignature: base.signature,
    base: base.draft,
    draft: {
      ...base.draft,
      markdown,
      cleanMarkdown,
      reviewComments: [
        {
          id: "c1",
          changeId: "document",
          content: "Preserved review feedback",
          createdAt: "2026-11-26T12:00:00.000Z",
        },
      ],
    },
    expectedDisk: { path: target, version: null, hash: null },
    localGeneration: 1,
    reason: "recreate",
    writeFile: true,
  };
}

test.each([
  false,
  true,
])("copy defaults prefer writable invoking/source folders and fall back to the allowed project folder (rooted=%s)", async (rooted) => {
  const source = folder("source");
  const invoking = folder("invoking");
  const project = folder("project");
  const target = path.join(source, "review.md");
  fs.writeFileSync(target, "Read [the guide](./guide.md).\n");
  host.dispose();
  host = start({ projectDir: project, ...(rooted ? { assetRoot: root } : {}) });
  const base = await open(target, "none", { copyDirectory: invoking });
  const route = `/api/comparisons/${base.review.id}/copy-destination`;
  const first = await request(host.app).post(route).send({});
  expect(first.body.allowed).toBe(true);
  expect(path.dirname(first.body.path)).toBe(invoking);
  fs.chmodSync(invoking, 0o555);
  const second = await request(host.app).post(route).send({});
  expect(second.body.allowed).toBe(true);
  expect(path.dirname(second.body.path)).toBe(source);
  fs.chmodSync(source, 0o555);
  const last = await request(host.app).post(route).send({});
  expect(last.body.allowed).toBe(true);
  expect(path.dirname(last.body.path)).toBe(rooted ? root : project);
  expect(last.body.relativeLinks).toContain("./guide.md");
  const explicit = await request(host.app)
    .post(route)
    .send({ path: path.join(invoking, "explicit.md") });
  expect(explicit.body.allowed).toBe(false);
  expect(explicit.body.path).toBe(path.join(invoking, "explicit.md"));
});

test.each([
  false,
  true,
])("binding infers a missing version only for a new path (already exists=%s)", async (exists) => {
  const target = path.join(root, "source.md");
  fs.writeFileSync(target, original);
  const base = await open(target);
  const selected = path.join(root, "selected.md");
  if (exists) fs.writeFileSync(selected, original);
  const bound = await request(host.app)
    .post(`/api/comparisons/${base.review.id}/binding`)
    .send({ expectedPath: target, path: selected });
  expect(bound.status).toBe(200);
  expect(bound.body.status).toBe(exists ? "incoming-changed" : "committed");
  expect(fs.readFileSync(selected, "utf8")).toBe(original);
  expect(fs.readFileSync(target, "utf8")).toBe(original);
});

test("explicit recreation exclusively creates the missing autosave file with exact clean text and the complete pending review", async () => {
  const { target, base, current } = await missing();
  expect(current.canRecreateFile).toBe(true);
  const body = recreateBody(base, target);
  const route = `/api/comparisons/${base.review.id}/reconcile`;
  const saved = await request(host.app).post(route).send(body);
  expect(saved.status).toBe(200);
  expect(saved.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(body.draft.cleanMarkdown);
  expect(saved.body.state.draft.markdown).toBe(body.draft.markdown);
  expect(saved.body.state.draft.reviewComments).toEqual(
    body.draft.reviewComments,
  );
  const retry = await request(host.app).post(route).send(body);
  expect(retry.body.status).toBe("committed");
  expect(retry.body.state.revision).toBe(saved.body.state.revision);
  expect(fs.readFileSync(target, "utf8")).toBe(body.draft.cleanMarkdown);
});

test("a missing autosave-none source is never a recreation destination", async () => {
  const { target, base, current } = await missing(false);
  expect(current.canRecreateFile).not.toBe(true);
  const saved = await request(host.app)
    .post(`/api/comparisons/${base.review.id}/reconcile`)
    .send(recreateBody(base, target));
  expect(saved.body.status).not.toBe("committed");
  expect(fs.existsSync(target)).toBe(false);
});

test.each([
  "before-request",
  "before-link",
  "after-link",
] as const)("recreation preserves a new outside file arriving %s", async (arrival) => {
  const { target, base } = await missing();
  const outside = "An arriving outside edit must survive.\r\n";
  let raced = arrival === "before-request";
  if (raced) fs.writeFileSync(target, outside);
  else {
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (to !== target) return link(from, to);
      raced = true;
      if (arrival === "before-link") fs.writeFileSync(target, outside);
      link(from, to);
      if (arrival === "after-link") fs.writeFileSync(target, outside);
    });
  }
  const saved = await request(host.app)
    .post(`/api/comparisons/${base.review.id}/reconcile`)
    .send(recreateBody(base, target));
  expect(raced).toBe(true);
  expect(saved.body.status).toBe("incoming-changed");
  expect(fs.readFileSync(target, "utf8")).toBe(outside);
  expect(saved.body.state.publishing).toBeUndefined();
});

test("recreation committed before a process interruption is recovered through the same witness and operation identity", async () => {
  const { target, base } = await missing();
  const link = fs.linkSync.bind(fs);
  let interrupted = false;
  vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
    link(from, to);
    if (to === target) {
      interrupted = true;
      throw Object.assign(new Error("Stopped after exclusive publication"), {
        code: "EIO",
      });
    }
  });
  const body = recreateBody(base, target, "interrupted-recreate");
  const saved = await request(host.app)
    .post(`/api/comparisons/${base.review.id}/reconcile`)
    .send(body);
  expect(interrupted).toBe(true);
  expect(saved.body.status).toBe("publishing");
  vi.restoreAllMocks();
  host.dispose();
  host = start();
  const recovered = await request(host.app)
    .post("/api/comparisons/operations/interrupted-recreate/resolve")
    .send({ ...body, reviewId: base.review.id });
  expect(recovered.body.status).toBe("committed");
  expect(recovered.body.state.draft).toMatchObject(body.draft);
  expect(fs.readFileSync(target, "utf8")).toBe(body.draft.cleanMarkdown);
});
