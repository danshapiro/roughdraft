import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;

test.describe("the single revision editor", () => {
  let project: string;
  test.beforeEach(() => {
    project = createMarkdownProject("revision-editor");
  });
  test.afterEach(() => {
    removeMarkdownProject(project);
  });

  test("only keeps suggestions on request, and copies, downloads, and saves the same Markdown @smoke", async ({
    page,
    request,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const initial = "# Notes\n\nUse old wording.\n";
    const filename = writeProjectFile(project, "notes.md", initial);
    const opened = await request.post(`${api}/document`, {
      data: { targetPath: filename },
    });
    expect(opened.ok()).toBeTruthy();
    const { id } = await opened.json();
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-path")).toHaveText(filename);
    await page.getByTestId("revision-suggest").click();
    await selectRichText(page, "old");
    await page.keyboard.type("new");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(page.getByTestId("revision-file-status")).toHaveText("Saved");
    await page.getByTestId("revision-copy").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(initial);
    const download = page.waitForEvent("download");
    await page.getByTestId("revision-download").click();
    const artifact = await download;
    expect(artifact.suggestedFilename()).toBe("notes.md");
    expect(fs.readFileSync((await artifact.path()) ?? "", "utf8")).toBe(
      initial,
    );
    expect(fs.readFileSync(filename, "utf8")).toBe(initial);

    await page.getByTestId(/^comment-rail-.*-action-accept$/).click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await page.getByTestId("revision-save").click();
    await expect(page.getByTestId("revision-file-status")).toHaveText("Saved");
    expect(fs.readFileSync(filename, "utf8")).toBe(
      "# Notes\n\nUse new wording.\n",
    );
    await page.getByTestId("revision-undo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(page.getByTestId("revision-file-status")).toHaveText(
      "Unsaved",
    );
    await page.getByTestId("revision-redo").click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect(page.getByTestId("revision-file-status")).toHaveText("Saved");

    await page.getByTestId("revision-edit").click();
    await selectRichText(page, "new");
    await page.keyboard.type("direct");
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await page.reload();
    await expect(richTextEditor(page)).toContainText("Use direct wording.");
    expect(fs.readFileSync(filename, "utf8")).toBe(
      "# Notes\n\nUse new wording.\n",
    );
  });

  test("compares in the editable document, and sends an unsaved snapshot independently of saving", async ({
    page,
    request,
  }) => {
    const before = writeProjectFile(
      project,
      "before.md",
      "# Rules\n\nUse red markers.\n\nKeep the door open.\n",
    );
    const after = writeProjectFile(
      project,
      "after.md",
      "# Rules\n\nUse blue markers.\n\nKeep the door shut.\n",
    );
    const opened = await request.post(api, {
      data: {
        editor: "unified",
        mode: "compare",
        beforePath: before,
        afterPath: after,
      },
    });
    expect(opened.ok()).toBeTruthy();
    const { id } = await opened.json();
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await page
      .getByTestId(/^comment-rail-.*-action-accept$/)
      .first()
      .click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.getByTestId(/^comment-rail-.*-action-reject$/).click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect(richTextEditor(page)).toContainText("Keep the door open.");
    await page.getByTestId("revision-undo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.getByTestId("revision-redo").click();

    await page.getByTestId("revision-send").click();
    await page
      .getByTestId("revision-feedback")
      .fill("Please check the terminology.");
    await page.getByTestId("revision-send-confirm").click();
    await expect(page.getByTestId("revision-send-confirm")).toBeHidden();
    const read = async () => (await request.get(`${api}/${id}`)).json();
    const { feedback, completion } = await read();
    expect(completion.fileWritten).toBe(false);
    expect(feedback).toMatchObject({
      destinationPath: null,
      saved: false,
      comment: "Please check the terminology.",
    });
    expect(feedback.draft.cleanMarkdown).toContain("Keep the door open.");
    expect(fs.readFileSync(after, "utf8")).toContain("Keep the door shut.");

    const output = path.join(project, "result.md");
    await page.getByTestId("revision-save-as").click();
    await page.getByTestId("revision-output").fill(output);
    await page.getByTestId("revision-save-confirm").click();
    await expect(page.getByTestId("revision-path")).toHaveText(output);
    expect(fs.readFileSync(output, "utf8")).toBe(feedback.draft.cleanMarkdown);
    expect((await read()).feedback).toEqual(feedback);
  });

  test("keeps the same passage and column when switching views", async ({
    page,
    request,
  }) => {
    const rows = Array.from(
      { length: 80 },
      (_, i) =>
        `Passage ${i}: A distinct paragraph with enough text to keep the same place.`,
    );
    const target = "Passage 45";
    const filename = writeProjectFile(project, "long.md", rows.join("\n\n"));
    const opened = await request.post(`${api}/document`, {
      data: { targetPath: filename },
    });
    const { id } = await opened.json();
    await page.goto(`/?comparison=${id}`);
    const formatted = richTextEditor(page);
    await expect(formatted).toContainText(target);
    const locate = (raw: boolean, scroll: boolean) =>
      page.evaluate(
        ({ raw, scroll, target }) => {
          const root = raw
            ? document.querySelector('[data-testid="revision-markdown"]')
            : document.querySelector(".ProseMirror");
          if (!root) throw new Error("Document view is missing");
          const tree = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let node = tree.nextNode(); node; node = tree.nextNode()) {
            const at = node.textContent?.indexOf(target) ?? -1;
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + target.length);
            if (scroll)
              window.scrollBy(0, range.getBoundingClientRect().top - 205);
            const { top, left } = range.getBoundingClientRect();
            return { top, left };
          }
          throw new Error("Reading passage is missing");
        },
        { raw, scroll, target },
      );
    const original = await locate(false, true);
    await page.getByTestId("revision-suggest").click();
    expect(await locate(false, false)).toEqual(original);
    await page.getByTestId("revision-format").click();
    await expect(page.getByTestId("revision-markdown")).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await locate(true, false)).top - original.top),
      )
      .toBeLessThan(3);
    expect(
      Math.abs((await locate(true, false)).left - original.left),
    ).toBeLessThan(3);
    await page.getByTestId("revision-format").click();
    await expect
      .poll(async () =>
        Math.abs((await locate(false, false)).top - original.top),
      )
      .toBeLessThan(3);
    expect((await locate(false, false)).left).toBe(original.left);
  });

  test("keeps comment history separate from document undo", async ({
    page,
    request,
  }) => {
    const before = writeProjectFile(project, "before.md", "Use red markers.\n");
    const after = writeProjectFile(project, "after.md", "Use blue markers.\n");
    const opened = await request.post(api, {
      data: {
        editor: "unified",
        mode: "compare",
        beforePath: before,
        afterPath: after,
      },
    });
    const { id } = await opened.json();
    await page.goto(`/?comparison=${id}`);
    await page.getByTestId(/^comment-rail-.*-action-reply$/).click();
    const reply = page.getByTestId(/^comment-rail-.*-editor$/);
    await reply.fill("A note about this wording");
    await reply.press("Control+Enter");
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "A note about this wording",
    );
    await expect(page.getByTestId("revision-undo")).toBeDisabled();
    await page.getByTestId("revision-comment-undo").click();
    await expect(page.getByTestId("document-review-rail")).not.toContainText(
      "A note about this wording",
    );
    await page.getByTestId("revision-comment-redo").click();
    await page.getByTestId(/^comment-rail-.*-action-accept$/).click();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "A note about this wording",
    );
    await page.reload();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "A note about this wording",
    );
    expect(fs.readFileSync(after, "utf8")).toBe("Use blue markers.\n");
  });

  test("keeps an edited draft when another process changes the destination", async ({
    page,
    request,
  }) => {
    const filename = writeProjectFile(project, "notes.md", "Original\n");
    const opened = await request.post(`${api}/document`, {
      data: { targetPath: filename },
    });
    const { id } = await opened.json();
    await page.goto(`/?comparison=${id}`);
    await selectRichText(page, "Original");
    await page.keyboard.type("My draft");
    fs.writeFileSync(filename, "External revision\n");
    await page.getByTestId("revision-save").click();
    await expect(page.getByTestId("revision-conflict")).toBeVisible();
    await page.getByTestId("revision-inspect").click();
    await expect(page.getByTestId("revision-disk-version")).toContainText(
      "External revision",
    );
    await page.reload();
    await expect(richTextEditor(page)).toContainText("My draft");
    expect(fs.readFileSync(filename, "utf8")).toBe("External revision\n");
  });
});
