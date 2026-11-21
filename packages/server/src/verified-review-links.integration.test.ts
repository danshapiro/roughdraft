import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.js";
import type { Comparison } from "./comparisons.js";

interface ReviewCliEvent {
  event: string;
  comparisonId: string;
  url: string;
  comparison: Comparison;
  error?: string;
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const cli = new URL("./cli.ts", import.meta.url).href;
const shell =
  '<!doctype html><html><head><title>Roughdraft</title></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';

describe("verified review links over real CLI and HTTP boundaries", () => {
  let directory: string;
  const servers: Server[] = [];
  let first: string;
  let second: string;
  let document: string;

  async function serve(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  }
  async function app(name: string, serverRoot = path.join(directory, name)) {
    const homeDir = path.join(directory, name);
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, "index.html"), shell);
    const server = createServer();
    const url = await serve(server);
    server.on(
      "request",
      createApp({
        homeDir,
        serverRoot,
        port: Number(new URL(url).port),
        comparisonsDir: path.join(homeDir, "reviews"),
        staticDirPath: homeDir,
      }).app,
    );
    return url;
  }
  beforeEach(async () => {
    fs.mkdirSync(path.join(root, ".test-tmp"), { recursive: true });
    directory = fs.mkdtempSync(path.join(root, ".test-tmp/verified-review-"));
    first = await app("first", root);
    second = await app("second");
    document = path.join(directory, "complex.md");
    fs.writeFileSync(
      document,
      "# Guide\n\nCurrent {++suggestion++}\n\n| Name | Value |\n| --- | --- |\n| A | B |\n",
    );
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function command(
    args: string[],
    env: NodeJS.ProcessEnv = {},
    cwd = root,
    onOpened?: (event: ReviewCliEvent) => Promise<void>,
  ) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { runCli } from ${JSON.stringify(cli)}; process.exit(await runCli(process.argv.slice(1)));`,
        ...args,
        "--no-open",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          ROUGHDRAFT_HOST: "",
          ROUGHDRAFT_PUBLIC_URL: "",
          ROUGHDRAFT_STATE_DIR: path.join(directory, "state"),
          ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(
            directory,
            "no-frontend.json",
          ),
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let errors = "";
    let buffer = "";
    const callbacks: Promise<void>[] = [];
    const callbackErrors: unknown[] = [];
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (event.event === "comparison.opened" && onOpened)
          callbacks.push(
            onOpened(event).catch((error) => {
              callbackErrors.push(error);
              child.kill("SIGTERM");
            }),
          );
      }
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await Promise.all(callbacks);
    if (callbackErrors.length) throw callbackErrors[0];
    return {
      code,
      errors,
      events: output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  }
  async function proxy(
    target: string,
    options: {
      prefix?: string;
      statusFrom?: string;
      shell?: string;
      legacyStatus?: boolean;
    } = {},
  ) {
    const prefix = options.prefix ?? "/";
    const origin = await serve(
      createServer(async (req, res) => {
        const requested = req.url ?? "/";
        if (!requested.startsWith(prefix)) {
          res.writeHead(404).end();
          return;
        }
        const route = `/${requested.slice(prefix.length)}`;
        if (!route.startsWith("/api/")) {
          res
            .writeHead(200, { "content-type": "text/html" })
            .end(options.shell ?? shell);
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const upstream = await fetch(
          new URL(
            route,
            route === "/api/status" ? (options.statusFrom ?? target) : target,
          ),
          {
            method: req.method,
            headers: body.length
              ? { "content-type": "application/json" }
              : undefined,
            body: body.length ? body : undefined,
          },
        );
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        if (route === "/api/status" && options.legacyStatus) {
          const status = await upstream.json();
          delete status.instanceId;
          delete status.capabilities.fileComparisons;
          delete status.publicUrl;
          res.end(JSON.stringify(status));
        } else res.end(Buffer.from(await upstream.arrayBuffer()));
      }),
    );
    return new URL(prefix, origin).toString();
  }
  it("rejects the incident's healthy public alias when that server does not own the created review", async () => {
    const result = await command(
      ["edit", document, "--port", new URL(first).port],
      { ROUGHDRAFT_PUBLIC_URL: second },
    );
    expect(result.code, JSON.stringify(result)).toBe(1);
    expect(
      result.events.some((event) => event.event === "comparison.opened"),
    ).toBe(false);
    expect(result.events[0]).toMatchObject({
      event: "comparison.verification_failed",
      created: true,
      serverUrl: expect.any(String),
      comparisonId: expect.any(String),
    });
    const saved = await fetch(
      new URL(`/api/comparisons/${result.events[0].comparisonId}`, first),
    );
    expect(saved.status).toBe(200);
    const records = fs.readdirSync(path.join(directory, "first/reviews"));
    const recovered = await command([
      "comparison",
      result.events[0].comparisonId,
      "--server",
      first,
    ]);
    expect(recovered.code, recovered.errors).toBe(0);
    expect(recovered.events[0].comparisonId).toBe(
      result.events[0].comparisonId,
    );
    expect(fs.readdirSync(path.join(directory, "first/reviews"))).toEqual(
      records,
    );
  });
  it("uses an exact foreign-source server, then reads its full URL from another working directory", async () => {
    const opened = await command([
      "edit",
      document,
      "--server",
      second,
      "--autosave",
      "none",
    ]);
    expect(opened.code, opened.errors).toBe(0);
    const event = opened.events[0];
    expect(event).toMatchObject({
      event: "comparison.opened",
      serverUrl: second,
      port: Number(new URL(second).port),
      portChanged: false,
    });
    expect(
      (await fetch(new URL(`/api/comparisons/${event.comparisonId}`, first)))
        .status,
    ).toBe(404);
    const read = await command(
      ["comparison", event.url, "--read"],
      {},
      directory,
    );
    expect(read.code, read.errors).toBe(0);
    expect(read.events[0]).toMatchObject({
      event: "comparison.read",
      comparisonId: event.comparisonId,
      url: event.url,
      comparison: { afterText: fs.readFileSync(document, "utf8") },
    });
    expect(fs.existsSync(path.join(directory, "state/server.json"))).toBe(
      false,
    );
  });

  it("accepts a canonical frontend proxy with a path prefix and retains that complete URL for reads", async () => {
    const publicUrl = await proxy(second, { prefix: "/editor/" });
    const opened = await command(
      ["edit", document, "--server", second, "--autosave", "none"],
      { ROUGHDRAFT_PUBLIC_URL: publicUrl },
    );
    expect(opened.code, opened.errors).toBe(0);
    expect(opened.events[0].url).toBe(
      `${publicUrl}?comparison=${opened.events[0].comparisonId}`,
    );
    const read = await command(
      ["comparison", opened.events[0].url, "--read"],
      { ROUGHDRAFT_PUBLIC_URL: first },
      directory,
    );
    expect(read.code, read.errors).toBe(0);
    expect(read.events[0].url).toBe(opened.events[0].url);
    expect(read.events[0].comparison.afterText).toBe(
      fs.readFileSync(document, "utf8"),
    );
  });
  it("rejects an alias that retrieves the correct ID but identifies another server instance", async () => {
    const publicUrl = await proxy(second, { statusFrom: first });
    const result = await command(["edit", document, "--server", second], {
      ROUGHDRAFT_PUBLIC_URL: publicUrl,
    });
    expect(result.code, result.errors).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      event: "comparison.verification_failed",
      created: true,
    });
    expect(result.events[0].error).toContain(
      "different Roughdraft server instance",
    );
    expect(result.events[0].url).toBeUndefined();
  });
  it("rejects a healthy API whose browser route does not serve the viewer", async () => {
    const publicUrl = await proxy(second, {
      shell: "<html><body>Healthy</body></html>",
    });
    const result = await command(["edit", document, "--server", second], {
      ROUGHDRAFT_PUBLIC_URL: publicUrl,
    });
    expect(result.code, result.errors).toBe(1);
    expect(result.events[0]).toMatchObject({
      event: "comparison.verification_failed",
      created: true,
    });
    expect(result.events[0].error).toContain("viewer application");
  });
  it("watches the full URL's original server from another cwd and reads recovered drafts and comments", async () => {
    const opened = await command([
      "edit",
      document,
      "--server",
      second,
      "--autosave",
      "none",
    ]);
    const review = opened.events[0].comparison;
    const draft = {
      markdown: "Recovered {++draft++}",
      decisions: {},
      reviewComments: [
        {
          id: "comment",
          changeId: "document",
          content: "Recovered comment",
          createdAt: "2026-11-21T12:00:00Z",
          scope: "document",
        },
      ],
    };
    const save = await fetch(
      new URL(`/api/comparisons/${review.id}/draft`, second),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: review.revision, ...draft }),
      },
    );
    expect(save.ok).toBe(true);
    const read = await command(
      ["comparison", opened.events[0].url, "--read"],
      {},
      directory,
    );
    expect(read.events[0].comparison).toMatchObject({
      draft: { markdown: draft.markdown },
      reviewComments: draft.reviewComments,
    });
    const watched = await command(
      ["comparison", opened.events[0].url, "--watch", "--timeout", "5"],
      {},
      directory,
      async (event) => {
        const sent = await fetch(
          new URL(`/api/comparisons/${review.id}/send`, second),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              revision: event.comparison.revision,
              ...draft,
              comment: "Fresh feedback on owner",
            }),
          },
        );
        expect(sent.ok).toBe(true);
      },
    );
    expect(watched.code, watched.errors).toBe(0);
    expect(watched.events.at(-1)).toMatchObject({
      event: "comparison.completed",
      comparison: { feedback: { comment: "Fresh feedback on owner" } },
    });
    expect(fs.existsSync(path.join(directory, "state/server.json"))).toBe(
      false,
    );
  });
  it("preserves automatic selection of the split development frontend and its backend proxy", async () => {
    const frontend = await proxy(first);
    const stateFile = path.join(directory, "dev-frontend.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        apiPort: Number(new URL(first).port),
        appPort: Number(new URL(frontend).port),
        mode: "full-dev",
        repoRoot: root,
        startedAt: new Date().toISOString(),
        url: frontend,
      }),
    );
    const result = await command(["edit", document, "--autosave", "none"], {
      ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: stateFile,
    });
    expect(result.code, result.errors).toBe(0);
    expect(result.events[0].url).toBe(
      `${frontend}?comparison=${result.events[0].comparisonId}`,
    );
    expect(new URL(result.events[0].serverUrl).port).toBe(new URL(first).port);
    expect(fs.existsSync(path.join(directory, "state/server.json"))).toBe(
      false,
    );
  });
  it("reads an existing full URL from a legacy server without rewriting its origin", async () => {
    const opened = await command(["edit", document, "--server", second]);
    const legacy = await proxy(second, { legacyStatus: true });
    const url = `${legacy}?comparison=${opened.events[0].comparisonId}`;
    const read = await command(
      ["comparison", url, "--read"],
      { ROUGHDRAFT_PUBLIC_URL: first },
      directory,
    );
    expect(read.code, read.errors).toBe(0);
    expect(read.events[0]).toMatchObject({
      event: "comparison.read",
      url,
      comparisonId: opened.events[0].comparisonId,
    });
    const write = await command(["edit", document, "--server", legacy]);
    expect(write.code).toBe(1);
    expect(write.errors).toContain(
      "does not support local file comparisons with server identity",
    );
  });
  it("fails an unavailable exact server without creating local server state", async () => {
    const unavailable = await serve(createServer());
    const stopped = servers.pop();
    if (!stopped) throw new Error("Expected the test-owned server");
    await new Promise<void>((resolve) => stopped.close(() => resolve()));
    const result = await command(["edit", document, "--server", unavailable]);
    expect(result.code).toBe(1);
    expect(result.errors).toContain(
      "Cannot connect to the selected Roughdraft server",
    );
    expect(result.events).toHaveLength(0);
    expect(fs.existsSync(path.join(directory, "state/server.json"))).toBe(
      false,
    );
  });
});
