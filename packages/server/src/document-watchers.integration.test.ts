import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWatcherRegistry } from "./document-watchers";
import { createApp } from "./index";

let directory: string;
const cleanup: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  const root = path.resolve(import.meta.dirname, "../../../.test-tmp");
  fs.mkdirSync(root, { recursive: true });
  directory = fs.mkdtempSync(path.join(root, "legacy-watch-"));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  fs.rmSync(directory, { recursive: true, force: true });
});
async function app() {
  const watchers = new DocumentWatcherRegistry();
  const application = createApp({
    projectDir: directory,
    homeDir: directory,
    watchers,
  });
  const server = http.createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    application.dispose();
    watchers.close();
  });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return { base, watchers };
}
async function subscribe(base: string) {
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  const response = await fetch(
    `${base}/api/markdown-file/events?path=draft.md&projectPath=${encodeURIComponent(directory)}`,
    { signal: controller.signal },
  );
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("Missing event stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function change() {
    const deadline = setTimeout(() => controller.abort(), 3000);
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) throw Error("Stream ended before change");
        buffer += decoder.decode(next.value, { stream: true });
        while (buffer.includes("\n\n")) {
          const boundary = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.includes("event: change")) {
            const data = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (data)
              return JSON.parse(data.slice(6)) as {
                path: string;
                version: string;
                exists: boolean;
                availability: string;
              };
          }
        }
      }
    } finally {
      clearTimeout(deadline);
    }
  }
  return { controller, change };
}
describe("legacy and unified shared watcher wiring", () => {
  it("uses one parent watch for two real legacy streams and preserves its old version contract", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Original");
    const { base, watchers } = await app();
    const first = await subscribe(base),
      second = await subscribe(base);
    expect(watchers.diagnostics().watchers).toBe(1);
    expect(watchers.diagnostics().reads).toBe(1);
    const a = first.change(),
      b = second.change();
    const replacement = path.join(directory, "draft.tmp");
    fs.writeFileSync(replacement, "Atomic complete replacement");
    fs.renameSync(replacement, filename);
    const [one, two] = await Promise.all([a, b]);
    const stat = fs.statSync(filename);
    const digest = crypto
      .createHash("sha256")
      .update("Atomic complete replacement")
      .digest("hex");
    expect(one).toMatchObject({
      path: "draft.md",
      exists: true,
      version: `${stat.mtimeMs}:${stat.size}:${digest}`,
    });
    expect(two).toEqual(one);
    expect(watchers.diagnostics().reads).toBe(2);
    first.controller.abort();
    await vi.waitFor(() => expect(watchers.diagnostics().listeners).toBe(1));
    second.controller.abort();
    await vi.waitFor(() => expect(watchers.diagnostics().watchers).toBe(0));
    expect(watchers.diagnostics().paths).toBe(0);
  });
  it("shares the live-file cache between legacy streams and repeated unified state reads", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "A complete shared document");
    const { base, watchers } = await app();
    await subscribe(base);
    const created = await fetch(`${base}/api/comparisons/document`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPath: filename, autosave: "none" }),
    });
    expect(created.status).toBe(201);
    const review = (await created.json()) as { id: string };
    const stateURL = `${base}/api/comparisons/${review.id}/state`;
    expect((await fetch(stateURL)).status).toBe(200);
    const reads = watchers.diagnostics().reads;
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => fetch(stateURL)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(watchers.diagnostics().reads).toBe(reads);
  });
  it("keeps stream subscriptions usable through deletion and recreation", async () => {
    const filename = path.join(directory, "draft.md");
    fs.writeFileSync(filename, "Original");
    const { base } = await app();
    const stream = await subscribe(base);
    const missing = stream.change();
    fs.unlinkSync(filename);
    expect(await missing).toMatchObject({
      exists: false,
      version: null,
      availability: "missing",
    });
    const restored = stream.change();
    fs.writeFileSync(filename, "Recreated complete file");
    expect(await restored).toMatchObject({
      exists: true,
      availability: "available",
    });
  });
});
