import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };
const fixtures = fileURLToPath(
  new URL("../../../docs/spec/fixtures/", import.meta.url),
);
const markdown = fs.readFileSync(
  path.join(fixtures, "editing-review.md"),
  "utf8",
);
interface Checkpoint {
  id: string;
  resolvedAt?: string;
}
interface SavedReview {
  draft: { markdown: string; cleanMarkdown?: string };
  reviewComments: Array<{ id: string; content: string }>;
  recoveryCheckpoints?: Checkpoint[];
}
async function open(
  page: Page,
  request: APIRequestContext,
  project: string,
  autosave: boolean,
  source = markdown,
) {
  const target = writeProjectFile(project, "practice.md", source);
  fs.cpSync(
    path.join(fixtures, "editing-review-assets"),
    path.join(project, "editing-review-assets"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(fixtures, "editing-review-linked.md"),
    path.join(project, "editing-review-linked.md"),
  );
  const response = await request.post(`${api}/document`, {
    headers,
    data: {
      targetPath: target,
      autosave: autosave ? target : "none",
      handoff: "chat",
      title: "Review recovery copies after an outside update clears",
    },
  });
  await expect(response).toBeOK();
  const { id } = await response.json();
  const url = `/?comparison=${id}`;
  await page.goto(url);
  await expect(richTextEditor(page)).toBeVisible();
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    /^(Review saved|Saved to file)$/,
  );
  const state = async () =>
    (await request.get(`${api}/${id}/state`, { headers })).json() as Promise<{
      signature: string;
      review: SavedReview;
    }>;
  const read = async () => (await state()).review;
  return { id: id as string, target, url, read, state };
}
async function replace(page: Page, before: string, after: string) {
  await selectRichText(page, before);
  await page.keyboard.insertText(after);
}
async function privateEditor(page: Page) {
  await page.getByTestId("comment-thread-c13").click();
  await page.getByTestId("comment-rail-c13-action-edit").click();
  const editor = page.getByTestId("comment-rail-c13-editor");
  await expect(editor).toBeVisible();
  return editor;
}
async function missingFileWait(
  page: Page,
  target: string,
  read: () => Promise<SavedReview>,
) {
  const contents = fs.readFileSync(target, "utf8");
  fs.unlinkSync(target);
  await expect(page.getByTestId("revision-conflict")).toBeVisible();
  await expect(page.getByTestId("revision-recreate-file")).toBeVisible();
  await expect
    .poll(
      async () =>
        ((await read()).recoveryCheckpoints ?? []).filter(
          (item) => !item.resolvedAt,
        ).length,
    )
    .toBeGreaterThan(0);
  fs.writeFileSync(target, contents);
  await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
  return contents;
}

