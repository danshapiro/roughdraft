import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  ChangeSet,
  Compartment,
  EditorState,
  type Extension,
  Prec,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { scanRoughdraftReview } from "@roughdraft/rfm";
import { basicSetup } from "codemirror";
import { diffChars, diffWordsWithSpace } from "diff";
import { useEffect, useRef } from "react";
import { cn } from "./lib/utils";
import { splitYamlDocumentMetadata } from "./markdown";

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

type CompositionRange = { from: number; to: number };
const sourceCompositions = new WeakMap<EditorView, CompositionRange>();
function composingWord(view: EditorView): CompositionRange {
  const selected = view.state.selection.main;
  const word = view.state.wordAt(selected.head);
  return {
    from: Math.min(selected.from, word?.from ?? selected.from),
    to: Math.max(selected.to, word?.to ?? selected.to),
  };
}
const literalProse = /^[\p{L}\p{M}\p{N}\s.,!?;:'’"()%—–-]*$/u;
function sourceBlock(text: string, range: CompositionRange) {
  const metadata = splitYamlDocumentMetadata(text);
  const bodyFrom = metadata.frontmatter?.length ?? 0;
  const bodyTo = text.length - (metadata.endmatter?.length ?? 0);
  if (range.from < bodyFrom)
    return {
      from: 0,
      to: bodyFrom,
      kind: "Frontmatter",
      plain: false,
      references: false,
    };
  if (range.to > bodyTo)
    return {
      from: bodyTo,
      to: text.length,
      kind: "Endmatter",
      plain: false,
      references: false,
    };
  const tree = markdownLanguage.parser.parse(metadata.body);
  let node = tree.resolveInner(Math.max(0, range.from - bodyFrom), 1);
  while (node.parent?.parent) node = node.parent;
  const from = node.from + bodyFrom;
  const to = Math.max(node.to + bodyFrom, range.to);
  return {
    from,
    to,
    kind: node.name,
    plain:
      node.name === "Paragraph" &&
      literalProse.test(text.slice(from, to)) &&
      !/\bwww\./i.test(text.slice(from, to)),
    references:
      node.name !== "FencedCode" &&
      node.name !== "CodeBlock" &&
      text.slice(from, to).includes("["),
  };
}

/** CodeMirror preserves its composing DOM when a remote transaction misses it. */
function sourceChangesDuringComposition(
  view: EditorView,
  value: string,
): ChangeSet | null {
  const changes = incomingSourceChanges(view.state, value);
  if (changes.empty) return changes;
  let composing = sourceCompositions.get(view);
  if (!composing && !view.composing && !view.compositionStarted) return changes;
  composing ??= composingWord(view);
  if (view.state.lineBreak !== (value.includes("\r\n") ? "\r\n" : "\n"))
    return null;
  const before = view.state.doc.toString();
  const after = view.state.toText(value).toString();
  const block = sourceBlock(before, composing);
  const nextBlock = sourceBlock(after, {
    from: changes.mapPos(composing.from, -1),
    to: changes.mapPos(composing.to, 1),
  });
  const scan = scanRoughdraftReview(before);
  const protectedRange = { ...composing };
  const plain =
    block.plain &&
    nextBlock.plain &&
    !scan.ranges.some(
      (range) => range.from <= composing.to && range.to >= composing.from,
    );
  if (!plain) {
    // An outside delimiter can turn the composing block into a code fence or
    // extend its enclosing block without changing any of the composing text.
    if (
      block.kind !== nextBlock.kind ||
      changes.mapPos(block.from, 1) !== nextBlock.from ||
      changes.mapPos(block.to, -1) !== nextBlock.to
    )
      return null;
    protectedRange.from = Math.min(protectedRange.from, block.from);
    protectedRange.to = Math.max(protectedRange.to, block.to);
    for (const range of scan.ranges)
      if (range.from <= protectedRange.to && range.to >= protectedRange.from) {
        protectedRange.from = Math.min(protectedRange.from, range.from);
        protectedRange.to = Math.max(protectedRange.to, range.to);
      }
    // Reference definitions can change the meaning of an unchanged link or
    // footnote. Keep that token context stable while its source is composing.
    const definitions = (text: string) =>
      [
        ...text.matchAll(
          /^ {0,3}\[[^\]\n]+\]:[^\n]*(?:\n(?: {2,}|\t)[^\n]*)*/gm,
        ),
      ].map((match) => match[0]);
    if (
      block.references &&
      JSON.stringify(definitions(before)) !== JSON.stringify(definitions(after))
    )
      return null;
    const owned = scan.items.filter(
      (item) =>
        item.offset < protectedRange.to && item.endOffset > protectedRange.from,
    );
    if (owned.length) {
      const incoming = new Map(
        scanRoughdraftReview(after).items.map((item) => [item.id, item]),
      );
      const meaning = ({
        offset: _offset,
        endOffset: _end,
        line: _line,
        column: _column,
        ...item
      }: (typeof owned)[number]) => item;
      if (
        owned.some((item) => {
          const next = incoming.get(item.id);
          return (
            !next ||
            JSON.stringify(meaning(item)) !== JSON.stringify(meaning(next))
          );
        })
      )
        return null;
    }
  }
  let touches = false;
  changes.iterChanges((from, to, _nextFrom, _nextTo, inserted) => {
    if (from <= protectedRange.to && to >= protectedRange.from) touches = true;
    // A paragraph split/join or source-token change needs the block guard,
    // even when the literal composing word itself is unchanged.
    if (
      plain &&
      from <= block.to &&
      to >= block.from &&
      /\n/.test(before.slice(from, to) + inserted.toString())
    )
      touches = true;
  });
  return touches ? null : changes;
}

/** Avoid parsing source for ordinary, non-composing remote acknowledgments. */
export function canApplyMarkdownSourceUpdate(view: EditorView, value: string) {
  return (
    (!sourceCompositions.has(view) &&
      !view.composing &&
      !view.compositionStarted) ||
    sourceChangesDuringComposition(view, value) !== null
  );
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
  const applyIncomingRef = useRef<(() => void) | null>(null);

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
          EditorView.updateListener.of((update) => {
            const range = sourceCompositions.get(update.view);
            if (range && update.docChanged)
              sourceCompositions.set(update.view, {
                from: update.changes.mapPos(range.from, -1),
                to: update.changes.mapPos(range.to, 1),
              });
          }),
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
      // CodeMirror flushes trailing Android composition mutations separately.
      // Match its own 50 ms composition cleanup before resuming an update.
      compositionTimer = setTimeout(() => {
        compositionTimer = undefined;
        if (!view.composing && !view.compositionStarted) {
          sourceCompositions.delete(view);
          applyIncomingRef.current?.();
          onCompositionEndRef.current?.();
        }
      }, 50);
    };
    const beginComposition = () => {
      cancelCompositionEnd();
      sourceCompositions.set(view, composingWord(view));
    };
    view.contentDOM.addEventListener("compositionstart", beginComposition);
    view.contentDOM.addEventListener("compositionend", finishComposition);

    return () => {
      cancelCompositionEnd();
      view.contentDOM.removeEventListener("compositionstart", beginComposition);
      view.contentDOM.removeEventListener("compositionend", finishComposition);
      editorViewRef.current = null;
      applyIncomingRef.current = null;
      sourceCompositions.delete(view);
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
    const apply = () => {
      const changes = sourceChangesDuringComposition(view, value);
      if (!changes) return;
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
        changes,
      });
    };
    applyIncomingRef.current = apply;
    apply();
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={cn("markdown-code-editor", className)}
      data-testid={testId}
    />
  );
}
