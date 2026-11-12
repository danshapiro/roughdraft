import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4317}`;
const beforeText =
  "# Preview\r\n\r\nKeep **old alpha**.\r\n\r\nUnchanged first context.\r\n\r\nChoose *old beta*.\r\n\r\nUnchanged second context.\r\n\r\nPending old gamma.";
const afterText = beforeText.replaceAll("old", "new");

test.describe("comparison version views", () => {
  let projectDir: string;
  test.beforeEach(() => {
    projectDir = createMarkdownProject("diff-toggle");
  });
  test.afterEach(() => removeMarkdownProject(projectDir));

  for (const mode of ["proposal", "applied", "compare"] as const) {
    test(`${mode} keeps frozen Before and After distinct from the selected Result without changing review or files${mode === "proposal" ? " @smoke" : ""}`, async ({
      page,
      request,
    }) => {
      const targetPath = writeProjectFile(
        projectDir,
        "instructions/AGENTS.md",
        mode === "applied" ? afterText : beforeText,
      );
      const oldPath = writeProjectFile(
        projectDir,
        "versions/old.md",
        beforeText,
      );
      const newPath = writeProjectFile(
        projectDir,
        "versions/new.md",
        afterText,
      );
      let review = await (
        await request.post(`${apiUrl}/api/comparisons`, {
          data: {
            mode,
            ...(mode === "compare" ? {} : { targetPath }),
            beforeText,
            afterText,
            beforeLabel: oldPath,
            afterLabel: newPath,
          },
        })
      ).json();
      if (mode !== "compare") {
        const changes = review.segments.filter(
          (segment: { kind: string }) => segment.kind === "change",
        );
        expect(changes).toHaveLength(3);
        review = await (
          await request.post(
            `${apiUrl}/api/comparisons/${review.id}/decisions`,
            {
              data: {
                revision: review.revision,
                decisions: [
                  {
                    id: changes[0].id,
                    decision: "before",
                    comment: "Saved feedback",
                  },
                  { id: changes[1].id, decision: "after" },
                ],
              },
            },
          )
        ).json();
      }
      const mutations: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && request.url().includes("/api/"))
          mutations.push(request.url());
      });
      await page.goto(`/?comparison=${review.id}`);
      const header = page.getByTestId("comparison-header");
      const identity = header.getByTestId("comparison-header-filename");
      if (mode === "compare") {
        await expect(identity).toContainText(oldPath);
        await expect(identity).toContainText(newPath);
      } else await expect(identity).toHaveText(targetPath);
      const diff = header.getByTestId("comparison-view-diff");
      await expect(diff).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("comparison-show-reviewed").click();
      const formatted = header.getByTestId("comparison-formatted");
      for (const literal of [false, true]) {
        if (literal) await formatted.click();
        for (const version of ["before", "after"] as const) {
          const button = header.getByTestId(`comparison-view-${version}`);
          await button.click();
          await expect(button).toHaveAttribute("aria-pressed", "true");
          await expect(diff).toHaveAttribute("aria-pressed", "false");
          const clean = page.getByTestId("comparison-clean-preview");
          const body = clean.getByTestId("rich-text-editor");
          const prefix = version === "before" ? "old" : "new";
          const other = version === "before" ? "new" : "old";
          await expect(body).toContainText(`${prefix} alpha`);
          await expect(body).toContainText(`${prefix} beta`);
          await expect(body).toContainText(`${prefix} gamma`);
          await expect(body).not.toContainText(`${other} alpha`);
          await expect(body).not.toContainText(`${other} beta`);
          await expect(body).not.toContainText(`${other} gamma`);
          if (literal) {
            await expect(body).toContainText("# Preview");
            await expect(body).toContainText(`**${prefix} alpha**`);
            await expect(body).toContainText(`*${prefix} beta*`);
          } else {
            await expect(body.getByRole("heading", { level: 1 })).toHaveText(
              "Preview",
            );
          }
          await expect(body.locator(".critic-change")).toHaveCount(0);
          await expect(body.locator(".ProseMirror")).toHaveAttribute(
            "contenteditable",
            "false",
          );
          await expect(
            page.locator('[data-testid="document-review-rail"]:visible'),
          ).toHaveCount(0);
          await expect(
            header.getByTestId("comparison-next-change"),
          ).toBeDisabled();
          await expect(
            page.getByTestId("comparison-show-reviewed"),
          ).toBeDisabled();
        }
        if (mode !== "compare") {
          await header.getByTestId("comparison-view-result").click();
          const body = page
            .getByTestId("comparison-clean-preview")
            .getByTestId("rich-text-editor");
          await expect(body).toContainText("old alpha");
          await expect(body).toContainText("new beta");
          await expect(body).toContainText("Pending new gamma.");
          await expect(body).not.toContainText("new alpha");
          await expect(body).not.toContainText("old beta");
          if (literal) await expect(body).toContainText("**old alpha**");
        } else
          await expect(
            header.getByTestId("comparison-view-result"),
          ).toHaveCount(0);
      }
      await formatted.click();
      const cleanView = header.getByTestId(
        mode === "compare" ? "comparison-view-after" : "comparison-view-result",
      );
      await cleanView.click();
      await expect(cleanView).toHaveAttribute("aria-pressed", "true");
      const preview = page.getByTestId("comparison-clean-preview");
      await expect(preview).toBeVisible();
      const editor = preview.getByTestId("rich-text-editor");
      await expect(
        preview.locator('[data-testid="rich-text-editor"] h1'),
      ).toHaveText("Preview");
      await expect(
        preview.locator('[data-testid="rich-text-editor"] strong'),
      ).toHaveText(mode === "compare" ? "new alpha" : "old alpha");
      await expect(
        preview.locator('[data-testid="rich-text-editor"] em'),
      ).toHaveText("new beta");
      await expect(editor).toContainText("Pending new gamma.");
      await expect(editor).not.toContainText("old beta");
      await expect(editor).not.toContainText("old gamma");
      await expect(editor.locator(".critic-change")).toHaveCount(0);
      await expect(editor.locator(".ProseMirror")).toHaveAttribute(
        "contenteditable",
        "false",
      );
      await expect(
        page.locator('[data-testid="document-review-rail"]:visible'),
      ).toHaveCount(0);
      await expect(header.getByTestId("comparison-next-change")).toBeDisabled();
      await expect(
        header.getByTestId("comparison-previous-change"),
      ).toBeDisabled();
      await expect(page.getByTestId("comparison-show-reviewed")).toBeDisabled();
      await page.screenshot({
        path: test.info().outputPath(`${mode}-clean-preview.png`),
      });
      await diff.click();
      await expect(diff).toHaveAttribute("aria-pressed", "true");
      await expect(preview).toHaveCount(0);
      await expect(
        page.getByTestId("comparison-show-reviewed"),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".critic-change").first()).toBeVisible();
      const saved = await (
        await request.get(`${apiUrl}/api/comparisons/${review.id}`)
      ).json();
      expect(saved).toEqual(review);
      expect(mutations).toEqual([]);
      expect(readProjectFile(projectDir, "instructions/AGENTS.md")).toBe(
        mode === "applied" ? afterText : beforeText,
      );
      expect(readProjectFile(projectDir, "versions/old.md")).toBe(beforeText);
      expect(readProjectFile(projectDir, "versions/new.md")).toBe(afterText);
    });
  }

  test("display toggles retain an unsubmitted native comment draft", async ({
    page,
    request,
  }) => {
    const targetPath = writeProjectFile(
      projectDir,
      "draft.md",
      "# Draft\n\nOriginal text.\n",
    );
    const review = await (
      await request.post(`${apiUrl}/api/comparisons`, {
        data: {
          mode: "proposal",
          targetPath,
          afterText: "# Draft\n\nChanged text.\n",
        },
      })
    ).json();
    const changeId = review.segments.find(
      (segment: { kind: string }) => segment.kind === "change",
    ).id;
    await page.goto(`/?comparison=${review.id}`);
    await page.getByTestId(`comment-rail-${changeId}-action-reply`).click();
    const editor = page.getByTestId(/^comment-rail-review-.*-editor$/);
    await editor.fill("Unsubmitted draft survives preview");
    await expect(page.getByTestId("comparison-save-status")).toHaveText(
      "Review saved separately",
    );
    const beforeToggle = await (
      await request.get(`${apiUrl}/api/comparisons/${review.id}`)
    ).json();
    const formatted = page.getByTestId("comparison-formatted");
    await formatted.click();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("Unsubmitted draft survives preview");
    for (const view of ["before", "after", "result"]) {
      await page.getByTestId(`comparison-view-${view}`).click();
      await expect(editor).toBeHidden();
    }
    await page.getByTestId("comparison-view-diff").click();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("Unsubmitted draft survives preview");
    await formatted.click();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("Unsubmitted draft survives preview");
    expect(
      await (
        await request.get(`${apiUrl}/api/comparisons/${review.id}`)
      ).json(),
    ).toEqual(beforeToggle);
    await editor.press(
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
    );
    await expect
      .poll(async () => {
        const saved = await (
          await request.get(`${apiUrl}/api/comparisons/${review.id}`)
        ).json();
        return saved.reviewComments.some(
          (comment: { content: string }) =>
            comment.content === "Unsubmitted draft survives preview",
        );
      })
      .toBe(true);
    expect(readProjectFile(projectDir, "draft.md")).toBe(
      "# Draft\n\nOriginal text.\n",
    );
  });

  test("full long paths and the view selector stay visible in the mobile sticky header", async ({
    page,
    request,
  }) => {
    const relativePath = `${"long-directory/".repeat(5)}a-very-long-unbroken-filename-to-prove-the-path-wraps-without-truncation.md`;
    const targetPath = writeProjectFile(
      projectDir,
      relativePath,
      beforeText.repeat(8),
    );
    const review = await (
      await request.post(`${apiUrl}/api/comparisons`, {
        data: { mode: "proposal", targetPath, afterText: afterText.repeat(8) },
      })
    ).json();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?comparison=${review.id}`);
    const header = page.getByTestId("comparison-header");
    const identity = header.getByTestId("comparison-header-filename");
    await expect(identity).toHaveText(targetPath);
    await expect(identity).toHaveCSS("white-space", "normal");
    await expect(identity).toHaveCSS("text-overflow", "clip");
    await page.evaluate(() =>
      window.scrollTo(0, document.body.scrollHeight / 2),
    );
    await expect
      .poll(async () => Math.round((await header.boundingBox())?.y ?? -1))
      .toBe(0);
    await header.getByTestId("comparison-view-after").click();
    for (const view of ["before", "diff", "after", "result"])
      await expect(header.getByTestId(`comparison-view-${view}`)).toBeVisible();
    await expect(header.getByTestId("comparison-apply")).toBeVisible();
    expect(
      await identity.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("mobile-full-path-preview.png"),
    });
    expect(readProjectFile(projectDir, relativePath)).toBe(
      beforeText.repeat(8),
    );
  });
});
