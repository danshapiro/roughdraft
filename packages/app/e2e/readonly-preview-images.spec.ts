import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };

for (const mode of ["document", "comparison"] as const) {
  test(`${mode}: Original and Final load sibling images without editing or rewriting their source @smoke`, async ({
    page,
    request,
  }) => {
    const project = createMarkdownProject("readonly-preview-images");
    const markdown =
      "# Release review\n\n![Test image](./pixel.svg)\n\n{~~Old wording~>New wording~~}{#s1}.\n";
    const before =
      mode === "comparison"
        ? markdown.replace("{~~Old wording~>New wording~~}{#s1}", "Old wording")
        : markdown;
    const after =
      mode === "comparison"
        ? markdown.replace("{~~Old wording~>New wording~~}{#s1}", "New wording")
        : markdown;
    const beforePath = writeProjectFile(
      project,
      mode === "comparison" ? "original/Draft.md" : "Draft.md",
      before,
    );
    const afterPath =
      mode === "comparison"
        ? writeProjectFile(project, "final/Draft.md", after)
        : beforePath;
    const originalWidth = mode === "comparison" ? 2 : 1;
    const finalWidth = mode === "comparison" ? 3 : 1;
    const svg = (width: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1"><rect width="${width}" height="1" fill="green"/></svg>`;
    writeProjectFile(
      project,
      mode === "comparison" ? "original/pixel.svg" : "pixel.svg",
      svg(originalWidth),
    );
    if (mode === "comparison")
      writeProjectFile(project, "final/pixel.svg", svg(finalWidth));
    const sourceFiles = [...new Set([beforePath, afterPath])];
    const sourceHashes = () =>
      Object.fromEntries(
        sourceFiles.map((filename) => [
          filename,
          createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        ]),
      );
    const hashesBefore = sourceHashes();
    let currentView = "Changes";
    let comparisonId = "";
    const imageRequests: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "image") imageRequests.push(request.url());
    });
    try {
      const response = await request.post(
        mode === "document" ? `${api}/document` : api,
        {
          headers,
          data:
            mode === "document"
              ? { targetPath: beforePath, autosave: "none", handoff: "chat" }
              : {
                  editor: "unified",
                  mode: "compare",
                  beforePath,
                  afterPath,
                  autosave: "none",
                  handoff: "chat",
                },
        },
      );
      await expect(response).toBeOK();
      const { id } = await response.json();
      comparisonId = id;
      const read = async () => {
        const response = await request.get(`${api}/${id}/state`, { headers });
        await expect(response).toBeOK();
        return response.json();
      };
      await page.goto(`/?comparison=${id}`);
      await expect(richTextEditor(page)).toBeVisible();
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        "Review saved",
      );
      const changesImage = richTextEditor(page).getByRole("img", {
        name: "Test image",
      });
      await changesImage.scrollIntoViewIfNeeded();
      await expect(changesImage).toHaveJSProperty("naturalWidth", finalWidth);
      expect(imageRequests.map((url) => new URL(url).pathname)).toEqual(
        imageRequests.map(() => "/api/files"),
      );
      const initial = await read();
      const mutations: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && request.url().includes("/api/"))
          mutations.push(request.url());
      });
      for (const [view, id, wording, expectedWidth, sourcePath] of [
        ["Original", "rejected", "Old wording", originalWidth, beforePath],
        ["Final", "accepted", "New wording", finalWidth, afterPath],
      ] as const) {
        currentView = view;
        await page.getByTestId("revision-view").click();
        await page.getByTestId(`revision-view-${id}`).click();
        const preview = page.getByTestId("revision-preview");
        const body = preview.locator(".ProseMirror");
        await expect(body).toHaveAttribute("contenteditable", "false");
        await expect(body).toContainText(wording);
        const image = preview.getByRole("img", { name: "Test image" });
        await image.scrollIntoViewIfNeeded();
        await expect(image).toHaveJSProperty("naturalWidth", expectedWidth);
        expect(imageRequests.map((url) => new URL(url).pathname)).toEqual(
          imageRequests.map(() => "/api/files"),
        );
        const imagePath = await image.getAttribute("src");
        expect(imagePath).toBeTruthy();
        const asset = await request.get(imagePath ?? "");
        await expect(asset).toBeOK();
        expect(asset.headers()["content-type"]).toContain("image/svg+xml");
        const imageUrl = new URL(imagePath ?? "", page.url());
        expect(imageUrl.pathname).toBe("/api/files");
        expect(imageUrl.searchParams.get("projectPath")).toBe(
          path.dirname(sourcePath),
        );
        expect(imageUrl.searchParams.get("path")).toBe("pixel.svg");
        await body.focus();
        await page.keyboard.type("Accidental typing");
        await expect(body).not.toContainText("Accidental typing");
        await expect(page.getByTestId("revision-view")).toContainText(view);

        const downloadButton = page.getByTestId("revision-download");
        if (!(await downloadButton.isVisible()))
          await page.getByTestId("revision-more").click();
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          downloadButton.click(),
        ]);
        try {
          const filename = await download.path();
          if (!filename) throw new Error("The preview download was not saved");
          const exported = fs.readFileSync(filename, "utf8");
          expect(exported).toContain("![Test image](./pixel.svg)");
          expect(exported).toContain(wording);
          expect(exported).not.toContain(
            view === "Original" ? "New wording" : "Old wording",
          );
          expect(exported).not.toContain("/api/files?");
          expect(exported).not.toContain("{~~");
        } finally {
          await download.delete();
        }
        await page.keyboard.press("Escape");
      }
      const final = await read();
      expect(final.signature).toBe(initial.signature);
      expect(final.draft).toEqual(initial.draft);
      expect(final.draft.markdown).toContain("![Test image](./pixel.svg)");
      expect(mutations).toEqual([]);
      expect(sourceHashes()).toEqual(hashesBefore);
      expect(fs.readFileSync(beforePath, "utf8")).toBe(before);
      expect(fs.readFileSync(afterPath, "utf8")).toBe(after);
      logE2eEvent("readonly-preview-images.loaded-without-saving", {
        comparisonId: id,
        views: ["Original", "Final"],
        mode,
        sourceHashes: hashesBefore,
      });
    } finally {
      const image = page
        .getByTestId("revision-preview")
        .getByRole("img", { name: "Test image" });
      const rendered = (await image.count())
        ? await image
            .evaluate((node: HTMLImageElement) => ({
              source: node.getAttribute("src"),
              resolvedSource: node.src,
              naturalWidth: node.naturalWidth,
            }))
            .catch(() => null)
        : null;
      const response = rendered
        ? await request.get(rendered.resolvedSource)
        : null;
      const diagnostic = {
        comparisonId,
        mode,
        view: currentView,
        image: rendered,
        asset: response
          ? {
              status: response.status(),
              contentType: response.headers()["content-type"],
            }
          : null,
        sourceHashesBefore: hashesBefore,
        sourceHashesAfter: sourceHashes(),
      };
      const diagnosticPath = test
        .info()
        .outputPath("readonly-preview-image.json");
      fs.writeFileSync(diagnosticPath, JSON.stringify(diagnostic, null, 2));
      await test.info().attach("readonly-preview-image", {
        path: diagnosticPath,
        contentType: "application/json",
      });
      logE2eEvent("readonly-preview-images.browser-result", diagnostic);
      removeMarkdownProject(project);
    }
  });
}

