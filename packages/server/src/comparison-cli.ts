import fs from "node:fs";
import path from "node:path";
import type { CliDependencies } from "./cli.js";
import {
  comparisonBrowserUrl,
  comparisonEndpoint,
  comparisonHandle,
  comparisonServerStatus,
  comparisonServerUrl,
  verifyComparisonUrl,
} from "./comparison-connection.js";
import { logServerEvent } from "./diagnostics.js";

export const COMPARISON_COMMANDS = [
  "edit",
  "propose",
  "review",
  "compare",
  "comparison",
  "snapshot",
] as const;
export type ComparisonCommand = (typeof COMPARISON_COMMANDS)[number];

interface ComparisonResult {
  id: string;
  status: "open" | "completed" | "applied";
  completion: {
    fileWritten: boolean;
    targetPath: string | null;
    accepted: number;
    reverted: number;
    completedAt: string;
  } | null;
  editor?: "unified";
  handoff?: "chat" | "button";
  revision?: number;
  feedback?: { sentAt: string; saved: boolean } | null;
  title?: string;
  afterText?: string;
  draft?: { markdown: string; decisions: Record<string, "kept"> } | null;
  reviewComments?: unknown[];
  [key: string]: unknown;
}
interface ComparisonOptions {
  positionals: string[];
  before?: string;
  after?: string;
  out?: string;
  title?: string;
  beforeLabel?: string;
  afterLabel?: string;
  autosave?: string;
  autosaveBase?: string;
  copyDirectory?: string;
  port?: string;
  server?: string;
  stateDir?: string;
  stateFile?: string;
  json: boolean;
  noOpen: boolean;
  noWatch: boolean;
  read: boolean;
  help: boolean;
  timeout: number;
}
export interface ComparisonConnection {
  apiUrl: string;
  frontendUrl: string;
  preferredPort?: number;
  portChanged?: boolean;
}
type Connect = (deps: CliDependencies) => Promise<ComparisonConnection>;

export function isComparisonCommand(value: string): value is ComparisonCommand {
  return (COMPARISON_COMMANDS as readonly string[]).includes(value);
}

export function printComparisonHelp(
  command: ComparisonCommand,
  log: (message: string) => void,
): void {
  const usages: Record<ComparisonCommand, string> = {
    edit: "roughdraft edit [FILE.md]",
    propose: "roughdraft propose TARGET.md --after CANDIDATE.md",
    review: "roughdraft review TARGET.md --before SNAPSHOT.md",
    compare: "roughdraft compare BEFORE.md AFTER.md",
    comparison: "roughdraft comparison ID|URL",
    snapshot: "roughdraft snapshot FILE.md --out SNAPSHOT.md",
  };
  log(`Usage: ${usages[command]}`);
  if (command === "snapshot") {
    log("Copies exact file bytes. Refuses to overwrite an existing snapshot.");
    log(
      "  --json                Print the snapshot path and source path as JSON",
    );
    return;
  }
  log(
    "Opens a saved review and returns immediately. Tell the agent in chat when ready.",
  );
  if (command === "comparison") {
    log(
      "  --read                Read the latest saved draft and comments without opening a browser",
    );
  } else {
    log("  --title TEXT          Review title understandable to a new reader");
    log("  --before-label TEXT   Friendly name for the previous version");
    log("  --after-label TEXT    Friendly name for the updated version");
    log(
      "  --autosave PATH|none  Save edits to this Markdown file, or only save the review",
    );
    log(
      "  --autosave-base old|new  Seed a new destination from this version (default new)",
    );
    log(
      "  --copy-directory PATH  Suggested folder on the server for Save separately",
    );
    log("edit FILE defaults autosave to FILE; other reviews default to none.");
  }
  log("  --watch               Wait for the user to press Send feedback");
  log("  --no-watch            Return immediately (default)");
  log(
    "  --timeout SECONDS     Maximum wait (default 1800); timeout is not approval",
  );
  log("  --no-open             Print the URL without launching a browser");
  log(
    "  --json                Print JSON events, including the actual write result",
  );
  log(
    "  --server URL          Use this exact existing server; never start or fall back",
  );
  log(
    "  --port PORT           Preferred local startup port (may change if busy)",
  );
  log("  --state-dir DIR       Directory containing the local server state");
  log("  --state-file FILE     Local server state file");
  log(
    "Use `roughdraft comparison ID --read --json` to read saved edits, suggestions, and comments.",
  );
}

