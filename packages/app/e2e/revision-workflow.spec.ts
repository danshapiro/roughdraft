import fs from "node:fs";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };
const keep = /^comment-rail-.*-action-accept$/;
const revert = /^comment-rail-.*-action-reject$/;
const beforeText =
  "# Rules\n\nUse red markers.\n\nKeep the door open.\n\nDisplay the original sign.\n";
const afterText = beforeText.replace("red", "blue").replace("open", "shut");

async function readReview(request: APIRequestContext, id: string) {
  const response = await request.get(`${api}/${id}`, { headers });
  await expect(response).toBeOK();
  return (await response.json()) as ComparisonReviewData;
}

async function saved(page: Page) {
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    /^(Saved to file|Review saved)$/,
  );
}

async function chooseMode(page: Page, name: "Read" | "Edit" | "Suggest") {
  await page.getByTestId("revision-mode").click();
  await page.getByTestId(`revision-mode-${name.toLowerCase()}`).click();
  await expect(page.getByTestId("revision-mode")).toContainText(name);
}

async function chooseView(
  page: Page,
  name: "Changes" | "All rejected" | "All accepted",
) {
  const ids = {
    Changes: "changes",
    "All rejected": "rejected",
    "All accepted": "accepted",
  };
  await page.getByTestId("revision-view").click();
  await page.getByTestId(`revision-view-${ids[name]}`).click();
}

async function openReviewedChanges(page: Page) {
  const button = page.getByTestId("revision-reviewed");
  if (
    !(await button.isVisible()) &&
    (await page.getByTestId("revision-more").isVisible())
  )
    await page.getByTestId("revision-more").click();
  await button.click();
  return page.getByTestId("revision-reviewed-dialog");
}

