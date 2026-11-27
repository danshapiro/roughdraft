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