function parseOptions(args: string[]): ComparisonOptions {
  const options: ComparisonOptions = {
    positionals: [],
    json: false,
    noOpen: false,
    noWatch: true,
    read: false,
    help: false,
    timeout: 1800,
  };
  const values = new Map([
    ["--before", "before"],
    ["--after", "after"],
    ["--out", "out"],
    ["--title", "title"],
    ["--before-label", "beforeLabel"],
    ["--after-label", "afterLabel"],
    ["--autosave", "autosave"],
    ["--autosave-base", "autosaveBase"],
    ["--copy-directory", "copyDirectory"],
    ["--port", "port"],
    ["--server", "server"],
    ["--state-dir", "stateDir"],
    ["--state-file", "stateFile"],
  ] as const);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      options.positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--json") options.json = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--no-watch") options.noWatch = true;
    else if (arg === "--watch") options.noWatch = false;
    else if (arg === "--read") options.read = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) {
      const separator = arg.indexOf("=");
      const flag = separator < 0 ? arg : arg.slice(0, separator);
      const key = values.get(flag as Parameters<typeof values.get>[0]);
      if (!key && flag !== "--timeout")
        throw new Error(`Unknown flag: ${flag}`);
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (!value || value.startsWith("--"))
        throw new Error(`${flag} requires a value.`);
      if (flag === "--timeout") {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) {
          throw new Error("--timeout must be a nonnegative finite number.");
        }
        options.timeout = number;
      } else if (key) {
        options[key] = value;
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else options.positionals.push(arg);
  }
  if (
    options.port &&
    (!/^\d+$/.test(options.port) ||
      Number(options.port) < 1 ||
      Number(options.port) > 65535)
  ) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  const handle = options.positionals[0]
    ? comparisonHandle(options.positionals[0])
    : null;
  if (options.server) comparisonServerUrl(options.server);
  if (
    (options.server || handle) &&
    (options.port || options.stateDir || options.stateFile)
  )
    throw new Error(
      "An exact server or review URL cannot be combined with --port, --state-dir, or --state-file.",
    );
  if (
    handle &&
    options.server &&
    comparisonServerUrl(options.server).toString() !== handle.serverUrl
  )
    throw new Error("The review URL and --server refer to different servers.");
  return options;
}

function markdownPath(cwd: string, value: string): string {
  const absolute = fs.realpathSync(path.resolve(cwd, value));
  if (
    path.extname(absolute).toLowerCase() !== ".md" ||
    !fs.statSync(absolute).isFile()
  ) {
    throw new Error(`Choose an existing Markdown file: ${absolute}`);
  }
  return absolute;
}

class ComparisonHttpError extends Error {}

async function request(
  deps: CliDependencies,
  url: URL,
  body?: unknown,
  timeout = 5000,
): Promise<ComparisonResult> {
  const response = await deps.fetchImpl(url, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout))),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { error?: string };
      detail = payload.error ?? detail;
    } catch {}
    throw new ComparisonHttpError(
      `Comparison request failed (${response.status}): ${detail}`,
    );
  }
  const result = (await response.json()) as ComparisonResult;
  if (
    typeof result.id !== "string" ||
    !["open", "completed", "applied"].includes(result.status)
  ) {
    throw new Error(
      "The server returned an invalid comparison. Use a Roughdraft server with file comparison support.",
    );
  }
  return result;
}

