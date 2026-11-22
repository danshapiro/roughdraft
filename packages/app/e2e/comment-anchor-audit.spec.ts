import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const annotated =
  '# Notes\n\nAlpha {==bravo charlie==}{>>First comment<<}{id="c1" by="user" at="2026-11-21T12:00:00.000Z"} delta echo.\n';

async function selectText(page: Page, text: string) {
  await richTextEditor(page).focus();
  await page.evaluate((value) => {
    const editor = document.querySelector(".ProseMirror");
    if (!editor) throw new Error("Missing editor");
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      nodes.push(current as Text);
      current = walker.nextNode();
    }
    const all = nodes.map((node) => node.data).join("");
    const start = all.indexOf(value);
    if (start < 0) throw new Error(`Missing text ${value}`);
    const range = document.createRange();
    let offset = 0;
    for (const node of nodes) {
      if (start >= offset && start < offset + node.length) {
        range.setStart(node, start - offset);
      }
      const end = start + value.length;
      if (end > offset && end <= offset + node.length) {
        range.setEnd(node, end - offset);
        break;
      }
      offset += node.length;
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  }, text);
  // Native selectionchange processing and ProseMirror's DOM observer settle
  // before the next keyboard operation; a user-created selection has this gap.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function anchorText(page: Page, id: string) {
  return richTextEditor(page)
    .locator(".comment-anchor[data-comment-ids]")
    .evaluateAll(
      (spans, commentId) =>
        spans
          .filter((span) =>
            JSON.parse(span.getAttribute("data-comment-ids") ?? "[]").includes(
              commentId,
            ),
          )
          .map((span) => span.textContent)
          .join(""),
      id,
    );
}

async function addComment(
  page: Page,
  selectedText: string,
  id: string,
  comment: string,
) {
  await selectText(page, selectedText);
  await page.getByTestId("selection-menu-action-comment").click();
  await page.getByTestId(`comment-rail-${id}-editor`).fill(comment);
  await page.getByTestId(`comment-rail-${id}-action-save`).click();
}

