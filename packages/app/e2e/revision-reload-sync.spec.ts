import fs from "node:fs";
import { expect, test } from "@playwright/test";
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
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let reloaded = false;
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

    const oldSnapshot = await request.get(`${api}/${id}`, { headers });
    await expect(oldSnapshot).toBeOK();
    await page.route(`**/api/comparisons/${id}/state**`, async (route) => {
      if (!reloaded) await responseGate;
      try {
        await route.continue();
      } catch (error) {
        if (!reloaded) throw error;
      }
    });
    let committed = false;
    let operationId: string | undefined;
    await page.route(`**/api/comparisons/${id}/reconcile`, async (route) => {
      const sent = route.request().postDataJSON();
      if (operationId || sent.draft?.cleanMarkdown !== "Reviewed wording\n") {
        await route.continue();
        return;
      }
      // Commit the original request once. Only its acknowledgement is held;
      // replaying an unreceived operation after reload is correctly fenced.
      operationId = sent.operationId;
      const response = await route.fetch();
      expect((await response.json()).status).toBe("committed");
      committed = true;
      await responseGate;
      try {
        await route.fulfill({ response });
      } catch (error) {
        if (!reloaded) throw error;
      }
    });
    await selectRichText(page, "Original wording");
    // Hold the complete snapshot this reload is meant to acknowledge. Per-key
    // typing can start an earlier save that blocks the final request behind it.
    await page.keyboard.insertText("Reviewed wording");
    await expect.poll(() => committed).toBe(true);
    expect(operationId).toBeTruthy();

    // Present revision N to the reloaded page while the real saved state is
    // N+1. Recovery must recognize the unacknowledged operation, rather than
    // treating its own saved work as a conflicting second tab.
    let servedOldSnapshot = false;
    await page.route(`**/api/comparisons/${id}`, async (route) => {
      if (servedOldSnapshot || route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      servedOldSnapshot = true;
      await route.fulfill({ response: oldSnapshot });
    });
    reloaded = true;
    await page.reload();
    await expect(richTextEditor(page)).toHaveText("Reviewed wording");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    expect(servedOldSnapshot).toBe(true);
    // Either the authoritative state or the operation lookup can recognize
    // this acknowledgement. The original operation must remain committed.
    const outcome = await request.get(`${api}/operations/${operationId}`, {
      headers,
    });
    await expect(outcome).toBeOK();
    expect((await outcome.json()).status).toBe("committed");
    const persisted = await request.get(`${api}/${id}`, { headers });
    expect((await persisted.json()).draft.cleanMarkdown).toBe(
      "Reviewed wording\n",
    );
    expect(fs.readFileSync(source, "utf8")).toBe("Original wording\n");
  } finally {
    releaseResponse();
    removeMarkdownProject(project);
  }
});