function validateUsage(
  command: ComparisonCommand,
  options: ComparisonOptions,
): void {
  const expected = command === "compare" ? 2 : 1;
  if (options.server && command === "snapshot")
    throw new Error("--server is not valid with snapshot.");
  if (
    command !== "comparison" &&
    options.positionals.some((value) => comparisonHandle(value))
  )
    throw new Error("A review URL is only valid with comparison.");
  if (
    command === "edit"
      ? options.positionals.length > 1
      : options.positionals.length !== expected
  )
    throw new Error(
      `Expected ${expected} argument(s) for ${command}. Use roughdraft help ${command}.`,
    );
  if (command === "propose" && !options.after)
    throw new Error("propose requires --after CANDIDATE.md.");
  if (command === "review" && !options.before)
    throw new Error("review requires --before SNAPSHOT.md.");
  if (command === "snapshot" && !options.out)
    throw new Error("snapshot requires --out SNAPSHOT.md.");
  if (options.before && command !== "review")
    throw new Error("--before is only valid with review.");
  if (options.after && command !== "propose")
    throw new Error("--after is only valid with propose.");
  if (options.out && command !== "snapshot")
    throw new Error("--out is only valid with snapshot.");
  if (options.read && command !== "comparison")
    throw new Error("--read is only valid with comparison ID.");
  if (options.read && !options.noWatch)
    throw new Error("Use either --read or --watch, not both.");
  if (options.autosaveBase && !["old", "new"].includes(options.autosaveBase))
    throw new Error("--autosave-base must be old or new.");
  if (options.copyDirectory !== undefined && !options.copyDirectory.trim())
    throw new Error("--copy-directory must name a folder on the server.");
  if (
    (command === "snapshot" || command === "comparison") &&
    [
      options.title,
      options.beforeLabel,
      options.afterLabel,
      options.autosave,
      options.autosaveBase,
      options.copyDirectory,
    ].some((value) => value !== undefined)
  )
    throw new Error(
      "Review metadata and autosave options are only valid when opening a new review.",
    );
}

function autosavePath(cwd: string, value: string): string {
  if (value === "none") return value;
  const absolute = path.resolve(cwd, value);
  if (path.extname(absolute).toLowerCase() !== ".md")
    throw new Error("Autosave output must have a .md extension or be none.");
  return absolute;
}

function printSavedReview(
  comparison: ComparisonResult,
  log: (message: string) => void,
): void {
  log(comparison.title || `Review ${comparison.id}`);
  log(`Review ID: ${comparison.id}`);
  log(`Draft:\n${comparison.draft?.markdown ?? comparison.afterText ?? ""}`);
  log(
    `Decisions:\n${JSON.stringify(comparison.draft?.decisions ?? {}, null, 2)}`,
  );
  log(`Comments:\n${JSON.stringify(comparison.reviewComments ?? [], null, 2)}`);
}

