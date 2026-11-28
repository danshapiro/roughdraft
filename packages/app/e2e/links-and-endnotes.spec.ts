import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const noteDefinition =
  "[^source]: A **clear** note with [Next](./Next.md).\n\n    A second paragraph with more detail.\n";
const draft = [
  "# Notes draft",
  "",
  "Opening paragraph with a note[^source] and its repeated reference[^source].",
  "",
  "[Next](./Next.md)",
  "",
  "[External site](https://example.test/site)",
  "",
  ...Array.from(
    { length: 18 },
    (_, index) =>
      `Reading paragraph ${index + 1} keeps the notes below the first screen.\n`,
  ),
  "A code example: `[^literal]`.",
  "",
  noteDefinition,
].join("\n");

async function setMode(page: Page, name: "Suggesting" | "Editing" | "Viewing") {
  await page.getByTestId("document-mode-trigger").click();
  await page.getByRole("option", { name, exact: true }).click(); // selector-check-ignore: the option label is the control contract.
  await expect(page.getByTestId("document-mode-trigger")).toContainText(name);
}

function linkPreview(page: Page) {
  return page.getByRole("dialog", { name: "Link preview", exact: true }); // selector-check-ignore: generated preview has a stable accessible label.
}

function endnotePreview(page: Page) {
  return page.getByRole("dialog", { name: "Endnote preview", exact: true }); // selector-check-ignore: generated preview has a stable accessible label.
}

function prepareProject(label: string) {
  const directory = createMarkdownProject(label);
  const target = writeProjectFile(directory, "Draft.md", draft);
  writeProjectFile(
    directory,
    "Next.md",
    "# Next\n\nThe neighboring document.\n",
  );
  return { directory, target };
}

test("document links support clicks, previews and keyboard activation in every mode @smoke", async ({
  page,
  context,
}) => {
  const { directory, target } = prepareProject("links");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.getByTestId("rich-text-editor");
  try {
    for (const mode of ["Suggesting", "Editing", "Viewing"] as const) {
      await openMarkdownFile(page, target);
      await setMode(page, mode);
      await editor
        .getByRole("link", { name: "Next", exact: true })
        .first()
        .click();
      await expect(editor).toContainText("The neighboring document.");
      expect(new URL(page.url()).searchParams.get("path")).toBe(
        target.replace(/Draft\.md$/, "Next.md"),
      );
      expect(readProjectFile(directory, "Draft.md")).toBe(draft);
    }

    await openMarkdownFile(page, target);
    await page.mouse.move(0, 0);
    const next = editor
      .getByRole("link", { name: "Next", exact: true })
      .first();
    await next.hover();
    await expect(linkPreview(page)).toContainText("The neighboring document.");
    await linkPreview(page)
      .getByRole("link", { name: "Open link", exact: true })
      .click();
    await expect(editor).toContainText("The neighboring document.");

    await openMarkdownFile(page, target);
    await next.focus();
    await expect(linkPreview(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(linkPreview(page)).toBeHidden();
    await next.focus();
    await expect(next).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor).toContainText("The neighboring document.");

    await context.route("https://example.test/site", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>External destination</title><h1>External destination</h1>",
      }),
    );
    await openMarkdownFile(page, target);
    const popupPromise = context.waitForEvent("page");
    await editor
      .getByRole("link", { name: "External site", exact: true })
      .click();
    const popup = await popupPromise;
    try {
      await expect(popup).toHaveTitle("External destination");
      expect(popup.url()).toBe("https://example.test/site");
    } finally {
      await popup.close();
    }
    expect(readProjectFile(directory, "Draft.md")).toBe(draft);
    expect(errors).toEqual([]);
  } finally {
    removeMarkdownProject(directory);
  }
});

