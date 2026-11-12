import { expect, type Locator, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;

async function place(passage: Locator, offset: number) {
  await passage.evaluate((element, top) => {
    window.scrollBy(0, element.getBoundingClientRect().top - top);
  }, offset);
  await expect
    .poll(async () => Math.round((await passage.boundingBox())?.y ?? -10000))
    .toBe(offset);
}

test.describe("comparison version scroll round trips", () => {
  let projectDir: string;
  test.beforeEach(() => {
    projectDir = createMarkdownProject("version-scroll");
  });
  test.afterEach(() => removeMarkdownProject(projectDir));

  test("keeps the beginning of the document at the top when switching versions", async ({
    page,
    request,
  }) => {
    const body = Array.from(
      { length: 45 },
      (_, i) =>
        `Reading paragraph ${i + 1}. Shared material below the changed instructions.`,
    ).join("\n\n");
    const beforeText = `# Original instructions\n\nUse the previous instructions.\n\n${body}`;
    const targetPath = writeProjectFile(projectDir, "Beginning.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: {
        mode: "proposal",
        targetPath,
        afterText: `# Updated instructions\n\nUse the new instructions.\n\n${body}`,
      },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await expect(page.getByTestId("comparison-view-diff")).toBeVisible();
    expect(await page.evaluate(() => scrollY)).toBe(0);
    for (const view of ["before", "diff", "after", "before", "after", "diff"]) {
      await page.getByTestId(`comparison-view-${view}`).click();
      await expect
        .poll(() => page.evaluate(() => scrollY))
        .toBeLessThanOrEqual(1);
    }
    expect(readProjectFile(projectDir, "Beginning.md")).toBe(beforeText);
  });

  test("returns to a deleted passage after visiting a version where it is absent", async ({
    page,
    request,
  }) => {
    const intro = Array.from(
      { length: 12 },
      (_, i) =>
        `Context ${i + 1}. Shared text before the deleted instructions.`,
    );
    const removed = Array.from(
      { length: 30 },
      (_, i) =>
        `Removed instruction ${i + 1}. This old policy is being removed, and I am reading it to understand the change.`,
    );
    const tail = Array.from(
      { length: 55 },
      (_, i) =>
        `Continuing paragraph ${i + 1}. Shared text after the deleted instructions.`,
    );
    const beforeText = ["# Policy review", ...intro, ...removed, ...tail].join(
      "\n\n",
    );
    const afterText = ["# Policy review", ...intro, ...tail].join("\n\n");
    const targetPath = writeProjectFile(projectDir, "Deleted.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await page.getByTestId("comparison-view-before").click();
    const passage = page
      .locator('[data-testid="rich-text-editor"]:visible p')
      .filter({ hasText: removed[14] });
    await place(passage, 240);
    await page.getByTestId("comparison-view-after").click();
    await expect(
      page.getByTestId("comparison-clean-preview"),
    ).not.toContainText(removed[14]);
    await page.getByTestId("comparison-view-before").click();
    await expect(passage).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs(((await passage.boundingBox())?.y ?? -10000) - 240),
      )
      .toBeLessThanOrEqual(24);
    expect(readProjectFile(projectDir, "Deleted.md")).toBe(beforeText);
  });
  test("does not flash the top while switching versions far down the document", async ({
    page,
    request,
  }) => {
    const intro = Array.from(
      { length: 12 },
      (_, i) => `Context ${i + 1}. Shared introduction before the change.`,
    );
    const removed = Array.from(
      { length: 20 },
      (_, i) =>
        `Removed paragraph ${i + 1}. This section appears only in the original version.`,
    );
    const tail = Array.from(
      { length: 70 },
      (_, i) =>
        `Reading passage ${i + 1}. Shared text after the changed instructions.`,
    );
    const beforeText = ["# Review", ...intro, ...removed, ...tail].join("\n\n");
    const afterText = ["# Review", ...intro, ...tail].join("\n\n");
    const targetPath = writeProjectFile(projectDir, "Frames.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    const passage = page
      .locator('[data-testid="rich-text-editor"]:visible p')
      .filter({ hasText: tail[30] });
    await place(passage, 240);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(2000);
    for (const view of ["before", "diff", "after", "diff", "before"]) {
      await page.evaluate(() => {
        const state = window as typeof window & {
          versionScrollFrames: number[];
          versionScrollFrame?: number;
        };
        state.versionScrollFrames = [];
        const sample = () => {
          state.versionScrollFrames.push(scrollY);
          state.versionScrollFrame = requestAnimationFrame(sample);
        };
        state.versionScrollFrame = requestAnimationFrame(sample);
      });
      await page.getByTestId(`comparison-view-${view}`).click();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let remaining = 8;
            const frame = () =>
              --remaining ? requestAnimationFrame(frame) : resolve();
            requestAnimationFrame(frame);
          }),
      );
      const frames = await page.evaluate(() => {
        const state = window as typeof window & {
          versionScrollFrames: number[];
          versionScrollFrame?: number;
        };
        cancelAnimationFrame(state.versionScrollFrame ?? 0);
        return state.versionScrollFrames;
      });
      await test.info().attach(`${view}-scroll-frames`, {
        body: JSON.stringify(frames),
        contentType: "application/json",
      });
      // Both versions have ample content before this passage. A frame at the
      // document start is a visible flash, even if a later correction recovers.
      expect(Math.min(...frames)).toBeGreaterThan(
        await page.evaluate(() => innerHeight),
      );
    }
    expect(readProjectFile(projectDir, "Frames.md")).toBe(beforeText);
  });
  test("keeps the rendered reading column aligned across every view", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const passage =
      "The same unchanged paragraph keeps its reading column while the versions change.";
    const beforeText = `# Reading column\n\nOriginal wording.\n\n${passage}`;
    const targetPath = writeProjectFile(projectDir, "Column.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: {
        mode: "proposal",
        targetPath,
        afterText: beforeText.replace("Original wording.", "Revised wording."),
      },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    const visiblePassage = page
      .locator('[data-testid="rich-text-editor"]:visible p')
      .filter({ hasText: passage });
    await expect(visiblePassage).toBeVisible();
    const original = await visiblePassage.boundingBox();
    if (!original) throw new Error("Reading paragraph has no visible bounds");
    for (const view of ["before", "diff", "after", "diff"]) {
      await page.getByTestId(`comparison-view-${view}`).click();
      await expect
        .poll(async () =>
          Math.abs(
            ((await visiblePassage.boundingBox())?.x ?? -10000) - original.x,
          ),
        )
        .toBeLessThanOrEqual(1);
      await expect
        .poll(async () =>
          Math.abs(
            ((await visiblePassage.boundingBox())?.width ?? -10000) -
              original.width,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
    await page.getByTestId("comparison-formatted").click();
    await expect
      .poll(async () =>
        Math.abs(
          ((await visiblePassage.boundingBox())?.x ?? -10000) - original.x,
        ),
      )
      .toBeLessThanOrEqual(1);
    for (const view of ["before", "after", "diff"]) {
      await page.getByTestId(`comparison-view-${view}`).click();
      await expect
        .poll(async () =>
          Math.abs(
            ((await visiblePassage.boundingBox())?.x ?? -10000) - original.x,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
    expect(readProjectFile(projectDir, "Column.md")).toBe(beforeText);
  });

  test("keeps unchanged document headings at the same vertical position", async ({
    page,
    request,
  }) => {
    const beforeText =
      "# Shared document title\n\nOriginal wording.\n\nUnchanged closing paragraph.";
    const targetPath = writeProjectFile(projectDir, "Spacing.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: {
        mode: "proposal",
        targetPath,
        afterText: beforeText.replace("Original wording.", "Updated wording."),
      },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    const heading = page
      .locator('[data-testid="rich-text-editor"]:visible')
      .getByRole("heading", { name: "Shared document title", exact: true });
    await expect(heading).toBeVisible();
    const initial = await heading.boundingBox();
    if (!initial) throw new Error("Document title has no visible bounds");
    const initialY = initial.y;
    for (const view of ["before", "diff", "after", "diff"]) {
      await page.getByTestId(`comparison-view-${view}`).click();
      await expect
        .poll(async () =>
          Math.abs(((await heading.boundingBox())?.y ?? -10000) - initialY),
        )
        .toBeLessThanOrEqual(1);
    }
  });
});
