import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliEnvironment,
  parsePreviewArgs,
  preparePreviewRuntime,
  runPreview,
} from "../../../scripts/preview.mjs";

const execute = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const roots: string[] = [];
const children: ChildProcess[] = [];

async function fixture() {
  await fs.mkdir(path.join(repoRoot, ".test-tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(repoRoot, ".test-tmp/preview-"));
  roots.push(root);
  const documentPath = path.join(root, "guide.md");
  const frontendDir = path.join(root, "frontend");
  await fs.mkdir(frontendDir);
  await fs.writeFile(
    path.join(frontendDir, "index.html"),
    '<!doctype html><html><head><title>Roughdraft</title></head><body><div id="root">Roughdraft fixture</div><script type="module" src="/app.js"></script></body></html>',
  );
  await fs.writeFile(
    documentPath,
    "# Guide\n\nReal document with **formatting**.\n",
  );
  return {
    root,
    documentPath,
    frontendDir,
    repoRoot,
    runtimeBaseDir: path.join(root, "runtimes"),
    title: "Guide review",
    autosave: "none",
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function start(runtime: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(runtime, "launch.mjs")], {
    cwd: runtime,
    env: { ...process.env, ...extraEnv, PORT: String(port) },
    stdio: "pipe",
  });
  children.push(child);
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk;
  });
  const url = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Standalone server exited: ${logs}`);
    try {
      const response = await fetch(`${url}api/status`);
      if (response.ok) return { url, port };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Standalone server did not start: ${logs}`);
}

