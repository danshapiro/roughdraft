import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.js";
import type { Comparison, ComparisonCompletion } from "./comparisons.js";

interface CliEvent {
  event: string;
  comparisonId: string;
  comparison: Comparison;
  completion: ComparisonCompletion | null;
  timedOut?: boolean;
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const cliModule = new URL("./cli.ts", import.meta.url).href;

describe("comparison CLI actual subprocess and filesystem", () => {
  let directory: string;
  let server: Server;
  let port: number;
  const children = new Set<ChildProcess>();
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "comparison-command-"));
    const { app } = createApp({
      homeDir: directory,
      comparisonsDir: path.join(directory, "reviews"),
    });
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function api(endpoint: string, body: unknown) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/comparisons${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = (await response.json()) as Comparison;
    expect(response.ok, JSON.stringify(data)).toBe(true);
    return data;
  }
  async function command(
    args: string[],
    onOpened?: (event: CliEvent) => Promise<void>,
  ) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {runCli} from ${JSON.stringify(cliModule)}; process.exit(await runCli(process.argv.slice(1)));`,
        ...args,
        "--no-open",
        "--json",
        "--port",
        String(port),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ROUGHDRAFT_HOST: "",
          ROUGHDRAFT_STATE_DIR: path.join(directory, "cli-state"),
          ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(
            directory,
            "no-frontend.json",
          ),
          ROUGHDRAFT_PUBLIC_URL: `http://127.0.0.1:${port}/`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(child);
    let output = "";
    let errors = "";
    let buffer = "";
    const opened: Promise<void>[] = [];
    const callbackErrors: unknown[] = [];
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data) => {
      const chunk = data.toString();
      output += chunk;
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const event = JSON.parse(line) as CliEvent;
        if (event.event === "comparison.opened" && onOpened)
          opened.push(
            onOpened(event).catch((error) => {
              callbackErrors.push(error);
              child.kill("SIGTERM");
            }),
          );
      }
    });
    child.stderr?.on("data", (data) => {
      errors += data.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    children.delete(child);
    await Promise.all(opened);
    if (callbackErrors.length) throw callbackErrors[0];
    return {
      code,
      errors,
      events: output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CliEvent),
    };
  }

  it("proposes through the real command and reports whether the sent snapshot matches disk", async () => {
    const target = path.join(directory, "AGENTS.md");
    const candidate = path.join(directory, "AGENTS.proposed.md");
    fs.writeFileSync(target, "# Rules\r\nOriginal");
    fs.writeFileSync(candidate, "# Rules\r\nNew rule");
    const result = await command(
      ["propose", target, "--after", candidate, "--timeout", "5"],
      async (event) => {
        expect(fs.readFileSync(target, "utf8")).toBe("# Rules\r\nOriginal");
        const review = event.comparison;
        const draft = {
          markdown: review.afterText,
          decisions: { wording: "kept" },
        };
        const base = await api(`/${review.id}/base`, {
          revision: review.revision,
          choice: "old",
        });
        const saved = await api(`/${review.id}/save`, {
          revision: base.revision,
          ...draft,
        });
        expect(fs.readFileSync(target, "utf8")).toBe("# Rules\r\nNew rule");
        await api(`/${review.id}/send`, { revision: saved.revision, ...draft });
      },
    );
    expect(result.code, result.errors).toBe(0);
    expect(result.events.at(-1)).toMatchObject({
      event: "comparison.completed",
      completion: { fileWritten: false, targetPath: target, accepted: 1 },
      comparison: { feedback: { saved: true, destinationPath: target } },
    });
    expect(fs.readFileSync(target, "utf8")).toBe("# Rules\r\nNew rule");
    const resumed = await command([
      "comparison",
      result.events[0].comparisonId,
      "--no-watch",
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.events[0].comparison.completion).toEqual(
      result.events.at(-1).completion,
    );
  }, 15000);

  it("keeps the target unchanged until a base is selected and a change is reverted", async () => {
    const target = path.join(directory, "AGENTS.md");
    const before = path.join(directory, "AGENTS.before.md");
    fs.writeFileSync(target, "Already changed\n");
    fs.writeFileSync(before, "Original\n");
    const timedOut = await command([
      "review",
      target,
      "--before",
      before,
      "--timeout",
      "0",
    ]);
    expect(timedOut.code).toBe(1);
    expect(timedOut.events.at(-1)).toMatchObject({
      timedOut: true,
      completion: null,
    });
    expect(fs.readFileSync(target, "utf8")).toBe("Already changed\n");
    const result = await command(
      ["comparison", timedOut.events[0].comparisonId, "--timeout", "5"],
      async (event) => {
        const review = event.comparison;
        const draft = { markdown: review.beforeText, decisions: {} };
        const recovered = await api(`/${review.id}/draft`, {
          revision: review.revision,
          ...draft,
        });
        expect(fs.readFileSync(target, "utf8")).toBe("Already changed\n");
        const base = await api(`/${review.id}/base`, {
          revision: recovered.revision,
          choice: "new",
        });
        expect(fs.readFileSync(target, "utf8")).toBe("Already changed\n");
        const saved = await api(`/${review.id}/save`, {
          revision: base.revision,
          ...draft,
        });
        await api(`/${review.id}/send`, { revision: saved.revision, ...draft });
      },
    );
    expect(result.code).toBe(0);
    expect(result.events.at(-1).completion).toMatchObject({
      fileWritten: false,
      targetPath: target,
    });
    expect(fs.readFileSync(target, "utf8")).toBe("Original\n");
  }, 15000);

  it("delivers complete large JSON events through a pipe before exiting, including completed resume", async () => {
    const target = path.join(directory, "large-AGENTS.md");
    const candidate = path.join(directory, "large-AGENTS.proposed.md");
    const before = `${Array.from(
      { length: 3000 },
      (_, index) =>
        `${index}: Preserve this exact Unicode content: café, 東京, and 📝.\r\n`,
    ).join("")}No final newline`;
    const after = `${before} — proposed addition`;
    fs.writeFileSync(target, before);
    fs.writeFileSync(candidate, after);
    const opened = await command([
      "propose",
      target,
      "--after",
      candidate,
      "--no-watch",
    ]);
    expect(opened.code, opened.errors).toBe(0);
    expect(opened.events).toHaveLength(1);
    const review = opened.events[0].comparison;
    expect(review.beforeText).toBe(before);
    expect(review.afterText).toBe(after);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const draft = { markdown: after, decisions: { ending: "kept" } };
    const base = await api(`/${review.id}/base`, {
      revision: review.revision,
      choice: "old",
    });
    const saved = await api(`/${review.id}/save`, {
      revision: base.revision,
      ...draft,
    });
    await api(`/${review.id}/send`, { revision: saved.revision, ...draft });
    const resumed = await command(
      ["comparison", review.id, "--timeout", "5"],
      async (event) => {
        await api(`/${review.id}/send`, {
          revision: event.comparison.revision,
          ...draft,
          comment: "New feedback",
        });
      },
    );
    expect(resumed.code, resumed.errors).toBe(0);
    expect(resumed.events).toHaveLength(2);
    for (const event of resumed.events) {
      expect(event.comparison.beforeText).toBe(before);
      expect(event.comparison.afterText).toBe(after);
    }
    expect(resumed.events[1]).toMatchObject({
      event: "comparison.completed",
      completion: { fileWritten: false, targetPath: target },
      comparison: { feedback: { saved: true } },
    });
    expect(fs.readFileSync(target, "utf8")).toBe(after);
  }, 15000);

  it("finishes a two-version comparison without a destination or source writes", async () => {
    const before = path.join(directory, "before.md");
    const after = path.join(directory, "after.md");
    fs.writeFileSync(before, "Before");
    fs.writeFileSync(after, "After");
    const result = await command(
      ["compare", before, after, "--timeout", "5"],
      async (event) => {
        expect(event.comparison.targetPath).toBe(null);
        await api(`/${event.comparison.id}/send`, {
          revision: event.comparison.revision,
          markdown: event.comparison.afterText,
          decisions: {},
        });
      },
    );
    expect(result.code).toBe(0);
    expect(result.events.at(-1).completion).toMatchObject({
      fileWritten: false,
      targetPath: null,
    });
    expect(fs.readFileSync(before, "utf8")).toBe("Before");
    expect(fs.readFileSync(after, "utf8")).toBe("After");
  }, 15000);
  it("waits for fresh feedback when resumed and follows it to a stale tab's copy", async () => {
    const source = path.join(directory, "original.md");
    const copy = path.join(directory, "copy.md");
    const draft = { markdown: "Copied text", decisions: {} };
    fs.writeFileSync(source, "Original text");
    const review = await api("/document", { targetPath: source });
    const earlier = await api(`/${review.id}/send`, {
      revision: review.revision,
      markdown: "Original text",
      decisions: {},
      comment: "Previous feedback",
    });
    const result = await command(
      ["comparison", review.id, "--timeout", "5"],
      async (event) => {
        expect(event.comparison.feedback).toEqual(earlier.feedback);
        const copied = await api(`/${review.id}/fork`, {
          path: copy,
          expectedVersion: null,
          ...draft,
        });
        await api(`/${copied.id}/send`, {
          revision: copied.revision,
          ...draft,
          comment: "Feedback from copy",
        });
      },
    );
    expect(result.code, result.errors).toBe(0);
    expect(result.events.at(-1)).toMatchObject({
      event: "comparison.completed",
      completion: { fileWritten: false, targetPath: copy },
      comparison: { feedback: { comment: "Feedback from copy", saved: true } },
    });
    expect(result.events.at(-1).comparisonId).not.toBe(review.id);
    expect(fs.readFileSync(source, "utf8")).toBe("Original text");
  }, 15000);

  it("reopens a file draft and waits for new feedback instead of replaying the old snapshot", async () => {
    const target = path.join(directory, "notes.md");
    fs.writeFileSync(target, "live file");
    const opened = await command(["edit", target, "--no-watch"]);
    const review = opened.events[0].comparison;
    expect(review).toMatchObject({ mode: "document", destinationPath: target });
    const first = await api(`/${review.id}/send`, {
      revision: review.revision,
      markdown: "first draft",
      decisions: {},
    });
    const received = await command(
      ["edit", target, "--timeout", "5"],
      async (event) => {
        expect(event.comparisonId).toBe(review.id);
        expect(event.comparison.feedback).toEqual(first.feedback);
        await api(`/${review.id}/send`, {
          revision: event.comparison.revision,
          markdown: "second draft",
          decisions: {},
        });
      },
    );
    expect(received.code, received.errors).toBe(0);
    expect(received.events.at(-1)?.comparison.feedback).toMatchObject({
      draft: { markdown: "second draft" },
      saved: false,
    });
    expect(fs.readFileSync(target, "utf8")).toBe("live file");
  }, 15000);
});
