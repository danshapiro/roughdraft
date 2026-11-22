import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const imageUrl = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="red"/></svg>',
).toString("base64")}`;

for (const operation of ["Delete", "type"] as const) {
  test(`Suggest ${operation} replaces a selected image through Keep and refresh`, async ({
    page,
    request,
  }) => {
    const project = createMarkdownProject("atomic-editing");
    try {
      const original = `# Picture\n\n![Red square](${imageUrl})\n\nTail.\n`;
      const filename = writeProjectFile(project, "picture.md", original);
      const response = await request.post(`${api}/document`, {
        data: { targetPath: filename, autosave: filename, handoff: "chat" },
      });
      await expect(response).toBeOK();
      const { id } = await response.json();
      await page.goto(`/?comparison=${id}`);
      await page.getByTestId("revision-mode").click();
      await page.getByTestId("revision-mode-suggest").click();
      const image = richTextEditor(page).locator('img[alt="Red square"]');
      await image.click();
      await richTextEditor(page).focus();
      await expect(image).toHaveClass(/ProseMirror-selectednode/);
      if (operation === "Delete") await page.keyboard.press("Delete");
      else await page.keyboard.type("Replacement");
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      expect(fs.readFileSync(filename, "utf8")).toBe(original);
      await page.getByTestId("revision-view").click();
      await page.getByTestId("revision-view-accepted").click();
      await expect(
        page.getByTestId("revision-preview").locator('img[alt="Red square"]'),
      ).toHaveCount(0);
      if (operation === "type")
        await expect(page.getByTestId("revision-preview")).toContainText(
          "Replacement",
        );
      await page.getByTestId("revision-view").click();
      await page.getByTestId("revision-view-changes").click();
      await page.getByTestId("revision-accept-all").click();
      await expect
        .poll(() => fs.readFileSync(filename, "utf8"))
        .not.toContain(imageUrl);
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        "Saved to file",
      );
      await page.reload();
      await expect(image).toHaveCount(0);
      await expect(richTextEditor(page)).toContainText("Tail.");
      if (operation === "type")
        await expect(richTextEditor(page)).toContainText("Replacement");
    } finally {
      removeMarkdownProject(project);
    }
  });
}

test("Suggest Backspace joins text across a soft line break", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("soft-break-editing");
  try {
    const original = "Alpha  \nBeta.\n";
    const filename = writeProjectFile(project, "break.md", original);
    const response = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename, handoff: "chat" },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await page.getByTestId("revision-mode").click();
    await page.getByTestId("revision-mode-suggest").click();
    await selectRichText(page, "Beta");
    await expect(
      page.getByTestId("selection-menu-action-comment"),
    ).toBeEnabled();
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => {
        const comment = page.getByTestId("selection-menu-action-comment");
        return (
          !(await comment.count()) ||
          !(await comment.isVisible()) ||
          (await comment.isDisabled())
        );
      })
      .toBe(true);
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    await page.getByTestId("revision-accept-all").click();
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe("AlphaBeta.\n");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    await page.reload();
    await expect(richTextEditor(page)).toHaveText("AlphaBeta.");
  } finally {
    removeMarkdownProject(project);
  }
});
