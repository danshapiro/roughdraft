interface MarkdownSourceGuard {
  canApplyUpdate: (value: string) => boolean;
}

const guards = new WeakMap<HTMLElement, MarkdownSourceGuard>();

/** The rich editor need not download CodeMirror to consult its active guard. */
export function markdownSourceGuard(host: HTMLElement) {
  return guards.get(host);
}

export function registerMarkdownSourceGuard(
  host: HTMLElement,
  guard: MarkdownSourceGuard,
) {
  guards.set(host, guard);
  return () => {
    if (guards.get(host) === guard) guards.delete(host);
  };
}
