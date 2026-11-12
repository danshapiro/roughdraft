import {
  expect,
  type APIRequestContext,
  type Page,
  test,
} from "@playwright/test";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;

async function createProposal(
  request: APIRequestContext,
  targetPath: string,
  afterText: string,
) {
  const response = await request.post(`${apiUrl}/api/comparisons`, {
    data: { mode: "proposal", targetPath, afterText },
  });
  expect(response.status()).toBe(201);
  const review = (await response.json()) as ComparisonReviewData;
  const changes = review.segments.filter(
    (segment) => segment.kind === "change",
  );
  expect(changes).toHaveLength(1);
  return { review, changeId: changes[0].id };
}

async function nativeMarks(page: Page) {
  return page.getByTestId("rich-text-editor").evaluate((root) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        ".critic-change[data-critic-change-id]",
      ),
    ].map((element) => ({
      text: element.textContent,
      kind: element.dataset.criticChangeKind,
      id: element.dataset.criticChangeId,
    })),
  );
}

async function expectUnchangedOnce(page: Page, text: string) {
  const rendered = await page
    .getByTestId("rich-text-editor")
    .evaluate((root, expected) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let count = 0;
      let marked = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes(expected)) continue;
        count += node.textContent.split(expected).length - 1;
        marked ||= Boolean(
          node.parentElement?.closest(".critic-change[data-critic-change-id]"),
        );
      }
      return { count, marked };
    }, text);
  expect(rendered, `Unchanged content: ${text}`).toEqual({
    count: 1,
    marked: false,
  });
}

async function acceptAndApply(page: Page, changeId: string) {
  await page.getByTestId(`comment-rail-${changeId}-action-accept`).click();
  await expect(page.getByTestId("comparison-save-status")).toHaveText(
    "Review saved separately",
  );
  await page.getByTestId("comparison-apply").click();
  await expect(page.getByTestId("comparison-outcome")).toContainText("Saved");
}

