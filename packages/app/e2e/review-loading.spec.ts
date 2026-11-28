import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
} from "./helpers";

test("a complex review loads over a limited connection and reuses downloaded code", async ({
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
  const metrics: Record<string, unknown> = {};
  try {
    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 200_000,
      uploadThroughput: 100_000,
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
    expect.soft(metrics.coldReadyMs).toBeLessThan(12_000);

    await page
      .getByRole("button", { name: "Show Markdown", exact: true })
      .click();
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
    await page
      .getByRole("button", { name: "Show formatted document", exact: true })
      .click();

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
