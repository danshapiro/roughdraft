import fs from "node:fs";
import path from "node:path";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const original =
  '# Editing notes\n\nRead {==guidance==}{>>Original comment<<}{#c1} carefully.\n\n---\ncomments:\n  c1:\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n';
let project: string;
test.beforeEach(() => {
  project = fs.mkdtempSync(
    path.resolve(import.meta.dirname, "../../../.test-tmp/persistence-"),
  );
});
test.afterEach(() => {
  removeMarkdownProject(project);
});
async function open(
  page: Page,
  request: APIRequestContext,
  markdown = original,
) {
  const filename = writeProjectFile(project, "notes.md", markdown);
  const created = await request.post(`${api}/document`, {
    data: { targetPath: filename, autosave: filename },
  });
  await expect(created).toBeOK();
  const { id } = (await created.json()) as ComparisonReviewData;
  await page.goto(`/?comparison=${id}`);
  await expect(richTextEditor(page)).toBeVisible();
  return {
    filename,
    id,
    read: async () => {
      const response = await request.get(`${api}/${id}`);
      await expect(response).toBeOK();
      return response.json() as Promise<ComparisonReviewData>;
    },
  };
}
async function replaceSource(page: Page, markdown: string) {
  await page.getByTestId("revision-format").click();
  const source = page.getByTestId("revision-markdown").locator(".cm-content");
  await source.focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(markdown);
  return source;
}

test("source comment deletion stays deleted after formatted editing and refresh", async ({
  page,
  request,
}) => {
  const { filename, read } = await open(page, request);
  const plain = "# Editing notes\n\nRead guidance carefully.\n";
  await replaceSource(page, plain);
  await expect
    .poll(async () => (await read()).reviewComments?.length ?? 0)
    .toBe(0);
  await page.getByTestId("revision-format").click();
  await selectRichText(page, "carefully");
  await page.keyboard.insertText("slowly");
  await expect
    .poll(() => fs.readFileSync(filename, "utf8"))
    .toContain("Read guidance slowly.");
  await page.reload();
  await expect(page.getByTestId("comment-thread-c1")).toHaveCount(0);
  await page.getByTestId("revision-format").click();
  await expect(page.getByTestId("revision-markdown")).not.toContainText(
    "Original comment",
  );
});

test("source-created comment keeps a later reply when its source creation is undone and redone", async ({
  page,
  request,
}) => {
  const plain = "# Editing notes\n\nRead guidance carefully.\n";
  const { read } = await open(page, request, plain);
  await replaceSource(page, original);
  await expect
    .poll(async () => (await read()).reviewComments?.length ?? 0)
    .toBe(1);
  await page.getByTestId("revision-format").click();
  await page.getByTestId("comment-thread-c1").click();
  await page.getByTestId("comment-rail-c1-action-reply").click();
  const reply = page.getByTestId("comment-rail-c2-editor");
  await reply.fill("Later reply");
  await reply.press("Control+Enter");
  await expect
    .poll(async () => (await read()).reviewComments?.map((c) => c.content))
    .toContain("Later reply");
  await page.getByTestId("revision-undo").click();
  await expect
    .poll(async () => (await read()).reviewComments?.map((c) => c.content))
    .toContain("Original comment");
  await expect
    .poll(async () => (await read()).reviewComments?.map((c) => c.content))
    .toContain("Later reply");
  await page.getByTestId("revision-redo").click();
  await expect
    .poll(async () => (await read()).reviewComments?.map((c) => c.content))
    .toContain("Later reply");
  await page.reload();
  await expect(page.getByTestId("document-review-rail")).toContainText(
    "Later reply",
  );
});

