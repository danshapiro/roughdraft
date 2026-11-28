import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import { richTextEditor } from "./helpers";

test("a failed initial review download can reload before the editor is mounted", async ({
  page,
  request,
}, testInfo) => {
  const scratch = fileURLToPath(
    new URL("../../../.test-tmp/", import.meta.url),
  );
  fs.mkdirSync(scratch, { recursive: true });
  const project = fs.mkdtempSync(
    path.join(scratch, "initial-review-download-"),
  );
  const filename = path.join(project, "plan.md");
  const original =
    "# Plan\n\nThe saved document survives a failed initial download.\n";
  fs.writeFileSync(filename, original);
  const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;
  const counts = new Map<string, number>();
  let failedUrl = "";
  let dependencyToFail: string | undefined;
  try {
    const shell = await request.get(api);
    const critical = new Set(
      [...(await shell.text()).matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(
        (match) => new URL(match[1], `${api}/`).pathname,
      ),
    );
    if (process.env.PLAYWRIGHT_PRODUCTION === "1") {
      const assets = fileURLToPath(new URL("../dist/assets/", import.meta.url));
      const entry = fs
        .readdirSync(assets)
        .find((name) => /^ComparisonReview-.*\.js$/.test(name));
      if (!entry) throw new Error("Missing compiled review entry");
      const module = ts.createSourceFile(
        entry,
        fs.readFileSync(path.join(assets, entry), "utf8"),
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
      );
      dependencyToFail = module.statements
        .flatMap((statement) =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier)
            ? [
                new URL(
                  statement.moduleSpecifier.text,
                  `${api}/assets/${entry}`,
                ).href,
              ]
            : [],
        )
        .find((url) => !critical.has(new URL(url).pathname));
    }
    await page.route(
      process.env.PLAYWRIGHT_PRODUCTION === "1"
        ? "**/assets/*.js"
        : "**/src/ComparisonReview.tsx",
      async (route) => {
        const url = route.request().url();
        if (critical.has(new URL(url).pathname)) return route.continue();
        if (dependencyToFail && url !== dependencyToFail)
          return route.continue();
        counts.set(url, (counts.get(url) ?? 0) + 1);
        if (!failedUrl) {
          failedUrl = url;
          await route.abort("failed");
        } else await route.continue();
      },
    );
    const created = await request.post(`${api}/api/comparisons/document`, {
      data: { targetPath: filename, autosave: "none", handoff: "chat" },
    });
    await expect(created).toBeOK();
    const { id } = await created.json();
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("feature-download-error")).toBeVisible();
    await expect(richTextEditor(page)).toHaveCount(0);
    const reload = page.getByTestId("feature-download-retry");
    await expect(reload).toHaveText("Reload page");
    await Promise.all([page.waitForEvent("domcontentloaded"), reload.click()]);
    await expect(richTextEditor(page)).toContainText(
      "survives a failed initial download",
    );
    expect(counts.get(failedUrl)).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
  } finally {
    await testInfo.attach("initial-download-attempts", {
      body: JSON.stringify({
        failedUrl,
        failedKind: dependencyToFail ? "shared dependency" : "entry",
        attempts: Object.fromEntries(counts),
      }),
      contentType: "application/json",
    });
    await page.goto("about:blank");
    fs.rmSync(project, { recursive: true, force: true });
  }
});

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
