import fs from "node:fs";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const markdown =
  "# Toolbar review\n\nReview {++the updated wording++}{#s1} before publishing.\n\nKeep this final paragraph.\n";
const secondaryActions = [
  "revision-format",
  "revision-copy",
  "revision-download",
  "revision-reviewed",
] as const;

async function openReview(
  page: Page,
  request: APIRequestContext,
  project: string,
) {
  const filename = writeProjectFile(project, "review.md", markdown);
  const response = await request.post(`${api}/document`, {
    headers: { Connection: "close" },
    data: { targetPath: filename, autosave: "none", handoff: "chat" },
  });
  await expect(response).toBeOK();
  const { id } = await response.json();
  await page.goto(`/?comparison=${id}`);
  await expect(richTextEditor(page)).toBeVisible();
  await expect(page.getByTestId("revision-pending")).toHaveText("1");
  return filename;
}

async function expandedToolbar(page: Page) {
  const header = page.getByTestId("revision-header");
  for (const id of secondaryActions)
    await expect(header.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("revision-more")).toBeHidden();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
}

test.describe("toolbar adapts to the space available on a foldable", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  let project: string;
  test.beforeEach(() => {
    project = createMarkdownProject("adaptive-toolbar");
  });
  test.afterEach(() => removeMarkdownProject(project));

  test("unfolding exposes actions that fit and folding preserves the review @smoke", async ({
    page,
    request,
  }, testInfo) => {
    const filename = await openReview(page, request, project);
    await expect(page.getByTestId("revision-more")).toBeVisible();
    await page.getByTestId("revision-more").tap();
    await expect(page.getByTestId("revision-more-actions")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 840, height: 900 });
    const more = page.getByTestId("revision-more");
    if (await more.isVisible()) await more.tap();
    const geometry = await page.evaluate(
      (ids) => ({
        viewport: innerWidth,
        coarsePointer: matchMedia("(pointer: coarse)").matches,
        header: document
          .querySelector('[data-testid="revision-header"]')
          ?.getBoundingClientRect()
          .toJSON(),
        actions: ids.map((id) => {
          const control = document.querySelector(`[data-testid="${id}"]`);
          return { id, bounds: control?.getBoundingClientRect().toJSON() };
        }),
      }),
      [
        "revision-mode",
        "revision-view",
        "revision-undo",
        "revision-redo",
        "revision-previous-change",
        "revision-next-change",
        "revision-accept-all",
        "revision-reject-all",
        ...secondaryActions,
      ],
    );
    await testInfo.attach("unfolded-toolbar-geometry", {
      body: JSON.stringify(geometry, null, 2),
      contentType: "application/json",
    });
    if (await more.isVisible()) await page.keyboard.press("Escape");
    await expandedToolbar(page);

    await page.getByTestId("revision-format").tap();
    await expect(page.getByTestId("revision-markdown")).toContainText(
      "updated wording",
    );
    await page.getByTestId("revision-format").tap();
    await page.setViewportSize({ width: 390, height: 420 });
    await expect(page.getByTestId("revision-more")).toBeVisible();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(richTextEditor(page)).toContainText("the updated wording");
    expect(fs.readFileSync(filename, "utf8")).toBe(markdown);
    await page.setViewportSize({ width: 840, height: 900 });
    await expandedToolbar(page);
  });

  test("reviewing the last suggestion releases space for actions without a resize @smoke", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await openReview(page, request, project);
    await expect(page.getByTestId("revision-more")).toBeVisible();
    await page.getByTestId("revision-accept-all").tap();
    await expect(page.getByTestId("revision-pending")).toHaveText("");
    await expandedToolbar(page);
    await expect(richTextEditor(page)).toContainText("the updated wording");
  });
});