test.describe("precise rendered comparison changes", () => {
  let projectDir: string;
  test.beforeEach(() => {
    projectDir = createMarkdownProject("precise-comparison");
  });
  test.afterEach(() => removeMarkdownProject(projectDir));

  test("one-word changes leave paragraph context once and unmarked while native review preserves exact source @smoke", async ({
    page,
    request,
  }) => {
    const beforeText =
      "# Precise paragraph\r\n\r\nUse careful reasoning before lunch.\r\n";
    const afterText = beforeText.replace("careful", "thorough");
    const targetPath = writeProjectFile(projectDir, "paragraph.md", beforeText);
    const { review, changeId } = await createProposal(
      request,
      targetPath,
      afterText,
    );
    await page.goto(`/?comparison=${review.id}`);
    await expect(
      page.locator('[data-testid="rich-text-editor"] p'),
    ).toHaveCount(1);
    await expectUnchangedOnce(page, "Use ");
    await expectUnchangedOnce(page, " reasoning before lunch.");
    expect(await nativeMarks(page)).toEqual([
      { text: "careful", kind: "substitution-old", id: changeId },
      { text: "thorough", kind: "substitution-new", id: changeId },
    ]);
    await expect(
      page.getByTestId(`suggestion-thread-${changeId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`suggestion-thread-${changeId}`),
    ).not.toContainText("reasoning before lunch.");
    await expect(
      page.getByTestId(`suggestion-thread-${changeId}`),
    ).toContainText("careful");
    await expect(
      page.getByTestId(`suggestion-thread-${changeId}`),
    ).toContainText("thorough");
    await page.getByTestId(`comment-rail-${changeId}-action-reply`).click();
    const replyEditor = page.getByTestId(/^comment-rail-review-.*-editor$/);
    await replyEditor.fill("Review only the changed word.");
    await replyEditor.press(
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
    );
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    expect(readProjectFile(projectDir, "paragraph.md")).toBe(beforeText);
    await page.reload();
    await expect(
      page.getByTestId(`suggestion-thread-${changeId}`),
    ).toContainText("Review only the changed word.");
    const saved = (await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json()) as ComparisonReviewData;
    expect(saved.id).toBe(review.id);
    expect(saved.segments.map((segment) => segment.id)).toEqual(
      review.segments.map((segment) => segment.id),
    );
    expect(
      saved.reviewComments?.find(
        (comment) => comment.content === "Review only the changed word.",
      )?.changeId,
    ).toBe(changeId);
    await acceptAndApply(page, changeId);
    expect(readProjectFile(projectDir, "paragraph.md")).toBe(afterText);
  });

  test("one changed list item leaves other items and surrounding words once unmarked", async ({
    page,
    request,
  }) => {
    const beforeText =
      "# Precise list\r\n\r\n- First unchanged item.\r\n- Keep old policy clear.\r\n- Last unchanged item.\r\n";
    const afterText = beforeText.replace("old", "new");
    const targetPath = writeProjectFile(projectDir, "list.md", beforeText);
    const { review, changeId } = await createProposal(
      request,
      targetPath,
      afterText,
    );
    await page.goto(`/?comparison=${review.id}`);
    await expect(
      page.locator('[data-testid="rich-text-editor"] ul'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="rich-text-editor"] li'),
    ).toHaveCount(3);
    for (const text of [
      "First unchanged item.",
      "Keep ",
      " policy clear.",
      "Last unchanged item.",
    ])
      await expectUnchangedOnce(page, text);
    expect(await nativeMarks(page)).toEqual([
      { text: "old", kind: "substitution-old", id: changeId },
      { text: "new", kind: "substitution-new", id: changeId },
    ]);
    await acceptAndApply(page, changeId);
    expect(readProjectFile(projectDir, "list.md")).toBe(afterText);
  });

  test("one changed table cell leaves unchanged cells once unmarked", async ({
    page,
    request,
  }) => {
    const beforeText =
      "# Precise table\r\n\r\n| Name | Policy |\r\n| --- | --- |\r\n| Stable alpha | old |\r\n| Stable beta | Keep steady |\r\n";
    const afterText = beforeText.replace("old", "new");
    const targetPath = writeProjectFile(projectDir, "table.md", beforeText);
    const { review, changeId } = await createProposal(
      request,
      targetPath,
      afterText,
    );
    await page.goto(`/?comparison=${review.id}`);
    await expect(
      page.locator('[data-testid="rich-text-editor"] table'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="rich-text-editor"] tr'),
    ).toHaveCount(3);
    for (const text of [
      "Name",
      "Policy",
      "Stable alpha",
      "Stable beta",
      "Keep steady",
    ])
      await expectUnchangedOnce(page, text);
    expect(await nativeMarks(page)).toEqual([
      { text: "old", kind: "substitution-old", id: changeId },
      { text: "new", kind: "substitution-new", id: changeId },
    ]);
    await acceptAndApply(page, changeId);
    expect(readProjectFile(projectDir, "table.md")).toBe(afterText);
  });

  test("format-only changes show the changed formatting without marking surrounding text", async ({
    page,
    request,
  }) => {
    const beforeText =
      "# Precise formatting\r\n\r\nKeep **these words** carefully.\r\n";
    const afterText = beforeText.replace("**these words**", "_these words_");
    const targetPath = writeProjectFile(projectDir, "format.md", beforeText);
    const { review, changeId } = await createProposal(
      request,
      targetPath,
      afterText,
    );
    await page.goto(`/?comparison=${review.id}`);
    await expect(
      page.locator('[data-testid="rich-text-editor"] p'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="rich-text-editor"] strong'),
    ).toHaveText("these words");
    await expect(
      page.locator('[data-testid="rich-text-editor"] em'),
    ).toHaveText("these words");
    await expectUnchangedOnce(page, "Keep ");
    await expectUnchangedOnce(page, " carefully.");
    expect(await nativeMarks(page)).toEqual([
      { text: "these words", kind: "substitution-old", id: changeId },
      { text: "these words", kind: "substitution-new", id: changeId },
    ]);
    await acceptAndApply(page, changeId);
    expect(readProjectFile(projectDir, "format.md")).toBe(afterText);
  });

  test("href-only changes retain both link destinations and visible review feedback", async ({
    page,
    request,
  }) => {
    const beforeText =
      "# Precise links\r\n\r\nRead [documentation](https://example.com/old) before editing.\r\n";
    const afterText = beforeText.replace("example.com/old", "example.com/new");
    const targetPath = writeProjectFile(projectDir, "links.md", beforeText);
    const { review, changeId } = await createProposal(
      request,
      targetPath,
      afterText,
    );
    await page.goto(`/?comparison=${review.id}`);
    await expect(
      page.locator('[data-testid="rich-text-editor"] p'),
    ).toHaveCount(1);
    await expect(
      page.locator(
        '[data-testid="rich-text-editor"] a[href="https://example.com/old"]',
      ),
    ).toHaveText("documentation");
    await expect(
      page.locator(
        '[data-testid="rich-text-editor"] a[href="https://example.com/new"]',
      ),
    ).toHaveText("documentation");
    await expectUnchangedOnce(page, "Read ");
    await expectUnchangedOnce(page, " before editing.");
    expect(await nativeMarks(page)).toEqual([
      { text: "documentation", kind: "substitution-old", id: changeId },
      { text: "documentation", kind: "substitution-new", id: changeId },
    ]);
    await expect(
      page.getByTestId(`suggestion-thread-${changeId}`),
    ).toContainText("https://example.com/old");
    await expect(
      page.getByTestId(`suggestion-thread-${changeId}`),
    ).toContainText("https://example.com/new");
    await acceptAndApply(page, changeId);
    expect(readProjectFile(projectDir, "links.md")).toBe(afterText);
  });
});