test("formatted multiline endnotes retain repeated references through navigation and save/reload @smoke", async ({
  page,
}) => {
  const { directory, target } = prepareProject("endnotes");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.getByTestId("rich-text-editor");
  const references = editor.getByRole("link", {
    name: "Endnote 1",
    exact: true,
  });
  try {
    await openMarkdownFile(page, target);
    await expect(references).toHaveCount(2);
    await page.mouse.move(0, 0);
    await references.first().hover();
    const preview = endnotePreview(page);
    await expect(preview).toContainText("A second paragraph with more detail.");
    await expect(preview.locator("strong")).toHaveText("clear"); // selector-check-ignore: semantic formatting is the behavior being verified.
    await preview.getByRole("link", { name: "Next", exact: true }).click();
    await expect(editor).toContainText("The neighboring document.");

    await openMarkdownFile(page, target);
    await references.last().click();
    const noteHash = new URL(
      (await references.last().getAttribute("href")) ?? "",
      page.url(),
    ).hash.slice(1);
    const note = page.locator(
      `[data-testid="rich-text-editor"] [id="${decodeURIComponent(noteHash)}"]`,
    );
    await expect(note).toBeInViewport();
    await note
      .getByRole("link", { name: /Back to reference/ })
      .first()
      .click();
    await expect(references.last()).toBeFocused();
    expect(new URL(page.url()).searchParams.get("path")).toBe(target);
    await page.mouse.move(0, 0);
    await references.first().focus();
    await expect(preview).toContainText("A clear note");
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();

    await setMode(page, "Editing");
    await page
      .locator('[data-testid="rich-text-editor"] p')
      .filter({ hasText: "Opening paragraph" })
      .first()
      .click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Home");
    await page.keyboard.type("Browser edit. ");
    await expect
      .poll(() => readProjectFile(directory, "Draft.md"))
      .toContain("Browser edit. Opening paragraph");
    const saved = readProjectFile(directory, "Draft.md");
    expect(saved.match(/\[\^source\]:/g)).toHaveLength(1);
    expect(saved.match(/\[\^source\](?!:)/g)).toHaveLength(2);
    expect(saved).toContain(noteDefinition.trimEnd());
    expect(saved).toContain("`[^literal]`");
    expect(saved).not.toContain("[^literal]:");
    await page.reload();
    await expect(references).toHaveCount(2);
    await page.mouse.move(0, 0);
    await references.last().hover();
    await expect(preview).toContainText("A second paragraph with more detail.");
    expect(errors).toEqual([]);
  } finally {
    removeMarkdownProject(directory);
  }
});

for (const navigation of ["document link", "endnote preview link"] as const) {
  test(`a ${navigation} saves pending edits before leaving the original file @smoke`, async ({
    page,
  }) => {
    const { directory, target } = prepareProject("pending-link-save");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await openMarkdownFile(page, target);
      await setMode(page, "Editing");
      const editor = page.getByTestId("rich-text-editor");
      await page
        .locator('[data-testid="rich-text-editor"] p')
        .filter({ hasText: "Opening paragraph" })
        .first()
        .click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Home");
      const now = Date.now();
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now + 1_000);
      await expect(page.getByTestId("document-save-status")).toHaveAttribute(
        "aria-label",
        "Saved",
      );
      const savedBeforeTyping = readProjectFile(directory, "Draft.md");
      await page.keyboard.type("Pending edit. ");
      expect(readProjectFile(directory, "Draft.md")).toBe(savedBeforeTyping);
      const destination = target.replace(/Draft\.md$/, "Next.md");
      let savedWhenNavigating: string | undefined;
      page.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          new URL(request.url()).searchParams.get("path") === destination
        )
          savedWhenNavigating = readProjectFile(directory, "Draft.md");
      });
      if (navigation === "endnote preview link") {
        await editor
          .getByRole("link", { name: "Endnote 1", exact: true })
          .first()
          .hover();
        await page.clock.fastForward(260);
        await expect(endnotePreview(page)).toBeVisible();
        expect(readProjectFile(directory, "Draft.md")).toBe(savedBeforeTyping);
        await endnotePreview(page)
          .getByRole("link", { name: "Next", exact: true })
          .click();
      } else {
        await editor
          .getByRole("link", { name: "Next", exact: true })
          .first()
          .click();
      }
      await page.waitForURL(
        (url) => url.searchParams.get("path") === destination,
        { waitUntil: "commit" },
      );
      expect(savedWhenNavigating).toContain("Pending edit. Opening paragraph");
      expect(readProjectFile(directory, "Draft.md")).toContain(
        "Pending edit. Opening paragraph",
      );
      // The frozen clock proves the original page flushed its pending save.
      // Let the destination's deferred editor mount after navigation commits.
      await page.clock.resume();
      await expect(editor).toContainText("The neighboring document.");
      expect(readProjectFile(directory, "Draft.md")).toContain(
        "Pending edit. Opening paragraph",
      );
      expect(errors).toEqual([]);
    } finally {
      await page.clock.resume();
      removeMarkdownProject(directory);
    }
  });
}
