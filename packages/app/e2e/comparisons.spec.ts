import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;

async function leaveNativeReply(page: Page, changeId: string, content: string) {
  await page.getByTestId(`comment-rail-${changeId}-action-reply`).click();
  const editor = page.getByTestId(/^comment-rail-review-.*-editor$/);
  await editor.fill(content);
  await editor.press(
    process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
  );
  await expect(page.getByTestId("document-review-rail")).toContainText(content);
  await expect(page.getByTestId("comparison-save-status")).toHaveText(
    "Review saved separately",
  );
}

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
    const [first, second] = review.segments.filter(
      (segment: { kind: string }) => segment.kind === "change",
    );
    await page.goto(`/?comparison=${review.id}`);
    await expect(page.getByTestId("comparison-mode")).toHaveText(
      "Proposed changes",
    );
    await expect(page.getByTestId("comparison-apply")).toBeDisabled();
    await expect(
      page.locator('[data-suggestion-thread-container="true"]'),
    ).toHaveCount(2);
    await leaveNativeReply(page, first.id, "Keep the first improvement.");
    const feedback = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    const firstReply = feedback.reviewComments.find(
      (comment: { content: string }) =>
        comment.content === "Keep the first improvement.",
    );
    await leaveNativeReply(
      page,
      firstReply.id,
      "A nested follow-up stays attached.",
    );
    await page.getByTestId(`comment-rail-${first.id}-action-accept`).click();
    await page.getByTestId(`comment-rail-${second.id}-action-reject`).click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    expect(readProjectFile(projectDir, "AGENTS.md")).toBe(beforeText);
    await page.reload();
    const saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.segments.find((segment: { id: string }) => segment.id === first.id)
        .decision,
    ).toBe("after");
    expect(
      saved.segments.find((segment: { id: string }) => segment.id === second.id)
        .decision,
    ).toBe("before");
    expect(
      saved.reviewComments.map(
        (comment: { content: string }) => comment.content,
      ),
    ).toContain("Keep the first improvement.");
    expect(
      saved.reviewComments.find(
        (comment: { content: string }) =>
          comment.content === "A nested follow-up stays attached.",
      ).parentCommentId,
    ).toBe(firstReply.id);
    await page.getByTestId("comparison-show-reviewed").click();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Keep the first improvement.",
    );
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "A nested follow-up stays attached.",
    );
    await expect(
      page.getByTestId(`suggestion-thread-${first.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`suggestion-thread-${second.id}`),
    ).toBeVisible();
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
    await expect(page.getByTestId("page-card-rich-text")).toBeVisible();
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
    const [first, second] = review.segments.filter(
      (segment: { kind: string }) => segment.kind === "change",
    );
    await page.goto(`/?comparison=${review.id}`);
    await expect(page.getByTestId("comparison-mode")).toHaveText(
      "Changes already made",
    );
    await expect(
      page.getByTestId(`comment-rail-${first.id}-action-accept`),
    ).toHaveAttribute("aria-label", "Keep");
    await expect(
      page.getByTestId(`comment-rail-${first.id}-action-reject`),
    ).toHaveAttribute("aria-label", "Revert");
    await page.getByTestId(`comment-rail-${first.id}-action-accept`).click();
    await page.getByTestId(`comment-rail-${second.id}-action-reject`).click();
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
    await expect(
      page.getByTestId(/^comment-rail-.*-action-(accept|reject)$/),
    ).toHaveCount(0);
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
    const segmentId = review.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    await page.goto(`/?comparison=${review.id}`);
    await page.getByTestId("comparison-accept-all").click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    fs.writeFileSync(targetPath, "# Someone else's edit\n");
    await page.getByTestId("comparison-apply").click();
    await expect(page.getByTestId("comparison-conflict")).toBeVisible();
    const saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.segments.find((segment: { id: string }) => segment.id === segmentId)
        .decision,
    ).toBe("after");
    expect(readProjectFile(projectDir, "conflict.md")).toBe(
      "# Someone else's edit\n",
    );
    await page.getByTestId("comparison-refresh").click();
    await expect(page.getByTestId("comparison-refresh-notice")).toBeVisible();
    await expect(page.getByTestId("comparison-apply")).toBeDisabled();
    await expect(page.getByTestId("comparison-toolbar")).toContainText(
      "1 undecided",
    );
    await expect(page.getByTestId("rich-text-editor")).toContainText(
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
    const segmentId = review.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    await page.goto(`/?comparison=${review.id}`);
    await leaveNativeReply(page, segmentId, "Discuss this alternative.");
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
      saved.reviewComments.map(
        (comment: { content: string }) => comment.content,
      ),
    ).toContain("Discuss this alternative.");
    expect(saved.completion.fileWritten).toBe(false);
    await page.reload();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Discuss this alternative.",
    );
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
    await page.getByTestId(`comment-rail-${segmentId}-action-accept`).click();
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review not saved",
    );
    await expect(page.getByTestId("comparison-toolbar")).toContainText(
      "0 undecided",
    );
    await expect(page.getByTestId("comparison-apply")).toBeDisabled();
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
  test("refreshed comparisons retain editable native feedback after its source change disappears @smoke", async ({
    page,
    request,
  }) => {
    const beforeText = "# Feedback\r\n\r\nOriginal wording.\r\n";
    const targetPath = writeProjectFile(projectDir, "detached.md", beforeText);
    const response = await request.post(`${apiUrl}/api/comparisons`, {
      data: {
        mode: "proposal",
        targetPath,
        afterText: beforeText.replace("Original wording.", "Proposed wording."),
      },
    });
    expect(response.status()).toBe(201);
    const review = await response.json();
    const originalChangeId = review.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    await page.goto(`/?comparison=${review.id}`);
    await leaveNativeReply(
      page,
      originalChangeId,
      "Please retain this feedback if the file changes.",
    );
    let saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    const rootComment = saved.reviewComments.find(
      (comment: { content: string }) =>
        comment.content === "Please retain this feedback if the file changes.",
    );
    await leaveNativeReply(
      page,
      rootComment.id,
      "The original reply should remain attached.",
    );
    saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    const originalReply = saved.reviewComments.find(
      (comment: { content: string }) =>
        comment.content === "The original reply should remain attached.",
    );
    expect(originalReply.parentCommentId).toBe(rootComment.id);
    expect(readProjectFile(projectDir, "detached.md")).toBe(beforeText);

    const currentText =
      "# A different current file\r\n\r\nNewer external content, without a final newline.";
    fs.writeFileSync(targetPath, currentText);
    await expect(page.getByTestId("comparison-conflict")).toBeVisible();
    await page.getByTestId("comparison-refresh").click();
    await expect(page.getByTestId("comparison-refresh-notice")).toBeVisible();
    saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.segments.some(
        (segment: { id: string }) => segment.id === originalChangeId,
      ),
    ).toBe(false);

    const detachedThread = page.getByTestId(`comment-thread-${rootComment.id}`);
    await expect(detachedThread).toBeVisible();
    await expect(detachedThread).toContainText(
      "Please retain this feedback if the file changes.",
    );
    await expect(detachedThread).toContainText(
      "The original reply should remain attached.",
    );
    await detachedThread.click();
    await page
      .getByTestId(`comment-rail-${rootComment.id}-action-edit`)
      .click();
    const editor = page.getByTestId(`comment-rail-${rootComment.id}-editor`);
    await editor.fill(
      "Edited through the native document feedback thread after refresh.",
    );
    await editor.press(
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
    );
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    await leaveNativeReply(
      page,
      originalReply.id,
      "A new nested reply after the anchor disappeared.",
    );
    expect(readProjectFile(projectDir, "detached.md")).toBe(currentText);

    await page.reload();
    const reloadedThread = page.getByTestId(`comment-thread-${rootComment.id}`);
    await expect(reloadedThread).toBeVisible();
    await expect(reloadedThread).toContainText(
      "Edited through the native document feedback thread after refresh.",
    );
    await expect(reloadedThread).toContainText(
      "The original reply should remain attached.",
    );
    await expect(reloadedThread).toContainText(
      "A new nested reply after the anchor disappeared.",
    );
    saved = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    expect(
      saved.reviewComments.find(
        (comment: { id: string }) => comment.id === originalReply.id,
      ).parentCommentId,
    ).toBe(rootComment.id);
    expect(
      saved.reviewComments.find(
        (comment: { content: string }) =>
          comment.content ===
          "A new nested reply after the anchor disappeared.",
      ).parentCommentId,
    ).toBe(originalReply.id);
    expect(
      saved.reviewComments.find(
        (comment: { id: string }) => comment.id === rootComment.id,
      ).changeId,
    ).toBe(originalChangeId);
    expect(readProjectFile(projectDir, "detached.md")).toBe(currentText);
    await expect(page.getByTestId("comparison-apply")).toBeDisabled();
  });
});
