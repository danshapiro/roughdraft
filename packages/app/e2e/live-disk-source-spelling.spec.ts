import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };
const original =
  "# Plan\n\nThe release supports for longer documents.\n\nBeta paragraph.\n";
const incoming = original.replace(
  "Beta paragraph.",
  "Beta paragraph, edited by the agent.",
);

function proposals(markdown: string) {
  return extractRoughdraftReviewIndex(markdown)
    .items.filter((item) => item.kind === "suggestion")
    .map((item) => ({ id: item.id, text: item.replacementText ?? item.text }));
}

for (const bound of [true, false]) {
  test(`a native pending insertion preserves exact agent prose through disk adoption and reload (${bound ? "bound file" : "autosave none"})`, async ({
    page,
    request,
  }, testInfo) => {
    const project = createMarkdownProject("native-disk-source-spelling");
    const target = writeProjectFile(project, "practice.md", original);
    const reconciles: Array<{ reason: string; writeFile: boolean }> = [];
    let before: ComparisonReviewData | undefined;
    let after: ComparisonReviewData | undefined;
    let reloaded: ComparisonReviewData | undefined;
    let adoptionStartsAt = 0;
    page.on("request", (request) => {
      if (!request.url().endsWith("/reconcile") || request.method() !== "POST")
        return;
      const body = request.postDataJSON();
      reconciles.push({ reason: body.reason, writeFile: body.writeFile });
    });
    try {
      const created = await request.post(`${api}/document`, {
        headers,
        data: {
          targetPath: target,
          autosave: bound ? target : "none",
          handoff: "chat",
        },
      });
      await expect(created).toBeOK();
      const { id } = await created.json();
      const read = async (): Promise<ComparisonReviewData> => {
        const response = await request.get(`${api}/${id}`, { headers });
        await expect(response).toBeOK();
        return response.json();
      };
      const saved = () =>
        expect(page.getByTestId("revision-file-status")).toHaveAttribute(
          "aria-label",
          /^(Review saved|Saved to file)$/,
        );
      await page.goto(`/?comparison=${id}`);
      await expect(richTextEditor(page)).toBeVisible();
      await saved();
      await page.getByTestId("revision-mode").click();
      await page.getByTestId("revision-mode-suggest").click();
      await selectRichText(page, "for longer");
      await page.keyboard.press("ArrowLeft");
      // Native Suggest typing moves the trailing space outside the markup.
      // Its accepted projection must retain the original single gap.
      await page.keyboard.type("offline review ");
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      await expect
        .poll(async () => (await read()).draft?.markdown)
        .toContain("offline review");
      await saved();
      before = await read();
      const pending = proposals(before.draft?.markdown ?? "");
      expect(pending).toHaveLength(1);
      expect(pending[0].text.trim()).toBe("offline review");
      expect(before.draft?.cleanMarkdown).toBe(original);
      expect(fs.readFileSync(target, "utf8")).toBe(original);
      adoptionStartsAt = reconciles.length;
      fs.writeFileSync(target, incoming);
      await expect(richTextEditor(page)).toContainText(
        "Beta paragraph, edited by the agent.",
      );
      await expect(richTextEditor(page)).toContainText(
        "The release supports offline review for longer documents.",
      );
      await expect
        .poll(async () => (await read()).draft?.markdown)
        .toContain("Beta paragraph, edited by the agent.");
      await saved();
      after = await read();
      await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      expect.soft(proposals(after.draft?.markdown ?? "")).toEqual(pending);
      expect.soft(after.draft?.cleanMarkdown).toBe(incoming);
      expect.soft(fs.readFileSync(target, "utf8")).toBe(incoming);
      expect
        .soft(
          reconciles.slice(adoptionStartsAt).filter((value) => value.writeFile),
        )
        .toEqual([]);

      await page.reload();
      await expect(richTextEditor(page)).toContainText(
        "Beta paragraph, edited by the agent.",
      );
      await expect(richTextEditor(page)).toContainText(
        "The release supports offline review for longer documents.",
      );
      await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
      await expect(page.getByTestId("revision-pending")).toHaveText("1");
      await saved();
      reloaded = await read();
      expect.soft(proposals(reloaded.draft?.markdown ?? "")).toEqual(pending);
      expect.soft(reloaded.draft?.cleanMarkdown).toBe(incoming);
      expect.soft(fs.readFileSync(target, "utf8")).toBe(incoming);
      expect
        .soft(
          reconciles.slice(adoptionStartsAt).filter((value) => value.writeFile),
        )
        .toEqual([]);
    } finally {
      const evidence = testInfo.outputPath("native-disk-source-spelling.json");
      fs.writeFileSync(
        evidence,
        JSON.stringify(
          {
            bound,
            before,
            after,
            reloaded,
            reconciles,
            adoptionStartsAt,
            file: fs.readFileSync(target, "utf8"),
          },
          null,
          2,
        ),
      );
      await testInfo.attach("native-disk-source-spelling", {
        contentType: "application/json",
        path: evidence,
      });
      removeMarkdownProject(project);
    }
  });
}

