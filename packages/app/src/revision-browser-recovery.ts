import type {
  BrowserRecovery,
  PendingOperation,
  RevisionDraft,
} from "./revision-session";

type SourceField = "markdown" | "cleanMarkdown";
interface StringDelta {
  anchor: "current" | "base";
  prefix: number;
  suffix: number;
  text: string;
}
type CompactDraft = Omit<RevisionDraft, SourceField> & {
  markdown?: string;
  cleanMarkdown?: string;
  cleanEqualsMarkdown?: true;
  markdownDelta?: StringDelta;
  cleanMarkdownDelta?: StringDelta;
};
type LiteralDraft = CompactDraft & { markdown: string };
type CompactOperation = Omit<
  PendingOperation,
  "draft" | "base" | "editorBase"
> & {
  draft: number;
  base: number;
  editorBase?: number;
};
interface CompactRecovery
  extends Omit<
    BrowserRecovery,
    "version" | "draft" | "base" | "operation" | "copyOperation"
  > {
  version: 3;
  draft: LiteralDraft;
  base: number;
  snapshots: CompactDraft[];
  stringBases?: Partial<Record<SourceField, string>>;
  operation?: CompactOperation | null;
  copyOperation?: CompactOperation | null;
}
function compactDraft(draft: RevisionDraft): LiteralDraft {
  return draft.cleanMarkdown === draft.markdown
    ? { ...draft, cleanMarkdown: undefined, cleanEqualsMarkdown: true }
    : draft;
}
function delta(
  value: string,
  anchor: string,
  name: StringDelta["anchor"],
): StringDelta {
  let prefix = 0;
  if (value === anchor) prefix = value.length;
  else
    while (
      prefix < value.length &&
      prefix < anchor.length &&
      value.charCodeAt(prefix) === anchor.charCodeAt(prefix)
    )
      prefix++;
  let suffix = 0;
  while (
    suffix < value.length - prefix &&
    suffix < anchor.length - prefix &&
    value.charCodeAt(value.length - suffix - 1) ===
      anchor.charCodeAt(anchor.length - suffix - 1)
  )
    suffix++;
  return {
    anchor: name,
    prefix,
    suffix,
    text: value.slice(prefix, value.length - suffix),
  };
}
interface StringChoice {
  cost: number;
  patch?: StringDelta;
}
function compactSources(
  drafts: CompactDraft[],
  current: RevisionDraft,
  base: RevisionDraft,
) {
  const stringBases: Partial<Record<SourceField, string>> = {};
  for (const field of ["markdown", "cleanMarkdown"] as const) {
    const currentSource = current[field] ?? current.markdown;
    const baseSource = base[field];
    const cache = new Map<
      string,
      { normal: StringChoice; alternate: StringChoice }
    >();
    for (const draft of drafts) {
      const value = draft[field];
      if (value === undefined || cache.has(value)) continue;
      const literal = { cost: JSON.stringify(value).length + field.length + 3 };
      const choose = (
        anchor: string,
        name: StringDelta["anchor"],
        previous: StringChoice,
      ) => {
        const patch = delta(value, anchor, name);
        // A raw middle this large cannot beat its literal after JSON overhead.
        if (patch.text.length + 48 >= value.length) return previous;
        const cost = JSON.stringify(patch).length + field.length + 8;
        return cost < previous.cost ? { cost, patch } : previous;
      };
      const normal = choose(currentSource, "current", literal);
      const alternate =
        baseSource === undefined || baseSource === currentSource
          ? normal
          : choose(baseSource, "base", normal);
      cache.set(value, { normal, alternate });
    }
    const costs = drafts.reduce(
      (total, draft) => {
        const value = draft[field];
        const choices = value === undefined ? undefined : cache.get(value);
        return choices
          ? {
              normal: total.normal + choices.normal.cost,
              alternate: total.alternate + choices.alternate.cost,
            }
          : total;
      },
      { normal: 0, alternate: 0 },
    );
    // Charge each field for the entire optional wrapper, including its comma.
    // This conservative bound guarantees the complete serialized record shrinks.
    const useBase =
      baseSource !== undefined &&
      costs.alternate + JSON.stringify(baseSource).length + field.length + 48 <
        costs.normal;
    if (useBase) stringBases[field] = baseSource;
    for (const draft of drafts) {
      const value = draft[field];
      const choices = value === undefined ? undefined : cache.get(value);
      const selected = useBase ? choices?.alternate : choices?.normal;
      if (!selected?.patch) continue;
      draft[field] = undefined;
      if (field === "markdown") draft.markdownDelta = selected.patch;
      else draft.cleanMarkdownDelta = selected.patch;
    }
  }
  return Object.keys(stringBases).length ? stringBases : undefined;
}
function expandString(
  value: unknown,
  current: string,
  base: string | undefined,
) {
  const patch = value as StringDelta | null;
  if (
    !patch ||
    typeof patch !== "object" ||
    Object.keys(patch).some(
      (key) => !["anchor", "prefix", "suffix", "text"].includes(key),
    ) ||
    !["current", "base"].includes(patch.anchor) ||
    !Number.isInteger(patch.prefix) ||
    !Number.isInteger(patch.suffix) ||
    patch.prefix < 0 ||
    patch.suffix < 0 ||
    typeof patch.text !== "string"
  )
    throw new Error("The recovery text patch is invalid.");
  const anchor = patch.anchor === "current" ? current : base;
  if (anchor === undefined || patch.prefix + patch.suffix > anchor.length)
    throw new Error("The recovery text patch is outside its literal source.");
  return (
    anchor.slice(0, patch.prefix) +
    patch.text +
    (patch.suffix ? anchor.slice(anchor.length - patch.suffix) : "")
  );
}
function expandDraft(
  draft: CompactDraft,
  current?: RevisionDraft,
  bases?: CompactRecovery["stringBases"],
): RevisionDraft {
  if (
    (draft.markdownDelta && (draft.markdown !== undefined || !current)) ||
    (draft.cleanMarkdownDelta &&
      (draft.cleanMarkdown !== undefined ||
        draft.cleanEqualsMarkdown ||
        !current)) ||
    (draft.cleanEqualsMarkdown && draft.cleanMarkdown !== undefined)
  )
    throw new Error("The recovery text source is ambiguous.");
  const {
    cleanEqualsMarkdown,
    markdownDelta,
    cleanMarkdownDelta,
    ...metadata
  } = draft;
  const markdown =
    markdownDelta && current
      ? expandString(markdownDelta, current.markdown, bases?.markdown)
      : draft.markdown;
  const cleanMarkdown = cleanEqualsMarkdown
    ? markdown
    : cleanMarkdownDelta && current
      ? expandString(
          cleanMarkdownDelta,
          current.cleanMarkdown ?? current.markdown,
          bases?.cleanMarkdown,
        )
      : draft.cleanMarkdown;
  const expanded = {
    ...metadata,
    markdown,
    ...(cleanMarkdown === undefined ? {} : { cleanMarkdown }),
  };
  if (
    !validDraft(expanded) ||
    (cleanMarkdown !== undefined && typeof cleanMarkdown !== "string")
  )
    throw new Error("The recovery document is invalid.");
  return expanded;
}
function validDraft(value: unknown): value is RevisionDraft {
  const draft = value as RevisionDraft | null;
  return Boolean(
    draft &&
      typeof draft.markdown === "string" &&
      draft.decisions &&
      Array.isArray(draft.reviewComments),
  );
}

