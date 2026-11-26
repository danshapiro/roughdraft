import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const fixtures = fileURLToPath(
  new URL("../../../docs/spec/fixtures/", import.meta.url),
);
const markdown = fs.readFileSync(
  path.join(fixtures, "editing-review.md"),
  "utf8",
);
const headers = { Connection: "close" };

for (const action of ["restore", "dismiss"] as const) {
  test(`a new tab can ${action} closed-browser work and finish recovery without submitting unfinished feedback`, async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(45_000);
    const project = createMarkdownProject(`browser-recovery-${action}`);
    try {
      const target = writeProjectFile(project, "practice.md", markdown);
      fs.cpSync(
        path.join(fixtures, "editing-review-assets"),
        path.join(project, "editing-review-assets"),
        { recursive: true },
      );
      fs.copyFileSync(
        path.join(fixtures, "editing-review-linked.md"),
        path.join(project, "editing-review-linked.md"),
      );
      const created = await request.post(`${api}/document`, {
        headers,
        data: {
          targetPath: target,
          autosave: target,
          title: "Recover private release-plan work from a closed tab",
        },
      });
      await expect(created).toBeOK();
      const { id } = await created.json();
      const url = `/?comparison=${id}`;
      await page.goto(url);
      await expect(richTextEditor(page)).toBeVisible();
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        /^(Saved to file|Review saved)$/,
      );
      const initial = await (
        await request.get(`${api}/${id}`, { headers })
      ).json();
      await page.getByTestId("comment-thread-c13").click();
      await page.getByTestId("comment-rail-c13-action-edit").click();
      const unfinished =
        "Private feedback from the closed tab; do not submit it while recovering.";
      await page.getByTestId("comment-rail-c13-editor").fill(unfinished);
      if (action === "restore") {
        await page.route(`**/api/comparisons/${id}/reconcile`, (route) => {
          if (
            route
              .request()
              .postDataJSON()
              .draft.markdown.includes("private browser schedule")
          )
            return route.abort("failed");
          return route.continue();
        });
        await selectRichText(page, "planting schedule");
        await page.keyboard.insertText("private browser schedule");
      }
      await expect
        .poll(() =>
          page.evaluate(
            ({ id, action }) =>
              Object.entries(sessionStorage).some(([key, value]) => {
                if (!key.startsWith(`roughdraft-draft:${id}:`)) return false;
                const record = JSON.parse(value);
                return (
                  record.uiDrafts?.comments?.c13?.value?.includes(
                    "Private feedback from",
                  ) &&
                  (action === "dismiss" ||
                    record.draft.markdown.includes("private browser schedule"))
                );
              }),
            { id, action },
          ),
        )
        .toBe(true);
      await page.close();
      const reopened = await context.newPage();
      await reopened.goto(url);
      await expect(richTextEditor(reopened)).toBeVisible();
      await reopened
        .getByTestId("revision-browser-recovery-inspect")
        .click({ timeout: 18_000 });
      const dialog = reopened.getByTestId("revision-recovery-dialog");
      const orphan = dialog.getByTestId(/^revision-recovery-orphan-/);
      await expect(orphan).toHaveCount(1);
      await orphan.click();
      if (action === "restore") {
        await expect(
          dialog.getByTestId("revision-recovery-source"),
        ).toContainText("private browser schedule");
        await dialog.getByTestId("revision-recovery-claim").click();
        await expect(dialog).toContainText("Browser work restored.");
      } else {
        await dialog.getByTestId("revision-recovery-dismiss").click();
        await expect(dialog).toContainText(
          "This removes only this browser recovery copy",
        );
        await dialog.getByTestId("revision-recovery-dismiss-confirm").click();
        await expect(dialog).toContainText("Browser recovery copy dismissed.");
      }
      await expect(
        dialog.getByTestId(/^revision-recovery-orphan-/),
      ).toHaveCount(0);
      await dialog.getByTestId("revision-recovery-done").click();
      if (action === "restore") {
        await expect(richTextEditor(reopened)).toContainText(
          "private browser schedule",
        );
        await reopened.getByTestId("comment-thread-c13").click();
        await expect(
          reopened.getByTestId("comment-rail-c13-editor"),
        ).toHaveValue(unfinished);
        await expect
          .poll(
            async () =>
              (await (await request.get(`${api}/${id}`, { headers })).json())
                .draft.markdown,
          )
          .toContain("private browser schedule");
      } else {
        await expect(
          reopened.getByTestId("revision-browser-recovery-inspect"),
        ).toHaveCount(0);
        expect(fs.readFileSync(target, "utf8")).toBe(markdown);
      }
      const final = await (
        await request.get(`${api}/${id}`, { headers })
      ).json();
      expect(
        final.reviewComments.find(
          (comment: { id: string }) => comment.id === "c13",
        ),
      ).toEqual(
        initial.reviewComments.find(
          (comment: { id: string }) => comment.id === "c13",
        ),
      );
      expect(fs.readFileSync(target, "utf8")).not.toContain(unfinished);
      await reopened.close();
    } finally {
      removeMarkdownProject(project);
    }
  });
}