export async function runComparisonCommand(
  command: ComparisonCommand,
  args: string[],
  originalDeps: CliDependencies,
  globalJson: boolean,
  connect: Connect,
): Promise<number> {
  let options: ComparisonOptions;
  try {
    options = parseOptions(args);
    if (options.help) {
      printComparisonHelp(command, originalDeps.log);
      return 0;
    }
    validateUsage(command, options);
  } catch (error) {
    originalDeps.error(
      error instanceof Error ? error.message : "Invalid comparison arguments.",
    );
    return 2;
  }
  const deps: CliDependencies = {
    ...originalDeps,
    env: {
      ...originalDeps.env,
      ...(options.port ? { ROUGHDRAFT_PORT: options.port } : {}),
      ...(options.stateDir ? { ROUGHDRAFT_STATE_DIR: options.stateDir } : {}),
      ...(options.stateFile
        ? { ROUGHDRAFT_STATE_FILE: options.stateFile }
        : {}),
    },
  };
  const json = options.json || globalJson;
  try {
    const input = options.positionals[0];
    const handle = command === "comparison" ? comparisonHandle(input) : null;
    const exactServer =
      handle?.serverUrl ??
      (options.server
        ? comparisonServerUrl(options.server).toString()
        : undefined);
    if (command === "snapshot") {
      const source = markdownPath(deps.cwd, input);
      const output = path.resolve(deps.cwd, options.out ?? "");
      if (path.extname(output).toLowerCase() !== ".md")
        throw new Error("Snapshot output must have a .md extension.");
      fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
      deps.log(
        json
          ? JSON.stringify({
              event: "snapshot.created",
              sourcePath: source,
              snapshotPath: output,
            })
          : `Snapshot saved to ${output}`,
      );
      return 0;
    }
    if (deps.env.ROUGHDRAFT_HOST?.trim() && !exactServer) {
      throw new Error(
        "File comparisons require a local-files Roughdraft server with access to both source paths. Unset ROUGHDRAFT_HOST; remote document sessions do not support comparison writes.",
      );
    }
    let payload: Record<string, string> | undefined;
    if (command === "edit")
      payload = input ? { targetPath: markdownPath(deps.cwd, input) } : {};
    if (command === "propose")
      payload = {
        editor: "unified",
        mode: "proposal",
        targetPath: markdownPath(deps.cwd, input),
        afterPath: markdownPath(deps.cwd, options.after ?? ""),
      };
    if (command === "review")
      payload = {
        editor: "unified",
        mode: "applied",
        targetPath: markdownPath(deps.cwd, input),
        beforePath: markdownPath(deps.cwd, options.before ?? ""),
      };
    if (command === "compare")
      payload = {
        editor: "unified",
        mode: "compare",
        beforePath: markdownPath(deps.cwd, input),
        afterPath: markdownPath(deps.cwd, options.positionals[1]),
      };
    if (payload) {
      Object.assign(payload, {
        autosave: autosavePath(
          deps.cwd,
          options.autosave ??
            (command === "edit" ? (payload.targetPath ?? "none") : "none"),
        ),
        handoff: options.noWatch ? "chat" : "button",
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.beforeLabel === undefined
          ? {}
          : { beforeLabel: options.beforeLabel }),
        ...(options.afterLabel === undefined
          ? {}
          : { afterLabel: options.afterLabel }),
        ...(options.autosaveBase === undefined
          ? {}
          : { autosaveBase: options.autosaveBase }),
        ...(options.copyDirectory === undefined
          ? {}
          : { copyDirectory: options.copyDirectory }),
      });
    }
    logServerEvent("comparison-cli", "review.request", {
      command,
      read: options.read,
      watch: !options.noWatch,
      handoff: payload?.handoff ?? null,
      autosaveEnabled:
        payload?.autosave !== undefined && payload.autosave !== "none",
    });
    const connection = exactServer
      ? { apiUrl: exactServer, frontendUrl: exactServer }
      : await connect(deps);
    const serverUrl = comparisonServerUrl(connection.apiUrl).toString();
    const selected = await comparisonServerStatus(deps, serverUrl, {
      allowLegacyRead: options.read && handle !== null,
    });
    // Validate a configured alias before creation; network verification follows creation.
    const browserBase = options.read
      ? serverUrl
      : deps.env.ROUGHDRAFT_PUBLIC_URL ||
        selected.publicUrl ||
        connection.frontendUrl;
    if (!handle) comparisonServerUrl(browserBase);
    const port = Number(
      new URL(serverUrl).port ||
        (new URL(serverUrl).protocol === "https:" ? 443 : 80),
    );
    const connectionOutput = {
      serverUrl,
      port,
      preferredPort: connection.preferredPort ?? null,
      portChanged: connection.portChanged ?? false,
    };
    const endpoint =
      command === "comparison"
        ? `/api/comparisons/${encodeURIComponent(handle?.id ?? input)}`
        : command === "edit"
          ? "/api/comparisons/document"
          : "/api/comparisons";
    let opened = await request(
      deps,
      comparisonEndpoint(serverUrl, endpoint),
      payload,
    );
    if (command === "comparison" && opened.id !== (handle?.id ?? input))
      throw new Error("The selected server returned a different review ID.");
    const url = handle
      ? new URL(handle.url)
      : comparisonBrowserUrl(browserBase, opened.id);
    if (options.read) {
      logServerEvent("comparison-cli", "review.read", {
        comparisonId: opened.id,
        hasDraft: opened.draft != null,
        commentCount: opened.reviewComments?.length ?? 0,
      });
      if (json)
        deps.log(
          JSON.stringify({
            event: "comparison.read",
            comparisonId: opened.id,
            url: url.toString(),
            ...connectionOutput,
            comparison: opened,
          }),
        );
      else printSavedReview(opened, deps.log);
      return 0;
    }
    try {
      await verifyComparisonUrl(deps, url, opened.id, selected);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "Review link verification failed.";
      logServerEvent(
        "comparison-cli",
        "review.verification-failed",
        {
          comparisonId: opened.id,
          serverUrl,
          created: command !== "comparison",
          error: detail,
        },
        "error",
      );
      if (json)
        deps.log(
          JSON.stringify({
            event: "comparison.verification_failed",
            comparisonId: opened.id,
            ...connectionOutput,
            created: command !== "comparison",
            error: detail,
          }),
        );
      deps.error(
        `Review ${opened.id} is saved on ${serverUrl}, but its browser link could not be verified: ${detail} Reopen this ID with --server ${serverUrl}; do not create another review.`,
      );
      return 1;
    }
    const reviewPath = `/api/comparisons/${encodeURIComponent(opened.id)}`;
    if (
      command === "comparison" &&
      !options.noWatch &&
      opened.handoff === "chat"
    ) {
      opened = await request(
        deps,
        comparisonEndpoint(serverUrl, `${reviewPath}/handoff`),
        {
          revision: opened.revision,
          handoff: "button",
        },
      );
    }
    const freshFeedback = opened.editor === "unified";
    const watchUrl = comparisonEndpoint(
      serverUrl,
      freshFeedback ? `${reviewPath}/watch` : reviewPath,
    );
    const feedbackKey = (result: ComparisonResult) =>
      result.feedback ? `${result.id}:${result.feedback.sentAt}` : null;
    let comparison =
      freshFeedback && !options.noWatch
        ? await request(deps, watchUrl)
        : opened;
    const previousFeedback = feedbackKey(comparison);
    if (!options.noOpen && deps.env.ROUGHDRAFT_NO_OPEN !== "1")
      deps.openUrl(url.toString());
    deps.log(
      json
        ? JSON.stringify({
            event: "comparison.opened",
            comparisonId: opened.id,
            url: url.toString(),
            ...connectionOutput,
            comparison: opened,
          })
        : url.toString(),
    );
    logServerEvent("comparison-cli", "review.opened", {
      comparisonId: opened.id,
      watch: !options.noWatch,
    });
    if (options.noWatch) return 0;
    const deadline = Date.now() + options.timeout * 1000;
    const awaitingFeedback = () =>
      freshFeedback
        ? feedbackKey(comparison) === previousFeedback
        : comparison.status === "open";
    while (awaitingFeedback()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (json)
          deps.log(
            JSON.stringify({
              event: "comparison.timeout",
              comparisonId: opened.id,
              url: url.toString(),
              timedOut: true,
              completion: null,
            }),
          );
        else
          deps.error(
            `No new feedback was received for ${opened.id}. Resume waiting with roughdraft comparison ${url.toString()} --watch, or read saved feedback with --read.`,
          );
        return 1;
      }
      try {
        comparison = await request(
          deps,
          watchUrl,
          undefined,
          Math.min(5000, remaining),
        );
      } catch (error) {
        // A saved comparison survives a server restart. Keep waiting through a
        // temporary connection loss, but surface permanent API errors promptly.
        if (
          error instanceof ComparisonHttpError ||
          !(
            error instanceof TypeError ||
            (error instanceof Error &&
              ["AbortError", "TimeoutError"].includes(error.name))
          )
        )
          throw error;
      }
      if (awaitingFeedback())
        await deps.sleepImpl(Math.min(500, Math.max(0, deadline - Date.now())));
    }
    url.searchParams.set("comparison", comparison.id);
    deps.log(
      json
        ? JSON.stringify({
            event: "comparison.completed",
            comparisonId: comparison.id,
            url: url.toString(),
            completion: comparison.completion,
            feedback: comparison.feedback ?? null,
            comparison,
          })
        : comparison.feedback
          ? `Feedback sent. ${comparison.feedback.saved ? "The snapshot matches the saved file." : "The snapshot has not been saved to the destination."}`
          : comparison.completion?.fileWritten
            ? `Review completed. Saved ${comparison.completion.targetPath}.`
            : "Review completed. No Markdown file was written.",
    );
    return 0;
  } catch (error) {
    logServerEvent(
      "comparison-cli",
      "review.failed",
      {
        command,
        error:
          error instanceof Error ? error.message : "File comparison failed.",
      },
      "error",
    );
    deps.error(
      error instanceof Error ? error.message : "File comparison failed.",
    );
    return 1;
  }
}
