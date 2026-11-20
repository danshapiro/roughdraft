import { EditorState, type Transaction } from "@tiptap/pm/state";
import {
  acceptCriticChangeTransaction,
  rejectCriticChangeTransaction,
} from "./editor-extensions";

export type ReviewDecision = "accept" | "reject";

/** Build without running the editor's update, history or autosave plugins. */
export function applySuggestionDecisions(
  transaction: Transaction,
  ids: Iterable<string>,
  decision: ReviewDecision,
): boolean {
  const resolve =
    decision === "accept"
      ? acceptCriticChangeTransaction
      : rejectCriticChangeTransaction;
  let scratch: EditorState | undefined;
  for (const id of ids) {
    scratch ??= EditorState.create({ doc: transaction.doc });
    const next = resolve(scratch, id);
    if (!next) return false;
    for (const step of next.steps) transaction.step(step);
    scratch = scratch.apply(next);
  }
  return true;
}

const apple = () => /Mac|iPhone|iPad/.test(navigator.platform);

function shortcutLetter(decision: ReviewDecision): string {
  return decision === "accept" ? "A" : "R";
}

export function reviewShortcutLabel(decision: ReviewDecision): string {
  return `${apple() ? "⌘⌥" : "Ctrl+Alt+"}${shortcutLetter(decision)}`;
}

export function reviewShortcutKeys(decision: ReviewDecision): string {
  return `${apple() ? "Meta" : "Control"}+Alt+${shortcutLetter(decision)}`;
}

export function reviewShortcut(event: KeyboardEvent): ReviewDecision | null {
  const isApple = apple();
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.getModifierState("AltGraph") ||
    !event.altKey ||
    event.shiftKey ||
    event.metaKey !== isApple ||
    event.ctrlKey === isApple
  )
    return null;
  if (event.code === "KeyA") return "accept";
  if (event.code === "KeyR") return "reject";
  return null;
}
