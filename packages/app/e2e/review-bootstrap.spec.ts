import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const fallback of [false, true]) {
  test(`an outside edit between the first read and subscription is adopted (${fallback ? "conditional requests" : "shared stream"})`, async ({
    page,
    request,
  }, testInfo) => {
    const project = createMarkdownProject("bootstrap-race");
    const original = "# Release plan\n\nThe agent's original paragraph.\n";
    const incoming =
      "# Release plan\n\nThe agent updated this paragraph before subscription.\n";
    const target = writeProjectFile(project, "review.md", original);
    const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
    const opened = await request.post(`${api}/document`, {
      data: { targetPath: target, autosave: "none", handoff: "chat" },
    });
    await expect(opened).toBeOK();
    const { id } = await opened.json();
    if (fallback)
      await page.addInitScript(() =>
        Object.defineProperty(window, "SharedWorker", { value: undefined }),
      );
    const captured = signal();
    const release = signal();
    const reads: string[] = [];
    const writes: unknown[] = [];
    await page.route(`**/api/comparisons/${id}/state*`, async (route) => {
      const index = reads.push(route.request().url());
      const response = await route.fetch();
      if (index === 1) {
        captured.resolve();
        await release.promise;
      }
      await route.fulfill({ response });
    });
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/${id}/reconcile`)
      )
        writes.push(request.postDataJSON());
    });
    try {
      await page.goto(`/?comparison=${id}`);
      await captured.promise;
      // A subscription must not start a second full read while this one waits.
      expect(reads).toHaveLength(1);
      fs.writeFileSync(target, incoming);
      release.resolve();
      await expect(richTextEditor(page)).toContainText("before subscription.");
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        "Review saved",
      );
      expect(fs.readFileSync(target, "utf8")).toBe(incoming);
      expect(
        writes.every((value) => !(value as { writeFile?: boolean }).writeFile),
      ).toBe(true);
      await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    } finally {
      release.resolve();
      await testInfo.attach("bootstrap-race-requests", {
        body: JSON.stringify({ fallback, reads, writes }, null, 2),
        contentType: "application/json",
      });
      await page.goto("about:blank");
      removeMarkdownProject(project);
    }
  });
}
