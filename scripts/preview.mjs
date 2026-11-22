#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { marked } from "marked";

const execute = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runtimeVersion = 1;

function logEvent(event, data, env = process.env, severity = "info") {
  if (!env.THOUGHTFUL_SLOG_FILE) return;
  return fs
    .appendFile(
      env.THOUGHTFUL_SLOG_FILE,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        runId: env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
        source: "preview",
        severity,
        event,
        data,
      })}\n`,
    )
    .catch(() => {});
}

export function parsePreviewArgs(argv, cwd = process.cwd()) {
  const options = {
    repoRoot: projectRoot,
    documentPath: path.join(projectRoot, "README.md"),
    autosave: "none",
    json: false,
    noOpen: false,
  };
  const values = new Map([
    ["--document", "documentPath"],
    ["--before", "beforePath"],
    ["--before-ref", "beforeRef"],
    ["--title", "title"],
    ["--autosave", "autosave"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--json") options.json = true;
    else if (argument === "--no-open") options.noOpen = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else {
      const key = values.get(argument);
      if (!key) throw new Error(`Unknown preview option: ${argument}`);
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${argument}`);
      options[key] = value;
    }
  }
  if (options.beforePath && options.beforeRef)
    throw new Error("Use either --before FILE or --before-ref REF.");
  options.documentPath = path.resolve(cwd, options.documentPath);
  if (options.beforePath)
    options.beforePath = path.resolve(cwd, options.beforePath);
  if (options.autosave !== "none")
    options.autosave = path.resolve(cwd, options.autosave);
  if (options.documentPath === path.join(projectRoot, "README.md"))
    options.title ??= "Review the Roughdraft Markdown editor";
  return options;
}

