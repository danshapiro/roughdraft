import { expect, type Locator, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;

async function markerTop(editor: Locator, marker: string) {
  return editor.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.textContent?.indexOf(text) ?? -1;
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        return range.getBoundingClientRect().top;
      }
      node = walker.nextNode();
    }
    throw new Error(`Reading passage not found: ${text}`);
  }, marker);
}

async function readAt(editor: Locator, marker: string, offset: number) {
  const top = await markerTop(editor, marker);
  await editor.evaluate(
    (_element, distance) => window.scrollBy(0, distance),
    top - offset,
  );
  await expect
    .poll(async () => Math.abs((await markerTop(editor, marker)) - offset))
    .toBeLessThanOrEqual(1);
}

async function expectReadingPlace(
  editor: Locator,
  marker: string,
  offset: number,
) {
  await expect
    .poll(async () => Math.abs((await markerTop(editor, marker)) - offset))
    .toBeLessThanOrEqual(24);
}

test.describe("comparison Markdown view", () => {
  let projectDir: string;
  test.beforeEach(() => {
    projectDir = createMarkdownProject("markdown-view");
  });
  test.afterEach(() => removeMarkdownProject(projectDir));

  test("shows literal Markdown with native review controls and clean selected source @smoke", async ({
    page,
    request,
  }) => {
    const beforeText = [
      "# Source preview",
      "Shared **bold emphasis** remains.",
      "Choose old alpha.",
      "- First **list item**.\n- Second item.",
      "Choose old beta.",
      '[Reference](https://example.com/reference "Reference title")',
      "Pending old gamma.",
    ].join("\r\n\r\n");
    const afterText = beforeText
      .replace("Choose old alpha.", "Choose new alpha.")
      .replace("Choose old beta.", "Choose new beta.")
      .replace("Pending old gamma.", "Pending new gamma.");
    const targetPath = writeProjectFile(projectDir, "AGENTS.md", beforeText);
    const created = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    expect(created.status()).toBe(201);
    let review = await created.json();
    const changes = review.segments.filter(
      (segment: { kind: string }) => segment.kind === "change",
    );
    expect(changes).toHaveLength(3);
    review = await (
      await request.post(`${apiUrl}/api/comparisons/${review.id}/decisions`, {
        data: {
          revision: review.revision,
          decisions: [
            { id: changes[0].id, decision: "before" },
            { id: changes[1].id, decision: "after" },
          ],
        },
      })
    ).json();
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/"))
        mutations.push(request.url());
    });
    await page.goto(`/?comparison=${review.id}`);
    const header = page.getByTestId("comparison-header");
    const formatted = header.getByTestId("comparison-formatted");
    const editor = page.locator('[data-testid="rich-text-editor"]:visible');
    await expect(formatted).toHaveAttribute("aria-pressed", "true");
    await expect(formatted).toHaveText("Markdown");
    await expect(editor.getByRole("heading", { level: 1 })).toHaveText(
      "Source preview",
    );
    await formatted.click();
    await expect(formatted).toHaveAttribute("aria-pressed", "false");
    await expect(formatted).toHaveText("Formatted");
    await expect(editor).toContainText("# Source preview");
    await expect(editor).toContainText("Shared **bold emphasis** remains.");
    await expect(editor).toContainText("- First **list item**.");
    await expect(editor).toContainText(
      '[Reference](https://example.com/reference "Reference title")',
    );
    await expect(editor.getByRole("heading")).toHaveCount(0);
    await expect(
      page.locator('[data-testid="rich-text-editor"]:visible strong'),
    ).toHaveCount(0);
    await expect(editor.locator(".ProseMirror")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await expect(editor.locator(".critic-change").first()).toBeVisible();
    await expect(page.getByTestId("document-review-rail")).toBeVisible();
    for (const action of ["accept", "reject", "reply"]) {
      await expect(
        page.getByTestId(`comment-rail-${changes[2].id}-action-${action}`),
      ).toBeEnabled();
    }
    await page.screenshot({
      path: test.info().outputPath("markdown-native-review.png"),
    });
    await header.getByTestId("comparison-show-diffs").click();
    await expect(editor).toContainText("# Source preview");
    await expect(editor).toContainText("Choose old alpha.");
    await expect(editor).toContainText("Choose new beta.");
    await expect(editor).toContainText("Pending new gamma.");
    await expect(editor).not.toContainText("Choose new alpha.");
    await expect(editor.locator(".critic-change")).toHaveCount(0);
    await expect(
      page.locator('[data-testid="document-review-rail"]:visible'),
    ).toHaveCount(0);
    await formatted.click();
    await expect(editor.getByRole("heading", { level: 1 })).toHaveText(
      "Source preview",
    );
    await expect(
      page.locator('[data-testid="rich-text-editor"]:visible strong').first(),
    ).toHaveText("bold emphasis");
    await header.getByTestId("comparison-show-diffs").click();
    await expect(editor.locator(".critic-change").first()).toBeVisible();
    expect(mutations).toEqual([]);
    expect(
      await (
        await request.get(`${apiUrl}/api/comparisons/${review.id}`)
      ).json(),
    ).toEqual(review);
    expect(readProjectFile(projectDir, "AGENTS.md")).toBe(beforeText);
  });

  test("keeps the current passage across formatted, Markdown and clean-source views", async ({
    page,
    request,
  }) => {
    const passages = Array.from(
      { length: 70 },
      (_, index) =>
        `Reading source marker ${index + 1}. This unchanged passage has **bold emphasis** and a [reference](https://example.com/reference/${index + 1}).`,
    );
    const beforeText = [
      "# Long formatted review",
      "Use old wording.",
      ...passages,
    ].join("\n\n");
    const targetPath = writeProjectFile(projectDir, "Review.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: {
        mode: "proposal",
        targetPath,
        afterText: beforeText.replace("old wording", "new wording"),
      },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/?comparison=${review.id}`);
    const header = page.getByTestId("comparison-header");
    const formatted = header.getByTestId("comparison-formatted");
    await expect(formatted).toBeVisible();
    const editor = page.locator('[data-testid="rich-text-editor"]:visible');
    const offset = 240;
    const first = "Reading source marker 24.";
    const later = "Reading source marker 43.";
    await readAt(editor, first, offset);
    await formatted.click();
    await expect(formatted).toHaveAttribute("aria-pressed", "false");
    await expectReadingPlace(editor, first, offset);
    await readAt(editor, later, offset);
    await header.getByTestId("comparison-show-diffs").click();
    await expectReadingPlace(editor, later, offset);
    await header.getByTestId("comparison-show-diffs").click();
    await expectReadingPlace(editor, later, offset);
    await formatted.click();
    await expect(formatted).toHaveAttribute("aria-pressed", "true");
    await expectReadingPlace(editor, later, offset);
    expect(
      await (
        await request.get(`${apiUrl}/api/comparisons/${review.id}`)
      ).json(),
    ).toEqual(review);
    expect(readProjectFile(projectDir, "Review.md")).toBe(beforeText);
  });
});
