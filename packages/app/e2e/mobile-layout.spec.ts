import fs from "node:fs";
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const before = "# Review\n\nUse original wording.\n\nKeep the door open.\n";
const after = "# Review\n\nUse updated wording.\n\nKeep the door shut.\n";

async function openReview(
  page: Page,
  request: APIRequestContext,
  files: { targetPath: string } | { beforePath: string; afterPath: string },
) {
  const response = await request.post(
    "targetPath" in files ? `${api}/document` : api,
    {
      headers: { Connection: "close" },
      data:
        "targetPath" in files
          ? files
          : { ...files, editor: "unified", mode: "compare" },
    },
  );
  await expect(response).toBeOK();
  const { id } = await response.json();
  await page.goto(`/?comparison=${id}`);
  await expect(richTextEditor(page)).toBeVisible();
  return id as string;
}

async function readableText(locator: Locator, minimum = 16) {
  const size = await locator.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect
    .soft(size, "Text should be readable without pinch zoom")
    .toBeGreaterThanOrEqual(minimum);
}

async function touchControls(container: Locator) {
  // Measure all native controls so a new undersized button cannot escape the check.
  const buttons = container.locator('button:visible, [role="option"]:visible'); // selector-check-ignore: aggregate touch-target audit
  expect(await buttons.count()).toBeGreaterThan(0);
  // Portaled popovers animate their scale. Measure once they have reached
  // their usable size, rather than sampling a frame during the opening.
  await expect
    .poll(
      async () =>
        buttons.evaluateAll((elements) =>
          elements
            .filter((button) => button.getAttribute("aria-disabled") !== "true")
            .map((button) => {
              const { width, height } = button.getBoundingClientRect();
              return {
                name:
                  button.getAttribute("aria-label") ??
                  button.textContent?.trim(),
                width,
                height,
                fontSize: Number.parseFloat(getComputedStyle(button).fontSize),
                hasText: Boolean(button.textContent?.trim()),
              };
            })
            .filter(
              (control) =>
                control.width < 44 ||
                control.height < 44 ||
                (control.hasText && control.fontSize < 14),
            ),
        ),
      {
        message: "Visible touch controls need 44px targets and readable labels",
      },
    )
    .toEqual([]);
}

async function noPageOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    "The page should fit the viewport without horizontal scrolling",
  ).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
}

