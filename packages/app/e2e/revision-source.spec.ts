import fs from "node:fs";
import { expect, test } from "@playwright/test";
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

test("editing Markdown source preserves feedback through formatted view and reopening", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("revision-source");
  const original =
    "# Notes\n\nUse {~~old~>new~~} wording.\n\nRead {==guidance==}{>>Check wording<<}{#c1}\n";
  const filename = writeProjectFile(project, "notes.md", original);
  try {
    const created = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename },
    });
    await expect(created).toBeOK();
    const { id } = (await created.json()) as ComparisonReviewData;
    const read = async (): Promise<ComparisonReviewData> => {
      const response = await request.get(`${api}/${id}`);
      await expect(response).toBeOK();
      return response.json();
    };

    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute("contenteditable", "true");
    await expect(source).toContainText("{~~old~>new~~}");
    await expect(source).toContainText("Check wording");
    await source.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n\nAdded in Markdown source.");

    await expect
      .poll(async () => (await read()).draft?.markdown)
      .toContain("Added in Markdown source.");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toContain("Added in Markdown source.");
    const saved = await read();
    expect(saved.draft?.markdown).toContain("{~~old~>new~~}");
    expect(
      saved.reviewComments?.some((item) => item.content === "Check wording"),
    ).toBe(true);
    expect(fs.readFileSync(filename, "utf8")).toContain("Use old wording.");
    expect(fs.readFileSync(filename, "utf8")).not.toContain("Check wording");
    logE2eEvent("revision.source-saved", {
      reviewId: id,
      comments: saved.reviewComments?.length ?? 0,
      suggestionPreserved: saved.draft?.markdown.includes("{~~old~>new~~}"),
      cleanFileWritten: true,
    });

    await page.getByTestId("revision-format").click();
    await expect(richTextEditor(page)).toContainText(
      "Added in Markdown source.",
    );
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.reload();
    await expect(richTextEditor(page)).toContainText(
      "Added in Markdown source.",
    );
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.getByTestId("revision-format").click();
    await expect(source).toContainText("{~~old~>new~~}");
    await expect(source).toContainText("Check wording");
  } finally {
    removeMarkdownProject(project);
  }
});

for (const mode of ["read", "suggest"] as const) {
  test(`Markdown source remains read-only in ${mode} mode`, async ({
    page,
    request,
  }) => {
    const project = createMarkdownProject("revision-source-readonly");
    const original = "# Notes\n\nOriginal source.\n";
    const filename = writeProjectFile(project, "notes.md", original);
    try {
      const created = await request.post(`${api}/document`, {
        data: { targetPath: filename, autosave: filename },
      });
      await expect(created).toBeOK();
      const { id } = (await created.json()) as ComparisonReviewData;
      await page.goto(`/?comparison=${id}`);
      await page.getByTestId("revision-mode").click();
      await page.getByTestId(`revision-mode-${mode}`).click();
      await page.getByTestId("revision-format").click();
      const source = page
        .getByTestId("revision-markdown")
        .locator(".cm-content");
      await expect(source).toHaveAttribute("contenteditable", "false");
      const before = await source.innerText();
      await source.click();
      await expect(source).toBeFocused();
      await page.keyboard.type("Accidental change");
      await expect(page.getByTestId("revision-mode")).toContainText(
        mode === "read" ? "Read" : "Suggest",
      );
      await expect(source).toHaveText(before, { useInnerText: true });
      expect(fs.readFileSync(filename, "utf8")).toBe(original);
      await page.getByTestId("revision-mode").click();
      await page.getByTestId("revision-mode-edit").click();
      await expect(source).toHaveAttribute("contenteditable", "true");
    } finally {
      removeMarkdownProject(project);
    }
  });
}

test("undoing a source edit restores its YAML and comment text together", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("revision-source-history");
  const original =
    '---\ntitle: Original\n---\n\nRead {==guidance==}{>>Original comment<<}{id="c1" at="2026-01-01T00:00:00.000Z"}\n';
  const updated = original
    .replace("title: Original", "title: Revised")
    .replace("Original comment", "Revised comment");
  const filename = writeProjectFile(project, "notes.md", original);
  try {
    const created = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename },
    });
    await expect(created).toBeOK();
    const { id } = (await created.json()) as ComparisonReviewData;
    const commentText = async () => {
      const response = await request.get(`${api}/${id}`);
      await expect(response).toBeOK();
      const review = (await response.json()) as ComparisonReviewData;
      return review.reviewComments?.find((comment) => comment.id === "c1")
        ?.content;
    };
    await page.goto(`/?comparison=${id}`);
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await source.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(updated);
    await expect.poll(commentText).toBe("Revised comment");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toContain("title: Revised");
    await page.getByTestId("revision-format").click();
    await page.getByTestId("revision-undo").click();
    await expect.poll(commentText).toBe("Original comment");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toContain("title: Original");
    await page.getByTestId("revision-redo").click();
    await expect.poll(commentText).toBe("Revised comment");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toContain("title: Revised");
  } finally {
    removeMarkdownProject(project);
  }
});

