import fs from "node:fs";
import path from "node:path";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
// Use one connection per fixture request; parallel tests can otherwise reuse
// a connection the test server has just closed.
const fixtureHeaders = { Connection: "close" };
const keep = /^comment-rail-.*-action-accept$/;
const revert = /^comment-rail-.*-action-reject$/;
const oldText = "# Rules\n\nUse red markers.\n\nKeep the door open.\n";
const newText = "# Rules\n\nUse blue markers.\n\nKeep the door shut.\n";

async function openReview(
  page: Page,
  request: APIRequestContext,
  files: { targetPath: string } | { beforePath: string; afterPath: string },
  options: {
    autosave?: string;
    autosaveBase?: "old" | "new";
    handoff?: "chat" | "button";
  } = {},
): Promise<string> {
  const response = await request.post(
    "targetPath" in files ? `${api}/document` : api,
    {
      headers: fixtureHeaders,
      data: {
        ...("targetPath" in files
          ? files
          : { ...files, editor: "unified", mode: "compare" }),
        autosave: "targetPath" in files ? files.targetPath : "none",
        ...options,
      },
    },
  );
  await expect(response).toBeOK();
  const { id } = await response.json();
  await page.goto(`/?comparison=${id}`);
  return id;
}

async function readReview(
  request: APIRequestContext,
  id: string,
): Promise<ComparisonReviewData> {
  const response = await request.get(`${api}/${id}`, {
    headers: fixtureHeaders,
  });
  await expect(response).toBeOK();
  return response.json();
}