test.describe("mobile and foldable review", () => {
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
    project = createMarkdownProject("mobile-layout");
  });
  test.afterEach(() => {
    removeMarkdownProject(project);
    expect(errors).toEqual([]);
  });

  test("a folded cover screen leaves room to read and comfortably tap review controls @smoke", async ({
    page,
    request,
  }) => {
    await openReview(page, request, {
      beforePath: writeProjectFile(project, "before.md", before),
      afterPath: writeProjectFile(project, "after.md", after),
    });
    const header = page.getByTestId("revision-header");
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await touchControls(header);
    await touchControls(page.getByTestId("document-review-rail"));
    await readableText(richTextEditor(page));
    const bounds = await header.boundingBox();
    expect
      .soft(
        bounds?.height,
        "The sticky toolbar must leave space for the document",
      )
      .toBeLessThanOrEqual(240);
    const editor = await richTextEditor(page).boundingBox();
    expect
      .soft(editor?.width, "Phone margins should leave a useful text column")
      .toBeGreaterThanOrEqual(296);
    await noPageOverflow(page);
    await page.getByTestId("revision-more").tap();
    const actions = page.getByTestId("revision-more-actions");
    await expect(actions).toBeVisible();
    await touchControls(actions);
    await page.getByTestId("revision-format").tap();
    await expect(page.getByTestId("revision-markdown")).toContainText(
      "updated wording",
    );
    await page.getByTestId("revision-more").tap();
    await page.getByTestId("revision-format").tap();
    await expect(richTextEditor(page)).toBeVisible();
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await page.getByTestId("revision-next-change").tap();
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
  });

  test("unfolding preserves a pending suggestion, text selection and the original file @smoke", async ({
    page,
    request,
  }) => {
    const targetPath = writeProjectFile(project, "notes.md", before);
    const id = await openReview(page, request, { targetPath });
    await page.getByTestId("revision-suggest").tap();
    await selectRichText(page, "original");
    await page.keyboard.insertText("updated");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await selectRichText(page, "Keep the door");
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(richTextEditor(page)).toContainText("updated wording");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      "Keep the door",
    );
    await readableText(richTextEditor(page));
    await touchControls(page.getByTestId("revision-header"));
    await noPageOverflow(page);
    await page.setViewportSize({ width: 1100, height: 760 });
    await touchControls(page.getByTestId("revision-header"));
    await noPageOverflow(page);
    await page.setViewportSize({ width: 360, height: 420 });
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect(fs.readFileSync(targetPath, "utf8")).toBe(before);
    await expect
      .poll(async () => {
        const response = await request.get(`${api}/${id}`, {
          headers: { Connection: "close" },
        });
        return (await response.json()).draft?.markdown;
      })
      .toMatch(/\{~~original~>updated~~\}/);
    await noPageOverflow(page);
  });

  test("a plain Markdown file has readable content and touch-sized file, mode and view controls @smoke", async ({
    page,
  }) => {
    const targetPath = writeProjectFile(project, "notes.md", before);
    await openMarkdownFile(page, targetPath);
    await expect(richTextEditor(page)).toBeVisible();
    await readableText(richTextEditor(page));
    const editor = await richTextEditor(page).boundingBox();
    expect
      .soft(
        editor?.width,
        "The plain-file editor should use the phone's available width",
      )
      .toBeGreaterThanOrEqual(296);
    await touchControls(page.getByTestId("document-page-header"));
    await noPageOverflow(page);
    await page.getByTestId("document-file-menu-trigger").tap();
    await expect(page.getByTestId("document-file-menu")).toBeVisible();
    await touchControls(page.getByTestId("document-file-menu"));
    await page.keyboard.press("Escape");
    await page.getByTestId("document-mode-trigger").tap();
    await expect(page.getByTestId("document-mode-options")).toBeVisible();
    await touchControls(page.getByTestId("document-mode-options"));
    await page.getByTestId("document-mode-viewing").tap();
    await expect(richTextEditor(page)).toHaveAttribute(
      "contenteditable",
      "false",
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe(before);
  });

  test("More actions opens Save As and saves a separate copy on a phone @smoke", async ({
    page,
    request,
  }) => {
    const targetPath = writeProjectFile(project, "original.md", before);
    await openReview(page, request, { targetPath });
    await page.getByTestId("revision-more").tap();
    await page.getByTestId("revision-save-as").tap();
    const destination = `${project}/saved-copy.md`;
    await page.getByTestId("revision-output").fill(destination);
    await page.getByTestId("revision-save-confirm").tap();
    await expect(page.getByTestId("revision-path")).toHaveText(destination);
    await expect(page.getByTestId("revision-file-status")).toHaveText("Saved");
    expect(fs.readFileSync(destination, "utf8")).toBe(before);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(before);
  });

  test("a short phone viewport keeps file-choice inputs and save actions reachable @smoke", async ({
    page,
    request,
  }) => {
    const folder = "a-long-descriptive-directory-name-for-a-shared-review";
    const beforePath = writeProjectFile(
      project,
      `${folder}/before-a-long-descriptive-document-name.md`,
      before,
    );
    const afterPath = writeProjectFile(
      project,
      `${folder}/after-a-long-descriptive-document-name.md`,
      after,
    );
    await openReview(page, request, { beforePath, afterPath });
    await page.getByTestId("revision-edit").tap();
    await expect(page.getByTestId("revision-base-dialog")).toBeVisible();
    await page.getByTestId("revision-base-copy").tap();
    await page.getByTestId("revision-copy-seed-new").tap();
    const destination = `${project}/mobile-copy.md`;
    const input = page.getByTestId("revision-base-path");
    await input.fill(destination);
    await page.setViewportSize({ width: 360, height: 360 });
    const dialog = page.getByTestId("revision-base-dialog");
    const bounds = await dialog.boundingBox();
    expect
      .soft(bounds?.y, "The modal top should stay inside the visible screen")
      .toBeGreaterThanOrEqual(8);
    expect
      .soft(
        (bounds?.y ?? 0) + (bounds?.height ?? 0),
        "The modal bottom should stay inside the visible screen",
      )
      .toBeLessThanOrEqual(352);
    await readableText(input);
    await touchControls(dialog);
    const confirm = page.getByTestId("revision-base-confirm");
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    await confirm.tap();
    await expect(page.getByTestId("revision-file-status")).toHaveText("Saved");
    await expect
      .poll(
        () =>
          fs.existsSync(destination) && fs.readFileSync(destination, "utf8"),
      )
      .toBe(after);
    expect(fs.readFileSync(beforePath, "utf8")).toBe(before);
    expect(fs.readFileSync(afterPath, "utf8")).toBe(after);
  });
});
