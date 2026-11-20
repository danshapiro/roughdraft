import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4agAAAAASUVORK5CYII=",
  "base64",
);

test("Save As resolves links, images, and restored text from the copy's directory", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("revision-save-as-links");
  try {
    const original = [
      "See [Neighbour](./next.md#details) and [Restore](./restore.md).",
      "",
      "![Pixel](./pixel.png)",
      "",
      "A note[^links].",
      "",
      "[^links]: [Note neighbour](./next.md).",
      "",
    ].join("\n");
    const changed = original.replace("[Restore](./restore.md)", "");
    const source = writeProjectFile(project, "A/note.md", original);
    const output = path.join(project, "B/copy.md");
    for (const folder of ["A", "B"]) {
      writeProjectFile(
        project,
        `${folder}/next.md`,
        `# Details\n\nFrom ${folder}.\n`,
      );
      writeProjectFile(
        project,
        `${folder}/restore.md`,
        `Restored in ${folder}.\n`,
      );
      writeProjectFile(project, `${folder}/pixel.png`, pixel);
    }
    const response = await request.post(`${api}/document`, {
      headers: { Connection: "close" },
      data: { targetPath: source },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);

    const editor = richTextEditor(page);
    const neighbour = editor.getByRole("link", {
      name: "Neighbour",
      exact: true,
    }); // selector-check-ignore: verify the Markdown link's rendered role and target.
    const restored = editor.getByRole("link", { name: "Restore", exact: true }); // selector-check-ignore: verify the link recreated by undo.
    const image = editor.getByRole("img", { name: "Pixel" }); // selector-check-ignore: verify the rendered Markdown image's URL.
    async function linkTarget(locator: typeof neighbour) {
      return new URL((await locator.getAttribute("href")) ?? "", page.url());
    }
    const assetDirectory = async () =>
      new URL(
        (await image.getAttribute("src")) ?? "",
        page.url(),
      ).searchParams.get("projectPath");
    await expect
      .poll(async () => (await linkTarget(neighbour)).searchParams.get("path"))
      .toBe(path.join(project, "A/next.md"));
    await expect.poll(assetDirectory).toBe(path.join(project, "A"));
    await selectRichText(page, "Restore");
    await page.keyboard.press("Backspace");
    await expect
      .poll(() => readProjectFile(project, "A/note.md"))
      .toBe(changed);

    await page.getByTestId("revision-save-as").click();
    await page.getByTestId("revision-output").fill(output);
    await page.getByTestId("revision-save-confirm").click();
    await expect(page.getByTestId("revision-path")).toHaveText(output);
    expect(readProjectFile(project, "B/copy.md")).toBe(changed);
    await expect
      .poll(async () => (await linkTarget(neighbour)).searchParams.get("path"))
      .toBe(path.join(project, "B/next.md"));
    expect((await linkTarget(neighbour)).hash).toBe("#details");
    await expect.poll(assetDirectory).toBe(path.join(project, "B"));
    await expect
      .poll(() =>
        image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBe(1);

    await page.getByTestId("revision-undo").click();
    await expect
      .poll(() => readProjectFile(project, "B/copy.md"))
      .toBe(original);
    await expect
      .poll(async () => (await linkTarget(restored)).searchParams.get("path"))
      .toBe(path.join(project, "B/restore.md"));
    expect(readProjectFile(project, "A/note.md")).toBe(changed);
    await page.getByTestId("revision-redo").click();
    await expect
      .poll(() => readProjectFile(project, "B/copy.md"))
      .toBe(changed);
    await expect(restored).toBeHidden();

    await editor.getByRole("link", { name: "Endnote 1", exact: true }).hover(); // selector-check-ignore: open the accessible endnote reference.
    const endnoteDialog = { name: "Endnote preview", exact: true };
    const note = page.getByRole("dialog", endnoteDialog); // selector-check-ignore: stable accessible title.
    const noteLink = note.getByRole("link", {
      name: "Note neighbour",
      exact: true,
    }); // selector-check-ignore: follow the actual Markdown link inside the preview.
    await expect(noteLink).toBeVisible();
    expect((await linkTarget(noteLink)).searchParams.get("path")).toBe(
      path.join(project, "B/next.md"),
    );
    await noteLink.click();
    await expect(editor).toContainText("From B.");
  } finally {
    removeMarkdownProject(project);
  }
});
