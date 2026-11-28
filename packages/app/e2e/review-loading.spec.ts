import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
} from "./helpers";

for (const profile of [
  {
    name: "1.6 Mbps, 150 ms",
    latency: 150,
    download: 200_000,
    upload: 100_000,
    readyBudget: 12_000,
    preparedHistory: false,
  },
  {
    name: "400 kbps, 400 ms",
    latency: 400,
    download: 50_000,
    upload: 25_000,
    readyBudget: 25_000,
    preparedHistory: true,
  },
]) {
  test(`a complex review loads and reuses downloaded code (${profile.name})`, async ({
    page,
    context,
    request,
  }, testInfo) => {
    test.skip(
      process.env.PLAYWRIGHT_PRODUCTION !== "1",
      "Measures built delivery",
    );
    test.setTimeout(90_000);
    const project = createMarkdownProject("review-loading");
    const fixtures = fileURLToPath(
      new URL("../../../docs/spec/fixtures/", import.meta.url),
    );
    fs.cpSync(fixtures, project, { recursive: true });
    const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
    const response = await request.post(api, {
      data: {
        editor: "unified",
        mode: "compare",
        beforePath: path.join(project, "editing-review-original.md"),
        afterPath: path.join(project, "editing-review.md"),
        autosave: "none",
        handoff: "chat",
      },
    });
    await expect(response).toBeOK();
    const { id } = await response.json();
    const cdp = await context.newCDPSession(page);
    const metrics: Record<string, unknown> = { profile };
    try {
      if (profile.preparedHistory) {
        await page.goto(`/?comparison=${id}`);
        await expect(richTextEditor(page)).toBeVisible();
        await page.getByTestId("comment-rail-s10-action-accept").click();
        await page.getByTestId("comment-rail-s11-action-reject").click();
        await expect
          .poll(async () => {
            const response = await request.get(`${api}/${id}/state`);
            return (await response.json()).draft.reviewed.length;
          })
          .toBe(2);
        await page.goto("about:blank");
      }
      await cdp.send("Network.enable");
      await cdp.send("Network.clearBrowserCache");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: profile.latency,
        downloadThroughput: profile.download,
        uploadThroughput: profile.upload,
      });
      const readResources = () =>
        page.evaluate(() =>
          performance.getEntriesByType("resource").map((entry) => {
            const resource = entry as PerformanceResourceTiming;
            return {
              name: new URL(resource.name).pathname,
              type: resource.initiatorType,
              transfer: resource.transferSize,
              encoded: resource.encodedBodySize,
              decoded: resource.decodedBodySize,
            };
          }),
        );
      const start = Date.now();
      await page.goto(`/?comparison=${id}`);
      await expect(richTextEditor(page)).toBeVisible({ timeout: 45_000 });
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        "Review saved",
      );
      metrics.coldReadyMs = Date.now() - start;
      const cold = await readResources();
      const scripts = cold.filter((resource) => resource.type === "script");
      metrics.cold = cold;
      const bytes = scripts.reduce(
        (total, resource) => total + resource.transfer,
        0,
      );
      metrics.coldScriptBytes = bytes;
      expect.soft(bytes).toBeLessThan(800_000);
      expect.soft(metrics.coldReadyMs).toBeLessThan(profile.readyBudget);

      await page.getByTestId("revision-format").click();
      await expect(
        page.getByTestId("revision-markdown").locator(".cm-content"),
      ).toBeVisible({ timeout: 20_000 });
      const source = await readResources();
      const newScripts = source.filter(
        (resource) =>
          resource.type === "script" &&
          !scripts.some((item) => item.name === resource.name),
      );
      metrics.sourceScripts = newScripts;
      expect.soft(newScripts.length).toBeGreaterThan(0);
      await page.getByTestId("revision-format").click();

      const warmStart = Date.now();
      await page.reload();
      await expect(richTextEditor(page)).toBeVisible({ timeout: 20_000 });
      metrics.warmReadyMs = Date.now() - warmStart;
      const warm = await readResources();
      metrics.warm = warm;
      expect
        .soft(
          warm
            .filter((resource) => resource.type === "script")
            .reduce((total, resource) => total + resource.transfer, 0),
        )
        .toBe(0);

      await page.getByTestId("revision-mode").click();
      await page.getByTestId("revision-mode-edit").click();
      await richTextEditor(page).click();
      await page.keyboard.press("Control+End");
      await page.evaluate(() => {
        const inputs: number[] = [];
        (
          window as unknown as { loadingInputTimes: number[] }
        ).loadingInputTimes = inputs;
        document
          .querySelector(".ProseMirror")
          ?.addEventListener("input", () => inputs.push(performance.now()));
      });
      const text = " Typing stays responsive.";
      await page.keyboard.type(text);
      await expect(richTextEditor(page)).toContainText(text.trim());
      const inputTimes = await page.evaluate(
        () =>
          (window as unknown as { loadingInputTimes: number[] })
            .loadingInputTimes,
      );
      const longestGap = Math.max(
        0,
        ...inputTimes.slice(1).map((time, index) => time - inputTimes[index]),
      );
      metrics.typing = { inputs: inputTimes.length, longestGapMs: longestGap };
      expect(inputTimes).toHaveLength(text.length);
      expect(longestGap).toBeLessThan(500);
    } finally {
      fs.writeFileSync(
        testInfo.outputPath("loading-metrics.json"),
        JSON.stringify(metrics, null, 2),
      );
      await testInfo.attach("loading-metrics", {
        body: JSON.stringify(metrics, null, 2),
        contentType: "application/json",
      });
      await cdp.detach();
      await page.goto("about:blank");
      removeMarkdownProject(project);
    }
  });
}
