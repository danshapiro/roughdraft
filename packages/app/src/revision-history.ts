import { type Node, Slice } from "@tiptap/pm/model";
import { EditorState, Plugin, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep, Step } from "@tiptap/pm/transform";
import type { ReviewedChange } from "./comparison-types";
import {
  documentMetadata,
  sameMetadata,
  withDocumentMetadata,
} from "./revision-metadata";
import { criticMarkdownToEditorState } from "./critic-markup";

export function reviewedChanges(doc: Node): ReviewedChange[] {
  return doc.attrs.reviewed ?? [];
}

function matches(doc: Node, change: ReviewedChange) {
  if (change.metadata)
    return (
      !change.stale &&
      sameMetadata(
        documentMetadata(doc.attrs.sourceMetadata?.markdown ?? ""),
        change.metadata.after,
      )
    );
  const { from, to, slice } = change.guard;
  return (
    !change.stale &&
    from >= 0 &&
    from <= to &&
    to <= doc.content.size &&
    doc.slice(from, to).eq(Slice.fromJSON(doc.type.schema, slice))
  );
}

/** Carry reversible decisions through unrelated edits; never replace newer work. */
export function mapReviewedChanges(
  changes: ReviewedChange[],
  transaction: Transaction,
): ReviewedChange[] {
  if (!transaction.docChanged) return changes;
  return changes.map((change) => {
    if (change.metadata)
      return {
        ...change,
        stale: change.stale || !matches(transaction.doc, change),
      };
    const start = transaction.mapping.map(change.guard.from, 1);
    const end = transaction.mapping.map(change.guard.to, -1);
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const inverse = change.inverse.map((json) =>
      Step.fromJSON(transaction.doc.type.schema, json).map(transaction.mapping),
    );
    const next = {
      ...change,
      guard: { ...change.guard, from, to },
      inverse: inverse
        .filter((step) => step !== null)
        .map((step) => step.toJSON()),
    };
    return {
      ...next,
      stale:
        change.stale ||
        start > end ||
        inverse.some((step) => !step) ||
        !matches(transaction.doc, next),
    };
  });
}

/** A remote-origin mapping is usable only when its guard and every inverse still apply. */
export function validateReviewedChange(
  doc: Node,
  change: ReviewedChange,
): boolean {
  if (!matches(doc, change)) return false;
  const transaction = EditorState.create({ doc }).tr;
  try {
    for (const json of change.inverse)
      if (transaction.maybeStep(Step.fromJSON(doc.type.schema, json)).failed)
        return false;
    return true;
  } catch {
    return false;
  }
}

export function mapRemoteReviewedChanges(
  changes: ReviewedChange[],
  transaction: Transaction,
): ReviewedChange[] {
  return mapReviewedChanges(
    changes.map((change) =>
      change.staleReason === "needs-remap"
        ? { ...change, stale: false }
        : change,
    ),
    transaction,
  ).map((change) => {
    if (change.stale || !validateReviewedChange(transaction.doc, change))
      return { ...change, stale: true };
    const next = { ...change, stale: false };
    delete next.staleReason;
    delete next.unmappedSince;
    delete next.originSignature;
    return next;
  });
}

export function recordReviewedChange(
  transaction: Transaction,
  detail: Pick<
    ReviewedChange,
    "decision" | "oldText" | "newText" | "keptId" | "keptIds"
  >,
  range: { from: number; to: number },
): Transaction {
  const before = transaction.before;
  const start = before.content.findDiffStart(transaction.doc.content);
  const end = before.content.findDiffEnd(transaction.doc.content);
  if (start !== null && end) {
    const overlap = start - Math.min(end.a, end.b);
    if (overlap > 0) {
      end.a += overlap;
      end.b += overlap;
    }
  }
  const from = start ?? range.from;
  const to = end ? Math.max(from, end.b) : range.to;
  // A single snapshot replacement has one coordinate system. Mapping a series
  // of inverse steps independently corrupts later steps' intermediate offsets.
  const inverse =
    start !== null && end
      ? [new ReplaceStep(from, to, before.slice(from, end.a)).toJSON()]
      : [];
  const previous = reviewedChanges(before);
  const sequence =
    previous.reduce(
      (max, item) =>
        Math.max(max, Number(/^decision-(\d+)$/.exec(item.id)?.[1] ?? 0)),
      0,
    ) + 1;
  return transaction.setDocAttribute("reviewed", [
    ...mapReviewedChanges(previous, transaction),
    {
      id: `decision-${sequence}`,
      ...detail,
      inverse,
      guard: { from, to, slice: transaction.doc.slice(from, to).toJSON() },
    },
  ]);
}

export function reopenReviewedChange(
  state: EditorState,
  id: string,
): Transaction | null {
  const changes = reviewedChanges(state.doc);
  const change = changes.find((item) => item.id === id);
  if (!change || !matches(state.doc, change)) return null;
  const transaction = state.tr;
  if (change.metadata) {
    const markdown = withDocumentMetadata(
      state.doc.attrs.sourceMetadata?.markdown ?? "",
      change.metadata.before,
    );
    const parsed = criticMarkdownToEditorState(markdown);
    transaction.setDocAttribute("sourceMetadata", {
      ...transaction.doc.attrs.sourceMetadata,
      sourceSpelling: undefined,
      markdown,
      frontmatter: parsed.frontmatter,
      endmatter: parsed.endmatter,
    });
  }
  for (const json of change.inverse) {
    if (transaction.maybeStep(Step.fromJSON(state.schema, json)).failed)
      return null;
  }
  const remaining = mapReviewedChanges(
    changes.filter((item) => item.id !== id),
    transaction,
  );
  transaction.setDocAttribute("reviewed", remaining);
  if (change.keptId || change.keptIds?.length) {
    const restored = new Set([change.keptId, ...(change.keptIds ?? [])]);
    transaction.setDocAttribute(
      "kept",
      (state.doc.attrs.kept ?? []).filter(
        (kept: string) => !restored.has(kept),
      ),
    );
  }
  return transaction;
}

/** Restore decidable passages in a detached state for outcome previews. */
export function undecidedDocument(doc: Node): Node {
  let state = EditorState.create({ doc });
  for (const change of [...reviewedChanges(doc)].reverse()) {
    const transaction = reopenReviewedChange(state, change.id);
    if (transaction) state = state.apply(transaction);
  }
  return state.doc;
}

export function createReviewedChangesPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, previous, current) {
      if (reviewedChanges(previous.doc) !== reviewedChanges(current.doc))
        return null;
      const contentChanges = transactions.filter(
        (tr) =>
          tr.docChanged &&
          (!tr.before.content.eq(tr.doc.content) ||
            !sameMetadata(
              documentMetadata(tr.before.attrs.sourceMetadata?.markdown ?? ""),
              documentMetadata(tr.doc.attrs.sourceMetadata?.markdown ?? ""),
            )),
      );
      if (!contentChanges.length || !reviewedChanges(current.doc).length)
        return null;
      let next = reviewedChanges(previous.doc);
      for (const transaction of contentChanges)
        next = mapReviewedChanges(next, transaction);
      return current.tr.setDocAttribute("reviewed", next);
    },
  });
}