test.describe("complete unified review workflows", () => {
  let project: string;
  test.beforeEach(() => {
    project = createMarkdownProject("revision-workflow");
  });
  test.afterEach(() => removeMarkdownProject(project));

  async function openDocument(page: Page, request: APIRequestContext) {
    const filename = writeProjectFile(project, "notes.md", beforeText);
    const response = await request.post(`${api}/document`, {
      headers,
      data: { targetPath: filename, autosave: filename, handoff: "chat" },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toContainText("Use red markers.");
    return { id: id as string, filename };
  }

  async function openComparison(page: Page, request: APIRequestContext) {
    const beforePath = writeProjectFile(project, "before.md", beforeText);
    const afterPath = writeProjectFile(project, "after.md", afterText);
    const response = await request.post(api, {
      headers,
      data: {
        editor: "unified",
        mode: "compare",
        beforePath,
        afterPath,
        autosave: afterPath,
        handoff: "chat",
      },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    return { id: id as string, beforePath, afterPath };
  }

  test("Suggest survives refresh and unfolding, so the next edit stays a suggestion @smoke", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { id, filename } = await openDocument(page, request);
    await chooseMode(page, "Suggest");
    await page.setViewportSize({ width: 840, height: 900 });
    await page.reload();
    await expect(page.getByTestId("revision-mode")).toContainText("Suggest");

    await selectRichText(page, "original");
    await page.keyboard.type("updated");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect
      .poll(async () => (await readReview(request, id)).draft?.markdown)
      .toContain("{~~original~>updated~~}");
    expect(fs.readFileSync(filename, "utf8")).toBe(beforeText);
    logE2eEvent("revision-workflow.suggest-restored", { id });
  });

  test("Read keeps formatted text and the autosaved file unchanged when typing", async ({
    page,
    request,
  }) => {
    const { id, filename } = await openDocument(page, request);
    await chooseMode(page, "Read");
    await saved(page);
    await expect(richTextEditor(page)).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await richTextEditor(page).click();
    await expect(richTextEditor(page)).toBeFocused();
    await page.keyboard.type("Accidental typing");
    await expect(richTextEditor(page)).not.toContainText("Accidental typing");
    await expect(page.getByTestId("revision-mode")).toContainText("Read");
    expect(fs.readFileSync(filename, "utf8")).toBe(beforeText);
    const initial = await readReview(request, id);

    await page.reload();
    await expect(page.getByTestId("revision-mode")).toContainText("Read");
    await expect(richTextEditor(page)).toHaveAttribute(
      "contenteditable",
      "false",
    );
    expect(await readReview(request, id)).toEqual(initial);
    logE2eEvent("revision-workflow.read-restored", { id });
  });

  test("clean outcome previews include comparison changes and suggestions without saving either", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { id, beforePath, afterPath } = await openComparison(page, request);
    await chooseMode(page, "Suggest");
    await selectRichText(page, "original");
    await page.keyboard.type("updated");
    await expect(page.getByTestId("revision-pending")).toHaveText("3");
    await page.getByTestId(keep).first().click();
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await page.getByTestId(revert).first().click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await saved(page);
    const initial = await readReview(request, id);
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/"))
        mutations.push(request.url());
    });

    for (const view of ["All rejected", "All accepted"] as const) {
      await chooseView(page, view);
      const preview = page.getByTestId("revision-preview");
      const body = preview.locator(".ProseMirror");
      await expect(preview).toBeVisible();
      await expect(body).toHaveAttribute("contenteditable", "false");
      const accepted = view === "All accepted";
      await expect(body).toContainText(
        accepted ? "Use blue markers." : "Use red markers.",
      );
      await expect(body).toContainText(
        accepted ? "Keep the door shut." : "Keep the door open.",
      );
      await expect(body).toContainText(
        accepted ? "Display the updated sign." : "Display the original sign.",
      );
      await expect(body.locator(".critic-change")).toHaveCount(0);
      await body.click();
      await expect(body).toBeFocused();
      await page.keyboard.type("Accidental typing");
      await expect(body).not.toContainText("Accidental typing");
      await expect(page.getByTestId("revision-view")).toContainText(view);
      await expect(page.getByTestId("revision-accept-all")).toBeHidden();
      await expect(page.getByTestId("revision-reject-all")).toBeHidden();
      await page.setViewportSize({ width: 840, height: 900 });
    }

    await chooseView(page, "Changes");
    await expect(page.getByTestId("revision-preview")).toBeHidden();
    await expect(page.getByTestId("revision-mode")).toContainText("Suggest");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect(await readReview(request, id)).toEqual(initial);
    expect(mutations).toEqual([]);
    expect(fs.readFileSync(beforePath, "utf8")).toBe(beforeText);
    expect(fs.readFileSync(afterPath, "utf8")).toBe(
      afterText.replace("shut", "open"),
    );
    logE2eEvent("revision-workflow.previews-read-only", { id });
  });

  for (const decision of ["Keep", "Revert"] as const) {
    test(`${decision} can be revisited and changed after reopening the review`, async ({
      page,
      request,
    }) => {
      const { id, afterPath } = await openComparison(page, request);
      const accepting = decision === "Keep";
      await page
        .getByTestId(accepting ? keep : revert)
        .first()
        .click();
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      await saved(page);
      await page.reload();
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      const history = await openReviewedChanges(page);
      await expect(history).toContainText(accepting ? "Accepted" : "Rejected");
      await history.getByTestId("revision-reopen-change").click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("revision-pending")).toHaveText("2");
      await page
        .getByTestId(accepting ? revert : keep)
        .first()
        .click();
      await saved(page);
      const expected = accepting ? afterText.replace("blue", "red") : afterText;
      await expect
        .poll(() => fs.readFileSync(afterPath, "utf8"))
        .toBe(expected);
      logE2eEvent("revision-workflow.decision-reopened", { id, decision });
    });
  }

  for (const decision of ["Keep", "Revert"] as const) {
    test(`native suggestion decisions (${decision}) can be reopened after refresh`, async ({
      page,
      request,
    }) => {
      if (decision === "Revert")
        await page.setViewportSize({ width: 390, height: 844 });
      const { id, filename } = await openDocument(page, request);
      await chooseMode(page, "Suggest");
      await selectRichText(page, "original");
      await page.keyboard.type("updated");
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      const accepting = decision === "Keep";
      await page.getByTestId(accepting ? keep : revert).click();
      await expect(page.getByTestId("revision-pending")).toBeEmpty();
      await saved(page);
      await page.reload();
      const history = await openReviewedChanges(page);
      await expect(history).toContainText(accepting ? "Accepted" : "Rejected");
      await history.getByTestId("revision-reopen-change").click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      await page.getByTestId(accepting ? revert : keep).click();
      await saved(page);
      const expected = accepting
        ? beforeText
        : beforeText.replace("original", "updated");
      await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(expected);
      logE2eEvent("revision-workflow.suggestion-reopened", { id, decision });
    });
  }

  test("reopening a reviewed change is blocked when that passage was edited later", async ({
    page,
    request,
  }) => {
    const { afterPath } = await openComparison(page, request);
    await page.getByTestId(keep).first().click();
    await chooseMode(page, "Edit");
    await selectRichText(page, "blue");
    await page.keyboard.type("cyan");
    await saved(page);
    await page.reload();
    const history = await openReviewedChanges(page);
    await expect(history.getByTestId("revision-reopen-change")).toBeDisabled();
    expect(fs.readFileSync(afterPath, "utf8")).toBe(
      afterText.replace("blue", "cyan"),
    );
  });

  test("reopening after refresh preserves later edits before and after that passage", async ({
    page,
    request,
  }) => {
    const { afterPath } = await openComparison(page, request);
    await page.getByTestId(keep).first().click();
    await saved(page);
    await chooseMode(page, "Edit");
    await selectRichText(page, "Rules");
    await page.keyboard.type("Updated rules");
    await selectRichText(page, "original");
    await page.keyboard.type("custom");
    await saved(page);
    await page.reload();

    const history = await openReviewedChanges(page);
    const reopen = history.getByTestId("revision-reopen-change");
    await expect(reopen).toBeEnabled();
    await reopen.click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await page.getByTestId(revert).first().click();
    await saved(page);
    const expected = afterText
      .replace("Rules", "Updated rules")
      .replace("blue", "red")
      .replace("original", "custom");
    await expect.poll(() => fs.readFileSync(afterPath, "utf8")).toBe(expected);
  });

  test("Reject all matches its preview for overlapping changes, and both previews survive the bulk decision", async ({
    page,
    request,
  }) => {
    const { id, beforePath, afterPath } = await openComparison(page, request);
    await chooseMode(page, "Suggest");
    await selectRichText(page, "blue");
    await page.keyboard.type("green");
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await saved(page);
    const previews = new Map<string, string>();
    for (const view of ["All rejected", "All accepted"] as const) {
      await chooseView(page, view);
      const body = page.getByTestId("revision-preview").locator(".ProseMirror");
      await expect(body).toBeVisible();
      await expect(body).toContainText(
        view === "All rejected" ? "Use red markers." : "Use green markers.",
      );
      await expect(body).toContainText(
        view === "All rejected" ? "Keep the door open." : "Keep the door shut.",
      );
      previews.set(view, await body.innerText());
    }
    await chooseView(page, "Changes");
    await page.getByTestId("revision-reject-all").click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await saved(page);
    await expect
      .poll(() => fs.readFileSync(afterPath, "utf8"))
      .toBe(beforeText);
    expect(fs.readFileSync(beforePath, "utf8")).toBe(beforeText);
    const afterBulk = await readReview(request, id);
    for (const view of ["All rejected", "All accepted"] as const) {
      await chooseView(page, view);
      const body = page.getByTestId("revision-preview").locator(".ProseMirror");
      await expect(body).toHaveText(previews.get(view) ?? "", {
        useInnerText: true,
      });
      await expect(body).toHaveAttribute("contenteditable", "false");
    }
    expect(await readReview(request, id)).toEqual(afterBulk);
    expect(fs.readFileSync(afterPath, "utf8")).toBe(beforeText);
    logE2eEvent("revision-workflow.overlapping-bulk-matches-preview", { id });
  });
});
