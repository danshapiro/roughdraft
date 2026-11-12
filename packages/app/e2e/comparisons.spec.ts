import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;

test.describe("file comparisons", () => {
  let projectDir: string;
  test.beforeEach(() => {
    projectDir = createMarkdownProject("comparisons");
  });
  test.afterEach(() => removeMarkdownProject(projectDir));

  test("persists mixed proposal choices without writing until Apply @smoke", async ({
    page,
    request,
  }) => {
    const beforeText =
      "# Rules\r\nOld first.\r\n\r\nSame context.\r\n\r\nOld second.";
    const afterText =
      "# Rules\r\nNew first.\r\n\r\nSame context.\r\n\r\nNew second.";
    const targetPath = writeProjectFile(projectDir, "AGENTS.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await expect(page.getByTestId("comparison-mode")).toHaveText(
      "Proposed changes",
    );
    await expect(page.getByTestId("comparison-apply")).toBeDisabled();
    const changes = page.getByTestId("comparison-change");
    await expect(changes).toHaveCount(2);
    await changes.nth(0).getByTestId("comparison-choice-after").click();
    await changes.nth(1).getByTestId("comparison-choice-before").click();
    await changes
      .nth(0)
      .getByTestId("comparison-change-comment")
      .fill("Keep the first improvement.");
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    expect(readProjectFile(projectDir, "AGENTS.md")).toBe(beforeText);
    await page.reload();
    await expect(
      changes.nth(0).getByTestId("comparison-choice-after"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      changes.nth(1).getByTestId("comparison-choice-before"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      changes.nth(0).getByTestId("comparison-change-comment"),
    ).toHaveValue("Keep the first improvement.");
    await expect(page.getByTestId("comparison-apply")).toHaveText(
      "Apply 1 change to AGENTS.md",
    );
    await page.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText("Saved");
    await expect(page.getByTestId("comparison-explanation")).toContainText(
      "Your selected changes were saved",
    );
    expect(readProjectFile(projectDir, "AGENTS.md")).toBe(
      beforeText.replace("Old first.", "New first."),
    );
    await expect(page.getByTestId("page-card-rich")).toHaveCount(0);
  });

  test("Keep/Revert selections only write the chosen reversions at the end @smoke", async ({
    page,
    request,
  }) => {
    const beforeText = "# Rules\nOld first.\n\nSame context.\n\nOld second.\n";
    const afterText = beforeText
      .replace("Old first.", "New first.")
      .replace("Old second.", "New second.");
    const targetPath = writeProjectFile(projectDir, "applied.md", afterText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "applied", targetPath, beforeText },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await expect(page.getByTestId("comparison-mode")).toHaveText(
      "Changes already made",
    );
    const changes = page.getByTestId("comparison-change");
    await expect(
      changes.nth(0).getByTestId("comparison-choice-after"),
    ).toHaveText("Keep");
    await expect(
      changes.nth(0).getByTestId("comparison-choice-before"),
    ).toHaveText("Revert");
    await changes.nth(0).getByTestId("comparison-choice-after").click();
    await changes.nth(1).getByTestId("comparison-choice-before").click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    expect(readProjectFile(projectDir, "applied.md")).toBe(afterText);
    await page.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText("Saved");
    expect(readProjectFile(projectDir, "applied.md")).toBe(
      afterText.replace("New second.", "Old second."),
    );
  });

  test("comparison finishes without writing and conversion requires an explicit destination", async ({
    page,
    request,
  }) => {
    const beforeText = "# Original\n";
    const afterText = "# Alternative\n";
    const targetPath = writeProjectFile(projectDir, "compare.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "compare", beforeText, afterText },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await expect(page.getByTestId("comparison-choice-after")).toHaveCount(0);
    await expect(page.getByTestId("comparison-apply")).toHaveCount(0);
    await page.getByTestId("comparison-propose").click();
    await expect(page.getByTestId("comparison-convert-submit")).toBeDisabled();
    await page.getByTestId("comparison-convert-target").fill(targetPath);
    await page.getByTestId("comparison-convert-submit").click();
    await expect(page.getByTestId("comparison-mode")).toHaveText(
      "Proposed changes",
    );
    expect(readProjectFile(projectDir, "compare.md")).toBe(beforeText);
    await page.getByTestId("comparison-complete").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText(
      "No file was written",
    );
    expect(readProjectFile(projectDir, "compare.md")).toBe(beforeText);
  });

  test("external edits block Apply and refresh visibly resets changed blocks", async ({
    page,
    request,
  }) => {
    const targetPath = writeProjectFile(
      projectDir,
      "conflict.md",
      "# Before\n",
    );
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText: "# Proposed\n" },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await page.getByTestId("comparison-accept-all").click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    fs.writeFileSync(targetPath, "# Someone else's edit\n");
    await page.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-conflict")).toBeVisible();
    await expect(page.getByTestId("comparison-choice-after")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(readProjectFile(projectDir, "conflict.md")).toBe(
      "# Someone else's edit\n",
    );
    await page.getByTestId("comparison-refresh").click();
    await expect(page.getByTestId("comparison-refresh-notice")).toBeVisible();
    await expect(page.getByTestId("comparison-apply")).toBeDisabled();
    await expect(page.getByTestId("comparison-choice-after")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByTestId("comparison-diff")).toContainText(
      "Someone else's edit",
    );
  });
  test("comparison comments save separately and Finish comparison never writes", async ({
    page,
    request,
  }) => {
    const beforePath = writeProjectFile(projectDir, "before.md", "# Before\n");
    const afterPath = writeProjectFile(projectDir, "after.md", "# After\n");
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "compare", beforePath, afterPath },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await page
      .getByTestId("comparison-change-comment")
      .fill("Discuss this alternative.");
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    await page.getByTestId("comparison-complete").click();
    await expect(page.getByTestId("comparison-outcome")).toContainText(
      "No file was written",
    );
    expect(readProjectFile(projectDir, "before.md")).toBe("# Before\n");
    expect(readProjectFile(projectDir, "after.md")).toBe("# After\n");
    const saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.segments.find(
        (segment: { kind: string }) => segment.kind === "change",
      ).comment,
    ).toBe("Discuss this alternative.");
    expect(saved.completion.fileWritten).toBe(false);
  });

  test("stale review revisions preserve local choices until explicit retry", async ({
    page,
    request,
  }) => {
    const targetPath = writeProjectFile(
      projectDir,
      "parallel.md",
      "# Before\n",
    );
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: { mode: "proposal", targetPath, afterText: "# After\n" },
    });
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await expect(page.getByTestId("comparison-mode")).toBeVisible();
    const segmentId = review.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    const external = await request.post(
      `${apiUrl}/api/comparisons/${review.id}/decisions`,
      { data: { revision: review.revision, comment: "Saved in another tab." } },
    );
    expect(external.ok()).toBe(true);
    await page.getByTestId("comparison-choice-after").click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review not saved",
    );
    await expect(page.getByTestId("comparison-choice-after")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(readProjectFile(projectDir, "parallel.md")).toBe("# Before\n");
    await page.getByTestId("comparison-retry").click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    const saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.segments.find((segment: { id: string }) => segment.id === segmentId)
        .decision,
    ).toBe("after");
    expect(saved.comment).toBe("Saved in another tab.");
    expect(readProjectFile(projectDir, "parallel.md")).toBe("# Before\n");
  });
});
