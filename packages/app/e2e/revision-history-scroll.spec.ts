import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const passagePrefix = "The reviewed passage says";
const passage = `${passagePrefix} use red markers for the final inspection.`;
const paragraphs = (count: number, label: string) =>
  Array.from(
    { length: count },
    (_, index) =>
      `${label} section ${index + 1}. This unchanged paragraph provides enough reading distance to place the reviewed passage outside the current viewport.`,
  ).join("\n\n");
const original = `# A long review\n\n${paragraphs(30, "Earlier")}\n\n${passage}\n\n${paragraphs(10, "Later")}\n`;
const revised = original.replace("red markers", "blue markers");

const reviewedPassage = (page: Page) =>
  richTextEditor(page)
    .getByRole("paragraph")
    .filter({ hasText: passagePrefix });

async function passagePosition(page: Page, target = reviewedPassage(page)) {
  const passage = await target.boundingBox();
  const header = await page.getByTestId("revision-header").boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  if (!passage || !header) throw new Error("The document passage disappeared");
  const headerBottom = header.y + header.height;
  return {
    top: passage.y,
    bottom: passage.y + passage.height,
    headerBottom,
    viewportHeight: height,
    visible: passage.y >= headerBottom && passage.y + passage.height <= height,
  };
}

async function openHistory(page: Page) {
  const historyButton = page.getByTestId("revision-reviewed");
  if (!(await historyButton.isVisible()))
    await page.getByTestId("revision-more").click();
  await historyButton.click();
  return page.getByTestId("revision-reviewed-dialog");
}

for (const { decision, width } of [
  { decision: "Keep", width: 1440 },
  { decision: "Revert", width: 390 },
] as const) {
  test(`History scrolls a reopened ${decision} passage into view at ${width}px @smoke`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(45_000);
    const project = createMarkdownProject("history-scroll");
    try {
      await page.setViewportSize({ width, height: 844 });
      const beforePath = writeProjectFile(project, "original.md", original);
      const afterPath = writeProjectFile(project, "revised.md", revised);
      const response = await request.post(api, {
        headers: { Connection: "close" },
        data: {
          editor: "unified",
          mode: "compare",
          beforePath,
          afterPath,
          autosave: "none",
          handoff: "chat",
        },
      });
      await expect(response).toBeOK();
      const { id } = await response.json();
      await page.goto(`/?comparison=${id}`);
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      await page
        .getByTestId(
          decision === "Keep"
            ? /^comment-rail-.*-action-accept$/
            : /^comment-rail-.*-action-reject$/,
        )
        .click();
      await expect(page.getByTestId("revision-pending")).toBeEmpty();
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        "Review saved",
      );
      await page.reload();
      await expect(page.getByTestId("revision-pending")).toBeEmpty();
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      const before = await passagePosition(page);
      expect(before.top).toBeGreaterThan(before.viewportHeight * 2);

      const history = await openHistory(page);
      await expect(history).toContainText(
        decision === "Keep" ? "Accepted" : "Rejected",
      );
      await history.getByTestId("revision-reopen-change").click();
      await expect(history).toBeHidden();
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      try {
        // Actual geometry catches dialog focus restoration undoing a scroll.
        await expect
          .poll(async () => {
            const position = await passagePosition(page);
            return position.visible ? "visible" : JSON.stringify(position);
          })
          .toBe("visible");
      } finally {
        logE2eEvent("revision-history-scroll.reopened", {
          id,
          decision,
          width,
          before,
          after: await passagePosition(page),
        });
        await page.screenshot({
          path: testInfo.outputPath("after-reopening.png"),
        });
      }
    } finally {
      removeMarkdownProject(project);
    }
  });
}

test("History reveals a reopened native suggestion after unfolding @smoke", async ({
  page,
  request,
}, testInfo) => {
  const project = createMarkdownProject("history-native-scroll");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const targetPath = writeProjectFile(
      project,
      "suggestions.md",
      original.replace("red markers", "{~~red~>blue~~} markers"),
    );
    const response = await request.post(`${api}/document`, {
      data: { targetPath, autosave: "none", handoff: "chat" },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.getByTestId(/^comment-rail-.*-action-reject$/).click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    await page.setViewportSize({ width: 840, height: 900 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    const before = await passagePosition(page);
    expect(before.top).toBeGreaterThan(before.viewportHeight * 2);
    const history = await openHistory(page);
    await history.getByTestId("revision-reopen-change").click();
    await expect(history).toBeHidden();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect
      .poll(async () => {
        const position = await passagePosition(page);
        return position.visible ? "visible" : JSON.stringify(position);
      })
      .toBe("visible");
    logE2eEvent("revision-history-scroll.native-reopened", {
      id,
      before,
      after: await passagePosition(page),
    });
    await page.screenshot({ path: testInfo.outputPath("native-reopened.png") });
  } finally {
    removeMarkdownProject(project);
  }
});

test("History reveals reopened YAML fields from the bottom of a long document @smoke", async ({
  page,
  request,
}, testInfo) => {
  const project = createMarkdownProject("history-metadata-scroll");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const beforePath = writeProjectFile(
      project,
      "original.md",
      `---\ntitle: Original title\n---\n\n${original}`,
    );
    const afterPath = writeProjectFile(
      project,
      "revised.md",
      `---\ntitle: Updated title\n---\n\n${original}`,
    );
    const response = await request.post(api, {
      data: {
        editor: "unified",
        mode: "compare",
        beforePath,
        afterPath,
        autosave: "none",
        handoff: "chat",
      },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.getByTestId(/^comment-rail-.*-action-accept$/).click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
    );
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
    const history = await openHistory(page);
    await history.getByTestId("revision-reopen-change").click();
    await expect(history).toBeHidden();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    const fields = richTextEditor(page).getByTestId("yaml-frontmatter");
    await expect
      .poll(async () => {
        const position = await passagePosition(page, fields);
        return position.visible ? "visible" : JSON.stringify(position);
      })
      .toBe("visible");
    logE2eEvent("revision-history-scroll.metadata-reopened", {
      id,
      after: await passagePosition(page, fields),
    });
    await page.screenshot({
      path: testInfo.outputPath("metadata-reopened.png"),
    });
  } finally {
    removeMarkdownProject(project);
  }
});
