import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const apiPort = process.env.API_PORT ?? "4317";
const api = `http://127.0.0.1:${apiPort}/api/comparisons`;
const root = fileURLToPath(new URL("../../..", import.meta.url));
const cli = new URL("../../server/src/cli.ts", import.meta.url).href;
const headers = { Connection: "close" };

test("chat reviews preserve unfinished comments, edits and choices without writing either source @smoke", async ({
  page,
  request,
}, info) => {
  const project = createMarkdownProject("agent-chat-review");
  try {
    const before =
      "# Laser product page\n\nUse original wording.\n\nExplain the material limits.\n";
    const after = before.replace("original", "revised");
    const beforePath = writeProjectFile(
      project,
      "evidence/SKILL-before.md",
      before,
    );
    const afterPath = writeProjectFile(
      project,
      "skills/upgrade-laser-product-page/SKILL.md",
      after,
    );
    const response = await request.post(api, {
      headers,
      data: {
        editor: "unified",
        mode: "compare",
        beforePath,
        afterPath,
        title: "Review the laser product page instructions",
        beforeLabel: "Original",
        afterLabel: "Revised",
        autosave: "none",
      },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    const read = async () =>
      (await request.get(`${api}/${id}`, { headers })).json();
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-path")).toHaveText(
      "Review the laser product page instructions",
    );
    await expect(page.getByTestId("revision-before-label")).toHaveAttribute(
      "title",
      beforePath,
    );
    await expect(page.getByTestId("revision-after-label")).toHaveAttribute(
      "title",
      afterPath,
    );
    await expect(page.getByTestId("revision-send")).toHaveCount(0);
    await expect(page.getByTestId("revision-save-as")).toHaveCount(0);
    await page.getByTestId("revision-details").click();
    await expect(page.getByTestId("revision-details-before")).toHaveText(
      beforePath,
    );
    await expect(page.getByTestId("revision-details-after")).toHaveText(
      afterPath,
    );
    await expect(page.getByTestId("revision-details-autosave")).toContainText(
      "No Markdown file writes",
    );
    await page.keyboard.press("Escape");

    await page
      .getByTestId(/^comment-rail-.*-action-reject$/)
      .first()
      .click();
    await expect(page.getByTestId("revision-base-dialog")).toHaveCount(0);
    await expect(richTextEditor(page)).toContainText("Use original wording.");
    await page.getByTestId("revision-mode").click();
    await page.getByTestId("revision-mode-edit").click();
    await selectRichText(page, "material limits");
    await page.keyboard.type("supported materials");
    await selectRichText(page, "supported materials");
    await page.getByTestId("selection-menu-action-comment").click();
    const comment = page.getByTestId(/^comment-rail-.*-editor$/);
    await comment.fill(
      "Please include an example for first-time laser owners.",
    );
    // Returning to chat must preserve this text even before the comment Save button.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect
      .poll(async () => (await read()).reviewComments?.[0]?.content)
      .toBe("Please include an example for first-time laser owners.");
    await expect
      .poll(async () => (await read()).draft?.cleanMarkdown)
      .toContain("supported materials");

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { runCli } from ${JSON.stringify(cli)}; process.exit(await runCli(process.argv.slice(1)));`,
        "comparison",
        id,
        "--read",
        "--json",
        "--port",
        apiPort,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          ROUGHDRAFT_HOST: "",
          ROUGHDRAFT_STATE_DIR: path.join(project, "state"),
          ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(
            project,
            "no-frontend.json",
          ),
        },
      },
    );
    const event = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "comparison.read");
    expect(event.comparison.reviewComments[0].content).toContain(
      "first-time laser owners",
    );
    expect(event.comparison.draft.cleanMarkdown).toContain(
      "supported materials",
    );
    expect(event.comparison.completion).toBeNull();
    expect(event.comparison.destinationPath).toBeNull();
    expect(fs.readFileSync(beforePath, "utf8")).toBe(before);
    expect(fs.readFileSync(afterPath, "utf8")).toBe(after);
    await page.reload();
    await expect(richTextEditor(page)).toContainText("supported materials");
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "first-time laser owners",
    );
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    await page.screenshot({
      path: info.outputPath("chat-review-desktop.png"),
      fullPage: true,
    });
    logE2eEvent("agent-review.chat-read", {
      id,
      comments: event.comparison.reviewComments.length,
      fileWritten: false,
    });
  } finally {
    removeMarkdownProject(project);
  }
});

test("an agent-selected output autosaves without a destination prompt @smoke", async ({
  page,
  request,
}, info) => {
  const project = createMarkdownProject("agent-output-review");
  try {
    const beforePath = writeProjectFile(
      project,
      "before.md",
      "# Plan\n\nUse original wording.\n",
    );
    const afterPath = writeProjectFile(
      project,
      "after.md",
      "# Plan\n\nUse revised wording.\n",
    );
    const output = path.join(project, "reviewed.md");
    const response = await request.post(api, {
      headers,
      data: {
        editor: "unified",
        mode: "compare",
        beforePath,
        afterPath,
        title: "Review the onboarding plan",
        autosave: output,
      },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await page.getByTestId("revision-mode").click();
    await page.getByTestId("revision-mode-edit").click();
    await selectRichText(page, "revised");
    await page.keyboard.type("reviewed");
    await expect
      .poll(() => fs.readFileSync(output, "utf8"))
      .toBe("# Plan\n\nUse reviewed wording.\n");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    await expect(page.getByTestId("revision-base-dialog")).toHaveCount(0);
    await page.getByTestId("revision-details").click();
    await expect(page.getByTestId("revision-details-autosave")).toHaveText(
      output,
    );
    await page.screenshot({ path: info.outputPath("agent-save-details.png") });
    expect(fs.readFileSync(beforePath, "utf8")).toContain("original");
    expect(fs.readFileSync(afterPath, "utf8")).toContain("revised");
    logE2eEvent("agent-review.output-saved", { id, output, fileWritten: true });
  } finally {
    removeMarkdownProject(project);
  }
});
