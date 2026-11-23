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

test("typing stays responsive after a substantial rewrite in the same review @smoke", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const project = createMarkdownProject("typing-stall");
  // The preserved list spelling differs from the rendered editor's canonical
  // spelling. A fresh page alone bypasses the costly preservation path.
  const opening = "a".repeat(1_900);
  const rewritten = "b".repeat(1_900);
  const suffix = " typing remains immediate";
  const source = [
    "# Continued review",
    "",
    "* Keep this exact list marker.",
    "* Keep this neighboring item.",
    "",
    "A {==stable passage==}{>>Keep this comment attached.<<}{#c1}.",
    "",
    "Review {~~old~>new~~}{#s1} wording.",
    "",
    "Leave {++pending wording++}{#s2} undecided.",
    "",
    opening,
    "",
    "Footer stays unchanged.",
    "",
  ].join("\r\n");
  const filename = writeProjectFile(project, "review.md", source);
  try {
    const response = await request.post(`${api}/document`, {
      headers: { Connection: "close" },
      data: { targetPath: filename, autosave: filename, handoff: "chat" },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toContainText(opening);
    await page.getByTestId("comment-rail-s1-action-accept").click();
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );

    // Retain this editor instance and its preservation baseline through a large
    // edit. Reloading here would hide the reported long-session failure.
    await selectRichText(page, opening);
    await page.keyboard.insertText(rewritten);
    // Measure native character edits in the page, excluding controller/IPC
    // contention from parallel browser tests. Yield after each edit so the
    // editor processes each DOM mutation separately, as it does while typing.
    const elapsedMs = await page.evaluate(async (text) => {
      const started = performance.now();
      for (const character of text) {
        if (!document.execCommand("insertText", false, character))
          throw new Error("The focused editor did not accept a character");
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      return performance.now() - started;
    }, suffix);
    const timingPath = testInfo.outputPath("continued-typing-duration.json");
    fs.writeFileSync(
      timingPath,
      JSON.stringify({
        rewrittenCharacters: rewritten.length,
        typedCharacters: suffix.length,
        elapsedMs,
      }),
    );
    await testInfo.attach("continued-typing-duration", {
      path: timingPath,
      contentType: "application/json",
    });
    // This deliberately generous boundary separates a normal typing burst from
    // the many-second per-character backlog, rather than enforcing frame timing.
    expect(
      elapsedMs,
      "a short typing burst must not queue seconds of work",
    ).toBeLessThan(5_000);
    await expect(richTextEditor(page)).toContainText(rewritten + suffix);
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    const saved = fs.readFileSync(filename, "utf8");
    expect(saved).toContain("* Keep this exact list marker.\r\n");
    expect(saved).toContain(rewritten + suffix);
    expect(saved).not.toContain("pending wording");
    await expect(page.getByTestId("comment-thread-c1")).toContainText(
      "Keep this comment attached.",
    );
    await expect(page.getByTestId("suggestion-thread-s2")).toHaveCount(1);
    await expect(page.getByTestId("revision-reviewed")).toContainText(
      "History (1)",
    );
    await page.reload();
    await expect(richTextEditor(page)).toContainText(rewritten + suffix);
    await expect(page.getByTestId("comment-thread-c1")).toContainText(
      "Keep this comment attached.",
    );
    await expect(page.getByTestId("suggestion-thread-s2")).toHaveCount(1);
    expect(fs.readFileSync(filename, "utf8")).toBe(saved);
  } finally {
    removeMarkdownProject(project);
  }
});

test("Undo restores deleted Markdown spelling after the draft has saved @smoke", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("typing-spelling-undo");
  const source =
    "# Exact source\r\n\r\n* Keep this original marker.\r\n* Keep this second item.\r\n\r\nFinal paragraph.\r\n";
  const filename = writeProjectFile(project, "review.md", source);
  try {
    const response = await request.post(`${api}/document`, {
      headers: { Connection: "close" },
      data: { targetPath: filename, autosave: filename, handoff: "chat" },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await richTextEditor(page).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .not.toContain("Keep this original marker.");
    await page.keyboard.press("Control+z");
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(source);
    await page.keyboard.press("Control+Shift+z");
    await expect
      .poll(() => fs.readFileSync(filename, "utf8"))
      .not.toContain("Keep this original marker.");
    await page.keyboard.press("Control+z");
    await expect.poll(() => fs.readFileSync(filename, "utf8")).toBe(source);
    await page.reload();
    await expect(richTextEditor(page)).toContainText("Final paragraph.");
    expect(fs.readFileSync(filename, "utf8")).toBe(source);
  } finally {
    removeMarkdownProject(project);
  }
});
