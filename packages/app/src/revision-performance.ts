interface RevisionPerformanceEntry {
  stage: string;
  at: number;
  duration: number;
  durationKind?: "cpu" | "elapsed";
}
interface RevisionPerformanceBuffer {
  entries: RevisionPerformanceEntry[];
}
export function recordRevisionTiming(
  stage: string,
  at: number,
  duration: number,
  durationKind?: "cpu" | "elapsed",
) {
  const buffer = (
    globalThis as typeof globalThis & {
      roughdraftProfile?: RevisionPerformanceBuffer;
    }
  ).roughdraftProfile;
  if (!buffer) return;
  buffer.entries.push({
    stage,
    at,
    duration,
    ...(durationKind ? { durationKind } : {}),
  });
  if (buffer.entries.length > 256)
    buffer.entries.splice(0, buffer.entries.length - 256);
}
/** Opt-in browser diagnostics; ordinary editor work records nothing. */
export function measureRevision<T>(stage: string, action: () => T): T {
  const buffer = (
    globalThis as typeof globalThis & {
      roughdraftProfile?: RevisionPerformanceBuffer;
    }
  ).roughdraftProfile;
  if (!buffer) return action();
  const started = performance.now();
  try {
    return action();
  } finally {
    recordRevisionTiming(
      stage,
      performance.timeOrigin + started,
      performance.now() - started,
    );
  }
}

/** Resume in another browser task so input and rendering can run in between. */
export function yieldRevisionTask(): Promise<void> {
  // Background timer clamping must not turn a finite review update into a
  // minute-long queue. Hidden documents have no input/rendering to protect.
  if (typeof document !== "undefined" && document.visibilityState === "hidden")
    return Promise.resolve();
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  return typeof scheduler?.yield === "function"
    ? scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));
}

/** Elapsed time includes the task pauses used by cooperative work. */
export async function measureRevisionAsync<T>(
  stage: string,
  action: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    recordRevisionTiming(
      stage,
      performance.timeOrigin + started,
      performance.now() - started,
      "elapsed",
    );
  }
}