async function command(program, args, options = {}) {
  try {
    return await execute(program, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      ...options,
    });
  } catch (error) {
    const detail = [error.stderr?.trim(), error.stdout?.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${program} ${args[0] ?? ""} failed${detail ? `:\n${detail}` : `: ${error.message}`}`,
      { cause: error },
    );
  }
}

async function jsonCommand(program, args, options) {
  const result = await command(program, args, options);
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(
      `${program} did not return valid JSON: ${result.stdout.trim()}`,
    );
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
    flag: "wx",
  });
  await fs.rename(temporary, file);
}

async function treeFiles(directory, relative = "") {
  const entries = await fs.readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await treeFiles(directory, name)));
    else
      files.push({
        path: name,
        contents: await fs.readFile(path.join(directory, name)),
      });
  }
  return files;
}

function inside(base, file) {
  const relative = path.relative(base, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function documentGraph(sourceDocument, load) {
  const files = new Map();
  async function visit(file) {
    if (files.has(file)) return;
    let contents;
    try {
      contents = await load(file);
    } catch (error) {
      throw new Error(
        `Cannot preserve local review resource ${file}: ${error.message}`,
        { cause: error },
      );
    }
    files.set(file, contents);
    if (path.extname(file).toLowerCase() !== ".md") return;
    const destinations = [];
    marked.walkTokens(marked.lexer(contents.toString("utf8")), (token) => {
      if (token.type === "link" || token.type === "image")
        destinations.push(token.href);
      if (token.type === "html") {
        for (const match of token.raw.matchAll(
          /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
        ))
          destinations.push(match[1]);
      }
    });
    for (const href of destinations) {
      if (!href || href.startsWith("#") || href.startsWith("//")) continue;
      if (/^file:/i.test(href) || path.isAbsolute(href))
        throw new Error(
          `Cannot preserve absolute local link ${href} in ${file}; use a relative file link for preview.`,
        );
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      let relative;
      try {
        relative = decodeURIComponent(href.split(/[?#]/, 1)[0]);
      } catch {
        throw new Error(
          `Cannot decode local review resource ${href} in ${file}.`,
        );
      }
      if (!relative) continue;
      const target = path.resolve(path.dirname(file), relative);
      if (
        path.extname(target).toLowerCase() !== ".md" &&
        !inside(path.dirname(file), target)
      )
        throw new Error(
          `Cannot preview local asset ${href} in ${file}: Roughdraft serves assets beneath each document's folder. Place the asset inside that folder.`,
        );
      await visit(target);
    }
  }
  await visit(sourceDocument);
  let root = path.dirname(sourceDocument);
  for (const file of files.keys())
    while (!inside(root, file)) root = path.dirname(root);
  return {
    document: path.relative(root, sourceDocument),
    files: [...files]
      .map(([file, contents]) => ({
        path: path.relative(root, file),
        contents,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function reviewDocuments(options) {
  const current = await documentGraph(options.documentPath, (file) =>
    fs.readFile(file),
  );
  let before = null;
  if (options.beforePath)
    before = await documentGraph(options.beforePath, (file) =>
      fs.readFile(file),
    );
  else if (options.beforeRef) {
    before = await documentGraph(options.documentPath, async (file) => {
      if (!inside(options.repoRoot, file))
        throw new Error(
          "--before-ref requires all referenced files inside this repository; use --before FILE for other documents.",
        );
      const relative = path
        .relative(options.repoRoot, file)
        .split(path.sep)
        .join("/");
      return (
        await command("git", ["show", `${options.beforeRef}:${relative}`], {
          cwd: options.repoRoot,
          encoding: "buffer",
        })
      ).stdout;
    });
  }
  return { current, before };
}

/** Package only the built frontend, bundled application dependencies and explicit review inputs. */
export async function preparePreviewRuntime(options) {
  const repoRoot = options.repoRoot ?? projectRoot;
  const documentPath = options.documentPath ?? path.join(repoRoot, "README.md");
  const autosave = options.autosave ?? "none";
  if (path.extname(documentPath).toLowerCase() !== ".md")
    throw new Error("Preview documents must have a .md extension.");
  if (
    autosave !== "none" &&
    (!path.isAbsolute(autosave) ||
      path.extname(autosave).toLowerCase() !== ".md")
  )
    throw new Error(
      "Autosave must be none or an absolute Markdown destination.",
    );
  const frontendDir =
    options.frontendDir ?? path.join(repoRoot, "packages/app/dist");
  const runtimeBaseDir =
    options.runtimeBaseDir ??
    path.join(os.homedir(), ".local/share/devservers/review-runtimes");
  const packageText = await fs.readFile(
    path.join(repoRoot, "package.json"),
    "utf8",
  );
  const { current, before } = await reviewDocuments({
    ...options,
    repoRoot,
    documentPath,
  });
  const mainDocument = current.files.find(
    (file) => file.path === current.document,
  );
  const heading = marked
    .lexer(mainDocument.contents.toString("utf8"))
    .find((token) => token.type === "heading");
  const title =
    options.title ??
    (path.resolve(documentPath) === path.join(repoRoot, "README.md")
      ? "Review the Roughdraft Markdown editor"
      : `Review ${heading?.text || path.basename(documentPath)}`);
  const frontend = await treeFiles(frontendDir);
  if (!frontend.some((file) => file.path === "index.html"))
    throw new Error("The built app is missing index.html; run pnpm build.");
  const bundle = await build({
    absWorkingDir: repoRoot,
    entryPoints: {
      cli: "packages/server/src/cli.ts",
      child: "packages/server/src/child.ts",
      server: "packages/server/src/index.ts",
    },
    outdir: "preview-bundle",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
    logLevel: "silent",
    banner: {
      js: 'import { createRequire as __previewCreateRequire } from "node:module"; const require = __previewCreateRequire(import.meta.url);',
    },
  });
  const configuration = {
    runtimeVersion,
    source: repoRoot,
    title,
    autosave,
    sourceDocument: path.resolve(documentPath),
    beforeSource: options.beforePath
      ? path.resolve(options.beforePath)
      : (options.beforeRef ?? null),
    document: current.document,
    before: before !== null,
  };
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(configuration))
    .update(packageText)
    .update(await fs.readFile(fileURLToPath(import.meta.url)));
  for (const file of [
    ...current.files,
    ...(before?.files ?? []),
    ...bundle.outputFiles,
    ...frontend,
  ])
    fingerprint.update(file.path).update(file.contents);
  const hash = fingerprint.digest("hex");
  const runtimeDir = path.join(
    runtimeBaseDir,
    `roughdraft-preview-${hash.slice(0, 16)}`,
  );
  const result = {
    runtimeDir,
    documentPath: path.join(runtimeDir, "documents/current", current.document),
    beforePath:
      before === null
        ? null
        : path.join(runtimeDir, "documents/before", before.document),
    title,
    autosave,
    fingerprint: hash,
  };
  const existing = await readJson(path.join(runtimeDir, "manifest.json"));
  if (existing) {
    if (existing.fingerprint !== hash)
      throw new Error(`Preview runtime identity conflict: ${runtimeDir}`);
    await logEvent(
      "runtime.reused",
      { runtimeDir, fingerprint: hash },
      options.env,
    );
    return result;
  }
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  const staging = await fs.mkdtemp(
    path.join(runtimeBaseDir, ".roughdraft-preparing-"),
  );
  try {
    await fs.mkdir(path.join(staging, "packages/server/dist"), {
      recursive: true,
    });
    await fs.mkdir(path.join(staging, "packages/server/bin"), {
      recursive: true,
    });
    await fs.mkdir(path.join(staging, "packages/app/dist"), {
      recursive: true,
    });
    await fs.mkdir(path.join(staging, "documents"));
    await fs.mkdir(path.join(staging, "state/comparisons"), {
      recursive: true,
    });
    await fs.writeFile(path.join(staging, "package.json"), packageText);
    await fs.writeFile(
      path.join(staging, "packages/server/package.json"),
      '{"type":"module","private":true}\n',
    );
    for (const file of bundle.outputFiles)
      await fs.writeFile(
        path.join(staging, "packages/server/dist", path.basename(file.path)),
        file.contents,
      );
    for (const file of frontend) {
      const destination = path.join(staging, "packages/app/dist", file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.contents);
    }
    for (const [namespace, graph] of [
      ["current", current],
      ["before", before],
    ]) {
      if (!graph) continue;
      for (const file of graph.files) {
        const destination = path.join(
          staging,
          "documents",
          namespace,
          file.path,
        );
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.contents);
      }
    }
    await fs.writeFile(
      path.join(staging, "packages/server/bin/roughdraft.mjs"),
      `import fs from "node:fs/promises";
${withManagedHostBypass.toString()}
let saved;
try { saved = JSON.parse(await fs.readFile(new URL("../../../state/preview.json", import.meta.url), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot read this preview's saved connection: " + error.message); }
if (saved?.serverUrl !== undefined) Object.assign(process.env, withManagedHostBypass(process.env, saved.serverUrl));
const { runCli } = await import("../dist/cli.js");
process.exitCode = await runCli(process.argv.slice(2));
`,
    );
    await fs.writeFile(
      path.join(staging, "launch.mjs"),
      `import path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst root = path.dirname(fileURLToPath(import.meta.url));\nprocess.env.ROUGHDRAFT_BIND_HOST = "127.0.0.1";\nprocess.env.ROUGHDRAFT_COMPARISONS_DIR = path.join(root, "state/comparisons");\nprocess.env.ROUGHDRAFT_STATE_DIR = path.join(root, "state");\nprocess.env.THOUGHTFUL_SLOG_FILE = path.join(root, "state/runtime.jsonl");\nprocess.env.THOUGHTFUL_SLOG_RUN_ID = ${JSON.stringify(`preview-${hash.slice(0, 16)}`)};\nconst port = Number(process.env.PORT);\nif (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Managed preview requires PORT.");\nconst { createServer } = await import("./packages/server/dist/server.js");\nawait createServer(port);\n`,
    );
    await fs.writeFile(
      path.join(staging, "manifest.json"),
      `${JSON.stringify({ ...configuration, fingerprint: hash, preparedAt: new Date().toISOString(), sourceDocument: documentPath, dependencyHandling: "Bundled server and CLI dependencies; copied frontend and documents; no source-worktree runtime dependencies" }, null, 2)}\n`,
    );
    try {
      await fs.rename(staging, runtimeDir);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      const concurrent = await readJson(path.join(runtimeDir, "manifest.json"));
      if (concurrent?.fingerprint !== hash) throw error;
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  await logEvent(
    "runtime.prepared",
    { runtimeDir, fingerprint: hash },
    options.env,
  );
  return result;
}

function withManagedHostBypass(env, serverUrl) {
  let selected;
  try {
    selected = new URL(serverUrl);
  } catch {
    throw new Error("The saved managed preview server URL is invalid.");
  }
  if (!["http:", "https:"].includes(selected.protocol))
    throw new Error(
      "The saved managed preview server URL must use HTTP or HTTPS.",
    );
  // Scope the bypass to this managed hostname, preserving the process's
  // outbound proxy and its existing exclusions in either environment spelling.
  const hostname = selected.hostname;
  const upperBypass = env.NO_PROXY ?? env.no_proxy ?? "";
  const lowerBypass = env.no_proxy ?? env.NO_PROXY ?? "";
  const appendHostname = (existing) =>
    existing.split(",").some((entry) => entry.trim() === hostname)
      ? existing
      : [existing, hostname].filter(Boolean).join(",");
  return {
    ...env,
    NO_PROXY: appendHostname(upperBypass),
    no_proxy: appendHostname(lowerBypass),
  };
}

export function cliEnvironment(env, runtimeDir, serverUrl) {
  const result = { ...env };
  for (const key of Object.keys(result))
    if (key.startsWith("ROUGHDRAFT_") || key === "DEVSERVERS_PUBLIC_URL")
      delete result[key];
  return {
    ...withManagedHostBypass(result, serverUrl),
    ROUGHDRAFT_STATE_DIR: path.join(runtimeDir, "state"),
    ROUGHDRAFT_COMPARISONS_DIR: path.join(runtimeDir, "state/comparisons"),
    ROUGHDRAFT_PUBLIC_URL: serverUrl,
  };
}

function cliEvent(stdout) {
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const event = events.findLast((item) => item.event === "comparison.opened");
  if (!event?.url || !event.comparisonId)
    throw new Error("Roughdraft did not return a verified review URL.");
  return event;
}

export async function runPreview(options) {
  const repoRoot = options.repoRoot ?? projectRoot;
  const env = options.env ?? process.env;
  if (!options.skipBuild) {
    await logEvent("build.started", { repoRoot }, env);
    await command("pnpm", ["build"], { cwd: repoRoot, env });
    await logEvent("build.completed", { repoRoot }, env);
  }
  const runtime = await preparePreviewRuntime({ ...options, repoRoot, env });
  const stateFile = path.join(runtime.runtimeDir, "state/preview.json");
  const saved = await readJson(stateFile);
  const devservers = options.devserversCommand ?? "devservers";
  const reason = `Dan needs to review ${runtime.title}; preserve the independent app, documents and saved review until accepted.`;
  const managed = await jsonCommand(
    devservers,
    [
      "start",
      "--cwd",
      runtime.runtimeDir,
      "--name",
      "review",
      "--no-repo",
      "--purpose",
      `Review Roughdraft: ${runtime.title}`,
      "--needed-for",
      "Until Dan accepts this document and application review",
      "--owner",
      "Dan / Roughdraft",
      "--review",
      "--reason",
      reason,
      "--health-url",
      "/api/status",
      "--json",
      "--",
      process.execPath,
      path.join(runtime.runtimeDir, "launch.mjs"),
    ],
    { cwd: repoRoot, env },
  );
  if (!managed.id || !managed.url || managed.state !== "active")
    throw new Error(
      "devservers did not return an active managed preview and canonical URL.",
    );
  const serverUrl = new URL(managed.url);
  if (!["http:", "https:"].includes(serverUrl.protocol))
    throw new Error("Managed preview URL must use HTTP or HTTPS.");
  await writeJson(stateFile, {
    ...saved,
    devserverId: managed.id,
    serverUrl: managed.url,
  });
  const kept = await jsonCommand(
    devservers,
    ["keep", managed.id, "--reason", reason, "--json"],
    { cwd: repoRoot, env },
  );
  if (kept.review_hold !== true || kept.expires_at !== null)
    throw new Error(
      `devservers did not retain review ${managed.id}; inspect devservers status ${managed.id} --json.`,
    );
  const checked = await jsonCommand(
    devservers,
    ["check", managed.id, "--json"],
    { cwd: repoRoot, env },
  );
  if (checked.access?.state !== "ready")
    throw new Error(
      `Managed preview public access failed: ${checked.access?.error ?? checked.access?.state ?? "not verified"}. Inspect devservers status ${managed.id} --json and devservers logs ${managed.id}.`,
    );
  const cli = path.join(
    runtime.runtimeDir,
    "packages/server/bin/roughdraft.mjs",
  );
  const existingReview = saved?.url ?? saved?.comparisonId;
  const args = existingReview
    ? ["comparison", existingReview]
    : runtime.beforePath
      ? ["review", runtime.documentPath, "--before", runtime.beforePath]
      : ["edit", runtime.documentPath];
  args.push("--server", managed.url, "--no-open", "--json");
  if (!existingReview)
    args.push("--title", runtime.title, "--autosave", runtime.autosave);
  let opened;
  try {
    opened = await command(process.execPath, [cli, ...args], {
      cwd: runtime.runtimeDir,
      env: cliEnvironment(env, runtime.runtimeDir, managed.url),
    });
  } catch (error) {
    const partial = error.cause?.stdout
      ?.trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .findLast((event) => event?.event === "comparison.verification_failed");
    if (partial?.comparisonId) {
      const recovery = {
        devserverId: managed.id,
        serverUrl: managed.url,
        comparisonId: partial.comparisonId,
        created: partial.created,
        runtimeDir: runtime.runtimeDir,
      };
      await writeJson(stateFile, { ...saved, ...recovery });
      error.recovery = recovery;
      await logEvent("preview.verification-failed", recovery, env, "error");
    }
    throw error;
  }
  const review = cliEvent(opened.stdout);
  const result = {
    event: "preview.ready",
    url: review.url,
    comparisonId: review.comparisonId,
    serverUrl: managed.url,
    devserverId: managed.id,
    runtimeDir: runtime.runtimeDir,
    documentPath: runtime.documentPath,
    title: runtime.title,
    autosave: runtime.autosave,
    kept: true,
    readCommand: [
      process.execPath,
      cli,
      "comparison",
      review.url,
      "--read",
      "--json",
    ],
  };
  await writeJson(stateFile, result);
  await logEvent(
    "preview.verified",
    {
      runtimeDir: runtime.runtimeDir,
      devserverId: managed.id,
      comparisonId: review.comparisonId,
      reusedReview: Boolean(existingReview),
    },
    env,
  );
  if (!options.noOpen && !env.ROUGHDRAFT_NO_OPEN) {
    // Reopening a verified saved review delegates the platform's browser integration to the packaged CLI.
    await command(
      process.execPath,
      [cli, "comparison", result.url, "--server", managed.url, "--json"],
      {
        cwd: runtime.runtimeDir,
        env: cliEnvironment(env, runtime.runtimeDir, managed.url),
      },
    );
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  let options;
  try {
    options = parsePreviewArgs(process.argv.slice(2));
    if (options.help) {
      console.log(
        "pnpm preview [--document FILE.md] [--before FILE.md | --before-ref REF] [--title TITLE] [--autosave FILE.md|none] [--json] [--no-open]\nBuild and keep a standalone managed preview; print its verified unified review URL.\nThe default document is README.md and autosave is none. --before-ref reads the same document at REF.",
      );
    } else {
      const result = await runPreview(options);
      console.log(options.json ? JSON.stringify(result) : result.url);
    }
  } catch (error) {
    await logEvent(
      "preview.failed",
      { error: error.message },
      process.env,
      "error",
    );
    if (options?.json || process.argv.slice(2).includes("--json"))
      console.error(
        JSON.stringify({
          event: "preview.failed",
          error: error.message,
          ...error.recovery,
        }),
      );
    else console.error(error.message);
    process.exitCode = 1;
  }
}
