interface RevisionPerformanceEntry {
  stage: string;
  at: number;
  duration: number;
}
interface RevisionPerformanceBuffer {
  entries: RevisionPerformanceEntry[];
}
export function recordRevisionTiming(
  stage: string,
  at: number,
  duration: number,
) {
  const buffer = (
    globalThis as typeof globalThis & {
      roughdraftProfile?: RevisionPerformanceBuffer;
    }
  ).roughdraftProfile;
  if (!buffer) return;
  buffer.entries.push({ stage, at, duration });
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
