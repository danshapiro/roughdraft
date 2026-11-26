import type { Node } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { replaceRevisionContent } from "./revision-remote-source";

type Range = { from: number; to: number; markType?: string };
function rangeOf(step: { toJSON(): unknown }): Range | null {
  const json = step.toJSON() as {
    from?: number;
    to?: number;
    pos?: number;
    stepType?: string;
    mark?: { type?: string };
  };
  const from = json.from ?? json.pos;
  return from === undefined
    ? null
    : {
        from,
        to: json.to ?? from,
        ...((json.stepType === "addMark" || json.stepType === "removeMark") &&
        json.mark?.type
          ? { markType: json.mark.type }
          : {}),
      };
}
function overlaps(a: Range, b: Range) {
  return a.from === a.to
    ? a.from > b.from && a.from < b.to
    : b.from === b.to
      ? b.from > a.from && b.from < a.to
      : a.from < b.to && a.to > b.from;
}

function independentMarks(a: Range, b: Range, state: EditorState) {
  if (!a.markType || !b.markType || a.markType === b.markType) return false;
  const left = state.schema.marks[a.markType];
  const right = state.schema.marks[b.markType];
  return Boolean(
    left && right && !left.excludes(right) && !right.excludes(left),
  );
}

/** Apply an incoming worker result across typing newer than the worker snapshot. */
export function rebaseRemoteTransaction(
  base: EditorState,
  current: EditorState,
  incoming: Node,
): Transaction | null {
  const wanted = replaceRevisionContent(base, incoming);
  const local = replaceRevisionContent(base, current.doc);
  const transaction = current.tr;
  let rebase = local.mapping;
  const ownProgress = new Mapping();
  const ownRanges: Range[] = [];
  for (const step of local.steps) {
    const range = rangeOf(step);
    if (range) {
      const inverse = ownProgress.invert();
      ownRanges.push({
        ...range,
        from: inverse.map(range.from, -1),
        to: inverse.map(range.to, 1),
      });
    }
    ownProgress.appendMap(step.getMap());
  }
  const incomingProgress = new Mapping();
  for (const step of wanted.steps) {
    const range = rangeOf(step);
    const inverse = incomingProgress.invert();
    if (
      range &&
      ownRanges.some(
        (own) =>
          !independentMarks(own, range, base) &&
          overlaps(
            { from: inverse.map(range.from, -1), to: inverse.map(range.to, 1) },
            own,
          ),
      )
    )
      return null;
    const mapped = step.map(rebase);
    if (!mapped || transaction.maybeStep(mapped).failed) return null;
    const next = new Mapping();
    next.appendMap(step.getMap().invert());
    next.appendMapping(rebase);
    next.appendMap(mapped.getMap());
    rebase = next;
    incomingProgress.appendMap(step.getMap());
  }
  return transaction;
}

/** Defer the composing block while applying independent outside patches. */
export function outsideComposition(
  state: EditorState,
  incoming: Transaction,
  range: Range,
): Transaction | null {
  const partial = state.tr;
  let mapping = new Mapping();
  const progress = new Mapping();
  for (const step of incoming.steps) {
    const touched = rangeOf(step);
    const from = progress.map(range.from, -1);
    const to = progress.map(range.to, 1);
    const next = new Mapping();
    next.appendMap(step.getMap().invert());
    next.appendMapping(mapping);
    if (touched && !(touched.from <= to && touched.to >= from)) {
      const mapped = step.map(mapping);
      if (!mapped || partial.maybeStep(mapped).failed) return null;
      next.appendMap(mapped.getMap());
    }
    mapping = next;
    progress.appendMap(step.getMap());
  }
  return partial;
}
