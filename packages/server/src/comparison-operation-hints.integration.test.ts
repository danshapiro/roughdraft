import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { SyncState } from "@roughdraft/rfm";
import { expect, test, vi } from "vitest";
import type { Comparison } from "./comparisons.js";
import {
  type DocumentWatchEvent,
  DocumentWatcherRegistry,
} from "./document-watchers.js";
import { createApp } from "./index.js";

test("guarded publication labels its watcher and SSE hints without claiming a later outside write", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../.test-tmp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "operation-hints-"));
  const target = path.join(root, "notes.md");
  const directory = path.join(root, "comparisons");
  const original = "First paragraph.\n\nSecond paragraph.\n";
  fs.writeFileSync(target, original);
  const watchers = new DocumentWatcherRegistry();
  const host = createApp({
    homeDir: root,
    projectDir: root,
    comparisonsDir: directory,
    staticDirPath: root,
    allowLocalFiles: true,
    watchers,
  });
  const server = http.createServer(host.app);
  const stream = new AbortController();
  let unsubscribe = () => {};
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const call = async (route: string, body?: object) => {
      const response = await fetch(`${origin}/api/comparisons${route}`, {
        method: body ? "POST" : "GET",
        headers: { Connection: "close", "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const created = await call("/document", {
      targetPath: target,
      autosave: target,
    });
    const state = (await call(`/${created.id}/state`)) as SyncState<Comparison>;
    const recordPath = path.join(directory, `${created.id}.json`);
    const events: DocumentWatchEvent[] = [];
    unsubscribe = watchers.subscribe([target, recordPath], (event) =>
      events.push(event),
    );
    const response = await fetch(
      `${origin}/api/comparisons/events?ids=${created.id}&protocol=1`,
      { signal: stream.signal },
    );
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("The real event stream needs a body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const nextHint = async () => {
      const deadline = setTimeout(() => stream.abort(), 3000);
      try {
        for (;;) {
          while (buffer.includes("\n\n")) {
            const boundary = buffer.indexOf("\n\n");
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!frame.includes("event: change")) continue;
            const data = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (data) return JSON.parse(data.slice(6));
          }
          const chunk = await reader.read();
          if (chunk.done)
            throw new Error("The live stream ended before its hint");
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        clearTimeout(deadline);
      }
    };
    expect((await nextHint()).reason).toBe("initial");

    const operationId = crypto.randomUUID();
    const published = original.replace("First", "Published first");
    const result = await call(`/${created.id}/reconcile`, {
      operationId,
      operationSequence: 1,
      pageInstanceId: "operation-hint-page",
      operationContext: state.operationContext,
      expectedRevision: state.revision,
      baseRevision: state.revision,
      baseSignature: state.signature,
      base: state.draft,
      draft: { ...state.draft, markdown: published, cleanMarkdown: published },
      expectedDisk: state.disk
        ? {
            path: state.disk.path,
            version: state.disk.version,
            hash: state.disk.hash,
          }
        : null,
      localGeneration: 1,
      writeFile: true,
      reason: "sync",
    });
    expect(result.status).toBe("committed");
    await vi.waitFor(() => {
      expect(events.some((event) => event.path === target)).toBe(true);
      expect(events.some((event) => event.path === recordPath)).toBe(true);
    });
    const applicationHints = [await nextHint(), await nextHint()];
    expect(events.filter((event) => event.path === target)[0]).toMatchObject({
      operationId,
      snapshot: { text: published },
    });
    for (const hint of applicationHints)
      expect(hint).toMatchObject({
        operationId,
        diskVersion: result.state.disk.version,
      });

    const outside = original.replace("Second", "Outside second");
    const staging = path.join(root, "outside-next.md");
    fs.writeFileSync(staging, outside);
    fs.renameSync(staging, target);
    await vi.waitFor(() => expect(events.at(-1)?.snapshot.text).toBe(outside));
    const external = events.find((event) => event.snapshot.text === outside);
    expect(external?.operationId).toBeUndefined();
    const externalHint = await nextHint();
    expect(externalHint.diskVersion).toBe(external?.snapshot.version);
    expect(externalHint.operationId).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toBe(outside);
  } finally {
    stream.abort();
    unsubscribe();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    host.dispose();
    watchers.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
