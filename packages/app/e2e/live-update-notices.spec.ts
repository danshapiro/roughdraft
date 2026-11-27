import fs from "node:fs";
import { expect, test } from "@playwright/test";
import type { ReconcileRequest, SyncState } from "@roughdraft/rfm";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };
const original = "# Garden plan\n\nThe planting schedule is ready.\n";

test("an idle tab receives the final peer update when its previous live read was delayed", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("live-trailing-notice");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const target = writeProjectFile(project, "practice.md", original);
    const created = await request.post(`${api}/document`, {
      headers,
      data: { targetPath: target, autosave: "none", handoff: "chat" },
    });
    await expect(created).toBeOK();
    const { id } = await created.json();
    // Observe actual delivered worker messages without changing their handling.
    // The held response is released only after the later hint reaches this tab.
    await page.addInitScript(() => {
      const NativeWorker = window.SharedWorker;
      Reflect.set(window, "liveNoticeEvents", []);
      window.SharedWorker = class extends NativeWorker {
        constructor(url: string | URL, options?: string | WorkerOptions) {
          super(url, options);
          this.port.addEventListener("message", (event) => {
            Reflect.get(window, "liveNoticeEvents").push(event.data);
          });
        }
      };
    });
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Review saved",
    );
    let captured = false;
    await page.route(`**/api/comparisons/${id}/state`, async (route) => {
      const response = await route.fetch();
      if (!captured && response.status() === 200) {
        const state = (await response.json()) as SyncState;
        if (state.draft.markdown.includes("Peer one.")) {
          captured = true;
          await held;
        }
      }
      await route.fulfill({ response });
    });
    let sequence = 0;
    const publish = async (markdown: string) => {
      const state = (await (
        await request.get(`${api}/${id}/state`, { headers })
      ).json()) as SyncState;
      const body: ReconcileRequest = {
        operationId: crypto.randomUUID(),
        pageInstanceId: "notice-peer",
        operationSequence: ++sequence,
        operationContext: state.operationContext,
        expectedRevision: state.revision,
        baseRevision: state.revision,
        baseSignature: state.signature,
        base: state.draft,
        draft: { ...state.draft, markdown, cleanMarkdown: markdown },
        expectedDisk: state.disk
          ? {
              path: state.disk.path,
              version: state.disk.version,
              hash: state.disk.hash,
            }
          : null,
        localGeneration: sequence,
        writeFile: false,
        reason: "sync",
      };
      const response = await request.post(`${api}/${id}/reconcile`, {
        headers,
        data: body,
      });
      await expect(response).toBeOK();
      const result = await response.json();
      expect(result.status).toBe("committed");
      return result.state.revision as number;
    };
    await publish(`${original}\nPeer one.\n`);
    await expect.poll(() => captured).toBe(true);
    const latestRevision = await publish(
      `${original}\nPeer one.\n\nPeer two.\n`,
    );
    await expect
      .poll(() =>
        page.evaluate(
          (revision) =>
            Reflect.get(window, "liveNoticeEvents").some((event: unknown) =>
              JSON.stringify(event).includes(`"revision":${revision}`),
            ),
          latestRevision,
        ),
      )
      .toBe(true);
    release();
    await expect(richTextEditor(page)).toContainText("Peer two.");
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  } finally {
    release();
    removeMarkdownProject(project);
  }
});

test("restoring an unchanged missing file clears its banner and resumes autosave", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("live-returned-file");
  try {
    const target = writeProjectFile(project, "practice.md", original);
    const created = await request.post(`${api}/document`, {
      headers,
      data: { targetPath: target, autosave: target, handoff: "chat" },
    });
    await expect(created).toBeOK();
    const { id } = await created.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
    fs.renameSync(target, `${target}.held`);
    await expect(page.getByTestId("revision-conflict")).toContainText(
      /missing/i,
    );
    fs.renameSync(`${target}.held`, target);
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    await selectRichText(page, "planting schedule");
    await page.keyboard.insertText("orchard schedule");
    await expect
      .poll(() => fs.readFileSync(target, "utf8"))
      .toContain("orchard schedule");
    await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
      "aria-label",
      "Saved to file",
    );
  } finally {
    removeMarkdownProject(project);
  }
});