test("undoing a source edit preserves rich-text edits made before entering source", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("revision-source-after-rich");
  const filename = writeProjectFile(project, "notes.md", "Original\n");
  try {
    const created = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename },
    });
    await expect(created).toBeOK();
    const { id } = (await created.json()) as ComparisonReviewData;
    await page.goto(`/?comparison=${id}`);
    await selectRichText(page, "Original");
    await page.keyboard.type("Edited");
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("Edited\n");
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await source.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText("Edited.\n");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe("Edited.\n");
    await page.getByTestId("revision-format").click();
    await page.getByTestId("revision-undo").click();
    await expect(richTextEditor(page)).toHaveText("Edited");
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("Edited\n");
    await page.getByTestId("revision-redo").click();
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe("Edited.\n");
    await page.getByTestId("revision-undo").click();
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("Edited\n");
    await page.reload();
    await expect(richTextEditor(page)).toHaveText("Edited");
  } finally {
    removeMarkdownProject(project);
  }
});

test("source-only Markdown spelling edits save exactly and survive undo and redo", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("revision-source-spelling");
  const filename = writeProjectFile(project, "notes.md", "* item\n");
  try {
    const created = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename },
    });
    await expect(created).toBeOK();
    const { id } = (await created.json()) as ComparisonReviewData;
    await page.goto(`/?comparison=${id}`);
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await source.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText("- item\n");
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("- item\n");
    await page.getByTestId("revision-format").click();
    await page.getByTestId("revision-undo").click();
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("* item\n");
    await page.getByTestId("revision-redo").click();
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("- item\n");
    await page.reload();
    await page.getByTestId("revision-format").click();
    await expect(source).toContainText("- item");
  } finally {
    removeMarkdownProject(project);
  }
});

test("source Undo after an outcome preview retains suggestions and feedback @smoke", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("revision-source-preview-history");
  const original =
    "# Notes\n\nUse {~~old~>new~~} wording.\n\nRead {==guidance==}{>>Check wording<<}{#c1}\n";
  const filename = writeProjectFile(project, "notes.md", original);
  try {
    const created = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename },
    });
    await expect(created).toBeOK();
    const { id } = (await created.json()) as ComparisonReviewData;
    const read = async (): Promise<ComparisonReviewData> => {
      const response = await request.get(`${api}/${id}`);
      await expect(response).toBeOK();
      return response.json();
    };
    await page.goto(`/?comparison=${id}`);
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await source.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\n\nWorking source edit.");
    await expect
      .poll(async () => (await read()).draft?.markdown)
      .toContain("Working source edit.");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    const baseline = await read();
    expect(baseline.reviewComments?.map((comment) => comment.content)).toEqual([
      "Check wording",
    ]);
    const baselineFile = fs.readFileSync(filename, "utf8");
    const mutations: string[] = [];
    const capture = (sent: { method(): string; url(): string }) => {
      if (sent.method() !== "GET" && sent.url().includes("/api/"))
        mutations.push(sent.url());
    };
    page.on("request", capture);
    await page.getByTestId("revision-view").click();
    await page.getByTestId("revision-view-accepted").click();
    const preview = page
      .getByTestId("revision-preview-markdown")
      .locator(".cm-content");
    await expect(preview).toHaveAttribute("contenteditable", "false");
    await expect(preview).toContainText("Use new wording.");
    await preview.click();
    await page.keyboard.press("Control+z");
    await page.getByTestId("revision-view").click();
    await page.getByTestId("revision-view-changes").click();
    await expect(source).toBeVisible();
    expect(await read()).toEqual(baseline);
    expect(fs.readFileSync(filename, "utf8")).toBe(baselineFile);
    expect(mutations).toEqual([]);
    page.off("request", capture);

    await source.focus();
    await page.keyboard.press("Control+z");
    await expect(source).not.toContainText("Working source edit.");
    await expect(source).toContainText("{~~old~>new~~}");
    await expect(source).toContainText("Check wording");
    await expect
      .poll(async () => (await read()).draft?.markdown)
      .toBe(original);
    expect((await read()).reviewComments).toEqual(baseline.reviewComments);
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toContain("Use old wording.");
    expect(fs.readFileSync(filename, "utf8")).not.toContain("Use new wording.");
    await page.getByTestId("revision-format").click();
    await page.reload();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect((await read()).reviewComments).toEqual(baseline.reviewComments);
    logE2eEvent("revision.source-preview-undo-safe", {
      reviewId: id,
      previewMutations: mutations.length,
      suggestionsPreserved: true,
      comments: baseline.reviewComments?.length ?? 0,
    });
  } finally {
    removeMarkdownProject(project);
  }
});

