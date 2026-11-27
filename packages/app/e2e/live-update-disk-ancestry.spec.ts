import fs from "node:fs";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  activeCommentDraft,
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };
const original =
  "# Garden review\n\nThe planting schedule is ready.\n\nThe lighting schedule is ready.\n";
const annotated = `# Garden review

The planting {==schedule==}{>>Check the planting dates.<<}{id="c1" by="AI" at="2026-11-22T12:00:00.000Z"} is ready.

Use {~~red~>blue~~}{id="s1" by="AI" at="2026-11-22T12:00:00.000Z"} markers.

The lighting schedule is ready.
`;

async function open(
  page: Page,
  request: APIRequestContext,
  targetPath: string,
) {
  const response = await request.post(`${api}/document`, {
    headers,
    data: { targetPath, autosave: "none", handoff: "chat" },
  });
  await expect(response).toBeOK();
  const { id } = await response.json();
  await page.goto(`/?comparison=${id}`);
  await expect(richTextEditor(page)).toBeVisible();
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    "Review saved",
  );
  return async () => {
    const response = await request.get(`${api}/${id}`, { headers });
    await expect(response).toBeOK();
    return (await response.json()) as ComparisonReviewData;
  };
}

test("saved browser prose survives an independent watched disk edit with autosave none", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("disk-ancestry-prose");
  try {
    const target = writeProjectFile(project, "practice.md", original);
    const read = await open(page, request, target);
    await selectRichText(page, "planting schedule");
    await page.keyboard.insertText("orchard schedule");
    await expect
      .poll(async () => (await read()).draft?.markdown)
      .toContain("orchard schedule");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    expect(fs.readFileSync(target, "utf8")).toBe(original);

    const disk = original.replace(
      "lighting schedule",
      "lighting and irrigation schedule",
    );
    fs.writeFileSync(target, disk);
    await expect(richTextEditor(page)).toContainText(
      "lighting and irrigation schedule",
    );
    await expect(richTextEditor(page)).toContainText("orchard schedule");
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    await expect
      .poll(async () => (await read()).draft?.markdown)
      .toContain("orchard schedule");
    await expect
      .poll(async () => (await read()).draft?.markdown)
      .toContain("lighting and irrigation schedule");
    await page.reload();
    await expect(richTextEditor(page)).toContainText("orchard schedule");
    await expect(richTextEditor(page)).toContainText(
      "lighting and irrigation schedule",
    );
    expect(fs.readFileSync(target, "utf8")).toBe(disk);
  } finally {
    removeMarkdownProject(project);
  }
});

test("deleted imported feedback and a kept proposal stay resolved after later watched disk edits and reload", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("disk-ancestry-feedback");
  try {
    const target = writeProjectFile(project, "practice.md", annotated);
    const read = await open(page, request, target);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-delete-thread").click();
    await expect
      .poll(async () => (await read()).reviewComments?.length ?? 0)
      .toBe(0);
    await page.getByTestId("comment-rail-s1-action-accept").click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect(richTextEditor(page)).toContainText("Use blue markers.");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    expect(fs.readFileSync(target, "utf8")).toBe(annotated);

    for (const lighting of [
      "lighting and irrigation",
      "lighting, irrigation and paths",
    ]) {
      const disk = annotated.replace(
        "lighting schedule",
        `${lighting} schedule`,
      );
      fs.writeFileSync(target, disk);
      await expect(richTextEditor(page)).toContainText(`${lighting} schedule`);
      await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
      await expect(page.getByTestId("comment-thread-c1")).toHaveCount(0);
      await expect(page.getByTestId("revision-pending")).toBeEmpty();
      await expect(richTextEditor(page)).toContainText("Use blue markers.");
      await expect
        .poll(async () => (await read()).reviewComments?.length ?? 0)
        .toBe(0);
      await expect
        .poll(async () => (await read()).draft?.markdown)
        .toContain(`${lighting} schedule`);
      await page.reload();
      await expect(richTextEditor(page)).toContainText(`${lighting} schedule`);
      await expect(page.getByTestId("comment-thread-c1")).toHaveCount(0);
      await expect(page.getByTestId("revision-pending")).toBeEmpty();
      await expect(richTextEditor(page)).toContainText("Use blue markers.");
      expect(fs.readFileSync(target, "utf8")).toBe(disk);
    }
  } finally {
    removeMarkdownProject(project);
  }
});

for (const feedback of ["comment", "suggestion"] as const) {
  test(`an agent rewrite detaches a saved browser-only ${feedback} without a false writing conflict`, async ({
    page,
    request,
  }) => {
    const project = createMarkdownProject(`disk-ancestry-browser-${feedback}`);
    try {
      const target = writeProjectFile(project, "practice.md", original);
      const read = await open(page, request, target);
      await selectRichText(page, "planting schedule");
      if (feedback === "comment") {
        await page.getByTestId("selection-menu-action-comment").click();
        const { editor } = await activeCommentDraft(page);
        await editor.fill("Check the review-only planting dates.");
        await editor.press("Control+Enter");
        await expect
          .poll(async () =>
            (await read()).reviewComments?.map((c) => c.content),
          )
          .toContain("Check the review-only planting dates.");
      } else {
        await page.getByTestId("revision-mode").click();
        await page.getByTestId("revision-mode-suggest").click();
        await selectRichText(page, "planting schedule");
        await page.keyboard.insertText("orchard schedule");
        await expect
          .poll(async () => (await read()).draft?.markdown)
          .toContain("orchard");
      }
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        "Review saved",
      );
      expect(fs.readFileSync(target, "utf8")).toBe(original);
      const disk = original.replace(
        "The planting schedule is ready.",
        "The agent rewrote the planting plan.",
      );
      fs.writeFileSync(target, disk);
      await expect(richTextEditor(page)).toContainText(
        "The agent rewrote the planting plan.",
      );
      await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
      if (feedback === "comment") {
        await expect
          .poll(async () => (await read()).reviewComments)
          .toEqual([
            expect.objectContaining({
              content: "Check the review-only planting dates.",
              scope: "document",
              originalQuote: "planting schedule",
              detachedReason: expect.any(String),
            }),
          ]);
      } else {
        await expect
          .poll(async () => (await read()).draft?.outdatedSuggestions)
          .toEqual([
            expect.objectContaining({
              originalText: "planting",
              proposedText: "orchard",
              reason: expect.any(String),
            }),
          ]);
        await expect(page.getByTestId("revision-pending")).toBeEmpty();
      }
      await page.reload();
      await expect(richTextEditor(page)).toContainText(
        "The agent rewrote the planting plan.",
      );
      await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
      expect(fs.readFileSync(target, "utf8")).toBe(disk);
    } finally {
      removeMarkdownProject(project);
    }
  });
}
