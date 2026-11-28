import fs from "node:fs";
import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import {
  activeCommentDraft,
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const original =
  "---\r\ntitle: Original\r\nowner: Product team\r\nexample: '{++literal++}'\r\n---\r\n\r\n# Body\r\n\r\nKeep __this body__ and [the link](./notes.md) unchanged.\r\n";
async function mode(page: Page, name: "edit" | "suggest") {
  await page.getByTestId("revision-mode").click();
  await page.getByTestId(`revision-mode-${name}`).click();
}
async function open(page: Page, request: APIRequestContext, project: string) {
  const filename = writeProjectFile(project, "frontmatter.md", original);
  const response = await request.post(`${api}/document`, {
    data: { targetPath: filename, autosave: filename, handoff: "chat" },
  });
  await expect(response).toBeOK();
  const { id } = await response.json();
  await page.goto(`/?comparison=${id}`);
  await expect(
    richTextEditor(page).getByTestId("yaml-frontmatter"),
  ).toContainText("title: Original");
  return { id: id as string, filename };
}

test("formatted YAML edits share Undo and save exactly through refresh and unfolding @smoke", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("frontmatter-editing");
  try {
    await page.setViewportSize({ width: 360, height: 780 });
    const { filename } = await open(page, request, project);
    await mode(page, "edit");
    await selectRichText(page, "Original");
    await page.keyboard.type("Updated");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe(original.replace("Original", "Updated"));
    await page.getByTestId("revision-undo").click();
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(original);
    await page.getByTestId("revision-redo").click();
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe(original.replace("Original", "Updated"));
    await page.reload();
    for (const width of [360, 840]) {
      await page.setViewportSize({ width, height: 780 });
      const yaml = richTextEditor(page).getByTestId("yaml-frontmatter");
      await expect(yaml).toContainText("title: Updated");
      expect(
        await yaml.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        ),
      ).toBeGreaterThanOrEqual(16);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
  } finally {
    await page.goto("about:blank");
    removeMarkdownProject(project);
  }
});

test("YAML suggestions and selected comments persist while outcome downloads exclude review markup @smoke", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("frontmatter-feedback");
  try {
    const { id, filename } = await open(page, request, project);
    await mode(page, "suggest");
    await selectRichText(page, "Original");
    await page.keyboard.type("Proposed");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await selectRichText(page, "Product team");
    await page.getByTestId("selection-menu-action-comment").click();
    const comment = await activeCommentDraft(page);
    await comment.editor.fill("Please confirm the document owner.");
    await page.getByTestId(`comment-rail-${comment.id}-action-save`).click();
    await expect
      .poll(async () =>
        (await (await request.get(`${api}/${id}`)).json()).reviewComments.map(
          (comment: { content: string }) => comment.content,
        ),
      )
      .toContain("Please confirm the document owner.");
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    await page.reload();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(
      page.getByTestId(`comment-thread-${comment.id}`),
    ).toContainText("Please confirm the document owner.");
    for (const choice of ["rejected", "accepted"] as const) {
      await page.getByTestId("revision-view").click();
      await page.getByTestId(`revision-view-${choice}`).click();
      const download = page.waitForEvent("download");
      await page.getByTestId("revision-download").click();
      const downloaded = await download;
      const file = await downloaded.path();
      if (!file) throw new Error("No downloaded outcome");
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain(
        choice === "accepted" ? "title: Proposed" : "title: Original",
      );
      expect(text).toContain("owner: Product team");
      expect(text).toContain("example: '{++literal++}'");
      expect(text).not.toContain("frontmatterAnchor");
      expect(text).not.toContain("Please confirm");
      expect(text).not.toContain("{~~");
      expect(fs.readFileSync(filename, "utf8")).toBe(original);
      await downloaded.delete();
    }
  } finally {
    await page.goto("about:blank");
    removeMarkdownProject(project);
  }
});

test("Enter and multiline typing in a YAML suggestion remain a pending proposal through refresh", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("frontmatter-multiline");
  try {
    const { id, filename } = await open(page, request, project);
    await mode(page, "suggest");
    await selectRichText(page, "Original");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.keyboard.type("release: next");
    await expect
      .poll(
        async () =>
          (await (await request.get(`${api}/${id}`)).json()).draft?.markdown,
      )
      .toContain("release: next");
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    await page.reload();
    await expect(
      richTextEditor(page).getByTestId("yaml-frontmatter"),
    ).toContainText("release: next");
    await page.getByTestId("revision-accept-all").click();
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe(original.replace("Original", "Original\r\nrelease: next"));
  } finally {
    await page.goto("about:blank");
    removeMarkdownProject(project);
  }
});