test("source edit after a UI comment edit uses its current text without restoring old feedback", async ({
  page,
  request,
}) => {
  const { read } = await open(page, request);
  await page.getByTestId("comment-thread-c1").click();
  await page.getByTestId("comment-rail-c1-action-edit").click();
  const comment = page.getByTestId("comment-rail-c1-editor");
  await comment.fill("Revised in UI");
  await comment.press("Control+Enter");
  await expect
    .poll(
      async () =>
        (await read()).reviewComments?.find((c) => c.id === "c1")?.content,
    )
    .toBe("Revised in UI");
  await page.getByTestId("revision-format").click();
  const source = page.getByTestId("revision-markdown").locator(".cm-content");
  await expect(source).toContainText("Revised in UI");
  await expect(source).not.toContainText("Original comment");
  await source.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n\nNew paragraph.");
  await expect
    .poll(async () => (await read()).draft?.markdown)
    .toContain("New paragraph.");
  await page.getByTestId("revision-format").click();
  await page.getByTestId("revision-undo").click();
  await expect
    .poll(
      async () =>
        (await read()).reviewComments?.find((c) => c.id === "c1")?.content,
    )
    .toBe("Revised in UI");
  await page.reload();
  await expect(page.getByTestId("document-review-rail")).toContainText(
    "Revised in UI",
  );
});

test("deleting a thread in formatted view removes it from Markdown source and refresh", async ({
  page,
  request,
}) => {
  const { read } = await open(page, request);
  await page.getByTestId("comment-thread-c1").click();
  await page.getByTestId("comment-rail-c1-action-delete-thread").click();
  await expect
    .poll(async () => (await read()).reviewComments?.length ?? 0)
    .toBe(0);
  await page.getByTestId("revision-format").click();
  const source = page.getByTestId("revision-markdown").locator(".cm-content");
  await expect(source).not.toContainText("Original comment");
  await source.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n\nMore notes.");
  await expect
    .poll(async () => (await read()).draft?.markdown)
    .toContain("More notes.");
  await page.reload();
  await expect
    .poll(async () => (await read()).reviewComments?.length ?? 0)
    .toBe(0);
});

test("unfinished comment text survives switching between Markdown source and formatted view", async ({
  page,
  request,
}) => {
  await open(page, request);
  await page.getByTestId("comment-thread-c1").click();
  await page.getByTestId("comment-rail-c1-action-edit").click();
  const comment = page.getByTestId("comment-rail-c1-editor");
  await comment.fill("Unfinished comment draft");
  await page.getByTestId("revision-format").click();
  await page.getByTestId("revision-format").click();
  await page.getByTestId("comment-thread-c1").click();
  await expect(comment).toBeVisible();
  await expect(comment).toHaveValue("Unfinished comment draft");
  await comment.press("Control+Enter");
  await page.reload();
  await expect(page.getByTestId("document-review-rail")).toContainText(
    "Unfinished comment draft",
  );
});

test("literal CriticMarkup closing text in a comment cannot leak into the document after refresh", async ({
  page,
  request,
}) => {
  const { filename, read } = await open(page, request);
  const literal =
    "Use the closing marker <<} in this example; keep this comment whole.";
  await page.getByTestId("comment-thread-c1").click();
  await page.getByTestId("comment-rail-c1-action-edit").click();
  const comment = page.getByTestId("comment-rail-c1-editor");
  await comment.fill(literal);
  await comment.press("Control+Enter");
  await expect
    .poll(
      async () =>
        (await read()).reviewComments?.find((c) => c.id === "c1")?.content,
    )
    .toBe(literal);
  await page.getByTestId("revision-format").click();
  await page.getByTestId("revision-format").click();
  await page.reload();
  await expect(richTextEditor(page)).toHaveText(
    "Editing notesRead guidance carefully.",
  );
  await page.getByTestId("comment-thread-c1").click();
  await expect(page.getByTestId("document-review-rail")).toContainText(literal);
  await selectRichText(page, "carefully");
  await page.keyboard.insertText("slowly");
  await expect
    .poll(() => fs.readFileSync(filename, "utf8"))
    .toContain("Read guidance slowly.");
  expect(fs.readFileSync(filename, "utf8")).not.toContain(
    "keep this comment whole",
  );
});

