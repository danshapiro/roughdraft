import {
  closeHistory,
  isHistoryTransaction,
  redoDepth,
  undoDepth,
} from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { EditorState } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Download,
  MessageSquare,
  Redo2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiBackend } from "./api-backend";
import { useComparisonReadingPosition } from "./comparison-reading-position";
import type {
  ComparisonReviewComment,
  ComparisonReviewData,
} from "./comparison-types";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  type CriticComment,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  criticChangeHighlightPluginKey,
  explicitReviewEdit,
} from "./editor-extensions";
import {
  type DocumentInteractionMode,
  RichTextEditorSurface,
} from "./PageCard";
import {
  acceptedDocument,
  cleanRevisionMarkdown,
  copyRevisionMarkdown,
  downloadRevisionMarkdown,
  editableMarkdownOptions,
  createSourceSpellingPreserver,
} from "./revision-markdown";
import { suggestionPositions } from "./revision-projection";
import {
  type BaseSide,
  type ReferenceChange,
  createReferenceComparison,
  referenceDecorations,
  revertReferenceChange,
} from "./revision-reference";
import {
  type InspectedDestination,
  type RevisionDraft,
  RevisionRequestError,
  useRevisionSession,
} from "./revision-session";
import "./RevisionEditor.css";

const referenceKey = new PluginKey<ReferenceChange[]>(
  "roughdraftFixedReference",
);
const referenceDecision = "roughdraftReferenceDecision";
const noChanges: ReferenceChange[] = [];

function kept(doc: ProseMirrorNode): string[] {
  return doc.attrs.kept ?? [];
}

function canonical(markdown: string) {
  const { doc } = criticMarkdownToEditorState(markdown);
  return editorStateToCriticMarkdown(acceptedDocument(doc), new Map());
}

function useReference(
  editor: Editor | null,
  markdown: string | null,
  baseSide: BaseSide,
  mode: DocumentInteractionMode,
) {
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (!editor || markdown === null) return;
    const parsed = criticMarkdownToEditorState(
      markdown,
      editableMarkdownOptions,
    );
    const reference = editor.schema.nodeFromJSON(parsed.doc);
    const compare = createReferenceComparison(reference, baseSide);
    let previousDecorations:
      | {
          content: ProseMirrorNode["content"];
          changes: ReferenceChange[];
          decisions: string[];
          activeId?: string | null;
          hoveredId?: string | null;
          set: DecorationSet;
        }
      | undefined;
    editor.registerPlugin(
      new Plugin({
        key: referenceKey,
        state: {
          init: (_, state) => compare(state.doc),
          apply: (transaction, previous) =>
            transaction.docChanged &&
            !transaction.before.content.eq(transaction.doc.content)
              ? compare(transaction.doc)
              : previous,
        },
        appendTransaction: (transactions, previous, current) => {
          // Keep follows the changed wording. Remove stale IDs, and mark only
          // changes made directly by the user. Undo carries the IDs in its step.
          if (
            !transactions.some((tr) => tr.docChanged) ||
            transactions.some(isHistoryTransaction)
          )
            return null;
          const old = referenceKey.getState(previous) ?? noChanges;
          const changes = referenceKey.getState(current) ?? noChanges;
          if (old === changes) return null;
          const ids = new Set(changes.map((change) => change.item.changeId));
          const currentKept = kept(current.doc);
          const next = new Set(currentKept.filter((id) => ids.has(id)));
          const previousIds = new Set(
            old.map((change) => change.item.changeId),
          );
          if (
            !transactions.some((tr) => tr.getMeta(referenceDecision)) &&
            (modeRef.current === "editing" ||
              transactions.some((tr) => tr.getMeta(explicitReviewEdit)))
          ) {
            for (const id of ids) if (!previousIds.has(id)) next.add(id);
          }
          return currentKept.length === next.size &&
            currentKept.every((id) => next.has(id))
            ? null
            : current.tr
                .setDocAttribute("kept", [...next])
                .setMeta(explicitReviewEdit, true);
        },
        props: {
          decorations: (state) => {
            const changes = referenceKey.getState(state) ?? noChanges;
            if (!changes.length) return DecorationSet.empty;
            const decisions = kept(state.doc);
            const highlighted = criticChangeHighlightPluginKey.getState(state);
            const activeId = highlighted?.selectedChangeId;
            const hoveredId = highlighted?.hoveredChangeId;
            const { content } = state.doc;
            if (
              previousDecorations?.content === content &&
              previousDecorations.changes === changes &&
              previousDecorations.decisions === decisions &&
              previousDecorations.activeId === activeId &&
              previousDecorations.hoveredId === hoveredId
            )
              return previousDecorations.set;
            const choices = new Set(decisions);
            const set = referenceDecorations(
              state.doc,
              changes.filter((change) => !choices.has(change.item.changeId)),
              { activeId, hoveredId },
            );
            previousDecorations = {
              content,
              changes,
              decisions,
              activeId,
              hoveredId,
              set,
            };
            return set;
          },
        },
      }),
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(referenceKey);
    };
  }, [editor, markdown, baseSide]);
}

