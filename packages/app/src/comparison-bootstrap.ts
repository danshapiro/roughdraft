import { browserPath } from "./browser-base-path";
import type { ComparisonReviewData } from "./comparison-types";

class ComparisonError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const pendingReads = new Map<string, Promise<ComparisonReviewData>>();

async function sendComparisonRequest(
  id: string,
  action?: string,
  body?: unknown,
): Promise<ComparisonReviewData> {
  const response = await fetch(
    browserPath(
      `/api/comparisons/${encodeURIComponent(id)}${action ? `/${action}` : ""}`,
    ),
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new ComparisonError(
      result.error ?? "The review could not be saved.",
      response.status,
    );
  return result as ComparisonReviewData;
}

/** Begin the route's data read before downloading and evaluating the editor. */
export function preloadComparison(id: string): Promise<ComparisonReviewData> {
  const key = browserPath(`/api/comparisons/${encodeURIComponent(id)}`);
  const pending = pendingReads.get(key);
  if (pending) return pending;
  const reading = sendComparisonRequest(id);
  pendingReads.set(key, reading);
  const release = () => {
    if (pendingReads.get(key) === reading) pendingReads.delete(key);
  };
  // No settled review cache: a later visit must read the current saved review.
  // Both handlers also make an early rejection safe while the route is loading.
  void reading.then(release, release);
  return reading;
}

export function requestComparison(
  id: string,
  action?: string,
  body?: unknown,
): Promise<ComparisonReviewData> {
  return action === undefined && body === undefined
    ? preloadComparison(id)
    : sendComparisonRequest(id, action, body);
}