async function fakeDevservers(root: string, url: string) {
  const bin = path.join(root, "devservers.mjs");
  const callsFile = path.join(root, "managed-calls.jsonl");
  await fs.writeFile(
    bin,
    `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n');\nconsole.log(JSON.stringify({id:'test-preview',url:${JSON.stringify(url)},state:'active',review:true,review_hold:true,expires_at:null,access:{state:'ready'}}));\n`,
    { mode: 0o755 },
  );
  return { bin, callsFile };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  }
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("durable preview", () => {
  it("parses explicit documents and before references without defaulting autosave to the source", () => {
    expect(parsePreviewArgs([], repoRoot)).toMatchObject({
      documentPath: path.join(repoRoot, "README.md"),
      autosave: "none",
    });
    expect(
      parsePreviewArgs(
        [
          "--document",
          "README.md",
          "--before-ref",
          "main",
          "--title",
          "Read me",
          "--autosave",
          "saved.md",
          "--json",
          "--no-open",
        ],
        repoRoot,
      ),
    ).toMatchObject({
      beforeRef: "main",
      title: "Read me",
      autosave: path.join(repoRoot, "saved.md"),
      json: true,
      noOpen: true,
    });
    expect(() =>
      parsePreviewArgs(["--before", "a.md", "--before-ref", "main"], repoRoot),
    ).toThrow(/before/);
    expect(() => parsePreviewArgs(["--document"], repoRoot)).toThrow(
      /document/,
    );
  });

  it("preserves documents and standalone server/CLI dependencies after their original source is gone", async () => {
    const options = await fixture();
    await fs.appendFile(
      options.documentPath,
      "A long document keeps the CLI JSON output above the pipe buffer.\n".repeat(
        3000,
      ),
    );
    const beforePath = path.join(options.root, "before.md");
    await fs.writeFile(beforePath, "# Guide\n\nBefore.\n");
    const prepared = await preparePreviewRuntime({ ...options, beforePath });
    const movedRuntime = path.join(options.root, "preserved");
    await fs.rename(prepared.runtimeDir, movedRuntime);
    await fs.rm(options.documentPath);
    await fs.rm(options.frontendDir, { recursive: true });
    const guard = path.join(options.root, "runtime-guard.mjs");
    await fs.writeFile(
      guard,
      `import { registerHooks } from 'node:module';\nimport { fileURLToPath } from 'node:url';\nimport path from 'node:path';\nconst root=process.env.TEST_PRESERVED_RUNTIME;\nregisterHooks({resolve(specifier, context, next) { const resolved=next(specifier, context); if (resolved.url.startsWith('file:')) { const relative=path.relative(root,fileURLToPath(resolved.url)); if (relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) throw new Error('Module resolved outside preserved runtime: '+resolved.url); } return resolved; }});\n`,
    );
    const guardedEnv = {
      ...process.env,
      NODE_OPTIONS: `--import=${guard}`,
      TEST_PRESERVED_RUNTIME: movedRuntime,
    };
    await expect(
      execute(
        process.execPath,
        ["--input-type=module", "-e", "await import('esbuild')"],
        { cwd: movedRuntime, env: guardedEnv },
      ),
    ).rejects.toThrow(/outside preserved runtime/);
    const { url } = await start(movedRuntime, guardedEnv);
    expect(await (await fetch(url)).text()).toContain("Roughdraft fixture");
    const cli = path.join(movedRuntime, "packages/server/bin/roughdraft.mjs");
    const after = path.join(
      movedRuntime,
      path.relative(prepared.runtimeDir, prepared.documentPath),
    );
    const before = path.join(
      movedRuntime,
      path.relative(prepared.runtimeDir, prepared.beforePath),
    );
    const result = await execute(
      process.execPath,
      [
        cli,
        "review",
        after,
        "--before",
        before,
        "--server",
        url,
        "--autosave",
        "none",
        "--title",
        "Durable guide",
        "--no-open",
        "--json",
      ],
      { cwd: movedRuntime, env: guardedEnv, maxBuffer: 16 * 1024 * 1024 },
    );
    const opened = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    expect(opened.event).toBe("comparison.opened");
    expect(new URL(opened.url).origin).toBe(new URL(url).origin);
    const read = await execute(
      process.execPath,
      [cli, "comparison", opened.url, "--read", "--json"],
      { cwd: movedRuntime, env: guardedEnv, maxBuffer: 16 * 1024 * 1024 },
    );
    const feedback = JSON.parse(read.stdout.trim().split("\n").at(-1) ?? "");
    expect(JSON.stringify(feedback)).toContain(
      "Real document with **formatting**.",
    );
    expect(JSON.stringify(feedback)).toContain("Before.");
    expect(
      await fs.stat(
        path.join(
          movedRuntime,
          "state/comparisons",
          `${opened.comparisonId}.json`,
        ),
      ),
    ).toBeTruthy();
  }, 30000);

  it("reuses unchanged runtime and leaves existing documents and drafts untouched when source changes", async () => {
    const options = await fixture();
    const first = await preparePreviewRuntime(options);
    await fs.mkdir(path.join(first.runtimeDir, "state/comparisons"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(first.runtimeDir, "state/comparisons/saved.json"),
      '{"draft":"Keep my edits"}',
    );
    const repeat = await preparePreviewRuntime(options);
    expect(repeat.runtimeDir).toBe(first.runtimeDir);
    await fs.writeFile(options.documentPath, "# Changed source\n");
    const changed = await preparePreviewRuntime(options);
    expect(changed.runtimeDir).not.toBe(first.runtimeDir);
    expect(await fs.readFile(first.documentPath, "utf8")).toContain(
      "Real document",
    );
    expect(
      await fs.readFile(
        path.join(first.runtimeDir, "state/comparisons/saved.json"),
        "utf8",
      ),
    ).toContain("Keep my edits");
  }, 30000);

  it("starts and keeps a managed runtime, then reopens the exact saved URL without replacing a draft", async () => {
    const options = await fixture();
    const prepared = await preparePreviewRuntime(options);
    const { url } = await start(prepared.runtimeDir);
    const { bin, callsFile } = await fakeDevservers(options.root, url);
    const config = {
      ...options,
      skipBuild: true,
      noOpen: true,
      devserversCommand: bin,
    };
    const first = await runPreview(config);
    const comparisonFile = path.join(
      prepared.runtimeDir,
      "state/comparisons",
      `${first.comparisonId}.json`,
    );
    const review = JSON.parse(await fs.readFile(comparisonFile, "utf8"));
    review.comment = "Reviewer's existing notes";
    await fs.writeFile(comparisonFile, JSON.stringify(review));
    const repeated = await runPreview(config);
    expect(repeated.url).toBe(first.url);
    expect(repeated.runtimeDir).toBe(prepared.runtimeDir);
    expect(repeated.autosave).toBe("none");
    const saved = JSON.parse(await fs.readFile(comparisonFile, "utf8"));
    expect(saved.comment).toBe("Reviewer's existing notes");
    const calls = (await fs.readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === "keep")).toHaveLength(2);
    expect(calls.filter((args) => args[0] === "check")).toHaveLength(2);
    expect(
      calls.some((args) => ["stop", "replace", "update"].includes(args[0])),
    ).toBe(false);
    expect(await fs.readFile(options.documentPath, "utf8")).toContain(
      "Real document",
    );
  }, 30000);
  it("retains a partially created review and verifies that same review on retry", async () => {
    const options = await fixture();
    const prepared = await preparePreviewRuntime(options);
    const { url } = await start(prepared.runtimeDir);
    const { bin } = await fakeDevservers(options.root, url);
    const config = {
      ...options,
      skipBuild: true,
      noOpen: true,
      devserversCommand: bin,
    };
    const shellPath = path.join(
      prepared.runtimeDir,
      "packages/app/dist/index.html",
    );
    const shell = await fs.readFile(shellPath);
    await fs.writeFile(shellPath, "<html>Temporary broken public route</html>");
    await expect(runPreview(config)).rejects.toThrow(/could not be verified/);
    const partial = JSON.parse(
      await fs.readFile(
        path.join(prepared.runtimeDir, "state/preview.json"),
        "utf8",
      ),
    );
    expect(partial.created).toBe(true);
    expect(partial.comparisonId).toBeTruthy();
    expect(partial.url).toBeUndefined();
    await fs.writeFile(shellPath, shell);
    const recovered = await runPreview(config);
    expect(recovered.comparisonId).toBe(partial.comparisonId);
    expect(
      (
        await fs.readdir(path.join(prepared.runtimeDir, "state/comparisons"))
      ).filter((file) => file.endsWith(".json")),
    ).toEqual([`${partial.comparisonId}.json`]);
  }, 30000);

  it("preserves the same document's version from an actual git reference", async () => {
    const options = await fixture();
    const documentPath = path.join(repoRoot, "README.md");
    const prepared = await preparePreviewRuntime({
      ...options,
      documentPath,
      beforeRef: "HEAD",
    });
    const expected = await execute("git", ["show", "HEAD:README.md"], {
      cwd: repoRoot,
    });
    expect(await fs.readFile(prepared.beforePath, "utf8")).toBe(
      expected.stdout,
    );
    expect(await fs.readFile(prepared.documentPath, "utf8")).toBe(
      await fs.readFile(documentPath, "utf8"),
    );
  }, 30000);
  it("keeps referenced images and linked Markdown documents after the source folder disappears", async () => {
    const options = await fixture();
    const sources = path.join(options.root, "source");
    await fs.mkdir(path.join(sources, "images"), { recursive: true });
    await fs.mkdir(path.join(sources, "notes"));
    const documentPath = path.join(sources, "guide.md");
    await fs.writeFile(
      documentPath,
      "# Guide\n\n![Map][map]\n\n[Details](notes/details.md)\n\n[map]: images/map.svg\n",
    );
    await fs.writeFile(
      path.join(sources, "images/map.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Preserved map</title></svg>',
    );
    await fs.writeFile(
      path.join(sources, "notes/details.md"),
      "# Linked details\n\n![Detail](detail.svg)\n",
    );
    await fs.writeFile(
      path.join(sources, "notes/detail.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Detail</title></svg>',
    );
    const prepared = await preparePreviewRuntime({ ...options, documentPath });
    await fs.rm(sources, { recursive: true });
    const { url } = await start(prepared.runtimeDir);
    const projectPath = path.dirname(prepared.documentPath);
    const image = await fetch(
      `${url}api/files?${new URLSearchParams({ projectPath, path: "images/map.svg" })}`,
    );
    expect(image.status).toBe(200);
    expect(await image.text()).toContain("Preserved map");
    const linked = await fetch(
      `${url}api/markdown-file?${new URLSearchParams({ projectPath, path: "notes/details.md" })}`,
    );
    expect(linked.status).toBe(200);
    expect(JSON.stringify(await linked.json())).toContain("Linked details");
    const nestedImage = await fetch(
      `${url}api/files?${new URLSearchParams({ projectPath: path.join(projectPath, "notes"), path: "detail.svg" })}`,
    );
    expect(nestedImage.status).toBe(200);
  }, 30000);

  it("rejects a missing local resource before claiming that a review is ready", async () => {
    const options = await fixture();
    await fs.writeFile(
      options.documentPath,
      "# Missing image\n\n![Missing](images/missing.png)\n",
    );
    await expect(preparePreviewRuntime(options)).rejects.toThrow(/missing.png/);
  }, 30000);
  it("keeps identically named documents from different source folders in separate reviews", async () => {
    const options = await fixture();
    const another = path.join(options.root, "another", "guide.md");
    await fs.mkdir(path.dirname(another));
    await fs.copyFile(options.documentPath, another);
    const first = await preparePreviewRuntime(options);
    const second = await preparePreviewRuntime({
      ...options,
      documentPath: another,
    });
    expect(second.runtimeDir).not.toBe(first.runtimeDir);
  }, 30000);

  it("prints a structured error for malformed JSON-mode invocations", async () => {
    let failed: { code?: number; stdout?: string; stderr?: string } | undefined;
    try {
      await execute(
        process.execPath,
        [
          path.join(repoRoot, "scripts/preview.mjs"),
          "--json",
          "--does-not-exist",
        ],
        { cwd: repoRoot },
      );
    } catch (error) {
      failed = error as typeof failed;
    }
    expect(failed?.code).toBe(1);
    expect(failed?.stdout).toBe("");
    expect(JSON.parse(failed?.stderr ?? "")).toMatchObject({
      event: "preview.failed",
      error: expect.stringContaining("--does-not-exist"),
    });
  });
  it("connects the CLI child directly to its selected server while preserving proxy settings and parent environment", async () => {
    const options = await fixture();
    const server = createHttpServer((_request, response) =>
      response.end("selected preview"),
    );
    const proxy = createHttpServer((_request, response) =>
      response.writeHead(502).end(),
    );
    proxy.on("connect", (_request, socket) =>
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const serverUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`;
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
      const original = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        NO_PROXY: "existing.example",
        no_proxy: "lower.example",
      };
      const beforeOriginal = { ...original };
      const beforeProcess = {
        NO_PROXY: process.env.NO_PROXY,
        no_proxy: process.env.no_proxy,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
      };
      const probe = `const response = await fetch(${JSON.stringify(serverUrl)}, {signal: AbortSignal.timeout(2000)}); if(response.status !== 200) throw new Error('Proxy intercepted selected preview: '+response.status); console.log(JSON.stringify({ text: await response.text(), NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy, HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY }));`;
      await expect(
        execute(process.execPath, ["--input-type=module", "-e", probe], {
          env: original,
        }),
      ).rejects.toThrow();
      const childEnv = cliEnvironment(original, options.root, serverUrl);
      const result = await execute(
        process.execPath,
        ["--input-type=module", "-e", probe],
        { env: childEnv },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        text: "selected preview",
        NO_PROXY: "existing.example,127.0.0.1",
        no_proxy: "lower.example,127.0.0.1",
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
      });
      expect(original).toEqual(beforeOriginal);
      expect({
        NO_PROXY: process.env.NO_PROXY,
        no_proxy: process.env.no_proxy,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
      }).toEqual(beforeProcess);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
      ]);
    }
  }, 10000);
  it("reads preview feedback with its emitted durable command under the original proxy environment", async () => {
    const options = await fixture();
    const prepared = await preparePreviewRuntime(options);
    const { url } = await start(prepared.runtimeDir);
    const { bin } = await fakeDevservers(options.root, url);
    const proxy = createHttpServer((_request, response) =>
      response.writeHead(502).end(),
    );
    proxy.on("connect", (_request, socket) =>
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"),
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
      const original = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        NO_PROXY: "existing.example",
        no_proxy: "lower.example",
      };
      const before = { ...original };
      const ready = await runPreview({
        ...options,
        skipBuild: true,
        noOpen: true,
        devserversCommand: bin,
        env: original,
      });
      const cli = path.join(
        ready.runtimeDir,
        "packages/server/bin/roughdraft.mjs",
      );
      const read = await execute(
        process.execPath,
        [cli, "comparison", ready.url, "--read", "--json"],
        { cwd: options.root, env: original },
      );
      expect(JSON.parse(read.stdout).comparison.id).toBe(ready.comparisonId);
      const emitted = await execute(
        ready.readCommand[0],
        ready.readCommand.slice(1),
        { cwd: options.root, env: original },
      );
      expect(JSON.parse(emitted.stdout).comparison.id).toBe(ready.comparisonId);
      expect(
        Object.keys(original).filter((key) => original[key] !== before[key]),
      ).toEqual([]);
      expect(original.NO_PROXY).toBe("existing.example");
      expect(original.no_proxy).toBe("lower.example");
      expect(original.HTTPS_PROXY).toBe(proxyUrl);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }, 15000);
});
