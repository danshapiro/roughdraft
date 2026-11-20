import fs from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

async function startEditing(page: Page, targetPath: string) {
  await openMarkdownFile(page, targetPath);
  await expect(richTextEditor(page)).toBeVisible();
  await page.getByTestId("document-mode-trigger").tap();
  await page.getByTestId("document-mode-editing").tap();
}

async function insideCoverScreen(page: Page, popup: Locator) {
  await expect(popup).toBeVisible();
  await popup.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const bounds = await popup.boundingBox();
  expect
    .soft(bounds?.x, "Popup left edge must remain reachable")
    .toBeGreaterThanOrEqual(8);
  expect
    .soft(
      (bounds?.x ?? 0) + (bounds?.width ?? 0),
      "Popup right edge must remain reachable",
    )
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) - 8);
  expect
    .soft(bounds?.y, "Popup top must remain below the viewport edge")
    .toBeGreaterThanOrEqual(8);
  expect
    .soft(
      (bounds?.y ?? 0) + (bounds?.height ?? 0),
      "Popup bottom must remain reachable",
    )
    .toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) - 8);
}

test.describe("mobile inline editing popups", () => {
  test.use({
    viewport: { width: 360, height: 780 },
    hasTouch: true,
    isMobile: true,
  });
  let project: string;
  let errors: string[];
  test.beforeEach(({ page }) => {
    errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    project = createMarkdownProject("mobile-link-editor");
  });
  test.afterEach(() => {
    removeMarkdownProject(project);
    expect(errors).toEqual([]);
  });

  test("link URLs near either cover-screen edge can be edited and saved @smoke", async ({
    page,
  }) => {
    const source = [
      "# Mobile links",
      "",
      "[left](https://example.com/left) starts this paragraph.",
      "",
      "MMMMMMMMMMMMMMMMM [right](https://example.com/right)",
      "",
    ].join("\n");
    const targetPath = writeProjectFile(project, "links.md", source);
    await startEditing(page, targetPath);

    for (const edge of ["left", "right"]) {
      // A normal tap follows a link; select its text to edit the URL.
      await selectRichText(page, edge);
      const editLink = page.getByTestId("selection-menu-action-link");
      await editLink.tap();
      await insideCoverScreen(page, page.getByTestId("link-popover"));
      const input = page.getByTestId("link-url-input");
      expect
        .soft((await input.boundingBox())?.height)
        .toBeGreaterThanOrEqual(44);
      await expect(input).toHaveValue(`https://example.com/${edge}`);
      await input.fill(`https://example.com/updated-${edge}`);
      await input.press("Enter");
      await input.press("Escape");
      await expect
        .poll(() => fs.readFileSync(targetPath, "utf8"))
        .toContain(`[${edge}](https://example.com/updated-${edge})`);
    }
    await page.reload();
    await expect(richTextEditor(page)).toBeVisible();
    for (const edge of ["left", "right"]) {
      await expect(
        richTextEditor(page).locator(
          `a[data-markdown-src="https://example.com/updated-${edge}"]`,
        ),
      ).toBeVisible();
    }
    await expect(page.getByTestId("file-conflict-notice")).toHaveCount(0);
  });

  test("an unfinished existing URL edit survives unfolding and anchor movement before save @smoke", async ({
    page,
  }) => {
    const context = Array.from(
      { length: 12 },
      (_, index) =>
        `Unchanged paragraph ${index + 1} has room to read and scroll.`,
    ).join("\n\n");
    const source = `# Mobile URL draft\n\n${context}\n\nA long lead-in moves this [draft link](https://example.com/original) when the screen unfolds.\n\n${context}\n`;
    const targetPath = writeProjectFile(project, "url-draft.md", source);
    await startEditing(page, targetPath);
    const anchor = richTextEditor(page).locator(
      'a[data-markdown-src="https://example.com/original"]',
    );
    await anchor.scrollIntoViewIfNeeded();
    await selectRichText(page, "draft link");
    await page.getByTestId("selection-menu-action-link").tap();
    const input = page.getByTestId("link-url-input");
    const editedUrl = "https://example.com/unfinished-mobile-edit";
    await input.fill(editedUrl);
    const folded = await anchor.boundingBox();
    await page.setViewportSize({ width: 768, height: 900 });
    const unfolded = await anchor.boundingBox();
    expect(
      Math.abs((unfolded?.x ?? 0) - (folded?.x ?? 0)) +
        Math.abs((unfolded?.y ?? 0) - (folded?.y ?? 0)),
      "Unfolding must exercise a real anchor-coordinate update",
    ).toBeGreaterThan(10);
    await expect
      .soft(input, "Unfolding must preserve the unfinished URL")
      .toHaveValue(editedUrl);

    // Refill so a reset from the first step does not mask the independent
    // scroll case. Scrolling must not commit or discard this unfinished edit.
    await input.fill(editedUrl);
    const beforeScroll = await anchor.boundingBox();
    await anchor.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    await expect
      .poll(async () =>
        Math.abs(
          ((await anchor.boundingBox())?.y ?? 0) - (beforeScroll?.y ?? 0),
        ),
      )
      .toBeGreaterThan(10);
    await expect
      .soft(input, "Moving the link must preserve the unfinished URL")
      .toHaveValue(editedUrl);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(source);

    await input.press("Enter");
    await input.press("Escape");
    await expect
      .poll(() => fs.readFileSync(targetPath, "utf8"))
      .toContain(`[draft link](${editedUrl})`);
    await page.reload();
    await expect(
      richTextEditor(page).locator(`a[data-markdown-src="${editedUrl}"]`),
    ).toBeVisible();
    await expect(page.getByTestId("file-conflict-notice")).toHaveCount(0);
  });

  for (const edge of ["left", "right"]) {
    test(`selection actions near the ${edge} cover-screen edge stay reachable and save @smoke`, async ({
      page,
    }) => {
      const word = `${edge}word`;
      const paragraph =
        edge === "left" ? `${word} stays here.` : `MMMMMMMMMMMMMMM ${word}`;
      const targetPath = writeProjectFile(
        project,
        "selection.md",
        `# Mobile selection\n\n${paragraph}\n`,
      );
      await startEditing(page, targetPath);
      await selectRichText(page, word);
      await insideCoverScreen(page, page.getByTestId("selection-menu"));
      await page.getByTestId("selection-menu-action-bold").tap();
      await expect
        .poll(() => fs.readFileSync(targetPath, "utf8"))
        .toContain(`**${word}**`);
      await expect(page.getByTestId("file-conflict-notice")).toHaveCount(0);
    });
  }
});