test("opening Markdown source does not rewrite CRLF line endings", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("revision-source-crlf");
  const original = "# Notes\r\n\r\nOriginal source.\r\n";
  const filename = writeProjectFile(project, "notes.md", original);
  try {
    const created = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename },
    });
    await expect(created).toBeOK();
    const { id } = (await created.json()) as ComparisonReviewData;
    await page.goto(`/?comparison=${id}`);
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await expect(source).toBeVisible();
    await source.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
  } finally {
    removeMarkdownProject(project);
  }
});

for (const feedback of ["reply", "edit"] as const) {
  test(`source Undo and Redo preserve a later comment ${feedback} @smoke`, async ({
    page,
    request,
  }) => {
    const project = createMarkdownProject("source-later-feedback");
    const original =
      '---\ntitle: Original\n---\n\nRead {==guidance==}{>>Original comment<<}{#c1}\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n';
    const filename = writeProjectFile(project, "notes.md", original);
    try {
      const created = await request.post(`${api}/document`, {
        data: { targetPath: filename, autosave: filename },
      });
      await expect(created).toBeOK();
      const { id } = await created.json();
      const comments = async () => {
        const response = await request.get(`${api}/${id}`);
        return (
          ((await response.json()) as ComparisonReviewData).reviewComments?.map(
            (comment) => comment.content,
          ) ?? []
        );
      };
      await page.goto(`/?comparison=${id}`);
      await page.getByTestId("revision-format").click();
      const source = page
        .getByTestId("revision-markdown")
        .locator(".cm-content");
      await source.focus();
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText(
        original.replace("title: Original", "title: Revised"),
      );
      await expect
        .poll(() => fs.readFileSync(filename, "utf8"))
        .toContain("title: Revised");
      await page.getByTestId("revision-format").click();
      await page.getByTestId("comment-thread-c1").click();
      await page.getByTestId(`comment-rail-c1-action-${feedback}`).click();
      const editor = page.getByTestId(
        `comment-rail-${feedback === "reply" ? "c2" : "c1"}-editor`,
      );
      await editor.fill("Later feedback from the UI");
      await editor.press("Control+Enter");
      await expect.poll(comments).toContain("Later feedback from the UI");
      await page.getByTestId("revision-undo").click();
      await expect
        .poll(() => fs.readFileSync(filename, "utf8"))
        .toContain("title: Original");
      await expect.poll(comments).toContain("Later feedback from the UI");
      await page.getByTestId("revision-redo").click();
      await expect
        .poll(() => fs.readFileSync(filename, "utf8"))
        .toContain("title: Revised");
      await expect.poll(comments).toContain("Later feedback from the UI");
      await page.reload();
      await expect.poll(comments).toContain("Later feedback from the UI");
    } finally {
      removeMarkdownProject(project);
    }
  });
}

test("source keyboard and header Undo and Redo share the same edit history", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("source-shared-history");
  const filename = writeProjectFile(project, "notes.md", "Original\n");
  try {
    const created = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename },
    });
    await expect(created).toBeOK();
    const { id } = (await created.json()) as ComparisonReviewData;
    await page.goto(`/?comparison=${id}`);
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await source.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText("Edited\n");
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("Edited\n");

    await source.focus();
    await page.keyboard.press("Control+z");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe("Original\n");
    await expect(page.getByTestId("revision-redo")).toBeEnabled();
    await page.getByTestId("revision-redo").click();
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("Edited\n");

    await page.getByTestId("revision-undo").click();
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe("Original\n");
    await source.focus();
    await page.keyboard.press("Control+Shift+Z");
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe("Edited\n");
    await expect(source).toContainText("Edited");
    await page.getByTestId("revision-format").click();
    await page.reload();
    await expect(richTextEditor(page)).toHaveText("Edited");
  } finally {
    removeMarkdownProject(project);
  }
});