function contents(filename: string) {
  // Tolerate an output file that the server hasn't created yet, so callers can
  // poll for the exact bytes of an asynchronous write.
  try {
    return fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function saved(page: Page) {
  return expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    /^(Saved to file|Review saved)$/,
  );
}

async function destination(page: Page, filename: string) {
  await page.getByTestId("revision-details").click();
  await expect(page.getByTestId("revision-details-autosave")).toHaveText(
    filename,
  );
  await page.keyboard.press("Escape");
}

async function selectMode(page: Page, mode: "edit" | "suggest") {
  await page.getByTestId("revision-mode").click();
  await page.getByTestId(`revision-mode-${mode}`).click();
}

async function recoverCopy(
  page: Page,
  request: APIRequestContext,
  id: string,
  output: string,
) {
  const { draft } = await readReview(request, id);
  if (!draft) throw new Error("Expected a saved review draft before recovery");
  const markdown = draft.cleanMarkdown ?? draft.markdown;
  const response = await request.post(`${api}/${id}/fork`, {
    headers: fixtureHeaders,
    data: { path: output, expectedVersion: null, markdown, decisions: {} },
  });
  await expect(response).toBeOK();
  const copy = await response.json();
  await page.goto(`/?comparison=${copy.id}`);
  await destination(page, output);
}

test.describe("the single revision editor", () => {
  let project: string;
  test.beforeEach(() => {
    project = createMarkdownProject("revision-editor");
  });
  test.afterEach(() => {
    removeMarkdownProject(project);
  });

  function compareFiles() {
    return {
      beforePath: writeProjectFile(project, "before.md", oldText),
      afterPath: writeProjectFile(project, "after.md", newText),
    };
  }

  test("suggestions stay in the sidecar until Keep; document edits, undo, and redo save automatically @smoke", async ({
    page,
    request,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const initial = "# Notes\n\nUse old wording.\n";
    const filename = writeProjectFile(project, "notes.md", initial);
    const id = await openReview(page, request, { targetPath: filename });
    await destination(page, filename);
    await selectMode(page, "suggest");
    await selectRichText(page, "old");
    await page.keyboard.type("new");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect
      .poll(async () => (await readReview(request, id)).draft?.markdown)
      .toMatch(/\{~~old~>new~~\}/);
    expect(contents(filename)).toBe(initial);
    await page.reload();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await saved(page);

    await page.getByTestId("revision-copy").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(initial);
    const download = page.waitForEvent("download");
    await page.getByTestId("revision-download").click();
    const artifact = await download;
    expect(artifact.suggestedFilename()).toBe("notes.md");
    expect(contents(await artifact.path())).toBe(initial);

    const accepted = "# Notes\n\nUse new wording.\n";
    await page.getByTestId(keep).click();
    await expect.poll(() => contents(filename)).toBe(accepted);
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await saved(page);
    await page.getByTestId("revision-undo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect.poll(() => contents(filename)).toBe(initial);
    await page.getByTestId("revision-redo").click();
    await expect.poll(() => contents(filename)).toBe(accepted);

    await selectMode(page, "edit");
    await selectRichText(page, "new");
    await page.keyboard.type("direct");
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect
      .poll(() => contents(filename))
      .toBe("# Notes\n\nUse direct wording.\n");
    await saved(page);
    await page.reload();
    await expect(richTextEditor(page)).toContainText("Use direct wording.");
  });

  for (const choice of ["old", "new"] as const) {
    const fromOld = choice === "old";
    test(`${fromOld ? "Keep with Old" : "Revert with New"} writes only the selected passage`, async ({
      page,
      request,
    }) => {
      const { beforePath, afterPath } = compareFiles();
      const changed = fromOld ? beforePath : afterPath;
      await openReview(
        page,
        request,
        { beforePath, afterPath },
        { autosave: changed },
      );
      await expect(page.getByTestId("revision-pending")).toHaveText("2");
      expect(contents(beforePath)).toBe(oldText);
      expect(contents(afterPath)).toBe(newText);
      await page
        .getByTestId(fromOld ? keep : revert)
        .first()
        .click();
      const untouched = fromOld ? afterPath : beforePath;
      const expected = fromOld
        ? oldText.replace("red", "blue")
        : newText.replace("blue", "red");
      await destination(page, changed);
      await expect.poll(() => contents(changed)).toBe(expected);
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      await saved(page);
      expect(contents(untouched)).toBe(fromOld ? newText : oldText);
      await page.reload();
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      expect(contents(changed)).toBe(expected);
    });
  }

  for (const decision of ["Accept", "Reject"] as const) {
    test(`${decision} all chooses an exact version; one undo restores all undecided changes`, async ({
      page,
      request,
    }) => {
      const { beforePath, afterPath } = compareFiles();
      const accept = decision === "Accept";
      const file = accept ? beforePath : afterPath;
      const all = page.getByTestId(`revision-${decision.toLowerCase()}-all`);
      await openReview(
        page,
        request,
        { beforePath, afterPath },
        { autosave: file },
      );
      expect(contents(beforePath)).toBe(oldText);
      expect(contents(afterPath)).toBe(newText);

      await all.click();
      await expect.poll(() => contents(file)).toBe(accept ? newText : oldText);
      await expect(page.getByTestId("revision-pending")).toBeEmpty();
      await saved(page);
      await page.getByTestId("revision-undo").click();
      await expect.poll(() => contents(file)).toBe(accept ? oldText : newText);
      await expect(page.getByTestId("revision-pending")).toHaveText("2");
    });
  }

  test("review shortcuts act on the current change and preserve the other choice", async ({
    page,
    request,
  }) => {
    const { beforePath, afterPath } = compareFiles();
    await openReview(
      page,
      request,
      { beforePath, afterPath },
      { autosave: afterPath },
    );
    const next = page.getByTestId("revision-next-change");
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await next.click();
    await page.keyboard.press(`${modifier}+Alt+A`);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect(contents(afterPath)).toBe(newText);

    await next.click();
    await page.keyboard.press(`${modifier}+Alt+R`);
    await expect
      .poll(() => contents(afterPath))
      .toBe(newText.replace("shut", "open"));
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    expect(contents(beforePath)).toBe(oldText);
  });

  test("Accept all combines pending native suggestions and comparison changes", async ({
    page,
    request,
  }) => {
    const same = "\nDisplay the original sign.\n";
    const before = oldText + same;
    const after = newText + same;
    const beforePath = writeProjectFile(project, "before.md", before);
    const afterPath = writeProjectFile(project, "after.md", after);
    await openReview(
      page,
      request,
      { beforePath, afterPath },
      { autosave: afterPath },
    );
    await selectMode(page, "suggest");
    await selectRichText(page, "original");
    await page.keyboard.type("updated");
    await expect(page.getByTestId("revision-pending")).toHaveText("3");
    await page.getByTestId("revision-accept-all").click();
    await expect
      .poll(() => contents(afterPath))
      .toBe(after.replace("original", "updated"));
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    expect(contents(beforePath)).toBe(before);
    await page.getByTestId("revision-undo").click();
    await expect.poll(() => contents(afterPath)).toBe(after);
    await expect(page.getByTestId("revision-pending")).toHaveText("3");
  });

  test("review-only decisions persist without writing either input or opening a file chooser", async ({
    page,
    request,
  }) => {
    const { beforePath, afterPath } = compareFiles();
    const id = await openReview(page, request, { beforePath, afterPath });
    await page.getByTestId(keep).first().click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await saved(page);
    await expect
      .poll(async () =>
        Object.keys((await readReview(request, id)).draft?.decisions ?? {}),
      )
      .toHaveLength(1);
    await page.reload();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect(contents(beforePath)).toBe(oldText);
    expect(contents(afterPath)).toBe(newText);
  });

  for (const seed of ["old", "new"] as const) {
    test(`an agent-selected copy starts from ${seed} without changing either input`, async ({
      page,
      request,
    }) => {
      const { beforePath, afterPath } = compareFiles();
      const output = path.join(project, `selected-${seed}.md`);
      await openReview(
        page,
        request,
        { beforePath, afterPath },
        { autosave: output, autosaveBase: seed },
      );
      expect(contents(output)).toBe(seed === "old" ? oldText : newText);
      await page
        .getByTestId(seed === "old" ? keep : revert)
        .first()
        .click();
      await expect
        .poll(() => contents(output))
        .toBe(
          seed === "old"
            ? oldText.replace("red", "blue")
            : newText.replace("blue", "red"),
        );
      await destination(page, output);
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      expect(contents(beforePath)).toBe(oldText);
      expect(contents(afterPath)).toBe(newText);
    });
  }

  test("an agent-selected autosave copy receives edits, undo, and redo while preserving the source", async ({
    page,
    request,
  }) => {
    const filename = writeProjectFile(
      project,
      "notes.md",
      "Original wording.\n",
    );
    const output = path.join(project, "copy.md");
    await openReview(
      page,
      request,
      { targetPath: filename },
      { autosave: output },
    );
    await selectRichText(page, "Original");
    await page.keyboard.type("Updated");
    await expect.poll(() => contents(output)).toBe("Updated wording.\n");
    await destination(page, output);
    await page.getByTestId("revision-undo").click();
    await expect.poll(() => contents(output)).toBe("Original wording.\n");
    expect(contents(filename)).toBe("Original wording.\n");
    await page.getByTestId("revision-redo").click();
    await expect.poll(() => contents(output)).toBe("Updated wording.\n");
    await saved(page);
  });

  test("sending feedback without a base records a snapshot and changes neither input", async ({
    page,
    request,
  }) => {
    const { beforePath, afterPath } = compareFiles();
    const id = await openReview(
      page,
      request,
      { beforePath, afterPath },
      { handoff: "button" },
    );
    await page.getByTestId("revision-send").click();
    await page
      .getByTestId("revision-feedback")
      .fill("Please check the terminology.");
    await page.getByTestId("revision-send-confirm").click();
    await expect(page.getByTestId("revision-send-confirm")).toBeHidden();
    const { feedback, completion } = await readReview(request, id);
    expect(completion?.fileWritten).toBe(false);
    expect(feedback).toMatchObject({
      destinationPath: null,
      saved: false,
      comment: "Please check the terminology.",
    });
    await page.getByTestId(keep).first().click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await saved(page);
    expect((await readReview(request, id)).feedback).toEqual(feedback);
    expect(contents(beforePath)).toBe(oldText);
    expect(contents(afterPath)).toBe(newText);
  });

  test("large reviews keep distant changes usable and save a typing burst before a shortcut", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const rows = Array.from(
      { length: 100 },
      (_, i) =>
        `Passage ${i} keeps the original wording. {~~old item~>updated item~~}{#s${i}} ${"Additional context for the reader. ".repeat(5).trim()}`,
    );
    const source = `# Large review\n\nOpening word stays here.\n\n${rows.join("\n\n")}\n`;
    const filename = writeProjectFile(project, "large-review.md", source);
    const id = await openReview(page, request, { targetPath: filename });
    const pending = page.getByTestId("revision-pending");
    await expect(pending).toHaveText("100");
    const cards = page.getByTestId(/^suggestion-thread-s\d+$/);
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeLessThan(35);
    await expect(page.getByTestId("suggestion-thread-s99")).toHaveCount(0);

    await page.getByTestId("revision-previous-change").click();
    await expect(
      richTextEditor(page).locator('[data-critic-change-id="s99"]').first(),
    ).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const last = page.getByTestId("suggestion-thread-s99");
    await expect(last).toBeInViewport();
    await last.getByTestId(keep).click();
    await expect(pending).toHaveText("99");
    await saved(page);

    await selectRichText(page, "Opening word");
    await page.keyboard.insertText("Refreshed opening");
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => contents(filename))
      .toContain("Refreshed opening stays here.");
    expect(contents(filename)).toContain(
      rows[99].replace("{~~old item~>updated item~~}{#s99}", "updated item"),
    );
    await page.setViewportSize({ width: 830, height: 900 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.getByTestId("suggestion-thread-s98")).toBeInViewport();
    expect(await cards.count()).toBeLessThan(35);
    const persisted = await readReview(request, id);
    expect(persisted.draft?.markdown).toContain("{~~old item~>updated item~~}");
    await page.reload();
    await expect(pending).toHaveText("99");
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
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
    await openReview(page, request, { targetPath: filename });
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
    await selectMode(page, "suggest");
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

  test("comment history stays in the sidecar and doesn't change document undo", async ({
    page,
    request,
  }) => {
    const { beforePath, afterPath } = compareFiles();
    const id = await openReview(
      page,
      request,
      { beforePath, afterPath },
      { autosave: afterPath },
    );
    await destination(page, afterPath);
    await page
      .getByTestId(/^comment-rail-.*-action-reply$/)
      .first()
      .click();
    const reply = page.getByTestId(/^comment-rail-.*-editor$/);
    const comment = "A note about this wording";
    await reply.fill(comment);
    await reply.press("Control+Enter");
    const rail = page.getByTestId("document-review-rail");
    await expect(rail).toContainText(comment);
    await expect(page.getByTestId("revision-undo")).toBeDisabled();
    await page.getByTestId("revision-comment-undo").click();
    await expect(rail).not.toContainText(comment);
    await page.getByTestId("revision-comment-redo").click();
    await expect
      .poll(async () =>
        (await readReview(request, id)).reviewComments?.map(
          (item) => item.content,
        ),
      )
      .toEqual([comment]);
    expect(contents(afterPath)).toBe(newText);
    await page.getByTestId(keep).first().click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await saved(page);
    await page.reload();
    await expect(rail).toContainText(comment);
    expect(contents(afterPath)).toBe(newText);
    expect(contents(beforePath)).toBe(oldText);
  });

  test("an external edit pauses writes and the agent can recover local changes into a copy", async ({
    page,
    request,
  }) => {
    const filename = writeProjectFile(project, "notes.md", "Original\n");
    const copy = path.join(project, "recovered.md");
    const id = await openReview(page, request, { targetPath: filename });
    await selectRichText(page, "Original");
    fs.writeFileSync(filename, "External revision\n");
    await page.keyboard.type("My draft");
    await expect(page.getByTestId("revision-conflict")).toBeVisible();
    await page.getByTestId("revision-inspect").click();
    await expect(page.getByTestId("revision-disk-version")).toContainText(
      "External revision",
    );
    await page.reload();
    await expect(richTextEditor(page)).toContainText("My draft");
    expect(contents(filename)).toBe("External revision\n");

    await recoverCopy(page, request, id, copy);
    await saved(page);
    expect(contents(copy)).toBe("My draft\n");
    expect(contents(filename)).toBe("External revision\n");
  });

  test("a stale tab preserves its edits, suggestions, and comments for the agent without overwriting the saved file", async ({
    page,
    request,
    context,
  }) => {
    const file = writeProjectFile(project, "shared.md", "Original\n");
    const id = await openReview(page, request, { targetPath: file });
    await expect(richTextEditor(page)).toHaveText("Original");
    const second = await context.newPage();
    await second.goto(`/?comparison=${id}`);
    let releaseSave = () => {};
    const delayedSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saveRoute = `**/api/comparisons/${id}/save`;
    await page.route(saveRoute, async (route) => {
      await delayedSave;
      await route.continue();
    });

    await selectRichText(page, "Original");
    await page.keyboard.insertText("Unsaved from the first tab");
    await selectMode(page, "suggest");
    await selectRichText(page, "first");
    await page.keyboard.insertText("recovered");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page
      .getByTestId(/^comment-rail-.*-action-reply$/)
      .first()
      .click();
    const reply = page.getByTestId(/^comment-rail-.*-editor$/);
    const comment = "Keep this note from the stale tab";
    await reply.fill(comment);
    await reply.press("Control+Enter");
    const rail = page.getByTestId("document-review-rail");
    await expect(rail).toContainText(comment);
    await selectRichText(second, "Original");
    await second.keyboard.insertText("Saved by the second tab");
    await expect.poll(() => contents(file)).toBe("Saved by the second tab\n");
    releaseSave();
    await expect(page.getByTestId("revision-conflict")).toContainText(
      "another browser",
    );
    await page.unroute(saveRoute);
    await page.reload();
    await expect(richTextEditor(page)).toContainText("Unsaved from the");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(rail).toContainText(comment);
    await expect(page.getByTestId("revision-conflict")).toContainText(
      "another browser",
    );
    expect(contents(file)).toBe("Saved by the second tab\n");

    await expect(page.getByTestId("revision-recover")).toBeVisible();
    await page.getByTestId("revision-recover").click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("comparison"))
      .not.toBe(id);
    const recoveredId = new URL(page.url()).searchParams.get("comparison");
    if (!recoveredId)
      throw new Error("The recovered review URL is missing its ID");
    await saved(page);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(rail).toContainText(comment);
    const recovered = await readReview(request, recoveredId);
    expect(recovered.draft?.markdown).toContain("{~~first~>recovered~~}");
    expect(recovered.reviewComments?.map((item) => item.content)).toEqual([
      comment,
    ]);
    const originalResponse = await request.get(`${api}/${id}`, {
      headers: fixtureHeaders,
    });
    await expect(originalResponse).toBeOK();
    expect((await originalResponse.json()).recoveredReviews).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: recoveredId })]),
    );
    expect(contents(file)).toBe("Saved by the second tab\n");
    await second.reload();
    await destination(second, file);
    await expect(richTextEditor(second)).toHaveText("Saved by the second tab");
    await page.reload();
    await expect(rail).toContainText(comment);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await selectMode(page, "edit");
    await selectRichText(page, "Unsaved");
    await page.keyboard.insertText("Preserved");
    await expect
      .poll(
        async () => (await readReview(request, recoveredId)).draft?.markdown,
      )
      .toContain("Preserved from the");
    expect(contents(file)).toBe("Saved by the second tab\n");
  });

  test("opening a linked file flushes a queued large-document edit and stays in the same editor", async ({
    page,
    request,
  }) => {
    const body = "A paragraph of unchanged text. ".repeat(425).trim();
    const first = writeProjectFile(
      project,
      "first.md",
      `Original.\n\n[Second file](second.md)\n\n${body}\n`,
    );
    const second = writeProjectFile(
      project,
      "second.md",
      "# Linked document\n",
    );
    await openReview(page, request, { targetPath: first });
    await selectRichText(page, "Original");
    await page.keyboard.type("Edited");
    await richTextEditor(page)
      .getByRole("link", { name: "Second file" })
      .click();
    // The outgoing editor remains mounted while its queued save finishes.
    // Wait for the linked document before interacting with its header.
    await expect(richTextEditor(page)).toContainText("Linked document");
    await destination(page, second);
    expect(contents(first)).toBe(
      `Edited.\n\n[Second file](second.md)\n\n${body}\n`,
    );
  });

  for (const { kind, original, proposed, expected } of [
    {
      kind: "link",
      original: "[Old wording](./guide.md)\n",
      proposed: "[New wording](guide.md)\n",
      expected: "[New wording](./guide.md)\n",
    },
    {
      kind: "image",
      original: "![Old image](old.png)\n",
      proposed: "![New image](new.png)\n",
    },
  ]) {
    test(`the first Keep uses New ${kind} content when choosing Old as the file`, async ({
      page,
      request,
    }) => {
      const beforePath = writeProjectFile(project, "before.md", original);
      const afterPath = writeProjectFile(project, "after.md", proposed);
      await openReview(
        page,
        request,
        { beforePath, afterPath },
        { autosave: beforePath },
      );
      await page.getByTestId(keep).first().click();
      await destination(page, beforePath);
      await expect.poll(() => contents(beforePath)).toBe(expected ?? proposed);
      expect(contents(afterPath)).toBe(proposed);
    });
  }

  test("Send feedback does not initiate a pending autosave", async ({
    page,
    request,
  }) => {
    const file = writeProjectFile(project, "mode.md", "Original\n");
    const id = await openReview(
      page,
      request,
      { targetPath: file },
      { handoff: "button" },
    );
    await expect(richTextEditor(page)).toHaveText("Original");
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await selectRichText(page, "Original");
    await page.keyboard.type("Edited in the browser");
    await page.getByTestId("revision-send").dispatchEvent("click");
    await page.getByTestId("revision-send-confirm").dispatchEvent("click");
    await expect
      .poll(async () => (await readReview(request, id)).feedback)
      .toMatchObject({
        saved: false,
        draft: { cleanMarkdown: "Edited in the browser\n" },
      });
    expect(contents(file)).toBe("Original\n");
    await page.clock.runFor(500);
    await expect.poll(() => contents(file)).toBe("Edited in the browser\n");
  });
});
