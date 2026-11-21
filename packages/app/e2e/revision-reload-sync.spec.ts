import fs from "node:fs";
import { type APIResponse, expect, type Route, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const apiPort = process.env.API_PORT ?? "4317";
const api = `http://127.0.0.1:${apiPort}/api/comparisons`;
const headers = { Connection: "close" };

test("reloading during the last draft save acknowledges that same saved snapshot", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("review-reload-sync");
  try {
    const source = writeProjectFile(project, "draft.md", "Original wording\n");
    const created = await request.post(`${api}/document`, {
      headers,
      data: {
        targetPath: source,
        autosave: "none",
        title: "Review the onboarding wording",
      },
    });
    await expect(created).toBeOK();
    const { id } = await created.json();
    await page.goto(`/?comparison=${id}`);
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );

    const pendingRoutes: Route[] = [];
    let pendingDraft: Record<string, unknown> | undefined;
    let committed = false;
    await page.route(`**/api/comparisons/${id}/draft`, async (route) => {
      if (!committed) {
        pendingRoutes.push(route);
        pendingDraft = route.request().postDataJSON();
        return;
      }
      await route.continue();
    });
    await selectRichText(page, "Original wording");
    await page.keyboard.type("Reviewed wording");
    await expect
      .poll(() => pendingDraft?.cleanMarkdown)
      .toBe("Reviewed wording\n");

    // The reload reads revision N just before the old page's pending request
    // commits N+1. Its new editor must recognize the identical saved draft,
    // rather than treating its own in-flight work as a conflicting second tab.
    let transition: Promise<APIResponse> | undefined;
    await page.route(`**/api/comparisons/${id}`, async (route) => {
      if (committed || route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      transition ??= (async () => {
        const oldSnapshot = await route.fetch();
        const persisted = await request.post(`${api}/${id}/draft`, {
          headers,
          data: pendingDraft,
        });
        expect(persisted.status()).toBe(200);
        committed = true;
        return oldSnapshot;
      })();
      const oldSnapshot = await transition;
      await route.fulfill({ response: oldSnapshot });
      await Promise.all(
        pendingRoutes.map((pending) => pending.abort().catch(() => {})),
      );
    });
    await page.reload();
    await expect(richTextEditor(page)).toContainText("Reviewed wording");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    const persisted = await request.get(`${api}/${id}`, { headers });
    expect((await persisted.json()).draft.cleanMarkdown).toBe(
      "Reviewed wording\n",
    );
    expect(fs.readFileSync(source, "utf8")).toBe("Original wording\n");
  } finally {
    removeMarkdownProject(project);
  }
});
