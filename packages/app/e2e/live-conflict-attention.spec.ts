import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const fixtures = fileURLToPath(
  new URL("../../../docs/spec/fixtures/", import.meta.url),
);
const markdown = fs.readFileSync(
  path.join(fixtures, "editing-review.md"),
  "utf8",
);
const headers = { Connection: "close" };
async function toggleMarkdown(page: Page) {
  const format = page.getByTestId("revision-format");
  if (!(await format.isVisible()))
    await page.getByTestId("revision-more").click();
  await format.click();
}

test("a conflict at the footer stays reachable across folded, short keyboard-sized, unfolded and Markdown views without submitting a private draft", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("conflict-attention");
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  try {
    const target = writeProjectFile(project, "practice.md", markdown);
    fs.cpSync(
      path.join(fixtures, "editing-review-assets"),
      path.join(project, "editing-review-assets"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(fixtures, "editing-review-linked.md"),
      path.join(project, "editing-review-linked.md"),
    );
    const created = await request.post(`${api}/document`, {
      headers,
      data: {
        targetPath: target,
        autosave: target,
        title: "Review a release plan while updates arrive",
      },
    });
    await expect(created).toBeOK();
    const { id } = await created.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      /^(Saved to file|Review saved)$/,
    );
    await page.getByTestId("comment-thread-c13").click();
    await page.getByTestId("comment-rail-c13-action-edit").click();
    const unfinished =
      "My private wording remains unsubmitted while resolving an update.";
    await page.getByTestId("comment-rail-c13-editor").fill(unfinished);
    let captured = false;
    await page.route(`**/api/comparisons/${id}/reconcile`, async (route) => {
      if (
        !captured &&
        route
          .request()
          .postDataJSON()
          .draft.markdown.includes("orchard schedule")
      ) {
        captured = true;
        await held;
      }
      await route.continue();
    });
    await selectRichText(page, "planting schedule");
    await page.keyboard.insertText("orchard schedule");
    await expect.poll(() => captured).toBe(true);
    fs.writeFileSync(
      target,
      markdown.replace("planting schedule", "garden schedule"),
    );
    release();
    await expect(page.getByTestId("revision-conflict")).toBeVisible();

    for (const [width, height, view] of [
      [360, 640, "changes"],
      [360, 360, "accepted"],
      [900, 600, "rejected"],
      [600, 360, "markdown"],
    ] as const) {
      await page.setViewportSize({ width, height });
      if (view === "markdown") {
        await toggleMarkdown(page);
      } else {
        await page.getByTestId("revision-view").click();
        await page.getByTestId(`revision-view-${view}`).click();
      }
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      const attention = page.getByTestId("revision-update-attention");
      await expect(attention).toBeInViewport();
      await attention.click();
      const dialog = page.getByTestId("revision-update-dialog");
      await expect(dialog).toBeVisible();
      for (const name of [
        "revision-discard",
        "revision-overwrite",
        "revision-save-separately",
      ]) {
        const action = dialog.getByTestId(name);
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeEnabled();
        await expect(action).toBeInViewport();
      }
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    }
    const saved = await (await request.get(`${api}/${id}`, { headers })).json();
    expect(
      saved.reviewComments.find(
        (comment: { id: string }) => comment.id === "c13",
      ).content,
    ).not.toBe(unfinished);
    expect(fs.readFileSync(target, "utf8")).not.toContain(unfinished);
    await toggleMarkdown(page);
    await page.getByTestId("revision-view").click();
    await page.getByTestId("revision-view-changes").click();
    await page.getByTestId("comment-thread-c13").click();
    await expect(page.getByTestId("comment-rail-c13-editor")).toHaveValue(
      unfinished,
    );
  } finally {
    release();
    removeMarkdownProject(project);
  }
});

test("a deleted autosave file is recreated only after confirmation while pending review and private feedback remain intact", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("recreate-autosave");
  try {
    const target = writeProjectFile(project, "practice.md", markdown);
    fs.cpSync(
      path.join(fixtures, "editing-review-assets"),
      path.join(project, "editing-review-assets"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(fixtures, "editing-review-linked.md"),
      path.join(project, "editing-review-linked.md"),
    );
    const created = await request.post(`${api}/document`, {
      headers,
      data: {
        targetPath: target,
        autosave: target,
        title: "Recreate a deleted release-plan file without losing its review",
      },
    });
    await expect(created).toBeOK();
    const { id } = await created.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      /^(Saved to file|Review saved)$/,
    );
    await page.getByTestId("comment-thread-c13").click();
    await page.getByTestId("comment-rail-c13-action-edit").click();
    const privateDraft =
      "Keep this unfinished feedback while recreating the autosave file.";
    await page.getByTestId("comment-rail-c13-editor").fill(privateDraft);
    const before = await (
      await request.get(`${api}/${id}`, { headers })
    ).json();
    fs.unlinkSync(target);
    await expect(page.getByTestId("revision-conflict")).toBeVisible();
    await expect(page.getByTestId("revision-recreate-file")).toBeVisible();
    await page.setViewportSize({ width: 360, height: 480 });
    await page.getByTestId("revision-view").click();
    await page.getByTestId("revision-view-accepted").click();
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await page.getByTestId("revision-update-attention").click();
    await page
      .getByTestId("revision-update-dialog")
      .getByTestId("revision-recreate-file")
      .click();
    const confirmation = page.getByTestId("revision-recreate-dialog");
    await expect(confirmation).toContainText(target);
    await expect(confirmation).toContainText(
      "You are viewing Final; this uses the working draft.",
    );
    expect(fs.existsSync(target)).toBe(false);
    await confirmation.getByTestId("revision-recreate-confirm").click();
    await expect.poll(() => fs.existsSync(target)).toBe(true);
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    const after = await (await request.get(`${api}/${id}`, { headers })).json();
    expect(after.draft.markdown).toBe(before.draft.markdown);
    expect(after.reviewComments).toEqual(before.reviewComments);
    expect(fs.readFileSync(target, "utf8")).toBe(after.draft.cleanMarkdown);
    expect(fs.readFileSync(target, "utf8")).not.toContain(privateDraft);
    await page.getByTestId("revision-view").click();
    await page.getByTestId("revision-view-changes").click();
    await page.getByTestId("comment-thread-c13").click();
    await expect(page.getByTestId("comment-rail-c13-editor")).toHaveValue(
      privateDraft,
    );
  } finally {
    removeMarkdownProject(project);
  }
});
