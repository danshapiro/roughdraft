import { closeHistory } from "@tiptap/pm/history";
import { type EditorState, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export const compositionCommitKey = new PluginKey(
  "roughdraftCompositionCommit",
);

export interface CompositionCommit {
  before: EditorState;
}

export interface NativeCompositionSession {
  before: EditorState;
  finishing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  text: string | null;
}

/** Keep the browser's composition node intact until its final text is committed. */
export function beginNativeComposition(
  view: EditorView,
): NativeCompositionSession {
  return { before: view.state, finishing: false, timer: null, text: null };
}

export function cancelCompositionTimer(session: NativeCompositionSession) {
  if (session.timer !== null) clearTimeout(session.timer);
  session.timer = null;
}

export function finishNativeComposition(
  view: EditorView,
  session: NativeCompositionSession,
  onFinished: () => void,
) {
  cancelCompositionTimer(session);
  if (session.finishing || view.isDestroyed) return;
  session.finishing = true;
  const transaction = view.state.tr;
  const { before } = session;
  const { selection } = before;
  // Chromium/ProseMirror can insert before a selected non-inclusive mark
  // instead of replacing it. Repair only that exact native insertion result.
  if (
    session.text &&
    !selection.empty &&
    selection.from <= transaction.doc.content.size &&
    selection.$from.sameParent(selection.$to) &&
    selection.$from.parent.isTextblock
  ) {
    const $from = transaction.doc.resolve(selection.from);
    const parentText = (node: typeof $from.parent) =>
      node.textBetween(0, node.content.size, "\n", "\ufffc");
    const oldText = parentText(selection.$from.parent);
    const expectedInsertion =
      oldText.slice(0, selection.$from.parentOffset) +
      session.text +
      oldText.slice(selection.$from.parentOffset);
    const selectedText = before.doc.textBetween(selection.from, selection.to);
    if (
      selectedText.length === selection.to - selection.from &&
      $from.parent.type === selection.$from.parent.type &&
      parentText($from.parent) === expectedInsertion
    )
      transaction.delete(
        selection.from + session.text.length,
        selection.to + session.text.length,
      );
  }
  // A native replacement at the exact edges of a non-inclusive comment mark
  // does not inherit that mark. Keep the same comment as keyboard/paste edits.
  if (!before.selection.empty) {
    const markType = before.schema.marks.commentRef;
    const ids = new Set<string>();
    before.doc.nodesBetween(
      before.selection.from,
      before.selection.to,
      (node) => {
        for (const id of markType?.isInSet(node.marks)?.attrs.commentIds ?? [])
          ids.add(id);
      },
    );
    const start = before.doc.content.findDiffStart(transaction.doc.content);
    const end = before.doc.content.findDiffEnd(transaction.doc.content);
    if (markType && ids.size && start !== null && end && end.b > start)
      transaction.addMark(
        start,
        end.b,
        markType.create({ commentIds: [...ids] }),
      );
  }
  view.dispatch(
    transaction.setMeta(compositionCommitKey, {
      before,
    } satisfies CompositionCommit),
  );
  view.dispatch(closeHistory(view.state.tr));
  console.info(
    JSON.stringify({
      severity: "info",
      component: "editing",
      event: "native-composition-finished",
      changed: !before.doc.eq(view.state.doc),
    }),
  );
  onFinished();
}

/** ProseMirror flushes the final DOM mutation after the compositionend handler. */
export function scheduleCompositionFinish(
  view: EditorView,
  session: NativeCompositionSession,
  text: string,
  onFinished: () => void,
) {
  cancelCompositionTimer(session);
  session.text = text;
  session.timer = setTimeout(
    () => finishNativeComposition(view, session, onFinished),
    0,
  );
}
