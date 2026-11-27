import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  Compartment,
  ChangeSet,
  EditorState,
  Prec,
  type Extension,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { diffChars, diffWordsWithSpace } from "diff";
import { cn } from "./lib/utils";

interface MarkdownCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onCompositionEnd?: () => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  className?: string;
  testId?: string;
  readingPosition?: { quote: string[]; offset: number } | null;
  sourceHistory?: { undo: () => void; redo: () => void };
}

/** Keep unchanged source ranges so CodeMirror maps selections and local history. */
function incomingSourceChanges(state: EditorState, value: string): ChangeSet {
  const before = state.doc.toString();
  const after = state.toText(value).toString();
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const budget = { timeout: 8, maxEditLength: 4096 };
  const parts =
    diffChars(before, after, budget) ??
    diffWordsWithSpace(before, after, budget);
  if (parts) {
    let position = 0;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part.added && !part.removed) {
        position += part.value.length;
        continue;
      }
      const from = position;
      let insert = "";
      while (
        index < parts.length &&
        (parts[index].added || parts[index].removed)
      ) {
        const change = parts[index++];
        if (change.removed) position += change.value.length;
        else insert += change.value;
      }
      index--;
      changes.push({ from, to: position, insert });
    }
  } else {
    // A broad rewrite must stay bounded. Unique unchanged lines provide linear
    // anchors, retaining distant selections even when the diff budget expires.
    const uniqueLines = (text: string) => {
      const lines = new Map<string, { from: number; to: number } | null>();
      for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
        if (!match[0]) continue;
        lines.set(
          match[0],
          lines.has(match[0])
            ? null
            : { from: match.index, to: match.index + match[0].length },
        );
      }
      return lines;
    };
    const oldLines = uniqueLines(before);
    let oldOffset = 0;
    let newOffset = 0;
    const replaceUntil = (oldEnd: number, newEnd: number) => {
      let from = oldOffset;
      let start = newOffset;
      while (from < oldEnd && start < newEnd && before[from] === after[start]) {
        from++;
        start++;
      }
      while (
        oldEnd > from &&
        newEnd > start &&
        before[oldEnd - 1] === after[newEnd - 1]
      ) {
        oldEnd--;
        newEnd--;
      }
      if (from !== oldEnd || start !== newEnd)
        changes.push({ from, to: oldEnd, insert: after.slice(start, newEnd) });
    };
    for (const [line, next] of uniqueLines(after)) {
      const previous = oldLines.get(line);
      if (!next || !previous || previous.from < oldOffset) continue;
      replaceUntil(previous.from, next.from);
      oldOffset = previous.to;
      newOffset = next.to;
    }
    replaceUntil(before.length, after.length);
  }
  return ChangeSet.of(changes, state.doc.length, "\n");
}

export function createMarkdownCodeEditorExtensions(
  readOnly: boolean,
  onDocumentChange: (value: string) => void,
  lastValueRef: { current: string },
  editableCompartment?: Compartment,
): Extension[] {
  const editableExtensions = [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ];
  return [
    basicSetup,
    yamlFrontmatter({ content: markdown() }),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ tabindex: "0" }),
    editableCompartment
      ? editableCompartment.of(editableExtensions)
      : editableExtensions,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;

      const nextValue = update.state.sliceDoc();
      if (nextValue === lastValueRef.current) return;

      lastValueRef.current = nextValue;
      onDocumentChange(nextValue);
    }),
    EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        color: "inherit",
        fontFamily:
          'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: "0.95rem",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "1.75",
        overflow: "auto",
      },
      ".cm-content": {
        minHeight: "70vh",
        padding: "0",
      },
      ".cm-line": {
        padding: "0",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "rgb(148 163 184)",
        marginRight: "0.75rem",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--cm-selection-bg, rgb(224 242 254))",
      },
      ".cm-gutterElement": {
        padding: "0 0.5rem 0 0",
      },
      ".cm-foldGutter": {
        display: "none",
      },
      ".cm-activeLine": {
        backgroundColor: "transparent",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "rgb(100 116 139)",
      },
      "&.cm-focused": {
        outline: "none",
      },
    }),
  ];
}

