import fs from "node:fs";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;

test.describe("basic editing audit", () => {
  let project: string;
  test.beforeEach(({ page }) => {
    project = createMarkdownProject("basic-editing-audit");
    page.on("console", (message) => {
      try {
        const event = JSON.parse(message.text());
        if (event.component === "suggesting")
          logE2eEvent("basic-editing.suggesting", event);
      } catch {
        // Other browser messages do not belong to this focused diagnosis.
      }
    });
  });
  test.afterEach(() => removeMarkdownProject(project));

  async function openDocument(
    page: Page,
    request: APIRequestContext,
    text: string,
    mode: "edit" | "suggest" = "edit",
  ) {
    const filename = writeProjectFile(project, "notes.md", text);
    const response = await request.post(`${api}/document`, {
      data: { targetPath: filename, autosave: filename, handoff: "chat" },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    if (mode === "suggest") {
      await page.getByTestId("revision-mode").click();
      await page.getByTestId("revision-mode-suggest").click();
    }
    return { id: id as string, filename };
  }

  async function caret(page: Page, text: string, side: "before" | "after") {
    await selectRichText(page, text);
    await expect(
      page.getByTestId("selection-menu-action-comment"),
    ).toBeEnabled();
    await page.keyboard.press(side === "before" ? "ArrowLeft" : "ArrowRight");
    // The helper's synthetic range has to reach the editor before the next
    // key. This public control reports when the model has a collapsed caret.
    await expect
      .poll(async () => {
        const comment = page.getByTestId("selection-menu-action-comment");
        if (!(await comment.count()) || !(await comment.isVisible()))
          return true;
        return comment.isDisabled();
      })
      .toBe(true);
  }

  async function draft(request: APIRequestContext, id: string) {
    const response = await request.get(`${api}/${id}`);
    await expect(response).toBeOK();
    return (await response.json()).draft?.markdown as string | undefined;
  }

  async function view(page: Page, name: "accepted" | "rejected" | "changes") {
    await page.getByTestId("revision-view").click();
    await page.getByTestId(`revision-view-${name}`).click();
    return name === "changes"
      ? richTextEditor(page)
      : page.getByTestId("revision-preview").locator(".ProseMirror");
  }

  for (const mode of ["edit", "suggest"] as const) {
    test(`${mode}: Enter splits a paragraph at the caret`, async ({
      page,
      request,
    }) => {
      const original = "Alpha beta gamma.\n";
      const { filename } = await openDocument(page, request, original, mode);
      await caret(page, "beta", "before");
      await page.keyboard.press("Enter");
      await page.keyboard.type("New ");
      await expect(richTextEditor(page)).toContainText("New beta gamma.");
      if (mode === "suggest") {
        await expect(page.getByTestId("revision-pending")).not.toBeEmpty();
        expect(fs.readFileSync(filename, "utf8")).toBe(original);
        const final = await view(page, "accepted");
        await expect(
          final.locator("p" /* selector-check-ignore: paragraph structure. */),
        ).toHaveText(["Alpha", "New beta gamma."]);
        const originalView = await view(page, "rejected");
        await expect(originalView).toHaveText("Alpha beta gamma.");
        await view(page, "changes");
        await page.getByTestId("revision-reject-all").click();
        await expect(richTextEditor(page)).toHaveText("Alpha beta gamma.");
        await page.reload();
        await expect(richTextEditor(page)).toHaveText("Alpha beta gamma.");
        expect(fs.readFileSync(filename, "utf8")).toBe(original);
      } else {
        await expect
          .poll(() => fs.readFileSync(filename, "utf8"))
          .toContain("Alpha\n\nNew beta gamma.");
      }
    });

    test(`${mode}: Shift+Enter inserts a line break inside the paragraph`, async ({
      page,
      request,
    }) => {
      await openDocument(page, request, "Alpha beta gamma.\n", mode);
      await caret(page, "gamma.", "after");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("Next line.");
      const body =
        mode === "suggest"
          ? await view(page, "accepted")
          : richTextEditor(page);
      await expect(
        body.locator("p" /* selector-check-ignore: paragraph structure. */),
      ).toHaveCount(1);
      await expect(
        body.locator("p br" /* selector-check-ignore: soft line breaks. */),
      ).toHaveCount(1);
      await expect(body).toContainText("Next line.");
    });

    test(`${mode}: Enter creates a new list item`, async ({
      page,
      request,
    }) => {
      await openDocument(page, request, "- Alpha\n- Omega\n", mode);
      await caret(page, "Alpha", "after");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Beta");
      const body =
        mode === "suggest"
          ? await view(page, "accepted")
          : richTextEditor(page);
      await expect(
        body.locator("li" /* selector-check-ignore: list structure. */),
      ).toHaveText(["Alpha", "Beta", "Omega"]);
    });

    test(`${mode}: multiline clipboard paste keeps paragraph boundaries`, async ({
      page,
      request,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const original = "Alpha.\n";
      const { filename } = await openDocument(page, request, original, mode);
      await caret(page, "Alpha.", "after");
      await page.evaluate(() =>
        navigator.clipboard.writeText(" First line.\n\nSecond line."),
      );
      await page.keyboard.press("Control+V");
      const body =
        mode === "suggest"
          ? await view(page, "accepted")
          : richTextEditor(page);
      await expect(
        body.locator("p" /* selector-check-ignore: paragraph structure. */),
      ).toHaveText(["Alpha. First line.", "Second line."]);
      if (mode === "suggest")
        expect(fs.readFileSync(filename, "utf8")).toBe(original);
    });

    test(`${mode}: cutting several paragraphs preserves separators on the clipboard`, async ({
      page,
      request,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await openDocument(
        page,
        request,
        "First paragraph.\n\nSecond paragraph.\n",
        mode,
      );
      await richTextEditor(page).focus();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Control+X");
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toMatch(/First paragraph\.\n+Second paragraph\./);
    });
  }

  test("suggest: Enter replaces a selected phrase with a paragraph break", async ({
    page,
    request,
  }) => {
    await openDocument(page, request, "Alpha beta gamma.\n", "suggest");
    await selectRichText(page, "beta ");
    await page.keyboard.press("Enter");
    const body = await view(page, "accepted");
    await expect(
      body.locator("p" /* selector-check-ignore: paragraph structure. */),
    ).toHaveText(["Alpha", "gamma."]);
    await view(page, "changes");
    await expect(page.getByTestId("revision-pending")).not.toBeEmpty();
  });

  test("suggest: Backspace at the next paragraph start joins the paragraphs", async ({
    page,
    request,
  }) => {
    await openDocument(page, request, "Alpha.\n\nBeta.\n", "suggest");
    await caret(page, "Beta.", "before");
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("revision-pending")).not.toBeEmpty();
    await page.getByTestId("revision-accept-all").click();
    await expect(
      richTextEditor(page).locator(
        "p" /* selector-check-ignore: paragraph structure. */,
      ),
    ).toHaveCount(1);
  });

  for (const key of ["Backspace", "Delete"]) {
    test(`suggest: ${key} removes an entire emoji without splitting its surrogate pair`, async ({
      page,
      request,
    }) => {
      await openDocument(page, request, "Alpha 🙂 beta.\n", "suggest");
      await caret(page, "🙂", key === "Backspace" ? "after" : "before");
      await page.keyboard.press(key);
      await expect(
        richTextEditor(page).locator(".critic-change-deletion"),
      ).toHaveText("🙂");
      await page.getByTestId("revision-accept-all").click();
      await expect(richTextEditor(page)).toHaveText("Alpha beta.");
    });
  }

  test("edit: formatting Undo and Redo preserve the attached comment", async ({
    page,
    request,
  }) => {
    const original =
      'Read {==this guidance==}{>>Keep the source.<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}.\n';
    const { filename } = await openDocument(page, request, original);
    await selectRichText(page, "this guidance");
    await page.getByTestId("selection-menu-action-bold").click();
    await expect(
      richTextEditor(page).locator(
        "strong" /* selector-check-ignore: bold formatting. */,
      ),
    ).toHaveText("this guidance");
    await page.getByTestId("revision-undo").click();
    await expect(
      richTextEditor(page).locator(
        "strong" /* selector-check-ignore: bold formatting. */,
      ),
    ).toHaveCount(0);
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Keep the source.",
    );
    await page.getByTestId("revision-redo").click();
    await expect(
      richTextEditor(page).locator(
        "strong" /* selector-check-ignore: bold formatting. */,
      ),
    ).toHaveText("this guidance");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toContain("**this guidance**");
    await page.reload();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Keep the source.",
    );
  });

  test("suggest: indenting a list stays pending until a review decision", async ({
    page,
    request,
  }) => {
    const original = "- Alpha\n- Beta\n";
    const { id, filename } = await openDocument(
      page,
      request,
      original,
      "suggest",
    );
    await caret(page, "Beta", "before");
    await page.keyboard.press("Tab");
    await expect(
      richTextEditor(page).locator(
        "ul ul" /* selector-check-ignore: list nesting. */,
      ),
    ).toHaveCount(1);
    await expect.poll(() => draft(request, id)).toBeTruthy();
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    await expect(page.getByTestId("revision-pending")).not.toBeEmpty();
  });

  test("suggest: formatting stays pending until a review decision", async ({
    page,
    request,
  }) => {
    const original = "Alpha beta gamma.\n";
    const { id, filename } = await openDocument(
      page,
      request,
      original,
      "suggest",
    );
    await selectRichText(page, "beta");
    await page.getByTestId("selection-menu-action-bold").click();
    await expect(
      richTextEditor(page).locator(
        "strong" /* selector-check-ignore: bold formatting. */,
      ),
    ).toHaveText("beta");
    await expect.poll(() => draft(request, id)).toContain("**beta**");
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    await expect(page.getByTestId("revision-pending")).not.toBeEmpty();
  });

  test("suggest: a new final paragraph stays pending until Keep @smoke", async ({
    page,
    request,
  }) => {
    const original = "Alpha.\n";
    const { filename } = await openDocument(page, request, original, "suggest");
    await caret(page, "Alpha.", "after");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await page.keyboard.press("Control+Shift+z");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await page.keyboard.type("Next paragraph.");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    const final = await view(page, "accepted");
    await expect(
      final.locator("p" /* selector-check-ignore: paragraph structure. */),
    ).toHaveText(["Alpha.", "Next paragraph."]);
    await view(page, "changes");
    await page.getByTestId("revision-accept-all").click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe("Alpha.\n\nNext paragraph.\n");
  });

  test("suggest: paragraph editing still works after a saved decision and source toggle @smoke", async ({
    page,
    request,
  }) => {
    const input =
      'Alpha {++new++}{id="s1" by="user" at="2026-01-01T00:00:00.000Z"} beta.\n\nUnchanged footer.\n';
    const accepted = "Alpha new beta.\n\nUnchanged footer.\n";
    const { filename } = await openDocument(page, request, input, "suggest");
    await page.getByTestId("revision-accept-all").click();
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(accepted);
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    await page.reload();
    await expect(page.getByTestId("revision-reviewed")).toBeEnabled();
    await page.getByTestId("revision-format").click();
    await expect(page.getByTestId("revision-markdown")).toBeVisible();
    await page.getByTestId("revision-format").click();
    await caret(page, "new", "before");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    expect(fs.readFileSync(filename, "utf8")).toBe(accepted);
    await page.getByTestId("revision-undo").click();
    await expect(page.getByTestId("revision-pending")).toBeEmpty();
    await expect(page.getByTestId("revision-reviewed")).toBeEnabled();
    await page.getByTestId("revision-redo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await richTextEditor(page).getByText("new beta.", { exact: true }).click();
    await page.keyboard.press("Home");
    await page.keyboard.type("Next ");
    const final = await view(page, "accepted");
    await expect(
      final.locator(
        "p" /* selector-check-ignore: proposed paragraph boundaries. */,
      ),
    ).toHaveText(["Alpha", "Next new beta.", "Unchanged footer."]);
    expect(fs.readFileSync(filename, "utf8")).toBe(accepted);
    await view(page, "changes");
    await page.getByTestId("revision-accept-all").click();
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .toBe("Alpha\n\nNext new beta.\n\nUnchanged footer.\n");
  });

  test("suggest: merging suggestions and document Undo preserve each reply's original parent and newer text", async ({
    page,
    request,
  }) => {
    const input =
      'Alpha {~~old~>new~~}{id="s1" by="AI" at="2026-01-01T00:00:00.000Z"} and {~~red~>blue~~}{id="s2" by="AI" at="2026-01-01T00:00:01.000Z"}{>>Keep this review note.<<}{id="c1" by="user" at="2026-01-01T00:00:02.000Z" re="s2"}.\n';
    const { id, filename } = await openDocument(
      page,
      request,
      input,
      "suggest",
    );
    const feedback = async () => {
      const response = await request.get(`${api}/${id}`);
      return (await response.json()).reviewComments?.find(
        (comment: { id: string }) => comment.id === "c1",
      );
    };
    await selectRichText(page, "Alpha");
    await page.getByTestId("selection-menu-action-bold").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect
      .poll(async () => (await feedback())?.parentCommentId)
      .toBe("s1");
    await page.getByTestId("comment-rail-c1-action-edit").click();
    const editor = page.getByTestId("comment-rail-c1-editor");
    await editor.fill("Newer feedback must survive Undo.");
    await editor.press("Control+Enter");
    await page.getByTestId("revision-undo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("2");
    await expect
      .poll(async () => (await feedback())?.parentCommentId)
      .toBe("s2");
    await expect
      .poll(async () => (await feedback())?.content)
      .toBe("Newer feedback must survive Undo.");
    await page.getByTestId("revision-redo").click();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect
      .poll(async () => (await feedback())?.parentCommentId)
      .toBe("s1");
    expect(fs.readFileSync(filename, "utf8")).toBe(input);
    await page.reload();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Newer feedback must survive Undo.",
    );
  });

  for (const key of ["Enter", "Shift+Enter"]) {
    test(`native-file Suggest ${key} saves review markup and Revert restores the original`, async ({
      page,
    }) => {
      const original = "Alpha beta gamma.\n";
      const filename = writeProjectFile(project, "native.md", original);
      await openMarkdownFile(page, filename);
      await page.getByTestId("document-mode-trigger").click();
      await page.getByTestId("document-mode-suggesting").click();
      await caret(page, "beta", "before");
      await page.keyboard.press(key);
      await page.keyboard.type("New ");
      await expect
        .poll(() => fs.readFileSync(filename, "utf8"))
        .toContain("{~~");
      await expect
        .poll(() => fs.readFileSync(filename, "utf8"))
        .toContain("New beta gamma.");
      await page.reload();
      await expect(page.getByTestId("document-review-rail")).toBeVisible();
      await page.getByTestId("document-reject-all").click();
      await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(original);
    });
  }

  test("suggest: phone typing within bold commented text preserves formatting and the comment anchor", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const original =
      '{==**Alpha beta**==}{>>Keep this note.<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}\n';
    const { id, filename } = await openDocument(
      page,
      request,
      original,
      "suggest",
    );
    await caret(page, "beta", "before");
    await page.keyboard.type("New ");
    const final = await view(page, "accepted");
    await expect(
      final.locator("strong" /* selector-check-ignore: bold formatting. */),
    ).toHaveText("Alpha New beta");
    await view(page, "changes");
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    await expect.poll(() => draft(request, id)).toContain("New");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    await page.reload();
    await expect(richTextEditor(page)).toContainText("Alpha New beta");
    await caret(page, "beta", "before");
    await page.keyboard.type("Again ");
    await expect.poll(() => draft(request, id)).toContain("Again");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    await page.getByTestId("revision-accept-all").click();
    const highlightedText = () =>
      richTextEditor(page)
        .locator(".comment-anchor[data-comment-ids]")
        .allTextContents();
    await expect
      .poll(async () => (await highlightedText()).join(""))
      .toContain("Alpha New Again beta");
    await page.reload();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Keep this note.",
    );
    await expect
      .poll(async () => (await highlightedText()).join(""))
      .toContain("Alpha New Again beta");
  });
});
