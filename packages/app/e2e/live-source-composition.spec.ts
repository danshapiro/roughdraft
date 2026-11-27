import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;

test("a real source keyboard composition accepts and saves another paragraph before the word ends", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("live-source-composition");
  const keyboard = await page.context().newCDPSession(page);
  try {
    const target = writeProjectFile(
      project,
      "source.md",
      "# Keyboard review\n\nTyping owner: .\n\nRemote owner: old.\n",
    );
    const created = await request.post(`${api}/document`, {
      data: { targetPath: target, autosave: target, handoff: "chat" },
    });
    await expect(created).toBeOK();
    const { id } = await created.json();
    const read = async () => (await request.get(`${api}/${id}`)).json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await source.evaluate((element) => {
      if (!(element instanceof HTMLElement))
        throw new Error("Expected the source editor");
      element.dataset.imeStarts = "0";
      element.dataset.imeEnds = "0";
      element.addEventListener("compositionstart", () => {
        element.dataset.imeStarts = String(
          Number(element.dataset.imeStarts) + 1,
        );
      });
      element.addEventListener("compositionend", () => {
        element.dataset.imeEnds = String(Number(element.dataset.imeEnds) + 1);
      });
    });
    await source.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await keyboard.send("Input.imeSetComposition", {
      text: "日本語",
      selectionStart: 3,
      selectionEnd: 3,
    });
    await expect(source).toHaveAttribute("data-ime-starts", "1");
    await expect(source).toHaveAttribute("data-ime-ends", "0");
    await expect
      .poll(async () => (await read()).draft?.markdown)
      .toContain("Typing owner: 日本語.");
    await expect
      .poll(() => fs.readFileSync(target, "utf8"))
      .toContain("Typing owner: 日本語.");
    fs.writeFileSync(
      target,
      fs
        .readFileSync(target, "utf8")
        .replace("Remote owner: old.", "Remote owner: incoming."),
    );
    await expect(source).toContainText("Remote owner: incoming.");
    await expect(source).toContainText("Typing owner: 日本語.");
    await expect(source).toHaveAttribute("data-ime-ends", "0");
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    await expect
      .poll(async () => (await read()).draft?.markdown)
      .toContain("Remote owner: incoming.");
    await keyboard.send("Input.imeSetComposition", {
      text: "日本語入力",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await expect(source).toContainText("Typing owner: 日本語入力.");
    await expect(source).toHaveAttribute("data-ime-starts", "1");
    await keyboard.send("Input.insertText", { text: "日本語入力" });
    await expect(source).toHaveAttribute("data-ime-ends", "1");
    await expect
      .poll(() => fs.readFileSync(target, "utf8"))
      .toContain("Typing owner: 日本語入力.");
    await page.keyboard.press("Control+z");
    await expect(source).toContainText("Typing owner: .");
    await expect(source).toContainText("Remote owner: incoming.");
  } finally {
    await keyboard.detach();
    removeMarkdownProject(project);
  }
});