export function MarkdownCodeEditor({
  value,
  onChange,
  onCompositionEnd,
  autoFocus = false,
  readOnly = false,
  className,
  testId,
  readingPosition,
  sourceHistory,
}: MarkdownCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCompositionEndRef = useRef(onCompositionEnd);
  onCompositionEndRef.current = onCompositionEnd;
  const sourceHistoryRef = useRef(sourceHistory);
  sourceHistoryRef.current = sourceHistory;
  const initialValueRef = useRef(value);
  const initialReadOnlyRef = useRef(readOnly);
  const lastValueRef = useRef(value);
  const editableCompartmentRef = useRef(new Compartment());
  const lineSeparatorCompartment = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;

    const view = new EditorView({
      parent: hostElement,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-z",
                run: (view) => {
                  const history = sourceHistoryRef.current;
                  if (!history) return false;
                  if (!view.state.readOnly) history.undo();
                  return true;
                },
                preventDefault: true,
              },
              {
                key: "Mod-Shift-z",
                run: (view) => {
                  const history = sourceHistoryRef.current;
                  if (!history) return false;
                  if (!view.state.readOnly) history.redo();
                  return true;
                },
                preventDefault: true,
              },
              {
                key: "Mod-y",
                run: (view) => {
                  const history = sourceHistoryRef.current;
                  if (!history) return false;
                  if (!view.state.readOnly) history.redo();
                  return true;
                },
                preventDefault: true,
              },
            ]),
          ),
          lineSeparatorCompartment.current.of(
            EditorState.lineSeparator.of(
              initialValueRef.current.includes("\r\n") ? "\r\n" : "\n",
            ),
          ),
          ...createMarkdownCodeEditorExtensions(
            initialReadOnlyRef.current,
            (nextValue) => onChangeRef.current(nextValue),
            lastValueRef,
            editableCompartmentRef.current,
          ),
        ],
      }),
    });

    editorViewRef.current = view;
    lastValueRef.current = view.state.sliceDoc();
    let compositionTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelCompositionEnd = () => {
      if (compositionTimer !== undefined) clearTimeout(compositionTimer);
      compositionTimer = undefined;
    };
    const finishComposition = () => {
      cancelCompositionEnd();
      if (!onCompositionEndRef.current) return;
      // CodeMirror flushes trailing Android composition mutations separately.
      // Match its own 50 ms composition cleanup before resuming an update.
      compositionTimer = setTimeout(() => {
        compositionTimer = undefined;
        if (!view.composing && !view.compositionStarted)
          onCompositionEndRef.current?.();
      }, 50);
    };
    view.contentDOM.addEventListener("compositionstart", cancelCompositionEnd);
    view.contentDOM.addEventListener("compositionend", finishComposition);

    return () => {
      cancelCompositionEnd();
      view.contentDOM.removeEventListener(
        "compositionstart",
        cancelCompositionEnd,
      );
      view.contentDOM.removeEventListener("compositionend", finishComposition);
      editorViewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    editorViewRef.current?.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    if (autoFocus) editorViewRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || !readingPosition?.quote.length) return;
    const words = [...view.state.doc.toString().matchAll(/[\p{L}\p{N}_]+/gu)];
    for (let size = readingPosition.quote.length; size > 0; size--) {
      const quote = readingPosition.quote.slice(0, size);
      const index = words.findIndex((_, start) =>
        quote.every((word, offset) => words[start + offset]?.[0] === word),
      );
      if (index < 0) continue;
      view.dispatch({
        effects: EditorView.scrollIntoView(words[index].index, {
          y: "start",
          yMargin: Math.max(0, readingPosition.offset),
        }),
      });
      break;
    }
  }, [readingPosition]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    const separator = value.includes("\r\n") ? "\r\n" : "\n";
    if (view.state.lineBreak !== separator)
      view.dispatch({
        effects: lineSeparatorCompartment.current.reconfigure(
          EditorState.lineSeparator.of(separator),
        ),
      });
    const currentValue = view.state.sliceDoc();
    if (currentValue === value) {
      lastValueRef.current = value;
      return;
    }

    lastValueRef.current = value;
    view.dispatch({
      annotations: [
        Transaction.addToHistory.of(false),
        Transaction.remote.of(true),
      ],
      changes: incomingSourceChanges(view.state, value),
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={cn("markdown-code-editor", className)}
      data-testid={testId}
    />
  );
}
