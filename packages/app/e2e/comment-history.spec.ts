import fs from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const original =
  'Alpha {~~old~>new~~}{id="s1" by="AI" at="2026-01-01T00:00:00.000Z"} and {~~red~>blue~~}{id="s2" by="AI" at="2026-01-01T00:00:01.000Z"}{>>Original feedback.<<}{id="c1" by="user" at="2026-01-01T00:00:02.000Z" re="s2"}.\n';

async function regroup(page: Page) {
  await selectRichText(page, "Alpha");
  await page.getByTestId("selection-menu-action-bold").click();
  await expect(page.getByTestId("revision-pending")).toHaveText("1");
}

async function open(page: Page, request: APIRequestContext, project: string) {
  const filename = writeProjectFile(project, "comments.md", original);
  const response = await request.post(`${api}/document`, {
    data: { targetPath: filename, autosave: "none", handoff: "chat" },
  });
  await expect(response).toBeOK();
  const { id } = await response.json();
  await page.goto(`/?comparison=${id}`);
  await page.getByTestId("revision-mode").click();
  await page.getByTestId("revision-mode-suggest").click();
  const feedback = async () => {
    const response = await request.get(`${api}/${id}`);
    await expect(response).toBeOK();
    return (await response.json()).reviewComments.find(
      (comment: { id: string }) => comment.id === "c1",
    );
  };
  return { feedback, filename };
}

test("regrouping suggestions does not create a separate comment Undo event @smoke", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("comment-history");
  try {
    const { feedback, filename } = await open(page, request, project);
    await regroup(page);
    await expect
      .poll(async () => (await feedback())?.parentCommentId)
      .toBe("s1");
    await expect(page.getByTestId("revision-comment-undo")).toHaveCount(0);
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
  } finally {
    removeMarkdownProject(project);
  }
});

test("comment Undo and Redo retain the current document attachment", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("comment-history");
  try {
    const { feedback, filename } = await open(page, request, project);
    await page.getByTestId("comment-rail-c1-action-edit").click();
    const editor = page.getByTestId("comment-rail-c1-editor");
    await editor.fill("Newer feedback.");
    await editor.press("Control+Enter");
    await expect
      .poll(async () => (await feedback())?.content)
      .toBe("Newer feedback.");
    await regroup(page);
    await expect
      .poll(async () => (await feedback())?.parentCommentId)
      .toBe("s1");
    await page.getByTestId("revision-comment-undo").click();
    await expect
      .poll(async () => {
        const comment = await feedback();
        return [comment?.content, comment?.parentCommentId];
      })
      .toEqual(["Original feedback.", "s1"]);
    await page.getByTestId("revision-undo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await expect
      .poll(async () => (await feedback())?.parentCommentId)
      .toBe("s2");
    await page.getByTestId("revision-comment-redo").click();
    await expect
      .poll(async () => {
        const comment = await feedback();
        return [comment?.content, comment?.parentCommentId];
      })
      .toEqual(["Newer feedback.", "s2"]);
    await page.getByTestId("revision-redo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect
      .poll(async () => (await feedback())?.parentCommentId)
      .toBe("s1");
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
  } finally {
    removeMarkdownProject(project);
  }
});
