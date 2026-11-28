import fs from "node:fs";
import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const before = "---\ntitle: Old\n---\n\nUse red.\n\n* Keep this list.\n";
const after = before.replace("Old", "New").replace("red", "blue");
async function saved(page: Page) {
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    "Saved to file",
  );
}
async function view(page: Page, choice: "changes" | "rejected" | "accepted") {
  await page.getByTestId("revision-view").click();
  await page.getByTestId(`revision-view-${choice}`).click();
}
async function open(
  page: Page,
  request: APIRequestContext,
  project: string,
  old = before,
  next = after,
) {
  const oldPath = writeProjectFile(project, "old.md", old);
  const newPath = writeProjectFile(project, "new.md", next);
  const response = await request.post(api, {
    data: {
      editor: "unified",
      mode: "compare",
      beforePath: oldPath,
      afterPath: newPath,
      autosave: newPath,
      handoff: "chat",
    },
  });
  await expect(response).toBeOK();
  const { id } = await response.json();
  await page.goto(`/?comparison=${id}`);
  return { id: id as string, newPath };
}

test("YAML-only changes remain reviewable and reopenable after refresh", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("metadata-only");
  try {
    const original = before;
    const revised = before.replace("Old", "New");
    const { newPath } = await open(page, request, project, original, revised);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(
      richTextEditor(page).getByTestId("yaml-frontmatter"),
    ).toContainText("title: New");
    await page.getByTestId(/^comment-rail-.*-action-reject$/).click();
    await saved(page);
    expect(fs.readFileSync(newPath, "utf8")).toBe(original);
    await page.reload();
    await expect(
      richTextEditor(page).getByTestId("yaml-frontmatter"),
    ).toContainText("title: Old");
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await page.getByTestId("revision-reviewed").click();
    await page.getByTestId("revision-reopen-change").click();
    await expect(
      richTextEditor(page).getByTestId("yaml-frontmatter"),
    ).toBeVisible();
    await saved(page);
    expect(fs.readFileSync(newPath, "utf8")).toBe(revised);
    await page.getByTestId(/^comment-rail-.*-action-accept$/).click();
    await saved(page);
    await page.reload();
    await expect(page.getByTestId("revision-pending")).toHaveText("");
    expect(fs.readFileSync(newPath, "utf8")).toBe(revised);
  } finally {
    removeMarkdownProject(project);
  }
});

test("bulk outcomes and exports include YAML while undo preserves exact unrelated source @smoke", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("metadata-bulk");
  try {
    const { id, newPath } = await open(page, request, project);
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await page.getByTestId("revision-reject-all").click();
    await saved(page);
    expect(fs.readFileSync(newPath, "utf8")).toBe(before);
    await page.getByTestId("revision-undo").click();
    await saved(page);
    expect(fs.readFileSync(newPath, "utf8")).toBe(after);
    await page.getByTestId("revision-redo").click();
    await saved(page);
    expect(fs.readFileSync(newPath, "utf8")).toBe(before);
    const initial = await (await request.get(`${api}/${id}`)).json();
    await page.getByTestId("revision-format").click();
    for (const choice of ["rejected", "accepted"] as const) {
      await view(page, choice);
      const source = page
        .getByTestId("revision-preview-markdown")
        .locator(".cm-content");
      await expect(source).toHaveAttribute("contenteditable", "false");
      await expect(source).toContainText(
        choice === "accepted" ? "title: New" : "title: Old",
      );
      await expect(source).toContainText(
        choice === "accepted" ? "Use blue." : "Use red.",
      );
    }
    const download = page.waitForEvent("download");
    await page.getByTestId("revision-download").click();
    const exported = await download;
    const filename = await exported.path();
    if (!filename) throw new Error("No downloaded preview");
    const text = fs.readFileSync(filename, "utf8");
    expect(text).toContain("title: New");
    expect(text).toContain("Use blue.");
    expect(fs.readFileSync(newPath, "utf8")).toBe(before);
    expect(await (await request.get(`${api}/${id}`)).json()).toEqual(initial);
  } finally {
    removeMarkdownProject(project);
  }
});