test.describe("comment anchors through document editing", () => {
  let project: string;
  test.beforeEach(() => {
    project = createMarkdownProject("anchor-audit");
  });
  test.afterEach(() => {
    removeMarkdownProject(project);
  });

  async function open(
    page: Page,
    request: APIRequestContext,
    markdown = annotated,
  ) {
    const targetPath = writeProjectFile(project, "notes.md", markdown);
    const response = await request.post(`${api}/document`, {
      data: { targetPath, autosave: "none" },
    });
    expect(response.ok()).toBe(true);
    const review = await response.json();
    await page.goto(`/?comparison=${review.id}`);
    await expect(richTextEditor(page)).toBeVisible();
    return review.id as string;
  }

  for (const width of [1440, 390]) {
    test.describe(`comment pointer at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 }, hasTouch: width === 390 });
      for (const mode of ["document", "native-file"] as const) {
        test(`first click on an inactive bold comment places the editing caret at ${width}px in ${mode} @smoke`, async ({
          page,
          request,
        }) => {
          const markdown =
            "# Notes\n\n" +
            Array.from(
              { length: 24 },
              (_, index) => `Unchanged context paragraph ${index + 1}.\n\n`,
            ).join("") +
            'Alpha {==**bravo charlie**==}{>>First comment<<}{id="c1" by="user" at="2026-11-21T12:00:00.000Z"} delta.\n\nFooter stays unchanged.\n';
          if (mode === "document") await open(page, request, markdown);
          else {
            const filename = writeProjectFile(project, "native.md", markdown);
            await openMarkdownFile(page, filename);
            await page.getByTestId("document-mode-trigger").click();
            await page.getByTestId("document-mode-editing").click();
          }
          const footer = richTextEditor(page).getByText(
            "Footer stays unchanged.",
            { exact: true },
          );
          await footer.click();
          await page.keyboard.press("End");
          await page.mouse.move(0, 0);
          const anchor = richTextEditor(page).getByText("bravo charlie", {
            exact: true,
          });
          if (width === 390) await anchor.tap({ position: { x: 25, y: 8 } });
          else await anchor.click({ position: { x: 25, y: 8 } });
          const selection = await page.evaluate(() => ({
            text: window.getSelection()?.anchorNode?.textContent,
            offset: window.getSelection()?.anchorOffset,
            focused: document.activeElement?.getAttribute("contenteditable"),
          }));
          logE2eEvent("comment.first-click-selection", {
            width,
            mode,
            ...selection,
          });
          await page.keyboard.type("CLICK ");
          await expect(footer).toHaveText("Footer stays unchanged.");
          expect(await anchorText(page, "c1")).toContain("CLICK ");
          await expect(page.getByTestId("comment-thread-c1")).toContainText(
            "First comment",
          );
        });
      }
    });
  }

  test("adding an overlapping comment keeps the original anchor's exact range @smoke", async ({
    page,
    request,
  }) => {
    await open(page, request);
    expect(await anchorText(page, "c1")).toBe("bravo charlie");
    await addComment(page, "charlie delta", "c2", "Second overlapping comment");
    expect(await anchorText(page, "c1")).toBe("bravo charlie");
    expect(await anchorText(page, "c2")).toBe("charlie delta");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    await page.reload();
    await expect(richTextEditor(page)).toBeVisible();
    expect(await anchorText(page, "c1")).toBe("bravo charlie");
    expect(await anchorText(page, "c2")).toBe("charlie delta");
  });

  test("replying to an outer comment preserves a nested comment's anchor", async ({
    page,
    request,
  }) => {
    await open(page, request);
    await addComment(page, "charlie", "c2", "Nested comment");
    expect(await anchorText(page, "c2")).toBe("charlie");
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-reply").click();
    await page
      .getByTestId("comment-rail-c3-editor")
      .fill("Reply to first comment");
    await page.getByTestId("comment-rail-c3-action-save").click();
    expect(await anchorText(page, "c1")).toBe("bravo charlie");
    expect(await anchorText(page, "c2")).toBe("charlie");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    await page.reload();
    await expect(richTextEditor(page)).toBeVisible();
    expect(await anchorText(page, "c2")).toBe("charlie");
  });

  test("editing before and inside an anchor preserves it through Undo and Redo", async ({
    page,
    request,
  }) => {
    await open(page, request);
    await selectText(page, "Alpha");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("Before ");
    expect(await anchorText(page, "c1")).toBe("bravo charlie");
    await selectText(page, "bravo");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("old ");
    expect(await anchorText(page, "c1")).toBe("bold ravo charlie");
    await page.getByTestId("revision-undo").click();
    expect(await anchorText(page, "c1")).toBe("bravo charlie");
    await page.getByTestId("revision-redo").click();
    expect(await anchorText(page, "c1")).toBe("bold ravo charlie");
  });

  test("comments across formatting and paragraph boundaries survive a reload", async ({
    page,
    request,
  }) => {
    await open(
      page,
      request,
      "# Notes\n\nOne **bold phrase** and its ending.\n\nSecond paragraph stays in the selection.\n",
    );
    await addComment(
      page,
      "bold phrase and its ending.Second paragraph",
      "c1",
      "Cross-block comment",
    );
    expect(await anchorText(page, "c1")).toBe(
      "bold phrase and its ending.Second paragraph",
    );
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    await page.reload();
    await expect(richTextEditor(page)).toBeVisible();
    expect(await anchorText(page, "c1")).toBe(
      "bold phrase and its ending.Second paragraph",
    );
    await expect(page.getByTestId("comment-thread-c1")).toContainText(
      "Cross-block comment",
    );
    await expect(page.getByTestId("comment-thread-c1")).toHaveCount(1);
  });

  test("pasting over every commented word keeps the comment on the pasted text", async ({
    page,
    request,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, request);
    await page.evaluate(() =>
      navigator.clipboard.writeText("Pasted replacement"),
    );
    await selectText(page, "bravo charlie");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+V" : "Control+V",
    );
    await expect(richTextEditor(page)).toContainText(
      "Alpha Pasted replacement delta echo.",
    );
    expect(await anchorText(page, "c1")).toBe("Pasted replacement");
    await page.getByTestId("revision-undo").click();
    expect(await anchorText(page, "c1")).toBe("bravo charlie");
  });

  test("replacing all commented words keeps the comment on the replacement", async ({
    page,
    request,
  }) => {
    await open(page, request);
    await selectText(page, "bravo charlie");
    await page.keyboard.type("replacement words");
    await expect(richTextEditor(page)).toContainText(
      "Alpha replacement words delta echo.",
    );
    expect(await anchorText(page, "c1")).toBe("replacement words");
    await page.getByTestId("revision-undo").click();
    expect(await anchorText(page, "c1")).toBe("bravo charlie");
  });
});
