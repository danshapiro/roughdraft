import { getSchema, type JSONContent } from "@tiptap/core";
import { type Node, Slice } from "@tiptap/pm/model";
import { EditorState, Plugin, type Transaction } from "@tiptap/pm/state";
import { Mapping, ReplaceStep, Step, StepMap } from "@tiptap/pm/transform";
import type { ReviewedChange } from "./comparison-types";
import {
  criticFrontmatterToEditorState,
  criticMarkdownToEditorState,
} from "./critic-markup";
import { splitYamlFrontmatter } from "./markdown";
import { createEditorExtensions } from "./editor-extensions";
import {
  documentMetadata,
  sameMetadata,
  withDocumentMetadata,
} from "./revision-metadata";

export function reviewedChanges(doc: Node): ReviewedChange[] {
  return doc.attrs.reviewed ?? [];
}

let migrationSchema: ReturnType<typeof getSchema> | undefined;

/** Upgrade old body-only positions once, against an exact guarded document. */
export function hydrateReviewedChanges(
  content: Node | JSONContent,
  changes: ReviewedChange[],
): ReviewedChange[] {
  if (changes.every((change) => change.frontmatterInContent === true))
    return changes;
  migrationSchema ??= getSchema(createEditorExtensions(""));
  const doc =
    "type" in content && typeof content.type === "object"
      ? (content as Node)
      : migrationSchema.nodeFromJSON(content);
  const offset =
    doc.firstChild?.type.name === "yamlFrontmatter"
      ? doc.firstChild.nodeSize
      : 0;
  const mapping = new Mapping([StepMap.offset(offset)]);
  return changes.map((change) => {
    if (change.frontmatterInContent === true) return change;
    if (change.metadata) return { ...change, frontmatterInContent: true };
    try {
      const inverse = change.inverse.map((json) =>
        Step.fromJSON(doc.type.schema, json).map(mapping),
      );
      const shifted = {
        ...change,
        frontmatterInContent: true,
        inverse: inverse
          .filter((step) => step !== null)
          .map((step) => step.toJSON()),
        guard: {
          ...change.guard,
          from: change.guard.from + offset,
          to: change.guard.to + offset,
        },
      };
      return {
        ...shifted,
        stale: Boolean(
          change.stale ||
            inverse.some((step) => step === null) ||
            !validateReviewedChange(doc, shifted),
        ),
      };
    } catch {
      return { ...change, frontmatterInContent: true, stale: true };
    }
  });
}

export function createReviewedChangeId() {
  const value =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `decision-${value}`;
}

export function reviewedMetadataIncludesFrontmatter(
  change: ReviewedChange,
): boolean {
  return Boolean(
    change.metadata &&
      (change.metadata.before.frontmatter !==
        change.metadata.after.frontmatter ||
        splitYamlFrontmatter(change.oldText).frontmatter !==
          splitYamlFrontmatter(change.newText).frontmatter),
  );
}

function matches(doc: Node, change: ReviewedChange) {
  if (change.metadata) {
    const current = documentMetadata(doc.attrs.sourceMetadata?.markdown ?? "");
    if (change.stale || current.endmatter !== change.metadata.after.endmatter)
      return false;
    if (!reviewedMetadataIncludesFrontmatter(change)) return true;
    const expected = change.metadata.after.frontmatter;
    const yaml =
      doc.firstChild?.type.name === "yamlFrontmatter" ? doc.firstChild : null;
    return expected === null
      ? yaml === null
      : yaml?.textContent ===
          doc.type.schema.nodeFromJSON(
            criticFrontmatterToEditorState(expected, null).node,
          ).textContent;
  }
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
  return transaction.setDocAttribute("reviewed", [
    ...mapReviewedChanges(previous, transaction),
    {
      id: createReviewedChangeId(),
      frontmatterInContent: true,
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
    const nextFrontmatter =
      parsed.doc.content?.[0]?.type === "yamlFrontmatter"
        ? state.schema.nodeFromJSON(parsed.doc.content[0])
        : null;
    const previousFrontmatter =
      transaction.doc.firstChild?.type.name === "yamlFrontmatter"
        ? transaction.doc.firstChild
        : null;
    if (previousFrontmatter || nextFrontmatter)
      transaction.replaceWith(
        0,
        previousFrontmatter?.nodeSize ?? 0,
        nextFrontmatter ? [nextFrontmatter] : [],
      );
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
