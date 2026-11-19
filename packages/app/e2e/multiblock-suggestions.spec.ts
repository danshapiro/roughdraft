import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  documentSaveStatus,
  fileConflictNotice,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const oldBlocks = [
  "The original setup supports the older laser.",
  "",
  "Read the original connection instructions before starting.",
  "",
  "## Original features",
  "",
  "- Keep the existing material settings.",
  "- Connect the older laser over USB.",
].join("\n");

const newBlocks = [
  "The proposed setup supports the LONGER laser.",
  "",
  "Read the updated connection instructions before starting.",
  "",
  "## Updated features",
  "",
  "- Use the updated material settings.",
  "- Connect the supported LONGER laser over USB.",
].join("\n");

const prefix = "# Laser setup\n\n";
const suffix = "\n\nKeep this final paragraph unchanged.\n";
const suggestion = `${prefix}{~~${oldBlocks}~>${newBlocks}~~}{id="s24" by="AI" at="2026-11-19T05:13:01.272Z"}${suffix}`;

for (const decision of ["accept", "reject"] as const) {
  test(`one suggestion spanning paragraphs, a heading and a feature list can ${decision} @smoke`, async ({
    page,
  }) => {
    const projectDir = createMarkdownProject(`multiblock-${decision}`);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const filePath = writeProjectFile(projectDir, "laser.md", suggestion);
      await openMarkdownFile(page, filePath);
      const editor = richTextEditor(page);
      await expect(editor).toBeVisible();

      // One reviewer-authored substitution must render as a single review item,
      // with real Markdown blocks on both sides and no exposed source syntax.
      await expect(editor).not.toContainText("{~~");
      await expect(editor).not.toContainText("~>");
      await expect(editor).not.toContainText("~~}");
      await expect(editor).not.toContainText('id="s24"');
      await expect(editor.getByRole("heading", { level: 2 })).toHaveText([
        // selector-check-ignore: real Markdown heading structure is the regression.
        "Original features",
        "Updated features",
      ]);
      await expect(editor.locator("ul")).toHaveCount(2); // selector-check-ignore: real list structure is the regression.
      await expect(editor.getByRole("listitem")).toHaveText([
        // selector-check-ignore: actual list-item structure is the regression.
        "Keep the existing material settings.",
        "Connect the older laser over USB.",
        "Use the updated material settings.",
        "Connect the supported LONGER laser over USB.",
      ]);
      await expect(page.getByTestId("suggestion-thread-s24")).toHaveCount(1);
      await expect(
        page.getByTestId("comment-rail-s24-action-accept"),
      ).toHaveCount(1);
      await expect(
        page.getByTestId("comment-rail-s24-action-reject"),
      ).toHaveCount(1);

      for (const [kind, texts, decoration] of [
        [
          "substitution-old",
          oldBlocks
            .split("\n")
            .filter(Boolean)
            .map((line) => line.replace(/^(## |- )/, "")),
          "line-through",
        ],
        [
          "substitution-new",
          newBlocks
            .split("\n")
            .filter(Boolean)
            .map((line) => line.replace(/^(## |- )/, "")),
          "underline",
        ],
      ] as const) {
        for (const text of texts) {
          const changedText = editor
            .locator(
              `[data-critic-change-id="s24"][data-critic-change-kind="${kind}"]`,
            )
            .filter({ hasText: text });
          await expect(changedText).toHaveCount(1);
          await expect(changedText).toHaveCSS(
            "text-decoration-line",
            decoration,
          );
        }
      }

      expect(readProjectFile(projectDir, "laser.md")).toBe(suggestion);
      if (decision === "accept")
        await page.screenshot({
          path: ".context/ui-state-screenshots/20261119-multiblock/suggestion.png",
          fullPage: true,
        });
      await page.getByTestId(`comment-rail-s24-action-${decision}`).click();
      const chosenBlocks = decision === "accept" ? newBlocks : oldBlocks;
      await expect
        .poll(() => readProjectFile(projectDir, "laser.md"))
        .toBe(`${prefix}${chosenBlocks}${suffix}`);
      await expect(page.getByTestId("suggestion-thread-s24")).toHaveCount(0);
      await expect(documentSaveStatus(page)).toHaveAttribute(
        "aria-label",
        "Saved",
      );
      await expect(fileConflictNotice(page)).toHaveCount(0);

      // Reload the actual saved file: accepting/rejecting must keep its blocks,
      // not just temporarily hide the other side in the current editor.
      await page.reload();
      await expect(
        richTextEditor(page).getByRole("heading", { level: 2 }),
      ).toHaveText(
        // selector-check-ignore: verify saved heading semantics.
        decision === "accept" ? "Updated features" : "Original features",
      );
      await expect(richTextEditor(page).locator("ul li")).toHaveCount(2); // selector-check-ignore: verify saved list semantics.
      await expect(richTextEditor(page)).not.toContainText("{~~");
      expect(errors).toEqual([]);
    } finally {
      removeMarkdownProject(projectDir);
    }
  });
}

test("editing and replying before resolving a block suggestion preserves both edits and unrelated suggestions @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("multiblock-edits");
  try {
    const input =
      suggestion +
      '\nKeep {++another suggestion++}{id="s25" by="AI" at="2026-11-19T05:13:01.272Z"}.\n';
    await openMarkdownFile(
      page,
      writeProjectFile(projectDir, "laser.md", input),
    );
    await expect(page.getByTestId("suggestion-thread-s24")).toBeVisible();
    await page.getByTestId("comment-rail-s24-action-reply").click();
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("This keeps all the setup instructions together.");
    await page.getByTestId("comment-rail-c1-action-save").click();
    await expect
      .poll(() => readProjectFile(projectDir, "laser.md"))
      .toContain("This keeps all the setup instructions together.");
    await page.getByTestId("document-mode-trigger").click();
    await page.getByRole("option", { name: "Editing", exact: true }).click(); // selector-check-ignore: the mode's accessible label is the control contract.
    await selectRichText(page, "Keep this final paragraph unchanged.");
    await page.keyboard.insertText("Keep this edited final paragraph.");
    await expect
      .poll(() => readProjectFile(projectDir, "laser.md"))
      .toContain("Keep this edited final paragraph.");
    await page.reload();
    await expect(page.getByTestId("suggestion-thread-s24")).toContainText(
      "This keeps all the setup instructions together.",
    );
    await expect(richTextEditor(page)).not.toContainText("{~~");
    await page.getByTestId("comment-rail-s24-action-accept").click();
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect
      .poll(() => readProjectFile(projectDir, "laser.md"))
      .not.toContain("s24");
    const saved = readProjectFile(projectDir, "laser.md");
    expect(saved).toContain("Keep this edited final paragraph.");
    expect(saved).toContain("The proposed setup supports the LONGER laser.");
    expect(saved).toContain("another suggestion");
    expect(saved).toContain('id="s25"');
    expect(saved).not.toContain(
      "This keeps all the setup instructions together.",
    );
    await expect(fileConflictNotice(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("suggestion-thread-s25")).toHaveCount(1);
    await expect(page.getByTestId("suggestion-thread-s24")).toHaveCount(0);
    await expect(richTextEditor(page)).toContainText(
      "Keep this edited final paragraph.",
    );
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("a suggestion starting and ending partway through paragraphs retains those boundaries @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("multiblock-boundary");
  const lead = "Unchanged lead ";
  const tail = " unchanged tail.";
  const before = "Original first.\n\n- Original feature";
  const after = "Proposed first.\n\n- Proposed feature";
  try {
    const input = `${lead}{~~${before}~>${after}~~}{#s24}${tail}\n\n---\nsuggestions:\n  s24:\n    by: AI\n    at: "2026-11-19T05:13:01.272Z"\n`;
    await openMarkdownFile(
      page,
      writeProjectFile(projectDir, "boundary.md", input),
    );
    await expect(page.getByTestId("suggestion-thread-s24")).toHaveCount(1);
    await expect(richTextEditor(page)).not.toContainText("{~~");
    await page.getByTestId("comment-rail-s24-action-accept").click();
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    const expected = `${lead}${after}${tail}`;
    await expect
      .poll(() => readProjectFile(projectDir, "boundary.md").trimEnd())
      .toBe(expected);
    await expect(richTextEditor(page)).toContainText(
      "Unchanged lead Proposed first.",
    );
    await expect(richTextEditor(page)).toContainText(
      "Proposed feature unchanged tail.",
    );
    await expect(fileConflictNotice(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("suggestion-thread-s24")).toHaveCount(0);
    await expect(richTextEditor(page)).not.toContainText("suggestions:");
    await expect(richTextEditor(page)).toContainText(
      "Unchanged lead Proposed first.",
    );
    await expect(richTextEditor(page)).toContainText(
      "Proposed feature unchanged tail.",
    );
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("a suggestion containing only a fenced code block still has one review action @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("multiblock-code");
  try {
    const input =
      '# Code review\n\n{++```js\nconst answer = 42;\n```++}{id="s24" by="AI" at="2026-11-19T05:13:01.272Z"}\n';
    await openMarkdownFile(
      page,
      writeProjectFile(projectDir, "code.md", input),
    );
    await expect(page.getByTestId("suggestion-thread-s24")).toHaveCount(1);
    await expect(page.getByTestId("suggestion-thread-s24")).toContainText(
      "const answer = 42;",
    );
    await expect(richTextEditor(page)).toContainText("const answer = 42;");
    await page.getByTestId("comment-rail-s24-action-accept").click();
    await expect
      .poll(() => readProjectFile(projectDir, "code.md"))
      .toBe("# Code review\n\n```js\nconst answer = 42;\n```\n");
    await page.reload();
    await expect(page.getByTestId("suggestion-thread-s24")).toHaveCount(0);
    await expect(richTextEditor(page)).toContainText("const answer = 42;");
  } finally {
    removeMarkdownProject(projectDir);
  }
});
