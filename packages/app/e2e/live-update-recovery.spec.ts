import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const fixtureDirectory = fileURLToPath(
  new URL("../../../docs/spec/fixtures/", import.meta.url),
);
const original = fs.readFileSync(
  path.join(fixtureDirectory, "editing-review.md"),
  "utf8",
);
const headers = { Connection: "close" };
const sourceItems = extractRoughdraftReviewIndex(original).items;

function expectCompleteFeedback(review: {
  draft: { markdown: string };
  reviewComments: Array<{
    id: string;
    content: string;
    parentCommentId?: string | null;
  }>;
}) {
  const expectedComments = new Map(
    sourceItems
      .filter((item) => item.kind !== "suggestion")
      .map((item) => [item.id, item]),
  );
  expect(review.reviewComments.map((comment) => comment.id).sort()).toEqual(
    [...expectedComments.keys()].sort(),
  );
  for (const comment of review.reviewComments) {
    const expected = expectedComments.get(comment.id);
    expect(comment.content).toBe(expected?.text);
    expect(comment.parentCommentId ?? null).toBe(expected?.parentId ?? null);
  }
  const suggestions = (markdown: string) =>
    [
      ...new Set(
        extractRoughdraftReviewIndex(markdown)
          .items.filter((item) => item.kind === "suggestion")
          .map((item) => item.id),
      ),
    ].sort();
  expect(suggestions(review.draft.markdown)).toEqual(suggestions(original));
}

async function chooseMode(page: Page, mode: "Read" | "Edit" | "Suggest") {
  await page.getByTestId("revision-mode").click();
  await page.getByTestId(`revision-mode-${mode.toLowerCase()}`).click();
}
async function chooseView(page: Page, view: "Changes" | "Original" | "Final") {
  await page.getByTestId("revision-view").click();
  const names = { Changes: "changes", Original: "rejected", Final: "accepted" };
  await page.getByTestId(`revision-view-${names[view]}`).click();
}
async function open(page: Page, request: APIRequestContext, project: string) {
  const target = writeProjectFile(project, "practice.md", original);
  fs.cpSync(
    path.join(fixtureDirectory, "editing-review-assets"),
    path.join(project, "editing-review-assets"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(fixtureDirectory, "editing-review-linked.md"),
    path.join(project, "editing-review-linked.md"),
  );
  const response = await request.post(`${api}/document`, {
    headers,
    data: {
      targetPath: target,
      autosave: target,
      handoff: "chat",
      title: "Review a release plan with live edits and comments",
    },
  });
  await expect(response).toBeOK();
  const { id } = await response.json();
  await page.goto(`/?comparison=${id}`);
  await expect(richTextEditor(page)).toBeVisible();
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    /^(Review saved|Saved to file)$/,
  );
  expect(fs.readFileSync(target, "utf8")).toBe(original);
  return { id: id as string, target };
}
async function makeConflict(page: Page, id: string, target: string) {
  let unblock = () => {};
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let first = true;
  let localRequest: unknown;
  await page.route(`**/api/comparisons/${id}/reconcile`, async (route) => {
    if (
      first &&
      route.request().postDataJSON().draft.markdown.includes("orchard schedule")
    ) {
      first = false;
      localRequest = route.request().postDataJSON();
      await held;
    }
    await route.continue();
  });
  try {
    await selectRichText(page, "planting schedule");
    await page.keyboard.insertText("orchard schedule");
    await expect.poll(() => first).toBe(false);
    fs.writeFileSync(
      target,
      original
        .replace("planting schedule", "garden schedule")
        .replace("lighting schedule", "lantern schedule"),
    );
  } finally {
    unblock();
  }
  await expect(page.getByTestId("revision-conflict")).toBeVisible();
  try {
    await expect(page.getByTestId("revision-discard")).toBeVisible();
  } catch (error) {
    const banner = await page.getByTestId("revision-conflict").innerText();
    const response = await page.request.get(`${api}/${id}/state`, { headers });
    const state = await response.json();
    const diagnostic = {
      banner,
      localRequest,
      state,
      disk: fs.readFileSync(target, "utf8"),
    };
    const filename = test.info().outputPath("conflict-diagnostic.json");
    fs.writeFileSync(filename, JSON.stringify(diagnostic, null, 2));
    console.info(
      JSON.stringify({
        event: "recovery-conflict-diagnostic",
        banner,
        savedSignature: state.signature,
        revision: state.revision,
      }),
    );
    throw error;
  }
}

