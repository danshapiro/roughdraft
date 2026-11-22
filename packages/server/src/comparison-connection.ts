import type { CliDependencies } from "./cli.js";
import { logServerEvent } from "./diagnostics.js";

export interface ComparisonServerStatus {
  backend: "local-files";
  instanceId?: string;
  capabilities: { fileComparisons?: boolean };
  publicUrl?: string | null;
}

/** A base may contain a managed proxy prefix; API paths must stay underneath it. */
export function comparisonServerUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Server URL must use http or https, without credentials, query, or fragment.",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function comparisonHandle(
  value: string,
): { id: string; serverUrl: string; url: string } | null {
  if (!/^https?:\/\//i.test(value)) return null;
  const url = new URL(value);
  const ids = url.searchParams.getAll("comparison");
  if (ids.length !== 1 || !ids[0].trim() || url.hash) {
    throw new Error(
      "A review URL must contain exactly one nonempty comparison ID and no fragment.",
    );
  }
  const base = new URL(url);
  base.search = "";
  return {
    id: ids[0],
    serverUrl: comparisonServerUrl(base.toString()).toString(),
    url: url.toString(),
  };
}

export function comparisonEndpoint(base: string, endpoint: string): URL {
  return new URL(endpoint.replace(/^\//, ""), comparisonServerUrl(base));
}

export async function comparisonServerStatus(
  deps: CliDependencies,
  base: string,
  options: { allowLegacyRead?: boolean } = {},
): Promise<ComparisonServerStatus> {
  let response: Response;
  try {
    response = await deps.fetchImpl(comparisonEndpoint(base, "/api/status"), {
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new Error(
      `Cannot connect to the selected Roughdraft server ${base}: ${error instanceof Error ? error.message : "connection failed"}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `Selected server status failed (${response.status}) at ${base}`,
    );
  const status = (await response.json()) as Partial<ComparisonServerStatus>;
  const identified =
    typeof status.instanceId === "string" &&
    status.instanceId.trim().length > 0;
  const legacyRead =
    options.allowLegacyRead &&
    status.capabilities?.fileComparisons === undefined &&
    !identified;
  if (
    status.backend !== "local-files" ||
    (!legacyRead &&
      (status.capabilities?.fileComparisons !== true || !identified))
  ) {
    throw new Error(
      `The selected server ${base} does not support local file comparisons with server identity. Update that server before using this command.`,
    );
  }
  if (legacyRead)
    logServerEvent("comparison-cli", "review.legacy-origin-read", {
      serverOrigin: new URL(base).origin,
    });
  return status as ComparisonServerStatus;
}

export function comparisonBrowserUrl(base: string, id: string): URL {
  const url = comparisonServerUrl(base);
  url.searchParams.set("comparison", id);
  return url;
}

export async function verifyComparisonUrl(
  deps: CliDependencies,
  url: URL,
  id: string,
  selected: ComparisonServerStatus,
): Promise<void> {
  const base = new URL(url);
  base.search = "";
  base.hash = "";
  const reviewResponse = await deps.fetchImpl(
    comparisonEndpoint(
      base.toString(),
      `/api/comparisons/${encodeURIComponent(id)}`,
    ),
    { signal: AbortSignal.timeout(5000) },
  );
  if (!reviewResponse.ok)
    throw new Error(
      `Final review URL cannot retrieve the saved review (${reviewResponse.status}).`,
    );
  const review = (await reviewResponse.json()) as { id?: unknown };
  if (review.id !== id)
    throw new Error("Final review URL returned a different review ID.");
  const status = await comparisonServerStatus(deps, base.toString());
  if (!selected.instanceId || status.instanceId !== selected.instanceId)
    throw new Error(
      "Final review URL belongs to a different Roughdraft server instance.",
    );
  const shellResponse = await deps.fetchImpl(url, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(5000),
  });
  const html = await shellResponse.text();
  if (
    !shellResponse.ok ||
    (shellResponse.url &&
      new URL(shellResponse.url).searchParams.get("comparison") !== id) ||
    !shellResponse.headers.get("content-type")?.includes("text/html") ||
    !/<(?:div|main)\b[^>]*\bid=["']root["']/i.test(html) ||
    !/<script\b[^>]*\btype=["']module["']/i.test(html) ||
    !/<title>[^<]*Roughdraft/i.test(html)
  ) {
    throw new Error(
      "Final review URL does not serve the Roughdraft viewer application.",
    );
  }
  logServerEvent("comparison-cli", "review.link-verified", {
    comparisonId: id,
    instanceId: selected.instanceId,
    serverOrigin: base.origin,
  });
}