/** Repeated immutable snapshots are stored once, including both operation slots. */
export function encodeBrowserRecovery(record: BrowserRecovery): string {
  const references = new Map<RevisionDraft, number>([[record.draft, -1]]);
  const snapshots: CompactDraft[] = [];
  const reference = (draft: RevisionDraft) => {
    const found = references.get(draft);
    if (found !== undefined) return found;
    const index = snapshots.length;
    snapshots.push({ ...compactDraft(draft) });
    references.set(draft, index);
    return index;
  };
  const operation = (pending: PendingOperation | null | undefined) =>
    pending && {
      ...pending,
      draft: reference(pending.draft),
      base: reference(pending.base),
      editorBase: pending.editorBase
        ? reference(pending.editorBase)
        : undefined,
    };
  const encoded: CompactRecovery = {
    ...record,
    version: 3,
    draft: compactDraft(record.draft),
    base: reference(record.base),
    snapshots,
    operation: operation(record.operation),
    copyOperation: operation(record.copyOperation),
  };
  encoded.stringBases = compactSources(snapshots, record.draft, record.base);
  return JSON.stringify(encoded);
}

/** Old open tabs and already-saved private recovery records remain readable. */
export function decodeBrowserRecovery(
  raw: string | null,
): BrowserRecovery | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as BrowserRecovery | CompactRecovery;
    if (!value || !validDraft(value.draft)) return null;
    if (value.version === 2) return validDraft(value.base) ? value : null;
    if (
      value.version !== 3 ||
      !Array.isArray(value.snapshots) ||
      value.snapshots.length > 7
    )
      return null;
    if (
      value.stringBases !== undefined &&
      (!value.stringBases ||
        typeof value.stringBases !== "object" ||
        Object.values(value.stringBases).some(
          (source) => typeof source !== "string",
        ))
    )
      return null;
    const current = expandDraft(value.draft);
    // Every patch references one of two known literals, never another patch.
    const snapshots = value.snapshots.map((draft) =>
      expandDraft(draft, current, value.stringBases),
    );
    const reference = (index: number) => {
      const draft = index === -1 ? current : snapshots[index];
      if (!Number.isInteger(index) || !validDraft(draft))
        throw new Error("The recovery snapshot is unavailable.");
      return draft;
    };
    const operation = (pending: CompactOperation | null | undefined) =>
      pending && {
        ...pending,
        draft: reference(pending.draft),
        base: reference(pending.base),
        editorBase:
          pending.editorBase !== undefined
            ? reference(pending.editorBase)
            : undefined,
      };
    const {
      snapshots: _snapshots,
      stringBases: _stringBases,
      ...metadata
    } = value;
    return {
      ...metadata,
      version: 2,
      draft: current,
      base: reference(value.base),
      operation: operation(value.operation),
      copyOperation: operation(value.copyOperation),
    };
  } catch {
    return null;
  }
}
