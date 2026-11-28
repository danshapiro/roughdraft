import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { richTextEditor } from "./helpers";

test("retries a failed Markdown download while retaining the working document", async ({
  page,
  request,
}, testInfo) => {
  const scratch = fileURLToPath(
    new URL("../../../.test-tmp/", import.meta.url),
  );
  fs.mkdirSync(scratch, { recursive: true });
  const project = fs.mkdtempSync(path.join(scratch, "optional-editor-"));
  const filename = path.join(project, "plan.md");
  fs.writeFileSync(filename, "# Plan\n\nDraft text.\n");
  let attempts = 0;
  const failures: string[] = [];
  page.on("requestfailed", (request) => failures.push(request.url()));
  try {
    const created = await request.post(
      `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons/document`,
      { data: { targetPath: filename, autosave: "none", handoff: "chat" } },
    );
    await expect(created).toBeOK();
    const { id } = await created.json();
    await page.goto(`/?comparison=${id}`);
    const editor = richTextEditor(page);
    await expect(editor).toBeVisible();
    await page.getByTestId("revision-mode").click();
    await page.getByTestId("revision-mode-edit").click();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Browser text must survive.");
    await expect(editor).toContainText("Browser text must survive.");
    await page.evaluate(() => {
      (window as unknown as { originalEditor: Element | null }).originalEditor =
        document.querySelector(".ProseMirror");
    });
    await page.route(
      (url) =>
        /\/(?:assets\/MarkdownCodeEditor-[^/]+\.js|src\/MarkdownCodeEditor\.tsx)(?:\?|$)/.test(
          url.toString(),
        ),
      async (route) => {
        attempts++;
        if (attempts === 1) await route.abort("failed");
        else await route.continue();
      },
    );
    await page.getByTestId("revision-format").click();
    const alert = page.getByTestId("feature-download-error");
    await expect(alert).toBeVisible();
    expect(attempts).toBe(1);
    await alert.getByTestId("feature-download-retry").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await expect(source).toBeVisible();
    await expect(source).toContainText("Browser text must survive.");
    expect(attempts).toBeGreaterThanOrEqual(2);
    await page.getByTestId("revision-format").click();
    await expect(editor).toBeVisible();
    await expect(editor).toContainText("Browser text must survive.");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { originalEditor: Element | null })
            .originalEditor === document.querySelector(".ProseMirror"),
      ),
    ).toBe(true);
    expect(fs.readFileSync(filename, "utf8")).toBe("# Plan\n\nDraft text.\n");
  } finally {
    await testInfo.attach("optional-editor-downloads", {
      body: JSON.stringify({ attempts, failures }, null, 2),
      contentType: "application/json",
    });
    await page.goto("about:blank");
    fs.rmSync(project, { recursive: true, force: true });
  }
});
