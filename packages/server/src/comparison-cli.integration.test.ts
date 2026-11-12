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
      child.once("exit", resolve);
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

  it("proposes through the real command, waits, and reports the actual final write", async () => {
    const target = path.join(directory, "AGENTS.md");
    const candidate = path.join(directory, "AGENTS.proposed.md");
    fs.writeFileSync(target, "# Rules\r\nOriginal");
    fs.writeFileSync(candidate, "# Rules\r\nNew rule");
    const result = await command(
      ["propose", target, "--after", candidate, "--timeout", "5"],
      async (event) => {
        expect(fs.readFileSync(target, "utf8")).toBe("# Rules\r\nOriginal");
        const review = event.comparison;
        const decided = await api(`/${review.id}/decisions`, {
          revision: review.revision,
          decisions: review.segments
            .filter((segment: { kind: string }) => segment.kind === "change")
            .map((segment: { id: string }) => ({
              id: segment.id,
              decision: "after",
            })),
        });
        await api(`/${review.id}/apply`, { revision: decided.revision });
      },
    );
    expect(result.code, result.errors).toBe(0);
    expect(result.events.at(-1)).toMatchObject({
      event: "comparison.completed",
      completion: { fileWritten: true, targetPath: target, accepted: 1 },
    });
    expect(fs.readFileSync(target, "utf8")).toBe("# Rules\r\nNew rule");
    const resumed = await command([
      "comparison",
      result.events[0].comparisonId,
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.events.at(-1).completion).toEqual(
      result.events.at(-1).completion,
    );
  }, 15000);

  it("keeps the target unchanged on timeout and reverts already-applied edits only at the final action", async () => {
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
        const decided = await api(`/${review.id}/decisions`, {
          revision: review.revision,
          decisions: review.segments
            .filter((segment: { kind: string }) => segment.kind === "change")
            .map((segment: { id: string }) => ({
              id: segment.id,
              decision: "before",
            })),
        });
        expect(fs.readFileSync(target, "utf8")).toBe("Already changed\n");
        await api(`/${review.id}/apply`, { revision: decided.revision });
      },
    );
    expect(result.code).toBe(0);
    expect(result.events.at(-1).completion).toMatchObject({
      fileWritten: true,
      reverted: 1,
    });
    expect(fs.readFileSync(target, "utf8")).toBe("Original\n");
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
        await api(`/${event.comparison.id}/complete`, {
          revision: event.comparison.revision,
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
});
