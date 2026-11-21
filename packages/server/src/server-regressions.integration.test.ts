import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli";
import { createApp } from "./index";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("server runtime regressions", () => {
  let fixture: string;
  const children: ChildProcessWithoutNullStreams[] = [];
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(() => {
    const temporaryRoot = path.join(repoRoot, ".test-tmp");
    fs.mkdirSync(temporaryRoot, { recursive: true });
    fixture = fs.mkdtempSync(path.join(temporaryRoot, "server-regressions-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0)) await close();
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  function startChild(source: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: repoRoot, env: { ...process.env, ...extraEnv } },
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    return { child, stdout: () => stdout, stderr: () => stderr };
  }

  async function startHost() {
    const { app } = createApp({ staticDirPath: fixture });
    const server = createHttpServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    return { server, url: `http://127.0.0.1:${address.port}` };
  }

  it("keeps local filesystem APIs unavailable on a network-bound server", async () => {
    const probe = createHttpServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const port = address.port;
    const host = startChild(
      `import {createServer} from './packages/server/src/index.ts'; await createServer(${port});`,
      { ROUGHDRAFT_BIND_HOST: "0.0.0.0", ROUGHDRAFT_TOKEN: "test-token" },
    );
    await vi.waitFor(
      () => expect(host.stdout()).toContain("Roughdraft running"),
      { timeout: 3_000 },
    );
    const base = `http://127.0.0.1:${port}`;
    fs.writeFileSync(path.join(fixture, "draft.md"), "# Original\n");
    const fileUrl = new URL("/api/markdown-file", base);
    fileUrl.searchParams.set("projectPath", fixture);
    fileUrl.searchParams.set("path", "draft.md");
    // A reverse proxy can make network requests arrive from 127.0.0.1. Neither
    // that socket address nor forwarded headers should restore local APIs.
    const read = await fetch(fileUrl, {
      headers: { "X-Forwarded-For": "127.0.0.1" },
    });
    const write = await fetch(fileUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Unauthorized\n" }),
    });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    const authenticatedRead = await fetch(fileUrl, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authenticatedRead.status).toBe(403);
    for (const route of [
      "/api/files",
      "/api/fs/list",
      "/api/pages",
      "/api/comparisons",
      "/api/review-events/status",
    ]) {
      expect((await fetch(new URL(route, base))).status).toBe(403);
    }
    expect(fs.readFileSync(path.join(fixture, "draft.md"), "utf8")).toBe(
      "# Original\n",
    );
    const register = await fetch(new URL("/api/remote-document", base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        sessionId: "network-test",
        originPath: "/source/draft.md",
        content: "# Remote\n",
      }),
    });
    expect(register.status).toBe(201);
  });

  it("keeps a connected remote stream alive after its connection deadline", async () => {
    const host = await startHost();
    const documentPath = path.join(fixture, "draft.md");
    fs.writeFileSync(documentPath, "# Original\n");
    // Shorten native deadlines so this tests the actual fetch body/abort boundary
    // without making every suite run wait ten seconds.
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      nativeTimeout(250),
    );
    const nativeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (callback, delay, ...args) =>
        nativeSetTimeout(callback, delay === 10_000 ? 250 : delay, ...args),
    );
    let openedUrl: string | null = null;
    let exited = false;
    const cli = runCli(["open", documentPath, "--no-open", "--json"], {
      env: { ROUGHDRAFT_HOST: host.url },
      log: (message) => {
        openedUrl = (JSON.parse(message) as { url: string }).url;
      },
      error: () => {},
    }).finally(() => {
      exited = true;
    });
    try {
      await vi.waitFor(() => expect(openedUrl).not.toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(exited).toBe(false);
      const id = new URL(openedUrl as unknown as string).searchParams.get(
        "session",
      );
      const save = await fetch(`${host.url}/api/remote-document/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Later save\n" }),
      });
      expect(save.status).toBe(200);
      await vi.waitFor(() =>
        expect(fs.readFileSync(documentPath, "utf8")).toBe("# Later save\n"),
      );
    } finally {
      host.server.closeAllConnections();
      await cli;
    }
  });

  it.each([
    false,
    true,
  ])("does not terminate an unrelated process named by stale state (listener exists: %s)", async (listenerExists) => {
    const victim = startChild("setInterval(() => {}, 1000);");
    await once(victim.child, "spawn");
    const host = listenerExists ? await startHost() : null;
    const port = host ? Number(new URL(host.url).port) : 65534;
    const stateFile = path.join(fixture, "server.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        pid: victim.child.pid,
        port,
        url: `http://localhost:${port}`,
        startedAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    await runCli(["stop", "--json"], {
      env: { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl: listenerExists
        ? fetch
        : async () => {
            throw new Error("No Roughdraft listener");
          },
      log: () => {},
      error: () => {},
    });
    expect(victim.child.signalCode).toBeNull();
    expect(victim.child.exitCode).toBeNull();
    expect(fs.existsSync(stateFile)).toBe(!listenerExists);
    if (host) expect((await fetch(`${host.url}/api/status`)).status).toBe(200);
  });

  it("preserves tracking and reports failure when an owned server stops answering HTTP", {
    timeout: 15_000,
  }, async () => {
    const host = startChild(`
      import { createServer } from 'node:http';
      import { createApp } from './packages/server/src/index.ts';
      const { app } = createApp();
      let withholdResponses = false;
      const server = createServer((request, response) => {
        if (!withholdResponses) app(request, response);
      });
      server.listen(0, '127.0.0.1', () => {
        console.log('port:' + server.address().port);
      });
      process.stdin.on('data', () => {
        withholdResponses = true;
        console.log('unresponsive');
      });
    `);
    await vi.waitFor(() => expect(host.stdout()).toMatch(/port:\d+/), {
      timeout: 3_000,
    });
    const port = Number(host.stdout().match(/port:(\d+)/)?.[1]);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`).then(
      (response) => response.json(),
    );
    expect(status.pid).toBe(host.child.pid);
    const stateFile = path.join(fixture, "server.json");
    const state = {
      pid: host.child.pid,
      port,
      url: `http://localhost:${port}`,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    host.child.stdin.write("withhold responses\n");
    await vi.waitFor(() => expect(host.stdout()).toContain("unresponsive"));

    const exitCode = await runCli(["stop", "--json"], {
      env: {
        ROUGHDRAFT_STATE_FILE: stateFile,
        ROUGHDRAFT_PORT: String(port),
      },
      log: () => {},
      error: () => {},
    });

    expect(exitCode).toBe(1);
    expect(host.child.exitCode).toBeNull();
    expect(host.child.signalCode).toBeNull();
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual(state);
  });

  it("initializes MCP using newline-delimited JSON over the CLI subprocess", async () => {
    const mcp = startChild(
      "import {runCli} from './packages/server/src/cli.ts'; process.exit(await runCli(['mcp']));",
    );
    mcp.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
    );
    await vi.waitFor(() => expect(mcp.stdout()).toContain("protocolVersion"), {
      timeout: 3_000,
    });
    expect(mcp.stdout().endsWith("\n")).toBe(true);
    expect(JSON.parse(mcp.stdout())).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18" },
    });
    mcp.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    await vi.waitFor(() =>
      expect(mcp.stdout().trim().split("\n")).toHaveLength(2),
    );
    expect(
      JSON.parse(mcp.stdout().trim().split("\n")[1] ?? "{}"),
    ).toMatchObject({
      id: 2,
      result: { tools: expect.any(Array) },
    });
  });
});
