import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;

for (const operation of ["typing", "Backspace", "paste", "cut"] as const) {
  test(`code suggestions: ${operation} stays pending through refresh and Keep${operation === "typing" ? " @smoke" : ""}`, async ({
    page,
    request,
    context,
  }) => {
    const project = createMarkdownProject("code-editing");
    try {
      const original = "```js\nalpha beta\n```\n";
      const filename = writeProjectFile(project, "code.md", original);
      const response = await request.post(`${api}/document`, {
        data: { targetPath: filename, autosave: filename, handoff: "chat" },
      });
      await expect(response).toBeOK();
      if (operation === "paste" || operation === "cut")
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const { id } = await response.json();
      const read = async () => {
        const response = await request.get(`${api}/${id}`);
        await expect(response).toBeOK();
        return response.json();
      };
      await page.goto(`/?comparison=${id}`);
      await page.getByTestId("revision-mode").click();
      await page.getByTestId("revision-mode-suggest").click();
      const code = richTextEditor(page).locator(
        "pre code" /* selector-check-ignore: literal code is the behavior under test. */,
      );
      await code.click();
      await page.keyboard.press("End");
      let expected: string;
      if (operation === "typing") {
        await page.keyboard.type(" NEW");
        expected = "alpha beta NEW";
      } else if (operation === "Backspace") {
        await page.keyboard.press("Backspace");
        expected = "alpha bet";
      } else if (operation === "paste") {
        await page.evaluate(() => navigator.clipboard.writeText(" pasted"));
        await page.keyboard.press("Control+V");
        expected = "alpha beta pasted";
      } else {
        await selectRichText(page, "beta");
        await expect(
          page.getByTestId("selection-menu-action-comment"),
        ).toBeEnabled();
        await page.keyboard.press("Control+X");
        expected = "alpha ";
      }
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      await expect
        .poll(async () => {
          const draft = (await read()).draft;
          return (
            typeof draft?.markdown === "string" && draft.markdown !== original
          );
        })
        .toBe(true);
      expect((await read()).draft.cleanMarkdown).toBe(original);
      expect(fs.readFileSync(filename, "utf8")).toBe(original);
      await page.reload();
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      await page.getByTestId("revision-view").click();
      await page.getByTestId("revision-view-accepted").click();
      await expect(
        page
          .getByTestId("revision-preview")
          .locator(
            "pre code" /* selector-check-ignore: preview code structure and bytes. */,
          ),
      ).toHaveText(expected);
      await page.getByTestId("revision-view").click();
      await page.getByTestId("revision-view-changes").click();
      await page.getByTestId("revision-accept-all").click();
      const expectedMarkdown = ["```js", expected, "```", ""].join("\n");
      await expect
        .poll(() => fs.readFileSync(filename, "utf8"))
        .toBe(expectedMarkdown);
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        "Saved to file",
      );
      await page.reload();
      await expect(code).toHaveText(expected);
      await expect(page.getByTestId("revision-pending")).toBeEmpty();
    } finally {
      removeMarkdownProject(project);
    }
  });
}