function pathLeaf(path: string) {
  return path.split(/[\\/]/).pop() || "Untitled.md";
}

function documentProject(path: string) {
  return path.startsWith("/")
    ? path.slice(0, path.lastIndexOf("/")) || "/"
    : undefined;
}

function TipButton({
  tip,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" {...props} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

type BaseAction =
  | { kind: "edit" }
  | { kind: "suggestion"; id: string; keep: boolean }
  | { kind: "reference"; pairId: string; keep: boolean };
type BaseSelection = BaseSide | "copy";

export function RevisionEditor({ initial }: { initial: ComparisonReviewData }) {
  const seed = useMemo<RevisionDraft>(() => {
    const parsed = criticMarkdownToEditorState(initial.afterText);
    return {
      markdown: initial.afterText,
      cleanMarkdown: cleanRevisionMarkdown(initial.afterText),
      decisions: {},
      reviewComments: [...parsed.comments.values()].map((comment) => ({
        ...comment,
        changeId: comment.parentCommentId ?? "document",
      })),
    };
  }, [initial.afterText]);
  const {
    session,
    draft,
    updateDraft,
    readDraft,
    run,
    inspect,
    recoveryError,
    recoveryPending,
    writePaused,
    reviewChanged,
    flush,
  } = useRevisionSession(initial, seed);
  const markdownFlushRef = useRef<(() => void) | null>(null);
  const [markdownQueued, setMarkdownQueued] = useState(false);
  const onMarkdownQueued = useCallback(() => setMarkdownQueued(true), []);
  const currentDraft = useCallback(() => {
    markdownFlushRef.current?.();
    return readDraft();
  }, [readDraft]);
  useEffect(() => {
    const preserve = () => {
      markdownFlushRef.current?.();
    };
    const preserveWhenHidden = () => {
      if (document.visibilityState === "hidden") preserve();
    };
    document.addEventListener("visibilitychange", preserveWhenHidden);
    window.addEventListener("pagehide", preserve);
    return () => {
      document.removeEventListener("visibilitychange", preserveWhenHidden);
      window.removeEventListener("pagehide", preserve);
    };
  }, []);
  const [source, setSource] = useState(draft);
  const [editorGeneration, restartEditor] = useState(0);
  const commentHistory = useRef<{
    past: ComparisonReviewComment[][];
    future: ComparisonReviewComment[][];
  }>({ past: [], future: [] });
  const reviewComments = draft.reviewComments ?? [];
  const commentMap = useMemo(
    () => new Map(reviewComments.map((comment) => [comment.id, comment])),
    [reviewComments],
  );
  const updateComments = useCallback(
    (next: Map<string, CriticComment>) => {
      updateDraft((current) => {
        const previous = current.reviewComments ?? [];
        const comments = [...next.values()]
          .filter((comment) => comment.content.trim())
          .map((comment) => ({
            ...comment,
            changeId:
              next.get(comment.parentCommentId ?? "")?.parentCommentId ??
              comment.parentCommentId ??
              "document",
          }));
        if (JSON.stringify(comments) === JSON.stringify(previous))
          return current;
        commentHistory.current.past.push(previous);
        commentHistory.current.future = [];
        return { ...current, reviewComments: comments };
      });
    },
    [updateDraft],
  );
  function moveCommentHistory(direction: "past" | "future") {
    const history = commentHistory.current;
    const next = history[direction].pop();
    if (!next) return;
    updateDraft((current) => {
      history[direction === "past" ? "future" : "past"].push(
        current.reviewComments,
      );
      return { ...current, reviewComments: next };
    });
  }
  const exactClean = useRef(
    source.cleanMarkdown ?? cleanRevisionMarkdown(source.markdown),
  );
  const preserveSource = useRef<ReturnType<
    typeof createSourceSpellingPreserver
  > | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [interaction, setInteraction] =
    useState<DocumentInteractionMode>("editing");
  const [formatted, setFormatted] = useState(true);
  const [, bump] = useState(0);
  const [actionError, setActionError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saveAs, setSaveAs] = useState(false);
  const [choosingBase, setChoosingBase] = useState(false);
  const [baseChoice, setBaseChoice] = useState<BaseSelection>("copy");
  const [copySeed, setCopySeed] = useState<BaseSide>("old");
  const firstAction = useRef<BaseAction | null>(null);
  const [afterBase, setAfterBase] = useState<{
    action: BaseAction;
    replacedEditor: Editor | null;
  } | null>(null);
  const [savePath, setSavePath] = useState("");
  const [replace, setReplace] = useState<InspectedDestination | null>(null);
  const [disk, setDisk] = useState<InspectedDestination | null>(null);
  const [conflict, setConflict] = useState(initial.targetChanged);
  const [sendOpen, setSendOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [activeChange, setActiveChange] = useState<string | null>(null);
  const documentRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const camera = useComparisonReadingPosition(
    documentRef,
    headerRef,
    String(formatted),
  );
  const captures = useRef(camera);
  captures.current = camera;
  const destination = session.destinationPath ?? null;
  const baseSide = session.baseVersion ?? "new";
  const reference =
    initial.mode === "document"
      ? null
      : baseSide === "old"
        ? initial.afterText
        : initial.beforeText;
  const referenceLabel =
    baseSide === "old" ? initial.afterLabel : initial.beforeLabel;
  const sourcePath =
    destination ??
    (initial.afterLabel.startsWith("/")
      ? initial.afterLabel
      : (initial.targetPath ?? ""));
  const backend = useMemo(
    () =>
      new ApiBackend({
        kind: "local-files",
        label: "Local files",
        detail: sourcePath,
        projectPath: documentProject(sourcePath),
      }),
    [sourcePath],
  );
  const page = useMemo(
    () => ({ id: initial.id, title: initial.title, content: source.markdown }),
    [initial, source.markdown],
  );
  const ownEditor = useRef<Editor | null>(null);
  const receiveEditor = useCallback((next: Editor | null) => {
    ownEditor.current = next;
    setEditor(next);
  }, []);
  useReference(editor, reference, baseSide, interaction);

  useEffect(() => {
    if (!editor) return;
    const touch = () => bump((revision) => revision + 1);
    editor.on("update", touch);
    touch();
    return () => {
      editor.off("update", touch);
    };
  }, [editor]);

  const changeMarkdown = useCallback(
    (markdown: string) => {
      setMarkdownQueued(false);
      const current = ownEditor.current?.state.doc;
      if (!current) return;
      const result = cleanRevisionMarkdown(markdown);
      preserveSource.current ??= createSourceSpellingPreserver(
        exactClean.current,
        canonical(exactClean.current),
      );
      const requested = canonical(result);
      const preserved = preserveSource.current(requested);
      const cleanMarkdown =
        preserved !== null && canonical(preserved) === requested
          ? preserved
          : result;
      updateDraft((previous) => ({
        ...previous,
        markdown,
        cleanMarkdown,
        decisions: Object.fromEntries(kept(current).map((id) => [id, "kept"])),
      }));
      setBlocked(false);
    },
    [updateDraft],
  );

  const chooseFile = useCallback((action: BaseAction | null = null) => {
    firstAction.current = action;
    setActionError("");
    setReplace(null);
    setSavePath("");
    setBaseChoice("copy");
    setCopySeed("old");
    setChoosingBase(true);
  }, []);

  const deciding = useCallback(
    (changeId: string, keep: boolean) => {
      const live = ownEditor.current;
      if (!live) return false;
      const change = referenceKey
        .getState(live.state)
        ?.find((item) => item.item.changeId === changeId);
      if (!destination) {
        if (change)
          chooseFile({ kind: "reference", pairId: change.pairId, keep });
        else chooseFile({ kind: "suggestion", id: changeId, keep });
        return true;
      }
      if (!change) return false;
      const leaveAsIs = keep === (baseSide === "new");
      const transaction = leaveAsIs
        ? live.state.tr.setDocAttribute("kept", [
            ...new Set([...kept(live.state.doc), changeId]),
          ])
        : revertReferenceChange(live.state, change);
      if (transaction) {
        live.view.dispatch(
          closeHistory(transaction)
            .setMeta(referenceDecision, true)
            .setMeta(explicitReviewEdit, true),
        );
        live.view.dispatch(closeHistory(live.state.tr));
      }
      return true;
    },
    [baseSide, chooseFile, destination],
  );

  useEffect(() => {
    if (!afterBase || !editor || editor === afterBase.replacedEditor) return;
    const { action } = afterBase;
    setAfterBase(null);
    if (action.kind === "edit") {
      setInteraction("editing");
    } else if (action.kind === "suggestion") {
      editor.view.dispatch(closeHistory(editor.state.tr));
      const decided = action.keep
        ? editor.commands.acceptCriticChange(action.id)
        : editor.commands.rejectCriticChange(action.id);
      if (!decided)
        setActionError("The suggestion moved. Review it before deciding.");
      editor.view.dispatch(closeHistory(editor.state.tr));
    } else {
      const match = referenceKey
        .getState(editor.state)
        ?.find((change) => change.pairId === action.pairId);
      if (match && !match.overlapsSuggestion)
        deciding(match.item.changeId, action.keep);
      else setActionError("The change moved. Review it before choosing again.");
    }
  }, [afterBase, deciding, editor]);

  const renderedChanges = editor
    ? (referenceKey.getState(editor.state) ?? noChanges)
    : noChanges;
  const decisions = editor
    ? kept(editor.state.doc)
    : Object.keys(source.decisions);
  const visibleChanges = useMemo(
    () =>
      renderedChanges
        .filter(
          (change) =>
            !change.overlapsSuggestion &&
            !decisions.includes(change.item.changeId),
        )
        .map((change) => change.item),
    [renderedChanges, decisions],
  );
  const reviewSurface = useMemo(
    () => ({
      suggestions: visibleChanges,
      decisions,
      markdownFlushRef,
      onMarkdownQueued,
      comments: commentMap,
      onCommentsChange: updateComments,
      onAccept: (id: string) => deciding(id, true),
      onReject: (id: string) => deciding(id, false),
      onBlockedSuggestionEdit: () => setBlocked(true),
    }),
    [
      commentMap,
      deciding,
      decisions,
      onMarkdownQueued,
      updateComments,
      visibleChanges,
    ],
  );
  const editorDoc = editor?.state.doc;
  const navigation = useMemo(() => {
    const positions = new Map<string, number>();
    const ignored = new Set(decisions);
    for (const change of renderedChanges) {
      const id = change.item.changeId;
      if (!change.overlapsSuggestion && !ignored.has(id))
        positions.set(id, change.from);
    }
    if (editorDoc) {
      for (const [id, pos] of suggestionPositions(editorDoc))
        positions.set(id, pos);
    }
    return [...positions.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  }, [decisions, editorDoc, renderedChanges]);
  const count = navigation.length;
  const markdown = draft.cleanMarkdown ?? draft.markdown;
  const cleanSaved = useMemo(
    () => cleanRevisionMarkdown(session.savedText ?? ""),
    [session.savedText],
  );
  const saved =
    !markdownQueued &&
    destination !== null &&
    destination === session.savedPath &&
    markdown === cleanSaved &&
    !writePaused &&
    !session.targetChanged;
  const filename = pathLeaf(destination ?? (sourcePath || "Untitled.md"));

  function navigate(direction: -1 | 1) {
    const index = activeChange ? navigation.indexOf(activeChange) : -1;
    const id =
      navigation[
        index < 0
          ? direction === 1
            ? 0
            : count - 1
          : (index + direction + count) % count
      ];
    if (!id) return;
    const anchors = [
      ...(documentRef.current?.querySelectorAll<HTMLElement>(
        "[data-critic-change-id]",
      ) ?? []),
    ];
    const target =
      anchors.find((anchor) => anchor.dataset.criticChangeId === id) ??
      documentRef.current?.querySelector<HTMLElement>(
        `[data-review-rail-anchor="${CSS.escape(id)}"]`,
      );
    if (!target) return;
    setActiveChange(id);
    const top =
      target.getBoundingClientRect().top +
      window.scrollY -
      (headerRef.current?.offsetHeight ?? 0) -
      16;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  }

  const reportError = (error: unknown) =>
    setActionError(error instanceof Error ? error.message : String(error));
  function showSaveAs() {
    if (!destination && !reviewChanged) {
      chooseFile(interaction === "suggesting" ? null : { kind: "edit" });
      return;
    }
    setActionError("");
    setSavePath("");
    setReplace(null);
    setSaveAs(true);
  }

  async function save(output?: InspectedDestination) {
    if (!destination && !output) {
      showSaveAs();
      return;
    }
    setBusy(true);
    setActionError("");
    try {
      const snapshot = currentDraft();
      await (output
        ? run("save", snapshot, {
            path: output.path,
            expectedVersion: output.version,
            baseVersion: session.baseVersion ?? null,
          })
        : run("sync", snapshot));
      setConflict(false);
      setSaveAs(false);
    } catch (error) {
      if (
        output &&
        error instanceof RevisionRequestError &&
        error.status === 409
      ) {
        setReplace(null);
      }
      if (
        !output &&
        error instanceof Error &&
        error.message.includes("destination changed")
      )
        setConflict(true);
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function inspectAndSave() {
    if (replace) {
      await save(replace);
      return;
    }
    setBusy(true);
    setActionError("");
    try {
      const output = await inspect(savePath.trim());
      if (output.path === destination)
        throw new Error("Choose a different file for the copy.");
      if (output.version === null) await save(output);
      else setReplace(output);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function selectBase() {
    setBusy(true);
    setActionError("");
    try {
      const side = baseChoice === "copy" ? copySeed : baseChoice;
      const draft = currentDraft();
      let snapshot = draft;
      if (side !== baseSide && initial.mode !== "document") {
        const live = ownEditor.current;
        if (!live) throw new Error("The editor is still loading.");
        const raw = side === "old" ? initial.beforeText : initial.afterText;
        const cleanMarkdown = cleanRevisionMarkdown(raw);
        let annotated = raw;
        if (draft.markdown !== (draft.cleanMarkdown ?? draft.markdown)) {
          const parsed = criticMarkdownToEditorState(
            raw,
            editableMarkdownOptions,
          );
          const target = live.schema.nodeFromJSON(acceptedDocument(parsed.doc));
          let state = EditorState.create({ doc: live.state.doc });
          const changes = createReferenceComparison(target)(state.doc).sort(
            (a, b) => b.from - a.from || b.to - a.to,
          );
          for (const change of changes) {
            const replacement = revertReferenceChange(state, change);
            if (!replacement)
              throw new Error(
                "A pending suggestion overlaps this version. Start from New to keep the suggestion.",
              );
            state = state.apply(replacement);
          }
          annotated = editorStateToCriticMarkdown(
            state.doc.toJSON(),
            commentMap,
            {
              frontmatter: parsed.frontmatter,
              endmatter: parsed.endmatter,
            },
          );
          if (
            canonical(cleanRevisionMarkdown(annotated)) !==
            canonical(cleanMarkdown)
          )
            throw new Error(
              "This version cannot carry the current annotations. Choose the other version or discard the overlapping suggestion first.",
            );
        }
        snapshot = {
          ...snapshot,
          markdown: annotated,
          cleanMarkdown,
          decisions: {},
        };
      }
      const chosen = await run("base", snapshot, {
        choice: baseChoice,
        ...(baseChoice === "copy" ? { path: savePath.trim(), seed: side } : {}),
      });
      setConflict(false);
      setChoosingBase(false);
      const replacedEditor = side !== baseSide ? ownEditor.current : null;
      if (replacedEditor) {
        const draftForEditor = chosen.draft
          ? { ...chosen.draft, reviewComments: chosen.reviewComments ?? [] }
          : snapshot;
        exactClean.current =
          draftForEditor.cleanMarkdown ?? draftForEditor.markdown;
        preserveSource.current = null;
        setSource(draftForEditor);
        restartEditor((generation) => generation + 1);
      }
      if (firstAction.current)
        setAfterBase({ action: firstAction.current, replacedEditor });
      firstAction.current = null;
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    setActionError("");
    try {
      await run("send", currentDraft(), { comment: comment.trim() });
      setSendOpen(false);
      setComment("");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onSave = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s")
        return;
      event.preventDefault();
      if (
        !busy &&
        !saveAs &&
        !choosingBase &&
        !sendOpen &&
        !disk &&
        !writePaused
      )
        void save();
    };
    document.addEventListener("keydown", onSave);
    return () => document.removeEventListener("keydown", onSave);
  });

  const fileState = saved
    ? "Saved"
    : conflict || session.targetChanged
      ? "File changed"
      : writePaused
        ? "Paused"
        : destination
          ? "Saving…"
          : "No file";
  return (
    <TooltipProvider delay={300}>
      <header
        className="revision-header comparison-header-bar"
        ref={headerRef}
        data-testid="revision-header"
      >
        <div className="revision-header-inner">
          <div className="revision-identity">
            <h1 data-testid="revision-path">
              {destination ?? "No file selected"}
            </h1>
            {reference !== null && <span>Comparing with {referenceLabel}</span>}
          </div>
          <div className="revision-tools">
            <div
              className="revision-tool-group"
              aria-label="Editing mode"
              role="group"
            >
              <TipButton
                tip="Write edits to the selected Markdown file automatically."
                data-testid="revision-edit"
                variant={
                  destination && interaction === "editing"
                    ? "secondary"
                    : "ghost"
                }
                aria-pressed={Boolean(destination && interaction === "editing")}
                onClick={() => {
                  if (!destination) chooseFile({ kind: "edit" });
                  else {
                    setInteraction("editing");
                    setBlocked(false);
                  }
                }}
              >
                Edit
              </TipButton>
              <TipButton
                tip={
                  blocked
                    ? "Use Edit for this formatting or structural change."
                    : "Propose wording that stays out of saved and exported Markdown until you Keep it."
                }
                data-testid="revision-suggest"
                variant={interaction === "suggesting" ? "secondary" : "ghost"}
                aria-pressed={interaction === "suggesting"}
                onClick={() => setInteraction("suggesting")}
              >
                Suggest
              </TipButton>
            </div>
            <div
              className="revision-tool-group"
              aria-label="Document history"
              role="group"
            >
              <TipButton
                tip="Undo document edit or review choice"
                aria-label="Undo"
                data-testid="revision-undo"
                variant="ghost"
                size="icon"
                disabled={!editor || undoDepth(editor.state) === 0}
                onClick={() => editor?.commands.undo()}
              >
                <Undo2 />
              </TipButton>
              <TipButton
                tip="Redo document edit or review choice"
                aria-label="Redo"
                data-testid="revision-redo"
                variant="ghost"
                size="icon"
                disabled={!editor || redoDepth(editor.state) === 0}
                onClick={() => editor?.commands.redo()}
              >
                <Redo2 />
              </TipButton>
            </div>
            <div
              className="revision-tool-group"
              role="group"
              aria-label="Document view"
            >
              <TipButton
                tip={
                  formatted
                    ? "Show the Markdown that Save would write."
                    : "Return to the rendered editor."
                }
                data-testid="revision-format"
                variant="ghost"
                onClick={() => {
                  captures.current();
                  if (formatted) currentDraft();
                  setFormatted(!formatted);
                }}
              >
                {formatted ? "Markdown" : "Formatted"}
              </TipButton>
              <TipButton
                tip="Copy the Markdown that Save would write."
                aria-label="Copy Markdown"
                data-testid="revision-copy"
                variant="ghost"
                size="icon"
                onClick={() => {
                  const draft = currentDraft();
                  void copyRevisionMarkdown(
                    draft.cleanMarkdown ?? draft.markdown,
                  ).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1400);
                  }, reportError);
                }}
              >
                {copied ? <Check /> : <Copy />}
              </TipButton>
              <TipButton
                tip="Download the Markdown that Save would write."
                aria-label="Download Markdown"
                data-testid="revision-download"
                variant="ghost"
                size="icon"
                onClick={() => {
                  const draft = currentDraft();
                  downloadRevisionMarkdown(
                    draft.cleanMarkdown ?? draft.markdown,
                    filename,
                  );
                }}
              >
                <Download />
              </TipButton>
            </div>
            <div
              className="revision-tool-group revision-navigation"
              aria-label="Change navigation"
              role="group"
            >
              <TipButton
                tip="Previous change"
                aria-label="Previous change"
                data-testid="revision-previous-change"
                variant="ghost"
                size="icon"
                disabled={!formatted || !count}
                onClick={() => navigate(-1)}
              >
                <ArrowUp />
              </TipButton>
              <span
                className="tabular-nums text-xs text-muted-foreground"
                data-testid="revision-pending"
                title="Unreviewed changes and pending suggestions"
              >
                {count || ""}
              </span>
              <TipButton
                tip="Next change"
                aria-label="Next change"
                data-testid="revision-next-change"
                variant="ghost"
                size="icon"
                disabled={!formatted || !count}
                onClick={() => navigate(1)}
              >
                <ArrowDown />
              </TipButton>
            </div>
            <div
              className="revision-tool-group"
              aria-label="Save and send"
              role="group"
            >
              <TipButton
                tip={
                  recoveryPending
                    ? "Saving changes."
                    : "Status of the selected Markdown file."
                }
                variant="ghost"
                data-testid="revision-file-status"
                className="w-[5rem] pointer-events-auto cursor-default text-muted-foreground"
                tabIndex={0}
                aria-disabled="true"
              >
                {fileState}
              </TipButton>
              <TipButton
                tip="Send a snapshot and comments to the agent. This does not write a file."
                data-testid="revision-send"
                variant="outline"
                disabled={busy || reviewChanged}
                onClick={() => {
                  setActionError("");
                  setSendOpen(true);
                }}
              >
                Send feedback
              </TipButton>
              <TipButton
                tip={
                  destination
                    ? "Copy the current Markdown and continue editing the copy."
                    : "Choose which Markdown file to edit."
                }
                data-testid="revision-save-as"
                variant="ghost"
                disabled={busy}
                onClick={showSaveAs}
              >
                {destination || reviewChanged ? "Save As…" : "Choose a file"}
              </TipButton>
            </div>
          </div>
        </div>
      </header>
      <main
        className="revision-page comparison-page"
        data-testid="revision-page"
      >
        {(recoveryError ||
          (actionError && !saveAs && !choosingBase && !sendOpen)) && (
          <p
            role="alert"
            className="comparison-error"
            data-testid="revision-error"
          >
            {actionError || recoveryError}
          </p>
        )}
        {(conflict || session.targetChanged || writePaused) && (
          <div className="comparison-conflict" data-testid="revision-conflict">
            <strong>
              {reviewChanged
                ? "This review changed in another browser. Your edits are still here."
                : "Autosave paused."}
            </strong>{" "}
            <Button
              variant="outline"
              data-testid="revision-inspect"
              onClick={() => void inspect().then(setDisk, reportError)}
            >
              Inspect file
            </Button>{" "}
            <Button variant="outline" onClick={showSaveAs}>
              Save As
            </Button>
          </div>
        )}
        <div ref={documentRef}>
          <div hidden={!formatted}>
            <RichTextEditorSurface
              key={editorGeneration}
              page={page}
              activeDocumentPath={sourcePath ? pathLeaf(sourcePath) : null}
              selected
              layout="default"
              focusRequestKey={null}
              sourceMarkdown={source.markdown}
              onMarkdownChange={changeMarkdown}
              interactionMode={
                !destination && interaction === "editing"
                  ? "viewing"
                  : interaction
              }
              beforeNavigate={async () => {
                try {
                  currentDraft();
                  return await flush();
                } catch (error) {
                  reportError(error);
                  return false;
                }
              }}
              backend={backend}
              onEditorReady={receiveEditor}
              editableReview={reviewSurface}
            />
            {(commentHistory.current.past.length > 0 ||
              commentHistory.current.future.length > 0) && (
              <div
                className="revision-comment-history"
                role="group"
                aria-label="Comment history"
              >
                <MessageSquare
                  aria-hidden="true"
                  className="size-3.5 text-muted-foreground"
                />
                <TipButton
                  tip="Undo comment change"
                  aria-label="Undo comment change"
                  data-testid="revision-comment-undo"
                  variant="ghost"
                  size="icon"
                  disabled={!commentHistory.current.past.length}
                  onClick={() => moveCommentHistory("past")}
                >
                  <Undo2 />
                </TipButton>
                <TipButton
                  tip="Redo comment change"
                  aria-label="Redo comment change"
                  data-testid="revision-comment-redo"
                  variant="ghost"
                  size="icon"
                  disabled={!commentHistory.current.future.length}
                  onClick={() => moveCommentHistory("future")}
                >
                  <Redo2 />
                </TipButton>
              </div>
            )}
          </div>
          {!formatted && (
            <div className="review-layout-grid">
              <div className="review-layout-main revision-markdown">
                <pre
                  data-comparison-anchor="unit-0"
                  data-testid="revision-markdown"
                  className="revision-source-text"
                >
                  {markdown}
                </pre>
              </div>
            </div>
          )}
        </div>
      </main>
      <Dialog
        open={choosingBase}
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) firstAction.current = null;
          setChoosingBase(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Choose a file</DialogTitle>
          <DialogDescription className="sr-only">
            Edits and review choices save to this file as you work.
          </DialogDescription>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void selectBase();
            }}
          >
            <div role="group" aria-label="File to edit" className="grid gap-2">
              {(["old", "new"] as const).map((side) => {
                const filename = session.baseOptions?.[side];
                if (!filename) return null;
                return (
                  <Button
                    key={side}
                    type="button"
                    data-testid={`revision-base-${side}`}
                    variant={baseChoice === side ? "secondary" : "outline"}
                    aria-pressed={baseChoice === side}
                    className="h-auto justify-start whitespace-normal break-all text-left"
                    onClick={() => {
                      setActionError("");
                      setBaseChoice(side);
                    }}
                  >
                    {side === "old" ? "Old" : "New"}: {filename}
                  </Button>
                );
              })}
              <Button
                type="button"
                data-testid="revision-base-copy"
                variant={baseChoice === "copy" ? "secondary" : "outline"}
                aria-pressed={baseChoice === "copy"}
                className="justify-start"
                onClick={() => {
                  setActionError("");
                  setBaseChoice("copy");
                }}
              >
                {initial.mode === "document" ? "New file" : "New copy"}
              </Button>
            </div>
            {baseChoice === "copy" && (
              <>
                {initial.mode !== "document" && (
                  <div
                    className="flex gap-2"
                    role="group"
                    aria-label="Start from"
                  >
                    {(["old", "new"] as const).map((side) => (
                      <Button
                        key={side}
                        type="button"
                        size="sm"
                        data-testid={`revision-copy-seed-${side}`}
                        variant={copySeed === side ? "secondary" : "outline"}
                        aria-pressed={copySeed === side}
                        onClick={() => setCopySeed(side)}
                      >
                        Start from {side === "old" ? "Old" : "New"}
                      </Button>
                    ))}
                  </div>
                )}
                <label htmlFor="revision-base-path">New file path</label>
                <Input
                  id="revision-base-path"
                  data-testid="revision-base-path"
                  value={savePath}
                  placeholder="/absolute/path/to/document.md"
                  onChange={(event) => setSavePath(event.target.value)}
                  autoComplete="off"
                />
              </>
            )}
            {actionError && (
              <p
                role="alert"
                className="text-destructive"
                data-testid="revision-base-error"
              >
                {actionError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="submit"
                data-testid="revision-base-confirm"
                title="Edits and review choices autosave to this file"
                disabled={busy || (baseChoice === "copy" && !savePath.trim())}
              >
                {baseChoice === "copy" ? "Create file" : "Use this file"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={saveAs}
        onOpenChange={(open) => {
          if (!busy) setSaveAs(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Save As</DialogTitle>
          <DialogDescription className="sr-only">
            Copy this Markdown and continue editing the copy.
          </DialogDescription>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void inspectAndSave();
            }}
          >
            <label htmlFor="revision-output">Destination path</label>
            <Input
              id="revision-output"
              data-testid="revision-output"
              value={savePath}
              onChange={(event) => {
                setSavePath(event.target.value);
                setReplace(null);
                setActionError("");
              }}
              placeholder="/absolute/path/to/document.md"
              autoComplete="off"
            />
            {initial.mode === "compare" && (
              <div className="flex flex-wrap gap-2">
                {[...new Set([initial.beforeLabel, initial.afterLabel])]
                  .filter((label) => label.startsWith("/"))
                  .map((label) => (
                    <Button
                      variant="outline"
                      key={label}
                      type="button"
                      title={label}
                      onClick={() => {
                        setSavePath(label);
                        setReplace(null);
                      }}
                    >
                      {pathLeaf(label)}
                    </Button>
                  ))}
              </div>
            )}
            {replace && (
              <p role="alert" data-testid="revision-replace">
                Replace the existing file at{" "}
                <span className="break-all">{replace.path}</span>?
              </p>
            )}
            {actionError && (
              <p
                role="alert"
                className="text-destructive"
                data-testid="revision-save-error"
              >
                {actionError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="submit"
                disabled={busy || !savePath.trim()}
                data-testid="revision-save-confirm"
              >
                {replace ? "Replace file" : "Save Markdown"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={disk !== null}
        onOpenChange={(open) => {
          if (!open) setDisk(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogTitle>{disk?.path}</DialogTitle>
          <DialogDescription className="sr-only">
            The current Markdown on disk.
          </DialogDescription>
          <pre
            data-testid="revision-disk-version"
            className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded border p-3"
          >
            {disk?.markdown ?? "This file is missing."}
          </pre>
        </DialogContent>
      </Dialog>
      <Dialog
        open={sendOpen}
        onOpenChange={(open) => {
          if (!busy) setSendOpen(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription className="sr-only">
            Send the current review without writing to disk.
          </DialogDescription>
          <Textarea
            data-testid="revision-feedback"
            aria-label="Overall comment"
            placeholder="Add an overall comment (optional)"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          {actionError && (
            <p role="alert" className="text-destructive">
              {actionError}
            </p>
          )}
          <DialogFooter>
            <Button
              data-testid="revision-send-confirm"
              title="Send the current snapshot without writing the file"
              disabled={busy}
              onClick={() => void send()}
            >
              Send snapshot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="sr-only" role="status">
        {copied ? "Markdown copied." : session.feedback ? "Feedback sent." : ""}
      </div>
    </TooltipProvider>
  );
}
