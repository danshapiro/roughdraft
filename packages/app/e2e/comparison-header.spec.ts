import fs from "node:fs";
import { expect, type Locator, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;

async function expectBelowHeader(anchor: Locator, header: Locator) {
  await expect
    .poll(async () => {
      const [target, bar] = await Promise.all([
        anchor.boundingBox(),
        header.boundingBox(),
      ]);
      return target && bar ? Math.round(target.y - bar.y - bar.height) : -1;
    })
    .toBeGreaterThanOrEqual(8);
  await expect
    .poll(async () => {
      const [target, bar] = await Promise.all([
        anchor.boundingBox(),
        header.boundingBox(),
      ]);
      return target && bar ? Math.round(target.y - bar.y - bar.height) : 1000;
    })
    .toBeLessThanOrEqual(24);
}

function longVersions() {
  const paragraphs = ["# Long review"];
  for (let section = 1; section <= 4; section++) {
    for (let paragraph = 1; paragraph <= 18; paragraph++) {
      paragraphs.push(
        `Context ${section}.${paragraph}: This unchanged paragraph gives the rendered document enough room for reviewing changes while scrolling.`,
      );
    }
    if (section < 4) paragraphs.push(`Use old wording ${section} here.`);
  }
  const beforeText = paragraphs.join("\r\n\r\n");
  return {
    beforeText,
    afterText: beforeText.replaceAll("Use old wording", "Use new wording"),
  };
}

test.describe("compact comparison header", () => {
  let projectDir: string;
  test.beforeEach(() => {
    projectDir = createMarkdownProject("comparison-header");
  });
  test.afterEach(() => removeMarkdownProject(projectDir));

  test("stays at the top, navigates native changes, and applies exact selected bytes @smoke", async ({
    page,
    request,
  }) => {
    const { beforeText, afterText } = longVersions();
    const targetPath = writeProjectFile(projectDir, "AGENTS.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    const changes = review.segments.filter(
      (segment: { kind: string }) => segment.kind === "change",
    );
    expect(changes).toHaveLength(3);
    await page.goto(`/?comparison=${review.id}`);
    const header = page.getByTestId("comparison-header");
    await expect(header).toBeVisible();
    await expect(header).toHaveCSS("position", "sticky");
    await expect(header.getByTestId("comparison-header-filename")).toHaveText(
      targetPath,
    );
    await expect(
      header.getByTestId("comparison-header-filename"),
    ).toHaveAttribute("title", targetPath);
    await expect(header.getByTestId("comparison-remaining")).toHaveText(
      "3 left",
    );
    await expect(header.getByTestId("comparison-apply")).toBeDisabled();
    await expect(page.getByTestId("comparison-apply")).toHaveCount(1);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect
      .poll(async () => Math.round((await header.boundingBox())?.y ?? -100))
      .toBe(0);
    expect(Math.round((await header.boundingBox())?.width ?? 0)).toBe(
      await page.evaluate(() => window.innerWidth),
    );
    await header.getByTestId("comparison-next-change").click();
    await expect(
      header.getByTestId("comparison-navigation-position"),
    ).toHaveText("1 / 3");
    await expectBelowHeader(
      page.locator(`[data-critic-change-id="${changes[0].id}"]`).first(),
      header,
    );
    await header.getByTestId("comparison-next-change").click();
    await expect(
      header.getByTestId("comparison-navigation-position"),
    ).toHaveText("2 / 3");
    await expectBelowHeader(
      page.locator(`[data-critic-change-id="${changes[1].id}"]`).first(),
      header,
    );
    await page.screenshot({
      path: test.info().outputPath("header-desktop.png"),
    });
    await header.getByTestId("comparison-previous-change").click();
    await expect(
      header.getByTestId("comparison-navigation-position"),
    ).toHaveText("1 / 3");
    await expectBelowHeader(
      page.locator(`[data-critic-change-id="${changes[0].id}"]`).first(),
      header,
    );

    await page
      .getByTestId(`comment-rail-${changes[0].id}-action-accept`)
      .click();
    await page
      .getByTestId(`comment-rail-${changes[1].id}-action-reject`)
      .click();
    await page
      .getByTestId(`comment-rail-${changes[2].id}-action-accept`)
      .click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    await expect(header.getByTestId("comparison-remaining")).toHaveText(
      "0 left",
    );
    expect(readProjectFile(projectDir, "AGENTS.md")).toBe(beforeText);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(header.getByTestId("comparison-apply")).toBeVisible();
    await expect(header.getByTestId("comparison-apply")).toHaveText(
      "Apply 2 changes to AGENTS.md",
    );
    await header.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText("Saved");
    expect(readProjectFile(projectDir, "AGENTS.md")).toBe(
      beforeText
        .replace("Use old wording 1", "Use new wording 1")
        .replace("Use old wording 3", "Use new wording 3"),
    );
  });

  test("keeps the final action blocked when the destination changes", async ({
    page,
    request,
  }) => {
    const targetPath = writeProjectFile(
      projectDir,
      "conflict.md",
      "# Original\r\n",
    );
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText: "# Proposed\r\n" },
    });
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    const header = page.getByTestId("comparison-header");
    await page.getByTestId("comparison-accept-all").click();
    await expect(header.getByTestId("comparison-apply")).toBeEnabled();
    const external = "# Newer external version without a final newline";
    fs.writeFileSync(targetPath, external);
    await expect(header.getByTestId("comparison-header-state")).toHaveText(
      "File changed",
    );
    await expect(header.getByTestId("comparison-apply")).toBeDisabled();
    await expect(page.getByTestId("comparison-conflict")).toBeVisible();
    expect(readProjectFile(projectDir, "conflict.md")).toBe(external);
  });

  test("fits a mobile header and exposes reviewed changes for navigation", async ({
    page,
    request,
  }) => {
    const { beforeText, afterText } = longVersions();
    const targetPath = writeProjectFile(
      projectDir,
      "a-very-long-markdown-filename-for-mobile-review.md",
      beforeText,
    );
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    const review = await response.json();
    const firstChangeId = review.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?comparison=${review.id}`);
    const header = page.getByTestId("comparison-header");
    await expect(header).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(header.getByTestId("comparison-next-change")).toBeVisible();
    await expect(header.getByTestId("comparison-apply")).toBeVisible();
    await page.getByTestId("comparison-accept-all").click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    await expect(header.getByTestId("comparison-next-change")).toBeDisabled();
    await page.getByTestId("comparison-show-reviewed").click();
    await expect(header.getByTestId("comparison-next-change")).toBeEnabled();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await header.getByTestId("comparison-next-change").click();
    await expect(
      header.getByTestId("comparison-navigation-position"),
    ).toHaveText("1 / 3");
    await expect
      .poll(async () => Math.round((await header.boundingBox())?.y ?? -100))
      .toBe(0);
    await expectBelowHeader(
      page.locator(`[data-critic-change-id="${firstChangeId}"]`).first(),
      header,
    );
    await page.screenshot({
      path: test.info().outputPath("header-mobile.png"),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      readProjectFile(
        projectDir,
        "a-very-long-markdown-filename-for-mobile-review.md",
      ),
    ).toBe(beforeText);
  });
  test("keeps Revert and Propose actions explicit in the header", async ({
    page,
    request,
  }) => {
    const beforeText = "# Before\r\n";
    const afterText = "# After\r\n";
    const targetPath = writeProjectFile(projectDir, "modes.md", afterText);
    const applied = await (
      await request.post(`${apiUrl}/api/comparisons`, {
        data: { mode: "applied", targetPath, beforeText },
      })
    ).json();
    const changeId = applied.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    await page.goto(`/?comparison=${applied.id}`);
    const header = page.getByTestId("comparison-header");
    await expect(header.getByTestId("comparison-header-mode")).toHaveText(
      "Already changed",
    );
    await expect(header.getByTestId("comparison-apply")).toBeDisabled();
    await page.getByTestId(`comment-rail-${changeId}-action-reject`).click();
    await expect(header.getByTestId("comparison-apply")).toHaveText(
      "Revert 1 change in modes.md",
    );
    await expect(header.getByTestId("comparison-apply")).toBeEnabled();
    expect(readProjectFile(projectDir, "modes.md")).toBe(afterText);
    await header.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText("Saved");
    expect(readProjectFile(projectDir, "modes.md")).toBe(beforeText);

    const compare = await (
      await request.post(`${apiUrl}/api/comparisons`, {
        data: { mode: "compare", beforeText, afterText },
      })
    ).json();
    await page.goto(`/?comparison=${compare.id}`);
    await expect(header.getByTestId("comparison-header-mode")).toHaveText(
      "Compare",
    );
    await expect(header.getByTestId("comparison-remaining")).toHaveText(
      "Read only",
    );
    await expect(header.getByTestId("comparison-apply")).toHaveCount(0);
    await expect(page.getByTestId("comparison-propose")).toHaveCount(1);
    await header.getByTestId("comparison-propose").click();
    const converter = page.getByTestId("comparison-convert");
    await expect(converter).toBeVisible();
    await expect(converter).toBeInViewport();
    const [converterBox, headerBox] = await Promise.all([
      converter.boundingBox(),
      header.boundingBox(),
    ]);
    expect(converterBox?.y ?? 0).toBeGreaterThanOrEqual(
      (headerBox?.y ?? 0) + (headerBox?.height ?? 0),
    );
    await page.getByTestId("comparison-convert-target").fill(targetPath);
    await page.getByTestId("comparison-convert-submit").click();
    await expect(header.getByTestId("comparison-header-mode")).toHaveText(
      "Proposed",
    );
    await expect(header.getByTestId("comparison-apply")).toBeDisabled();
    expect(readProjectFile(projectDir, "modes.md")).toBe(beforeText);
  });
});
