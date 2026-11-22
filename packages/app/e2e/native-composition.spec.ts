import fs from "node:fs";
import {
  type APIRequestContext,
  type CDPSession,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const compositionSessions = new WeakMap<Page, CDPSession>();

async function compositionClient(page: Page) {
  let client = compositionSessions.get(page);
  if (!client) {
    client = await page.context().newCDPSession(page);
    compositionSessions.set(page, client);
  }
  return client;
}

async function setComposition(page: Page, text: string) {
  const client = await compositionClient(page);
  await client.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

async function commitComposition(page: Page, text: string) {
  const client = await compositionClient(page);
  await client.send("Input.insertText", { text });
}

test.describe("native text composition", () => {
  let project: string;
  test.beforeEach(() => {
    project = createMarkdownProject("native-composition");
  });
  test.afterEach(() => removeMarkdownProject(project));

  async function openDocument(
    page: Page,
    request: APIRequestContext,
    text = "Alpha beta.\n",
  ) {
    const filename = writeProjectFile(project, "notes.md", text);
    const response = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename, handoff: "chat" },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    return { filename, id: id as string };
  }

  async function chooseSuggest(page: Page) {
    await page.getByTestId("revision-mode").click();
    await page.getByTestId("revision-mode-suggest").click();
  }

  async function draft(request: APIRequestContext, id: string) {
    const response = await request.get(`${api}/${id}`);
    await expect(response).toBeOK();
    return (await response.json()).draft?.markdown as string | undefined;
  }

  for (const mode of ["edit", "suggest"] as const) {
    test(`${mode}: IME updates replace the composition and commit as one undo step${mode === "suggest" ? " @smoke" : ""}`, async ({
      page,
      request,
    }) => {
      const original = "Alpha beta.\n";
      const { filename, id } = await openDocument(page, request, original);
      if (mode === "suggest") await chooseSuggest(page);
      await richTextEditor(page).click();
      await page.keyboard.press("End");
      await setComposition(page, "n");
      // Wait beyond the autosave debounce: an unfinished native composition
      // must neither rewrite its DOM node nor send transient unmarked text.
      await page.waitForTimeout(650);
      expect(fs.readFileSync(filename, "utf8")).toBe(original);
      expect((await draft(request, id)) ?? "").not.toContain("beta.n");
      await setComposition(page, "ni");
      await expect(richTextEditor(page)).toHaveText("Alpha beta.ni");
      await commitComposition(page, "你");
      if (mode === "suggest") {
        await expect(page.getByTestId("revision-pending")).toHaveText("1");
        await expect(richTextEditor(page)).not.toContainText("nni");
        expect(fs.readFileSync(filename, "utf8")).toBe(original);
      } else {
        await expect(richTextEditor(page)).toHaveText("Alpha beta.你");
        await expect
          .poll(() => fs.readFileSync(filename, "utf8"))
          .toBe("Alpha beta.你\n");
      }
      await page.keyboard.press("Control+z");
      await expect(richTextEditor(page)).toHaveText("Alpha beta.");
      await expect(page.getByTestId("revision-pending")).toBeEmpty();
      await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(original);
      await page.keyboard.press("Control+Shift+z");
      if (mode === "suggest") {
        await expect(page.getByTestId("revision-pending")).toHaveText("1");
        await page.getByTestId("revision-accept-all").click();
      }
      await expect(richTextEditor(page)).toHaveText("Alpha beta.你");
      await expect
        .poll(() => fs.readFileSync(filename, "utf8"))
        .toBe("Alpha beta.你\n");
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        "Saved to file",
      );
      await page.reload();
      await expect(richTextEditor(page)).toHaveText("Alpha beta.你");
    });
  }

  test("replacing a commented word by composition preserves its thread on Keep and refresh", async ({
    page,
    request,
  }) => {
    const original =
      'Alpha {==beta==}{>>Clarify this word.<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}.\n';
    const { filename } = await openDocument(page, request, original);
    await chooseSuggest(page);
    await richTextEditor(page)
      .locator(".comment-anchor[data-comment-ids]")
      .dblclick();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("beta");
    await setComposition(page, "n");
    await setComposition(page, "ni");
    await commitComposition(page, "你");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    await page.getByTestId("revision-accept-all").click();
    await expect(richTextEditor(page)).toHaveText("Alpha 你.");
    await expect(
      richTextEditor(page).locator(".comment-anchor[data-comment-ids]"),
    ).toHaveText("你");
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Clarify this word.",
    );
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    await page.reload();
    await expect(
      richTextEditor(page).locator(".comment-anchor[data-comment-ids]"),
    ).toHaveText("你");
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Clarify this word.",
    );
  });

  test("canceling a composition leaves no suggestion or file change", async ({
    page,
    request,
  }) => {
    const original = "Alpha beta.\n";
    const { filename } = await openDocument(page, request, original);
    await chooseSuggest(page);
    await richTextEditor(page).click();
    await page.keyboard.press("End");
    await setComposition(page, "ni");
    await setComposition(page, "");
    await expect(richTextEditor(page)).toHaveText("Alpha beta.");
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
  });

  test("native file composition stays pending and Revert restores its original", async ({
    page,
  }) => {
    const original = "Alpha beta.\n";
    const filename = writeProjectFile(project, "native.md", original);
    await openMarkdownFile(page, filename);
    await page.getByTestId("document-mode-trigger").click();
    await page.getByTestId("document-mode-suggesting").click();
    await richTextEditor(page).click();
    await page.keyboard.press("End");
    await setComposition(page, "n");
    await setComposition(page, "ni");
    await commitComposition(page, "你");
    await expect(richTextEditor(page)).not.toContainText("nni");
    await expect(
      page.getByTestId(/^comment-rail-.*-action-reject$/),
    ).toHaveCount(1);
    await page.getByTestId(/^comment-rail-.*-action-reject$/).click();
    await expect(richTextEditor(page)).toHaveText("Alpha beta.");
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(original);
  });
});