test("a sibling image below the reading viewport downloads only when brought into view", async ({
  page,
  request,
}) => {
  const project = createMarkdownProject("offscreen-images");
  const markdown = `# A longer release plan\n\n${Array.from({ length: 100 }, (_, index) => `Section ${index + 1}. This paragraph leaves real reading distance before the diagram at the end of this document.`).join("\n\n")}\n\n![Deferred diagram](./below-fold.svg)\n`;
  const target = writeProjectFile(project, "review.md", markdown);
  writeProjectFile(
    project,
    "below-fold.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>',
  );
  const imageRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "image") imageRequests.push(request.url());
  });
  try {
    const opened = await request.post(`${api}/document`, {
      data: { targetPath: target, autosave: "none", handoff: "chat" },
    });
    await expect(opened).toBeOK();
    const { id } = await opened.json();
    await page.goto(`/?comparison=${id}`);
    await expect(richTextEditor(page)).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(imageRequests).toEqual([]);
    const image = richTextEditor(page).getByRole("img", {
      name: "Deferred diagram",
    });
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveJSProperty("naturalWidth", 40);
    expect(imageRequests.map((url) => new URL(url).pathname)).toEqual([
      "/api/files",
    ]);
    expect(fs.readFileSync(target, "utf8")).toBe(markdown);
  } finally {
    await page.goto("about:blank");
    removeMarkdownProject(project);
  }
});