for (const mode of ["Read", "Edit", "Suggest"] as const) {
  for (const view of ["Changes", "Original", "Final"] as const) {
    for (const presentation of ["formatted", "Markdown"] as const) {
      test(`conflict resolution keeps independent work in ${mode} / ${view} / ${presentation}`, async ({
        page,
        request,
      }) => {
        const project = createMarkdownProject("live-resolution");
        try {
          const { id, target } = await open(page, request, project);
          await makeConflict(page, id, target);
          await chooseMode(page, mode);
          await chooseView(page, view);
          if (presentation === "Markdown")
            await page.getByTestId("revision-format").click();
          await page.getByTestId("revision-compare-changes").click();
          const comparison = page.getByTestId("revision-compare-dialog");
          await expect(comparison).toContainText("orchard");
          await expect(comparison).toContainText("garden");
          await comparison
            .getByRole("button", { name: "Done", exact: true })
            .click();
          const keepLocal = mode !== "Read";
          await page
            .getByTestId(keepLocal ? "revision-overwrite" : "revision-discard")
            .click();
          if (view !== "Changes")
            await expect(
              page.getByTestId("revision-resolve-dialog"),
            ).toContainText(`You are viewing ${view}`);
          await page.getByTestId("revision-resolve-confirm").click();
          await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
          await expect
            .poll(() => fs.readFileSync(target, "utf8"))
            .toContain(keepLocal ? "orchard schedule" : "garden schedule");
          expect(fs.readFileSync(target, "utf8")).toContain("lantern schedule");
          const saved = await (
            await request.get(`${api}/${id}`, { headers })
          ).json();
          expect(saved.draft.markdown).toContain("{#s1}");
          expect(
            saved.reviewComments.some((comment: { content: string }) =>
              comment.content.includes("red maple"),
            ),
          ).toBe(true);
          expectCompleteFeedback(saved);
          await page.reload();
          await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
          await expect(page.getByTestId("revision-mode")).toContainText(mode);
          await expect(page.getByTestId("revision-view")).toContainText(view);
        } finally {
          removeMarkdownProject(project);
        }
      });
    }
  }
}

test("Save separately preserves complete feedback and shows the actual path across folding and preview views", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("live-copy");
  try {
    const { id, target } = await open(page, request, project);
    await makeConflict(page, id, target);
    await chooseView(page, "Final");
    await page.setViewportSize({ width: 390, height: 844 });
    const fileBeforeCopy = fs.readFileSync(target, "utf8");
    const reviewBeforeCopy = await (
      await request.get(`${api}/${id}`, { headers })
    ).json();
    await page.getByTestId("revision-save-separately").click();
    const dialog = page.getByTestId("revision-save-copy-dialog");
    const field = page.getByTestId("revision-copy-path");
    await expect(field).not.toHaveValue("");
    await expect(dialog).toContainText("You are viewing Final");
    await field.fill(target);
    await expect(dialog).toContainText(
      "Choose an unused path different from the document and comparison inputs",
    );
    await expect(page.getByTestId("revision-save-copy-confirm")).toBeDisabled();
    const occupied = writeProjectFile(
      project,
      "occupied.md",
      "An existing unrelated file.\n",
    );
    await field.fill(occupied);
    await expect(dialog).toContainText("Choose an unused path");
    await expect(page.getByTestId("revision-save-copy-confirm")).toBeDisabled();
    expect(fs.readFileSync(occupied, "utf8")).toBe(
      "An existing unrelated file.\n",
    );
    fs.mkdirSync(path.join(project, "different-folder"));
    await field.fill(path.join(project, "different-folder", "separate.md"));
    await expect(dialog).toContainText(
      "relative links may resolve differently",
    );
    await expect(page.getByTestId("revision-save-copy-confirm")).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await expect(page.getByTestId("revision-save-copy-confirm")).toBeEnabled();
    const copy = path.join(project, "separate.md");
    await field.fill(copy);
    await page.setViewportSize({ width: 840, height: 420 });
    await expect(field).toHaveValue(copy);
    await expect
      .poll(() =>
        dialog.evaluate(
          (element) =>
            element.getBoundingClientRect().right <= window.innerWidth,
        ),
      )
      .toBe(true);
    await expect(page.getByTestId("revision-save-copy-confirm")).toBeEnabled();
    await page.getByTestId("revision-save-copy-confirm").dblclick();
    await expect(page.getByTestId("revision-copy-saved-path")).toHaveText(copy);
    expect(fs.readFileSync(target, "utf8")).toBe(fileBeforeCopy);
    expect(fs.readFileSync(copy, "utf8")).toContain("orchard schedule");
    expect(
      extractRoughdraftReviewIndex(fs.readFileSync(copy, "utf8")).items,
    ).toEqual([]);
    const link = await dialog
      .getByRole("link", { name: "Open saved review" })
      .getAttribute("href");
    expect(link).toBeTruthy();
    const copiedId = new URL(link ?? "", "http://localhost").searchParams.get(
      "comparison",
    );
    expect(copiedId).not.toBe(id);
    const copied = await (
      await request.get(`${api}/${copiedId}`, { headers })
    ).json();
    expect(copied.draft.markdown).toContain("{#s1}");
    expect(copied.reviewComments).toEqual(reviewBeforeCopy.reviewComments);
    expectCompleteFeedback(copied);
    const descendants = await (
      await request.get(`${api}/${id}`, { headers })
    ).json();
    expect(JSON.stringify(descendants)).toContain(copiedId);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByTestId("revision-view")).toContainText("Final");
  } finally {
    removeMarkdownProject(project);
  }
});

