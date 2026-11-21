import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

test("remote session opens, saves through the CLI, and reports disconnection @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("remote-browser");
  const filePath = writeProjectFile(
    projectDir,
    "remote.md",
    "# Remote document\n\nOriginal.\n",
  );
  const cli = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../server/bin/roughdraft.mjs", import.meta.url),
      ),
      "open",
      filePath,
      "--no-open",
      "--json",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ROUGHDRAFT_HOST: `http://127.0.0.1:${process.env.API_PORT ?? 4317}`,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  let viewerUrl = "";
  cli.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    try {
      viewerUrl = (JSON.parse(stdout) as { url: string }).url;
    } catch {
      // CLI stdout may arrive in separate chunks.
    }
  });
  cli.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const stopCli = async () => {
    if (cli.exitCode !== null || cli.signalCode !== null) return;
    const exited = once(cli, "exit");
    cli.kill("SIGTERM");
    await exited;
  };
  try {
    await expect
      .poll(() => {
        if (cli.exitCode !== null)
          throw new Error(`Remote CLI exited: ${stderr}`);
        return viewerUrl;
      })
      .not.toBe("");
    const url = new URL(viewerUrl);
    url.searchParams.set("editor", "code");
    await page.goto(url.toString());
    await expect(codeEditor(page)).toContainText("Original.");
    await expect(page.getByTestId("remote-session-connected")).toBeVisible();
    await appendInCodeEditor(page, "\nSaved through the remote CLI.");
    await expect
      .poll(() => readProjectFile(projectDir, "remote.md"))
      .toContain("Saved through the remote CLI.");
    await stopCli();
    await expect(page.getByTestId("remote-session-disconnected")).toBeVisible();
  } finally {
    await stopCli();
    removeMarkdownProject(projectDir);
  }
});

test("saves the latest draft after a delayed save response @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("serialized-autosave");
  let releaseFirstResponse = () => {};
  const responseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  let writes = 0;
  let completedWrites = 0;
  try {
    const filePath = writeProjectFile(
      projectDir,
      "draft.md",
      "# Draft\n\nOriginal.\n",
    );
    // Isolate response ordering from the independent filesystem watcher.
    await page.route("**/api/markdown-file/events**", (route) => route.abort());
    await page.route("**/api/markdown-file?**", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const requestNumber = ++writes;
      const response = await route.fetch();
      if (requestNumber === 1) await responseGate;
      await route.fulfill({ response });
      completedWrites += 1;
    });
    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original.");
    await page.clock.install();
    await appendInCodeEditor(page, "\nFirst edit.");
    await page.clock.runFor(600);
    await expect.poll(() => writes).toBe(1);

    await appendInCodeEditor(page, "\nSecond edit.");
    await page.clock.runFor(600);
    expect(writes).toBe(1);
    releaseFirstResponse();
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect
      .poll(() => readProjectFile(projectDir, "draft.md"))
      .toContain("First edit.\nSecond edit.");
    expect(writes).toBe(2);
    await page.getByTestId("document-mode-trigger").click();
    await page.getByTestId("document-mode-viewing").click();
    await expect(codeEditor(page)).toContainText("First edit.");
    await expect(codeEditor(page)).toContainText("Second edit.");
    await page.getByTestId("document-mode-trigger").click();
    await page.getByTestId("document-mode-editing").click();
    await appendInCodeEditor(page, "\nAfter mode change.");
    await page.clock.runFor(600);
    await expect
      .poll(() => readProjectFile(projectDir, "draft.md"))
      .toContain("First edit.\nSecond edit.\nAfter mode change.");
    await expect.poll(() => completedWrites).toBe(3);
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
  } finally {
    releaseFirstResponse();
    await page.unrouteAll({ behavior: "wait" });
    removeMarkdownProject(projectDir);
  }
});

test("rich-text edits preserve fenced examples and literal Markdown on disk @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("literal-markdown-save");
  const code =
    "<details>\n<summary>Example</summary>\n# Literal heading\n\nBody\n\n\nMore\n</details>";
  try {
    const filePath = writeProjectFile(
      projectDir,
      "literals.md",
      [
        "# Literals",
        "",
        "```html",
        code,
        "```",
        "",
        "The literal \\*word\\* is documented.",
        "",
        "#### Deep heading",
        "",
        "Edit here.",
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("Edit here.");
    await page.getByTestId("document-mode-trigger").click();
    await page.getByTestId("document-mode-editing").click();
    await richTextEditor(page).click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    await page.keyboard.type(" Added text.");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );
    await expect
      .poll(() => readProjectFile(projectDir, "literals.md"))
      .toContain("Added text.");
    const saved = readProjectFile(projectDir, "literals.md");
    expect(saved).toContain(code);
    expect(saved).toContain("\\*word\\*");
    expect(saved).toContain("#### Deep heading");
    await page.reload();
    await expect(richTextEditor(page).getByRole("code")).toHaveText(code);
    await expect(
      richTextEditor(page).getByRole("heading", { level: 4 }),
    ).toHaveText("Deep heading");
  } finally {
    removeMarkdownProject(projectDir);
  }
});
