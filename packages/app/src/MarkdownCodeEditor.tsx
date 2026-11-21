import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  Compartment,
  EditorState,
  Prec,
  type Extension,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { cn } from "./lib/utils";

interface MarkdownCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  className?: string;
  testId?: string;
  readingPosition?: { quote: string[]; offset: number } | null;
  sourceHistory?: { undo: () => void; redo: () => void };
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

    return () => {
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
      annotations: Transaction.addToHistory.of(false),
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: value,
      },
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
