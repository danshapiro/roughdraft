import fs from "node:fs";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const annotated =
  '# Comment editing\n\nRead {==this guidance==}{>>Original feedback<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}.\n\nAnother passage to review.\n';

test.describe("comment lifecycle audit", () => {
  let project: string;

  test.beforeEach(() => {
    project = createMarkdownProject("comment-lifecycle-audit");
  });

  test.afterEach(() => removeMarkdownProject(project));

  async function openDocument(
    page: Page,
    request: APIRequestContext,
    text = annotated,
  ) {
    const filename = writeProjectFile(project, "notes.md", text);
    const response = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename, handoff: "chat" },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    return { id: id as string, filename };
  }

  async function readComments(request: APIRequestContext, id: string) {
    const response = await request.get(`${api}/${id}`);
    await expect(response).toBeOK();
    const review = await response.json();
    return (review.reviewComments ?? []).map(
      (comment: { content: string }) => comment.content,
    ) as string[];
  }

  for (const width of [1440, 390]) {
    test(`Edit focuses the existing comment so typing works at ${width}px${width === 1440 ? " @smoke" : ""}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const { id, filename } = await openDocument(page, request);
      await page.getByTestId("comment-thread-c1").click();
      await page.getByTestId("comment-rail-c1-action-edit").click();
      const editor = page.getByTestId("comment-rail-c1-editor");
      await expect(editor).toBeFocused();
      await page.keyboard.press("End");
      await page.keyboard.type(" with detail");
      await page.keyboard.press("Control+Enter");
      await expect(editor).toBeHidden();
      await expect
        .poll(() => readComments(request, id))
        .toContain("Original feedback with detail");
      expect(fs.readFileSync(filename, "utf8")).toBe(annotated);
      await page.reload();
      await expect(page.getByTestId("document-review-rail")).toContainText(
        "Original feedback with detail",
      );
    });
  }

  test("Escape restores an edited comment after it autosaves", async ({
    page,
    request,
  }) => {
    const { id, filename } = await openDocument(page, request);
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-edit").click();
    const editor = page.getByTestId("comment-rail-c1-editor");
    await editor.fill("Changed feedback");
    await expect
      .poll(() => readComments(request, id))
      .toContain("Changed feedback");
    await editor.press("Escape");
    await expect(editor).toBeHidden();
    await expect
      .poll(() => readComments(request, id))
      .toContain("Original feedback");
    expect(fs.readFileSync(filename, "utf8")).toBe(annotated);
  });

  test("a canceled new reply leaves no empty comment or highlight", async ({
    page,
    request,
  }) => {
    const { id, filename } = await openDocument(page, request);
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-reply").click();
    const reply = page.getByTestId("comment-rail-c2-editor");
    await expect(reply).toBeFocused();
    await reply.fill("Do not keep this reply");
    await reply.press("Escape");
    await expect(reply).toBeHidden();
    await expect
      .poll(() => readComments(request, id))
      .not.toContain("Do not keep this reply");
    expect(fs.readFileSync(filename, "utf8")).toBe(annotated);
    await page.reload();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Original feedback",
    );
    await expect(page.getByTestId("comment-rail-c2")).toHaveCount(0);
  });

  test("a canceled new root comment does not leave review markup", async ({
    page,
    request,
  }) => {
    const plain = "# Draft\n\nA passage to review.\n";
    const { filename } = await openDocument(page, request, plain);
    await selectRichText(page, "passage");
    await page.getByTestId("selection-menu-action-comment").click();
    const editor = page.getByTestId("comment-rail-c1-editor");
    await expect(editor).toBeFocused();
    await editor.fill("A draft comment");
    await editor.press("Escape");
    await expect(editor).toBeHidden();
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(plain);
    await page.reload();
    await expect(richTextEditor(page)).toContainText("A passage to review.");
    await expect(page.getByTestId("document-review-rail")).toBeHidden();
  });

  test("editing a comment survives unfolding and Cancel still restores it", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { id, filename } = await openDocument(page, request);
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-edit").click();
    const editor = page.getByTestId("comment-rail-c1-editor");
    await editor.fill("Feedback while unfolding");
    await expect
      .poll(() => readComments(request, id))
      .toContain("Feedback while unfolding");
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect(editor).toHaveValue("Feedback while unfolding");
    await expect(editor).toBeFocused();
    await page.getByTestId("comment-rail-c1-action-cancel").click();
    await expect
      .poll(() => readComments(request, id))
      .toContain("Original feedback");
    await page.reload();
    await expect(page.getByTestId("comment-rail-c1")).toContainText(
      "Original feedback",
    );
    expect(fs.readFileSync(filename, "utf8")).toBe(annotated);
  });

  test("a multiline root comment survives Save and reload", async ({
    page,
    request,
  }) => {
    const plain = "# Draft\n\nA passage to review.\n";
    const { id, filename } = await openDocument(page, request, plain);
    await selectRichText(page, "passage");
    await page.getByTestId("selection-menu-action-comment").click();
    const editor = page.getByTestId("comment-rail-c1-editor");
    await expect(editor).toBeFocused();
    await page.keyboard.type("Keep the detail.");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(
      "Second line: café, 日本語, and an emoji 🙂.",
    );
    await page.getByTestId("comment-rail-c1-action-save").click();
    const content =
      "Keep the detail.\nSecond line: café, 日本語, and an emoji 🙂.";
    await expect.poll(() => readComments(request, id)).toEqual([content]);
    await page.reload();
    await expect(page.getByTestId("comment-rail-c1")).toContainText(content);
    expect(fs.readFileSync(filename, "utf8")).toBe(plain);
  });

  test("deleting a reply and its thread can each be undone", async ({
    page,
    request,
  }) => {
    const { id, filename } = await openDocument(page, request);
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-reply").click();
    const reply = page.getByTestId("comment-rail-c2-editor");
    await expect(reply).toBeFocused();
    await page.keyboard.type("A reply that can be restored.");
    await page.keyboard.press("Control+Enter");
    await expect
      .poll(() => readComments(request, id))
      .toEqual(["Original feedback", "A reply that can be restored."]);
    await page.getByTestId("comment-rail-c2-action-delete").click();
    await expect
      .poll(() => readComments(request, id))
      .toEqual(["Original feedback"]);
    await page.getByTestId("revision-comment-undo").click();
    await expect
      .poll(() => readComments(request, id))
      .toEqual(["Original feedback", "A reply that can be restored."]);
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-delete-thread").click();
    await expect.poll(() => readComments(request, id)).toEqual([]);
    await page.getByTestId("revision-comment-undo").click();
    await expect
      .poll(() => readComments(request, id))
      .toEqual(["Original feedback", "A reply that can be restored."]);
    await page.reload();
    await expect(page.getByTestId("comment-rail-c2")).toContainText(
      "A reply that can be restored.",
    );
    expect(fs.readFileSync(filename, "utf8")).toBe(annotated);
  });
});