test("explicit Reload from file completes when exact mixed metadata prevents automatic adoption", async ({
  page,
  request,
}, testInfo) => {
  const original =
    '# Plan\r\n\r\nThe release supports {++offline review++}{#s1} for longer documents.\r\n\r\nBeta paragraph.\r\n\r\n---\r\n# Keep this metadata comment.\r\nstatus: "in progress" # Keep this scalar comment.\r\nsuggestions:\r\n  s1:\r\n    by: AI\r\n    at: "2026-11-22T12:00:00.000Z"\r\n';
  const incoming = original.replace(
    "Beta paragraph.",
    "Beta paragraph, edited.",
  );
  const project = createMarkdownProject("explicit-disk-reload");
  const target = writeProjectFile(project, "practice.md", original);
  const reconciles: Array<{ reason: string; writeFile: boolean }> = [];
  let stage = "opening the original file";
  let latest: ComparisonReviewData | undefined;
  page.on("request", (request) => {
    if (!request.url().endsWith("/reconcile") || request.method() !== "POST")
      return;
    const body = request.postDataJSON();
    reconciles.push({ reason: body.reason, writeFile: body.writeFile });
  });
  try {
    const created = await request.post(`${api}/document`, {
      headers,
      data: { targetPath: target, autosave: target, handoff: "chat" },
    });
    await expect(created).toBeOK();
    const { id } = await created.json();
    const read = async (): Promise<ComparisonReviewData> => {
      const response = await request.get(`${api}/${id}`, { headers });
      await expect(response).toBeOK();
      latest = await response.json();
      return latest as ComparisonReviewData;
    };
    const saved = () =>
      expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        /^(Review saved|Saved to file)$/,
      );
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await saved();
    await expect.poll(async () => (await read()).savedText).toBe(original);
    const pending = proposals(latest?.draft?.markdown ?? "");
    expect(pending).toEqual([{ id: "s1", text: "offline review" }]);
    expect(fs.readFileSync(target, "utf8")).toBe(original);

    stage = "waiting for the outside update";
    fs.writeFileSync(target, incoming);
    const banner = page.getByTestId("revision-conflict");
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("revision-reload-file")).toBeVisible();
    await expect(page.getByTestId("revision-save-separately")).toBeVisible();
    await expect(page.getByTestId("revision-discard")).toHaveCount(0);
    await expect(page.getByTestId("revision-overwrite")).toHaveCount(0);
    expect(fs.readFileSync(target, "utf8")).toBe(incoming);

    stage = "confirming explicit Reload from file";
    await page.getByTestId("revision-reload-file").click();
    const dialog = page.getByTestId("revision-reload-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("revision-reload-confirm").click();
    stage = "waiting for explicit Reload to complete";
    await expect(dialog).toBeHidden();
    await expect(banner).toHaveCount(0);
    await expect(richTextEditor(page)).toContainText("Beta paragraph, edited.");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await saved();
    await expect.poll(async () => (await read()).savedText).toBe(incoming);
    expect(proposals(latest?.draft?.markdown ?? "")).toEqual(pending);
    expect(fs.readFileSync(target, "utf8")).toBe(incoming);
    expect(reconciles.filter((value) => value.writeFile)).toEqual([]);

    stage = "reopening the acknowledged raw file";
    await page.reload();
    await expect(richTextEditor(page)).toContainText("Beta paragraph, edited.");
    await expect(richTextEditor(page)).toContainText("offline review");
    await expect(page.getByTestId("revision-pending")).toHaveText("1");
    await expect(banner).toHaveCount(0);
    await saved();
    const reloaded = await read();
    expect(reloaded.savedText).toBe(incoming);
    expect(proposals(reloaded.draft?.markdown ?? "")).toEqual(pending);
    expect(fs.readFileSync(target, "utf8")).toBe(incoming);
    expect(reconciles.filter((value) => value.writeFile)).toEqual([]);
    stage = "complete";
  } finally {
    const evidence = testInfo.outputPath("explicit-disk-reload.json");
    fs.writeFileSync(
      evidence,
      JSON.stringify(
        {
          stage,
          latest,
          reconciles,
          file: fs.readFileSync(target, "utf8"),
          banners: await page
            .getByTestId("revision-conflict")
            .allTextContents(),
          dialogs: await page
            .getByTestId("revision-reload-dialog")
            .allTextContents(),
        },
        null,
        2,
      ),
    );
    await testInfo.attach("explicit-disk-reload", {
      contentType: "application/json",
      path: evidence,
    });
    removeMarkdownProject(project);
  }
});
