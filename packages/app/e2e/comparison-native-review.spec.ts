import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;

test("comparisons render Markdown and review changes through Roughdraft's native UI @smoke", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("comparison-native");
  const beforeText = [
    "# Agent rules",
    "",
    "## Review process",
    "",
    "- Keep **careful** reasoning.",
    "- Read [reference docs](https://example.com/reference).",
    "",
    "Use the old workflow.",
    "",
  ].join("\r\n");
  const afterText = beforeText
    .replace("**careful**", "**thorough**")
    .replace("old workflow", "new workflow");

  try {
    const targetPath = writeProjectFile(projectDir, "AGENTS.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    const changedSegments = review.segments.filter(
      (segment: { kind: string }) => segment.kind === "change",
    );
    expect(changedSegments).toHaveLength(2);
    await page.goto(`/?comparison=${review.id}`);

    // The real Roughdraft renderer must produce semantic Markdown elements;
    // printing source markers in a parallel diff surface does not satisfy this.
    await expect(
      page
        .getByTestId("comparison-native-document")
        .getByTestId("page-card-rich-text"),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-testid="comparison-native-document"] [data-testid="rich-text-editor"] h1',
      ),
    ).toHaveText("Agent rules");
    await expect(
      page.locator(
        '[data-testid="comparison-native-document"] [data-testid="rich-text-editor"] h2',
      ),
    ).toHaveText("Review process");
    await expect(
      page.locator(
        '[data-testid="comparison-native-document"] [data-testid="rich-text-editor"] ul',
      ),
    ).not.toHaveCount(0);
    await expect(
      page.locator(
        '[data-testid="comparison-native-document"] [data-testid="rich-text-editor"] li',
      ),
    ).not.toHaveCount(0);
    await expect(
      page.locator(
        '[data-testid="comparison-native-document"] [data-testid="rich-text-editor"] strong',
      ),
    ).toContainText(["thorough"]);
    await expect(
      page.locator(
        '[data-testid="comparison-native-document"] [data-testid="rich-text-editor"] a[href="https://example.com/reference"]',
      ),
    ).toContainText(["reference docs"]);
    await expect(page.getByTestId("document-review-rail")).toBeVisible();
    await expect(
      page.locator(".critic-change[data-critic-change-id]"),
    ).not.toHaveCount(0);

    const firstChangeId = changedSegments[0].id;
    const secondChangeId = changedSegments[1].id;
    await expect(
      page.getByTestId(`suggestion-thread-${firstChangeId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`suggestion-thread-${secondChangeId}`),
    ).toBeVisible();

    // Native suggestion actions save sidecar choices, not rich-editor output.
    await page
      .getByTestId(`comment-rail-${firstChangeId}-action-accept`)
      .click();
    await page
      .getByTestId(`comment-rail-${secondChangeId}-action-reject`)
      .click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    expect(readProjectFile(projectDir, "AGENTS.md")).toBe(beforeText);
    const selected = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      selected.segments.find(
        (segment: { id: string }) => segment.id === firstChangeId,
      ).decision,
    ).toBe("after");
    expect(
      selected.segments.find(
        (segment: { id: string }) => segment.id === secondChangeId,
      ).decision,
    ).toBe("before");
    await page.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText("Saved");
    expect(readProjectFile(projectDir, "AGENTS.md")).toBe(
      beforeText.replace("**careful**", "**thorough**"),
    );
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("native comparison decisions and comments remain usable on mobile", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("comparison-native-mobile");
  try {
    const beforeText = "# Mobile review\n\nUse **old wording** here.\n";
    const targetPath = writeProjectFile(projectDir, "mobile.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: {
        mode: "proposal",
        targetPath,
        afterText: beforeText.replace("old wording", "new wording"),
      },
    });
    const review = await response.json();
    const changeId = review.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?comparison=${review.id}`);
    await expect(
      page
        .getByTestId("comparison-native-document")
        .getByTestId("page-card-rich-text"),
    ).toBeVisible();
    await expect(page.getByTestId("document-review-rail")).toBeVisible();
    await expect(
      page.getByTestId(`comment-rail-${changeId}-action-accept`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`comment-rail-${changeId}-action-reply`),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByTestId(`comment-rail-${changeId}-action-accept`).click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    await expect(page.getByTestId("comparison-apply")).toBeEnabled();
    expect(readProjectFile(projectDir, "mobile.md")).toBe(beforeText);
    await page.getByTestId("comparison-show-reviewed").click();
    await expect(
      page.getByTestId(`comment-rail-${changeId}-action-reject`),
    ).toBeVisible();
    await page.getByTestId(`comment-rail-${changeId}-action-reject`).click();
    await expect(page.getByTestId("comparison-apply")).toHaveText(
      "Apply 0 changes to mobile.md",
    );
    expect(readProjectFile(projectDir, "mobile.md")).toBe(beforeText);
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("linked list changes preserve existing mixed choices and legacy feedback until an explicit native action", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("comparison-native-linked");
  try {
    const beforeText =
      "# List review\n\n- alpha old\n- beta unchanged\n- gamma old\n";
    const afterText = beforeText
      .replace("alpha old", "alpha new")
      .replace("gamma old", "gamma new");
    const targetPath = writeProjectFile(projectDir, "linked.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    const review = await response.json();
    const changes = review.segments.filter(
      (segment: { kind: string }) => segment.kind === "change",
    );
    expect(changes).toHaveLength(2);
    const seeded = await request.post(
      `${apiUrl}/api/comparisons/${review.id}/decisions`,
      {
        data: {
          revision: review.revision,
          decisions: [
            {
              id: changes[0].id,
              decision: "after",
              comment: "Preserve this earlier feedback.",
            },
            { id: changes[1].id, decision: "before" },
          ],
        },
      },
    );
    expect(seeded.ok()).toBe(true);
    await page.goto(`/?comparison=${review.id}`);
    await expect(
      page
        .getByTestId("comparison-native-document")
        .getByTestId("rich-text-editor"),
    ).toContainText("alpha new");
    await expect(
      page
        .getByTestId("comparison-native-document")
        .getByTestId("rich-text-editor"),
    ).toContainText("gamma old");
    let saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.segments.find(
        (segment: { id: string }) => segment.id === changes[0].id,
      ).decision,
    ).toBe("after");
    expect(
      saved.segments.find(
        (segment: { id: string }) => segment.id === changes[1].id,
      ).decision,
    ).toBe("before");
    await expect(page.getByTestId("comparison-linked-notice")).toContainText(
      "2 source changes appear in 1 review group",
    );
    await page.getByTestId("comparison-show-reviewed").click();
    await expect(
      page.locator('[data-suggestion-thread-container="true"]'),
    ).toHaveCount(1);
    const group = page.getByTestId(`suggestion-thread-${changes[0].id}`);
    await expect(group).toContainText("2 linked changes");
    await expect(group).toContainText("Preserve this earlier feedback.");
    const legacyId = `legacy:${changes[0].id}`;
    await page.getByTestId(`comment-rail-${legacyId}-action-edit`).click();
    await page
      .getByTestId(`comment-rail-${legacyId}-editor`)
      .fill("Earlier feedback, edited through the native thread.");
    await page
      .getByTestId(`comment-rail-${legacyId}-editor`)
      .press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    await page.reload();
    await page.getByTestId("comparison-show-reviewed").click();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Earlier feedback, edited through the native thread.",
    );
    saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.segments.find(
        (segment: { id: string }) => segment.id === changes[0].id,
      ).comment,
    ).toBe("Earlier feedback, edited through the native thread.");
    expect(
      saved.segments.find(
        (segment: { id: string }) => segment.id === changes[1].id,
      ).decision,
    ).toBe("before");
    await page
      .getByTestId(`comment-rail-${changes[0].id}-action-accept`)
      .click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.segments
        .filter((segment: { kind: string }) => segment.kind === "change")
        .every((segment: { decision: string }) => segment.decision === "after"),
    ).toBe(true);
    expect(readProjectFile(projectDir, "linked.md")).toBe(beforeText);
    await page.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText("Saved");
    expect(readProjectFile(projectDir, "linked.md")).toBe(afterText);
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("format-only changes retain native highlights and an explicit decision", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("comparison-native-format");
  try {
    const beforeText = "# Formatting\n\nKeep **these words**.\n";
    const afterText = "# Formatting\n\nKeep _these words_.\n";
    const targetPath = writeProjectFile(projectDir, "format.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    const review = await response.json();
    const changeId = review.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    await page.goto(`/?comparison=${review.id}`);
    await expect(
      page.locator(
        '[data-testid="comparison-native-document"] [data-testid="rich-text-editor"] strong',
      ),
    ).toHaveText("these words");
    await expect(
      page.locator(
        '[data-testid="comparison-native-document"] [data-testid="rich-text-editor"] em',
      ),
    ).toHaveText("these words");
    await expect(
      page.locator(".critic-change[data-critic-change-id]"),
    ).not.toHaveCount(0);
    await page.getByTestId(`comment-rail-${changeId}-action-accept`).click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    expect(readProjectFile(projectDir, "format.md")).toBe(beforeText);
    await page.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText("Saved");
    expect(readProjectFile(projectDir, "format.md")).toBe(afterText);
  } finally {
    removeMarkdownProject(projectDir);
  }
});