test("typing literal review markers in formatted text does not turn them into feedback after saving", async ({
  page,
  request,
}) => {
  const { filename } = await open(
    page,
    request,
    "# Literal examples\n\nReplace this sentence.\n",
  );
  const literal = "Please type {>>literal markers<<} exactly.";
  await selectRichText(page, "Replace this sentence.");
  await page.keyboard.insertText(literal);
  await expect(richTextEditor(page)).toContainText(literal);
  await expect
    .poll(() => fs.readFileSync(filename, "utf8"))
    .toContain("literal markers");
  await page.reload();
  await expect(richTextEditor(page)).toContainText(literal);
});

test("source editing an annotated code block autosaves clean code and preserves literal examples @smoke", async ({
  page,
  request,
}) => {
  const code = String.raw`const marker = "==}"; // C:\\notes`;
  const example = 'const sample = "{>>literal<<} {++added++} {~~old~>new~~}";';
  const markdown = `* Keep this source spelling\n\n\`\`\`ts\n${code}\n\`\`\`\n\n\`\`\`text\n${example}\n\`\`\`\n`;
  const { filename, read } = await open(page, request, markdown);
  await selectRichText(page, code);
  await page.getByTestId("selection-menu-action-comment").click();
  const comment = page.getByTestId("comment-rail-c1-editor");
  await comment.fill("Check the code marker");
  await comment.press("Control+Enter");
  await expect
    .poll(async () => (await read()).draft?.markdown)
    .toContain("codeAnchorEncoding: backslash");
  await page.getByTestId("revision-format").click();
  const source = page.getByTestId("revision-markdown").locator(".cm-content");
  await source.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.insertText("Updated introduction.\n\n");
  await expect.poll(() => fs.readFileSync(filename, "utf8")).toContain(code);
  await expect
    .poll(() => fs.readFileSync(filename, "utf8"))
    .toContain("Updated introduction.");
  const saved = fs.readFileSync(filename, "utf8");
  expect(saved).toContain(code);
  expect(saved).toContain("* Keep this source spelling");
  expect(saved).toContain(example);
  expect(saved).not.toContain("Check the code marker");
  expect(saved).not.toContain("codeAnchorEncoding");
  await page.getByTestId("revision-format").click();
  await page.reload();
  await expect(richTextEditor(page)).toContainText(code);
  await expect(richTextEditor(page)).toContainText(example);
  await expect(page.getByTestId("document-review-rail")).toContainText(
    "Check the code marker",
  );
});

test("an existing code-review sidecar keeps legacy feedback visible after refresh without rewriting code", async ({
  page,
  request,
}) => {
  const markdown =
    '```text\n{==C:\\notes==}{>>Legacy feedback<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}\n```\n';
  const filename = writeProjectFile(project, "notes.md", markdown);
  const created = await request.post(`${api}/document`, {
    data: { targetPath: filename, autosave: "none" },
  });
  await expect(created).toBeOK();
  const review = (await created.json()) as ComparisonReviewData;
  const saved = await request.post(`${api}/${review.id}/draft`, {
    data: {
      revision: review.revision,
      markdown,
      cleanMarkdown: markdown,
      decisions: {},
      reviewComments: [
        {
          id: "c1",
          changeId: "document",
          content: "Legacy feedback",
          createdAt: "2026-01-01T00:00:00.000Z",
          authorType: "user",
        },
      ],
    },
  });
  await expect(saved).toBeOK();
  await page.goto(`/?comparison=${review.id}`);
  await expect(page.getByTestId("document-review-rail")).toContainText(
    "Legacy feedback",
  );
  await page.reload();
  await expect(page.getByTestId("document-review-rail")).toContainText(
    "Legacy feedback",
  );
  await expect(richTextEditor(page)).toContainText(
    "{==C:\\notes==}{>>Legacy feedback<<}",
  );
  expect(fs.readFileSync(filename, "utf8")).toBe(markdown);
});
