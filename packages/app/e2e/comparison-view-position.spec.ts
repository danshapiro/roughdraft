import { expect, type Locator, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;

function versions() {
  const introduction = Array.from(
    { length: 10 },
    (_, index) => `Introduction ${index + 1}. This context is unchanged.`,
  );
  const removed = Array.from(
    { length: 20 },
    (_, index) =>
      `Removed paragraph ${index + 1}. This old material takes up space before the passage being read.`,
  );
  const passages = Array.from(
    { length: 70 },
    (_, index) =>
      `Reading marker ${index + 1}. This unchanged passage should stay in place when changing views.`,
  );
  return {
    beforeText: [
      "# Long review",
      ...introduction,
      ...removed,
      ...passages,
    ].join("\n\n"),
    afterText: ["# Long review", ...introduction, ...passages].join("\n\n"),
    firstPassage: passages[23],
    laterPassage: passages[42],
  };
}

async function placePassage(passage: Locator, offset: number) {
  await passage.evaluate((element, top) => {
    window.scrollBy(0, element.getBoundingClientRect().top - top);
  }, offset);
  await expect
    .poll(async () => Math.round((await passage.boundingBox())?.y ?? -10000))
    .toBe(offset);
}

async function expectPassagePosition(passage: Locator, offset: number) {
  await expect(passage).toBeVisible();
  await expect
    .poll(async () => {
      const box = await passage.boundingBox();
      return box ? Math.abs(box.y - offset) : 10000;
    })
    .toBeLessThanOrEqual(24);
}

test.describe("comparison display position", () => {
  let projectDir: string;
  test.beforeEach(() => {
    projectDir = createMarkdownProject("view-position");
  });
  test.afterEach(() => removeMarkdownProject(projectDir));

  for (const viewport of [
    { width: 1440, height: 1000, name: "desktop" },
    { width: 390, height: 844, name: "mobile" },
  ]) {
    test(`${viewport.name} keeps the passage in view when hiding and showing diffs${viewport.name === "desktop" ? " @smoke" : ""}`, async ({
      page,
      request,
    }) => {
      const { beforeText, afterText, firstPassage, laterPassage } = versions();
      const targetPath = writeProjectFile(projectDir, "Review.md", beforeText);
      const response = await request.post(`${apiUrl}/api/comparisons`, {
        data: { mode: "proposal", targetPath, afterText },
      });
      expect(response.status()).toBe(201);
      const review = await response.json();
      const mutations: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() !== "GET" &&
          request.url().includes("/api/comparisons")
        )
          mutations.push(request.url());
      });
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/?comparison=${review.id}`);
      const visibleParagraph = (text: string) =>
        page
          .locator('[data-testid="rich-text-editor"]:visible p')
          .filter({ hasText: text });
      const header = page.getByTestId("comparison-header");
      const toggle = header.getByTestId("comparison-show-diffs");
      await expect(toggle).toBeVisible();
      const offset = 240;
      await placePassage(visibleParagraph(firstPassage), offset);
      const originalScroll = await page.evaluate(() => window.scrollY);
      expect(originalScroll).toBeGreaterThan(1000);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expectPassagePosition(visibleParagraph(firstPassage), offset);

      // The reader can move while previewing. Restore the newly read passage,
      // rather than remembering the old scroll offset from before hiding diffs.
      await placePassage(visibleParagraph(laterPassage), offset);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expectPassagePosition(visibleParagraph(laterPassage), offset);
      await page.screenshot({
        path: test.info().outputPath(`${viewport.name}-passage-preserved.png`),
      });
      expect(mutations).toEqual([]);
      expect(
        await (
          await request.get(`${apiUrl}/api/comparisons/${review.id}`)
        ).json(),
      ).toEqual(review);
      expect(readProjectFile(projectDir, "Review.md")).toBe(beforeText);
    });
  }
});
