import fs from "node:fs";
import path from "node:path";

/** Optional per-run diagnostics; never write protocol traffic to stdout. */
export function logServerEvent(
  source: string,
  event: string,
  data: Record<string, unknown> = {},
  severity: "info" | "warn" | "error" = "info",
): void {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
        source,
        severity,
        event,
        data,
      })}\n`,
    );
  } catch {
    // Diagnostics must not interrupt file saves or corrupt MCP output.
  }
}