for (const feedbackKind of [
  "comment edit",
  "new reply",
  "new comment",
] as const) {
  test(`a fresh browser restores an unfinished ${feedbackKind} from a durable separate-copy checkpoint without submitting it`, async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const project = createMarkdownProject("live-copy-feedback");
    let fresh: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    try {
      const { id, target } = await open(page, request, project);
      const read = async (reviewId: string) =>
        (await request.get(`${api}/${reviewId}`, { headers })).json();
      const before = await read(id);
      const originalComment = before.reviewComments.find(
        (comment: { id: string }) => comment.id === "c13",
      );
      expect(originalComment).toBeDefined();
      const unfinished =
        "Unsubmitted feedback retained in the separate review, including after a fresh browser opens it.";
      const anchorQuote = "working release-plan document";
      if (feedbackKind !== "new comment")
        await page.getByTestId("comment-thread-c13").click();
      let draftId = "c13";
      if (feedbackKind === "comment edit") {
        await page.getByTestId("comment-rail-c13-action-edit").click();
      } else {
        if (feedbackKind === "new reply")
          await page.getByTestId("comment-rail-c13-action-reply").click();
        else {
          await selectRichText(page, anchorQuote);
          await page.getByTestId("selection-menu-action-comment").click();
        }
        const editor = page.getByTestId(/^comment-rail-.*-editor$/);
        await expect(editor).toBeVisible();
        const testId = await editor.getAttribute("data-testid");
        const id = /^comment-rail-(.+)-editor$/.exec(testId ?? "")?.[1];
        if (!id)
          throw new Error("The new feedback did not expose its draft ID");
        draftId = id;
        expect(draftId).not.toBe("c13");
      }
      await page.getByTestId(`comment-rail-${draftId}-editor`).fill(unfinished);
      await makeConflict(page, id, target);
      expect(
        (await read(id)).reviewComments.find(
          (comment: { id: string }) => comment.id === "c13",
        ),
      ).toEqual(originalComment);
      const originalFile = fs.readFileSync(target, "utf8");
      await page.getByTestId("revision-save-separately").click();
      const dialog = page.getByTestId("revision-save-copy-dialog");
      const destination = path.join(project, "feedback-copy.md");
      await page.getByTestId("revision-copy-path").fill(destination);
      await expect(
        page.getByTestId("revision-save-copy-confirm"),
      ).toBeEnabled();
      await page.getByTestId("revision-save-copy-confirm").click();
      await expect(page.getByTestId("revision-copy-saved-path")).toHaveText(
        destination,
      );
      const href = await dialog
        .getByRole("link", { name: "Open saved review" })
        .getAttribute("href");
      const url = new URL(href ?? "", baseURL);
      const copyId = url.searchParams.get("comparison");
      expect(copyId).toBeTruthy();
      if (!copyId)
        throw new Error("The saved copy did not provide its review ID");
      const saved = await read(copyId);
      const checkpoint = saved.recoveryCheckpoints.find(
        (entry: { kind?: string }) => entry.kind === "copy-feedback",
      );
      expect(checkpoint).toBeDefined();
      expect(checkpoint.uiDrafts.comments[draftId]).toMatchObject({
        value: unfinished,
        original:
          feedbackKind === "comment edit" ? originalComment.content : "",
        editing: true,
      });
      expect(
        saved.reviewComments.find(
          (comment: { id: string }) => comment.id === "c13",
        ),
      ).toEqual(originalComment);
      if (feedbackKind !== "comment edit") {
        expect(
          saved.reviewComments.find(
            (comment: { id: string }) => comment.id === draftId,
          ),
        ).toBeUndefined();
      }
      const copyFile = fs.readFileSync(destination, "utf8");
      expect(copyFile).not.toContain(unfinished);
      const cli = fileURLToPath(
        new URL("../../server/bin/roughdraft.mjs", import.meta.url),
      );
      const command = spawn(
        process.execPath,
        [cli, "comparison", url.href, "--read", "--json", "--no-open"],
        {
          cwd: project,
          env: { ...process.env, ROUGHDRAFT_NO_OPEN: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      command.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      command.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => command.kill("SIGKILL"), 10_000);
      const code = await new Promise<number | null>((resolve, reject) => {
        command.once("error", reject);
        command.once("close", resolve);
      }).finally(() => clearTimeout(timer));
      expect(code, stderr).toBe(0);
      const event = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((entry) => entry.event === "comparison.read");
      expect(event.comparison.recoveryCheckpoints).toContainEqual(
        expect.objectContaining({
          id: checkpoint.id,
          uiDrafts: checkpoint.uiDrafts,
        }),
      );
      await dialog.getByTestId("revision-copy-done").click();

      fresh = await browser.newContext();
      expect((await fresh.storageState()).origins).toEqual([]);
      const reopened = await fresh.newPage();
      await reopened.goto(url.href);
      await expect(richTextEditor(reopened)).toBeVisible();
      await expect(
        reopened.getByTestId(`comment-rail-${draftId}-editor`),
      ).toHaveCount(0);
      await reopened.getByTestId("revision-details").click();
      await reopened.getByTestId("revision-recovery-copies").click();
      const recovery = reopened.getByTestId("revision-recovery-dialog");
      await recovery
        .getByTestId(`revision-recovery-copy-${checkpoint.id}`)
        .click({ timeout: 7_500 });
      await expect(
        recovery.getByTestId("revision-recovery-restore-feedback"),
      ).toBeVisible();
      const beforeRestore = await read(copyId);
      const beforeRestoreFiles = {
        original: fs.readFileSync(target, "utf8"),
        copy: fs.readFileSync(destination, "utf8"),
      };
      fs.writeFileSync(
        test.info().outputPath("feedback-before-restore.json"),
        JSON.stringify(
          {
            feedbackKind,
            draftId,
            saved,
            beforeRestore,
            checkpoint,
            originalFile,
            copyFile,
            beforeRestoreFiles,
          },
          null,
          2,
        ),
      );
      expect(beforeRestore.reviewComments).toEqual(saved.reviewComments);
      expect(beforeRestoreFiles.original).toBe(originalFile);
      expect(beforeRestoreFiles.copy).toBe(copyFile);
      await recovery.getByTestId("revision-recovery-restore-feedback").click();
      await expect(recovery).toContainText("Unfinished feedback restored.");
      await recovery.getByTestId("revision-recovery-done").click();
      const restoredThread = feedbackKind === "new comment" ? draftId : "c13";
      await reopened.getByTestId(`comment-thread-${restoredThread}`).click();
      const restored = reopened
        .getByTestId(`comment-thread-${restoredThread}`)
        .getByTestId(`comment-rail-${draftId}-editor`);
      await expect(restored).toBeVisible();
      await expect(restored).toHaveValue(unfinished);
      await expect(
        reopened.getByTestId(`comment-rail-${draftId}-action-cancel`),
      ).toBeVisible();
      const after = await read(copyId);
      expect(after.reviewComments).toEqual(beforeRestore.reviewComments);
      expect(after.draft).toEqual(beforeRestore.draft);
      expect(
        (await read(id)).reviewComments.find(
          (comment: { id: string }) => comment.id === "c13",
        ),
      ).toEqual(originalComment);
      expect(fs.readFileSync(target, "utf8")).toBe(originalFile);
      expect(fs.readFileSync(destination, "utf8")).toBe(copyFile);
      if (feedbackKind !== "comment edit") {
        await reopened
          .getByTestId(`comment-rail-${draftId}-action-save`)
          .click();
        await expect
          .poll(async () =>
            (await read(copyId)).reviewComments.find(
              (comment: { id: string }) => comment.id === draftId,
            ),
          )
          .toMatchObject({
            id: draftId,
            content: unfinished,
            parentCommentId: feedbackKind === "new reply" ? "c13" : null,
          });
        const submitted = await read(copyId);
        expect(submitted.reviewComments).toHaveLength(
          beforeRestore.reviewComments.length + 1,
        );
        expect(
          submitted.reviewComments.find(
            (comment: { id: string }) => comment.id === "c13",
          ),
        ).toEqual(originalComment);
        if (feedbackKind === "new comment")
          expect(
            extractRoughdraftReviewIndex(submitted.draft.markdown).items.find(
              (item) => item.id === draftId,
            ),
          ).toMatchObject({
            kind: "comment",
            text: unfinished,
            anchorText: anchorQuote,
          });
        expect(fs.readFileSync(target, "utf8")).toBe(originalFile);
        expect(fs.readFileSync(destination, "utf8")).toBe(copyFile);
      }
    } finally {
      await fresh?.close();
      removeMarkdownProject(project);
    }
  });
}

test("incoming source updates retain the typing caret and shared Undo in a real browser", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("live-source-caret");
  try {
    const text = "First paragraph.\n\nMiddle paragraph.\n\nLast paragraph.\n";
    const target = writeProjectFile(project, "source.md", text);
    const response = await request.post(`${api}/document`, {
      headers,
      data: { targetPath: target, autosave: target },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    await page.getByTestId("revision-format").click();
    const source = page.getByTestId("revision-markdown").locator(".cm-content");
    await source.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    for (let offset = 0; offset < 3; offset++)
      await page.keyboard.press("ArrowRight");
    const incoming = text
      .replace("First", "Incoming first")
      .replace("Last", "Incoming last");
    fs.writeFileSync(target, incoming);
    await expect(source).toContainText("Incoming first");
    await expect(source).toContainText("Incoming last");
    await page.keyboard.insertText("!");
    const typed = incoming.replace("Middle", "Mid!dle");
    await expect.poll(() => fs.readFileSync(target, "utf8")).toBe(typed);
    await page.keyboard.press("Control+z");
    await expect.poll(() => fs.readFileSync(target, "utf8")).toBe(incoming);
    await page.keyboard.press("Control+Shift+Z");
    await expect.poll(() => fs.readFileSync(target, "utf8")).toBe(typed);
  } finally {
    removeMarkdownProject(project);
  }
});

test("idle disk adoption keeps both prepared History examples safely reopenable", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("live-history");
  try {
    const { id, target } = await open(page, request, project);
    for (const [suggestion, decision, passage] of [
      ["s10", "accept", "deliberately clear"],
      ["s11", "reject", "keep the comment history"],
    ] as const) {
      await page
        .getByTestId(`comment-rail-${suggestion}-action-${decision}`)
        .click();
      await expect
        .poll(async () => {
          const review = await (
            await request.get(`${api}/${id}`, { headers })
          ).json();
          return review.draft.reviewed?.find(
            (entry: { oldText: string; newText: string }) =>
              entry.oldText === passage || entry.newText === passage,
          )?.decision;
        })
        .toBe(decision);
    }
    const file = fs.readFileSync(target, "utf8");
    const changed = file.replace(
      "# Try Roughdraft",
      "An outside writer added this paragraph above both History examples.\n\n# Try Roughdraft",
    );
    expect(changed).not.toBe(file);
    fs.writeFileSync(target, changed);
    await expect(richTextEditor(page)).toContainText(
      "An outside writer added this paragraph",
    );
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    const historyButton = page.getByTestId("revision-reviewed");
    if (!(await historyButton.isVisible()))
      await page.getByTestId("revision-more").click();
    await historyButton.click();
    const history = page.getByTestId("revision-reviewed-dialog");
    await expect(history.getByTestId("revision-reopen-change")).toHaveCount(2);
    for (const button of await history
      .getByTestId("revision-reopen-change")
      .all())
      await expect(button).toBeEnabled();
    await history
      .getByTestId("revision-reviewed-entry")
      .filter({ hasText: "deliberately clear" })
      .getByTestId("revision-reopen-change")
      .click();
    await expect(history).toBeHidden();
    await expect(
      page.getByTestId("comment-rail-s10-action-accept"),
    ).toBeVisible();
    const restored = richTextEditor(page)
      .getByRole("paragraph")
      .filter({ hasText: "History Keep example" });
    await expect
      .poll(async () => {
        const bounds = await restored.boundingBox();
        const header = await page.getByTestId("revision-header").boundingBox();
        return Boolean(
          bounds &&
            header &&
            bounds.y >= header.y + header.height &&
            bounds.y + bounds.height <= (page.viewportSize()?.height ?? 0),
        );
      })
      .toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain(
      "An outside writer added this paragraph",
    );
  } finally {
    removeMarkdownProject(project);
  }
});
