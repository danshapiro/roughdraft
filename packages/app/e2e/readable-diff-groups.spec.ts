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
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };
const original = "Use outdated and undersized equipment.\n";
const final = "Use modernized and appropriately-sized machinery.\n";
// These IDs were persisted for this paragraph before readable grouping existed.
const atomicIds = [
  "reference-5-13-1mcanwzwel81m",
  "reference-18-28-3vixkxv408xfa",
  "reference-29-38-3phs0msn43d4h",
];

async function readReview(request: APIRequestContext, id: string) {
  const response = await request.get(`${api}/${id}`, { headers });
  await expect(response).toBeOK();
  return (await response.json()) as ComparisonReviewData;
}

async function saved(page: Page) {
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    "Saved to file",
  );
}

test.describe("readable groups of nearby prose edits", () => {
  let project: string;
  test.beforeEach(() => {
    project = createMarkdownProject("readable-diff-groups");
  });
  test.afterEach(() => removeMarkdownProject(project));

  async function createComparison(request: APIRequestContext) {
    const beforePath = writeProjectFile(project, "original.md", original);
    const afterPath = writeProjectFile(project, "final.md", final);
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
    const { id, revision } = (await response.json()) as ComparisonReviewData;
    return { id, revision, afterPath };
  }

  test("one Revert restores a complete dense passage, and Undo survives unfolding @smoke", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { id, afterPath } = await createComparison(request);
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(
      page.getByTestId(/^comment-rail-.*-action-reject$/),
    ).toHaveCount(1);

    await page
      .getByTestId(`comment-rail-${atomicIds[0]}-action-reject`)
      .click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect(richTextEditor(page)).toHaveText(original.trim());
    await saved(page);
    await expect.poll(() => fs.readFileSync(afterPath, "utf8")).toBe(original);

    await page.setViewportSize({ width: 840, height: 900 });
    await page.getByTestId("revision-undo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(richTextEditor(page)).toContainText("modernized");
    await saved(page);
    await expect.poll(() => fs.readFileSync(afterPath, "utf8")).toBe(final);
    logE2eEvent("readable-diff-groups.revert-undo", { id });
  });

  test("Keep persists every group member, and reopening after refresh restores one decision", async ({
    page,
    request,
  }) => {
    const { id, afterPath } = await createComparison(request);
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page
      .getByTestId(`comment-rail-${atomicIds[0]}-action-accept`)
      .click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await saved(page);
    await expect
      .poll(async () => (await readReview(request, id)).draft?.decisions)
      .toEqual(Object.fromEntries(atomicIds.map((id) => [id, "kept"])));

    await page.reload();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await page.getByTestId("revision-reviewed").click();
    const history = page.getByTestId("revision-reviewed-dialog");
    await expect(history.getByTestId("revision-reopen-change")).toHaveCount(1);
    await history.getByTestId("revision-reopen-change").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page
      .getByTestId(`comment-rail-${atomicIds[0]}-action-reject`)
      .click();
    await saved(page);
    await expect.poll(() => fs.readFileSync(afterPath, "utf8")).toBe(original);
    await page.getByTestId("revision-undo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await saved(page);
    await expect.poll(() => fs.readFileSync(afterPath, "utf8")).toBe(final);
    logE2eEvent("readable-diff-groups.keep-reopened", { id });
  });

  test("old word decisions stay kept and a later member's comment follows the remaining group", async ({
    page,
    request,
  }) => {
    const { id, revision, afterPath } = await createComparison(request);
    const note = "Retain this comment on the grouped passage.";
    const seeded = await request.post(`${api}/${id}/draft`, {
      headers,
      data: {
        revision,
        markdown: final,
        cleanMarkdown: final,
        decisions: { [atomicIds[0]]: "kept" },
        reviewComments: [
          {
            id: "legacy-note",
            changeId: atomicIds[2],
            parentCommentId: atomicIds[2],
            content: note,
            createdAt: "2026-11-21T00:00:00.000Z",
            authorType: "user",
          },
        ],
      },
    });
    await expect(seeded).toBeOK();

    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    const group = page.getByTestId(`suggestion-thread-${atomicIds[1]}`);
    await expect(group).toContainText(note);
    await expect(
      page.getByTestId(`comment-rail-${atomicIds[0]}-action-reject`),
    ).toHaveCount(0);
    await page.reload();
    await expect(group).toContainText(note);
    await page
      .getByTestId(`comment-rail-${atomicIds[1]}-action-reject`)
      .click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await saved(page);
    await expect
      .poll(() => fs.readFileSync(afterPath, "utf8"))
      .toBe("Use modernized and undersized equipment.\n");
    expect((await readReview(request, id)).draft?.decisions).toEqual({
      [atomicIds[0]]: "kept",
    });
    logE2eEvent("readable-diff-groups.legacy-comment-retained", { id });
  });
});
