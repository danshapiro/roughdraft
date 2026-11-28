// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { expect, test } from "vitest";
import { deferredEntries } from "../deferred-entries";

test("emitted optional entry URLs load the correct exports and reuse shared dependencies", async () => {
  const temporary = fileURLToPath(
    new URL("../../../.test-tmp/", import.meta.url),
  );
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, "deferred-entries-"));
  try {
    await fs.writeFile(
      path.join(directory, "main.js"),
      [
        'import { editorEntryUrl } from "virtual:roughdraft-deferred-entries";',
        'export { shared } from "./shared.js";',
        "export { editorEntryUrl };",
        'export const firstLoad = () => import("./Editor.js");',
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(directory, "shared.js"),
      "export const shared = {};\n",
    );
    await fs.writeFile(
      path.join(directory, "Editor.js"),
      [
        'import { shared } from "./shared.js";',
        'export const Editor = { shared, identity: Symbol("editor module") };',
      ].join("\n"),
    );
    const result = await build({
      configFile: false,
      root: directory,
      base: "./",
      logLevel: "silent",
      plugins: [
        deferredEntries({ editorEntryUrl: path.join(directory, "Editor.js") }),
      ],
      build: {
        outDir: path.join(directory, "built"),
        minify: false,
        modulePreload: false,
        rollupOptions: {
          input: path.join(directory, "main.js"),
          preserveEntrySignatures: "strict",
          output: {
            entryFileNames: "[name]-[hash].mjs",
            chunkFileNames: "[name]-[hash].mjs",
          },
        },
      },
    });
    if (Array.isArray(result) || !("output" in result))
      throw new Error("Expected one build output");
    const main = result.output.find(
      (file) => file.type === "chunk" && file.name === "main",
    );
    if (!main) throw new Error("Missing built main module");
    const entry = await import(
      pathToFileURL(path.join(directory, "built", main.fileName)).href
    );
    const original = await entry.firstLoad();
    const retryUrl = new URL(entry.editorEntryUrl);
    retryUrl.searchParams.set("roughdraft-retry", "1");
    const retried = await import(retryUrl.href);
    expect(original.Editor.shared).toBe(entry.shared);
    expect(retried.Editor.shared).toBe(entry.shared);
    expect(retried.Editor.identity).not.toBe(original.Editor.identity);
    expect((await import(retryUrl.href)).Editor).toBe(retried.Editor);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
