import type {
  BrowserRecovery,
  PendingOperation,
  RevisionDraft,
} from "./revision-session";

type CompactDraft = RevisionDraft & { cleanEqualsMarkdown?: true };
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
    "version" | "base" | "operation" | "copyOperation"
  > {
  version: 3;
  draft: CompactDraft;
  base: number;
  snapshots: CompactDraft[];
  operation?: CompactOperation | null;
  copyOperation?: CompactOperation | null;
}
function compactDraft(draft: RevisionDraft): CompactDraft {
  return draft.cleanMarkdown === draft.markdown
    ? { ...draft, cleanMarkdown: undefined, cleanEqualsMarkdown: true }
    : draft;
}
function expandDraft(draft: CompactDraft): RevisionDraft {
  if (!draft.cleanEqualsMarkdown) return draft;
  const { cleanEqualsMarkdown: _same, ...expanded } = draft;
  return { ...expanded, cleanMarkdown: expanded.markdown };
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
    snapshots.push(compactDraft(draft));
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
    if (value.version !== 3 || !Array.isArray(value.snapshots)) return null;
    const current = expandDraft(value.draft);
    const reference = (index: number) => {
      const draft = index === -1 ? current : value.snapshots[index];
      if (!Number.isInteger(index) || !validDraft(draft))
        throw new Error("The recovery snapshot is unavailable.");
      return expandDraft(draft);
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
    const { snapshots: _snapshots, ...metadata } = value;
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