test("a peer Undo that removes the overlap resumes the paused tab and saves its wording without a conflict action", async ({
  page,
  request,
  context,
}) => {
  const project = createMarkdownProject("checkpoint-peer-undo");
  const peer = await context.newPage();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseResume = () => {};
  const resume = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  try {
    const plain =
      "Practice paragraph one: keep the planting schedule steady.\n\nPractice paragraph two: keep the lighting schedule steady.\n";
    const review = await open(page, request, project, false, plain);
    const originalFile = fs.readFileSync(review.target, "utf8");
    await peer.goto(review.url);
    await expect(richTextEditor(peer)).toBeVisible();
    await expect(peer.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    const baselineSignature = (await review.state()).signature;
    let captured = false;
    await page.route(
      `**/api/comparisons/${review.id}/reconcile`,
      async (route) => {
        if (
          route
            .request()
            .postDataJSON()
            .draft.markdown.includes("orchard schedule")
        ) {
          if (!captured) {
            captured = true;
            await held;
          } else await resume;
        }
        await route.continue();
      },
    );
    await replace(page, "planting schedule", "orchard schedule");
    await expect.poll(() => captured).toBe(true);
    await replace(peer, "planting schedule", "garden schedule");
    await expect
      .poll(async () => (await review.read()).draft?.markdown)
      .toContain("garden schedule");
    release();
    await expect(page.getByTestId("revision-discard")).toBeVisible();
    await expect(page.getByTestId("revision-overwrite")).toBeVisible();
    await expect
      .poll(
        async () =>
          ((await review.read()).recoveryCheckpoints ?? []).filter(
            (item) => !item.resolvedAt,
          ).length,
      )
      .toBeGreaterThan(0);
    await richTextEditor(peer).focus();
    await peer.keyboard.press("Control+z");
    await expect
      .poll(async () => (await review.state()).signature)
      .toBe(baselineSignature);
    releaseResume();
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    await expect
      .poll(async () => (await review.read()).draft?.markdown)
      .toContain("orchard schedule");
    await expect(richTextEditor(page)).toContainText("orchard schedule");
    expect(fs.readFileSync(review.target, "utf8")).toBe(originalFile);
  } finally {
    release();
    releaseResume();
    await peer.close();
    removeMarkdownProject(project);
  }
});

test("an unchanged existing comment editor does not keep an automatically cleared file-wait checkpoint unresolved", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("checkpoint-empty-comment");
  try {
    const review = await open(page, request, project, true);
    const originalComment = (await review.read()).reviewComments.find(
      (item) => item.id === "c13",
    )?.content;
    expect(originalComment).toBeTruthy();
    const editor = await privateEditor(page);
    await expect(editor).toHaveValue(originalComment ?? "");
    await missingFileWait(page, review.target, review.read);
    await expect(editor).toHaveValue(originalComment ?? "");
    await replace(
      page,
      "Footer stays unchanged",
      "Footer checkpoint cleanup verified",
    );
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => fs.readFileSync(review.target, "utf8"))
      .toContain("Footer checkpoint cleanup verified");
    await expect
      .poll(async () =>
        ((await review.read()).recoveryCheckpoints ?? []).filter(
          (item) => !item.resolvedAt,
        ),
      )
      .toEqual([]);
    expect(
      (await review.read()).reviewComments.find((item) => item.id === "c13")
        ?.content,
    ).toBe(originalComment);
    expect(fs.readFileSync(review.target, "utf8")).not.toContain(
      originalComment,
    );
    await page.getByTestId("comment-thread-c13").click();
    await expect(editor).toHaveValue(originalComment ?? "");
  } finally {
    removeMarkdownProject(project);
  }
});

test("private feedback keeps its recovery copy until explicitly submitted and a later save covers it", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("checkpoint-submit-feedback");
  const unfinished =
    "Keep my unfinished recovery feedback private until I save this comment.";
  try {
    const review = await open(page, request, project, true);
    const editor = await privateEditor(page);
    await editor.fill(unfinished);
    await missingFileWait(page, review.target, review.read);
    await replace(
      page,
      "Footer stays unchanged",
      "Footer before submitting recovery feedback",
    );
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => fs.readFileSync(review.target, "utf8"))
      .toContain("Footer before submitting recovery feedback");
    const recovery = (await review.read()).recoveryCheckpoints ?? [];
    const retained = recovery.filter((item) => !item.resolvedAt);
    expect(retained.length).toBeGreaterThan(0);
    const checkpoint = await (
      await request.get(`${api}/${review.id}/checkpoints/${retained[0].id}`, {
        headers,
      })
    ).json();
    expect(checkpoint.uiDrafts.comments.c13.value).toBe(unfinished);
    expect(
      (await review.read()).reviewComments.find((item) => item.id === "c13")
        ?.content,
    ).not.toBe(unfinished);
    expect(fs.readFileSync(review.target, "utf8")).not.toContain(unfinished);
    await page.getByTestId("comment-thread-c13").click();
    await expect(editor).toHaveValue(unfinished);
    await editor.press("Control+Enter");
    await expect(editor).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await review.read()).reviewComments.find((item) => item.id === "c13")
            ?.content,
      )
      .toBe(unfinished);
    await replace(
      page,
      "Footer before submitting recovery feedback",
      "Footer after submitting recovery feedback",
    );
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => fs.readFileSync(review.target, "utf8"))
      .toContain("Footer after submitting recovery feedback");
    await expect
      .poll(async () =>
        ((await review.read()).recoveryCheckpoints ?? []).filter(
          (item) => !item.resolvedAt,
        ),
      )
      .toEqual([]);
    expect(
      (await review.read()).reviewComments.find((item) => item.id === "c13")
        ?.content,
    ).toBe(unfinished);
    expect(fs.readFileSync(review.target, "utf8")).not.toContain(unfinished);
  } finally {
    removeMarkdownProject(project);
  }
});
