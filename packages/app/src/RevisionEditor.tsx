import {
  closeHistory,
  isHistoryTransaction,
  redoDepth,
  undoDepth,
} from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Download,
  FileCode2,
  Info,
  MessageSquare,
  MoreHorizontal,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
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
  applySuggestionDecisions,
  type ReviewDecision,
  reviewShortcut,
  reviewShortcutLabel,
} from "./review-decisions";
import { equalRevisionDraft } from "./revision-draft";
import {
  acceptedDocument,
  cleanRevisionMarkdown,
  copyRevisionMarkdown,
  createSourceSpellingPreserver,
  downloadRevisionMarkdown,
  editableMarkdownOptions,
} from "./revision-markdown";
import { suggestionPositions } from "./revision-projection";
import {
  type BaseSide,
  createReferenceComparison,
  type ReferenceChange,
  referenceDecorations,
  revertReferenceChange,
} from "./revision-reference";
import {
  type InspectedDestination,
  type RevisionDraft,
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
      void flush().catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
    };
    const preserveWhenHidden = () => {
      if (document.visibilityState === "hidden") preserve();
    };
    document.addEventListener("visibilitychange", preserveWhenHidden);
    window.addEventListener("pagehide", preserve);
    window.addEventListener("blur", preserve);
    return () => {
      document.removeEventListener("visibilitychange", preserveWhenHidden);
      window.removeEventListener("pagehide", preserve);
      window.removeEventListener("blur", preserve);
    };
  }, [flush]);
  const [source] = useState(draft);
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [compactTools, setCompactTools] = useState(
    () => window.matchMedia("(max-width: 1023px), (pointer: coarse)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px), (pointer: coarse)");
    const update = () => {
      setCompactTools(query.matches);
      setMoreOpen(false);
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [disk, setDisk] = useState<InspectedDestination | null>(null);
  const [conflict, setConflict] = useState(initial.targetChanged);
  const [preservedReview, setPreservedReview] = useState(false);
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
  const sourcePath =
    destination ??
    (baseSide === "old" ? initial.beforePath : initial.afterPath) ??
    initial.baseOptions?.[baseSide] ??
    initial.targetPath ??
    "";
  const beforePath = initial.beforePath ?? initial.baseOptions?.old ?? null;
  const afterPath = initial.afterPath ?? initial.baseOptions?.new ?? null;
  const beforeLabel = initial.beforeLabel.startsWith("/")
    ? pathLeaf(initial.beforeLabel)
    : initial.beforeLabel;
  const afterLabel = initial.afterLabel.startsWith("/")
    ? pathLeaf(initial.afterLabel)
    : initial.afterLabel;
  const buttonHandoff = session.handoff !== "chat";
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

  const deciding = useCallback(
    (changeId: string, keep: boolean) => {
      const live = ownEditor.current;
      if (!live) return false;
      const change = referenceKey
        .getState(live.state)
        ?.find((item) => item.item.changeId === changeId);
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
    [baseSide],
  );

  const decideAll = useCallback(
    (decision: ReviewDecision) => {
      const live = ownEditor.current;
      if (!live) return;
      const existing = new Set(kept(live.state.doc));
      const changes = (referenceKey.getState(live.state) ?? noChanges).filter(
        (change) =>
          !change.overlapsSuggestion && !existing.has(change.item.changeId),
      );
      const nativeIds = suggestionPositions(live.state.doc).keys();
      const tr = live.state.tr;
      if ((decision === "accept") === (baseSide === "new")) {
        if (changes.length > 0) {
          tr.setDocAttribute("kept", [
            ...existing,
            ...changes.map((change) => change.item.changeId),
          ]);
        }
      } else if (changes.length > 0) {
        // Working right to left keeps untouched positions valid. Verify every
        // replacement before dispatching any of the choices.
        changes.sort((a, b) => b.from - a.from || b.to - a.to);
        let boundary = live.state.doc.content.size;
        let scratch = EditorState.create({ doc: tr.doc });
        for (const change of changes) {
          const replacement =
            change.to <= boundary && revertReferenceChange(scratch, change);
          if (!replacement) {
            setActionError(
              "Some changes overlap or moved. Review them individually before choosing again.",
            );
            return;
          }
          for (const step of replacement.steps) tr.step(step);
          scratch = scratch.apply(replacement);
          boundary = change.from;
        }
      }
      if (!applySuggestionDecisions(tr, nativeIds, decision)) {
        setActionError("A suggestion moved. Review it before deciding.");
        return;
      }
      if (!tr.docChanged) return;
      // A resolved native edit can appear as a new difference from the frozen
      // file. Mark the newly introduced comparison wording as already reviewed.
      live.view.dispatch(closeHistory(tr).setMeta(explicitReviewEdit, true));
      live.view.dispatch(closeHistory(live.state.tr));
      setActiveChange(null);
      setActionError("");
    },
    [baseSide],
  );

  const renderedChanges = editor
    ? (referenceKey.getState(editor.state) ?? noChanges)
    : noChanges;
  const decisions = editor
    ? kept(editor.state.doc)
    : Object.keys(source.decisions);
  const visibleChanges = useMemo(() => {
    const decided = new Set(decisions);
    return renderedChanges
      .filter(
        (change) =>
          !change.overlapsSuggestion && !decided.has(change.item.changeId),
      )
      .map((change) => change.item);
  }, [renderedChanges, decisions]);
  const decisionsDisabled =
    busy ||
    sendOpen ||
    Boolean(disk) ||
    conflict ||
    session.targetChanged ||
    writePaused;
  const reviewSurface = useMemo(
    () => ({
      suggestions: visibleChanges,
      disabled: decisionsDisabled,
      activeChangeId: activeChange,
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
      activeChange,
      commentMap,
      deciding,
      decisions,
      decisionsDisabled,
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
  const persistedDraft = session.draft ?? seed;
  const reviewSaved =
    !markdownQueued &&
    !recoveryPending &&
    !recoveryError &&
    equalRevisionDraft(draft, {
      ...persistedDraft,
      reviewComments: session.draft
        ? (session.reviewComments ?? [])
        : seed.reviewComments,
    });
  const saved =
    reviewSaved &&
    (!destination ||
      (destination === session.savedPath && markdown === cleanSaved)) &&
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
  async function preserveReview() {
    setBusy(true);
    setActionError("");
    try {
      await run("recover", currentDraft(), {
        autosave: "none",
        baseVersion: session.baseVersion ?? null,
      });
      setConflict(false);
      setDisk(null);
      setPreservedReview(true);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setActionError("");
    try {
      await run("sync", currentDraft());
      setConflict(false);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("destination changed")
      )
        setConflict(true);
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
      if (!busy && !sendOpen && !disk && !writePaused) void save();
    };
    document.addEventListener("keydown", onSave);
    return () => document.removeEventListener("keydown", onSave);
  });

  const fileState = saved
    ? destination
      ? "Saved to file"
      : "Review saved"
    : conflict || session.targetChanged
      ? "File changed"
      : writePaused
        ? "Paused"
        : "Saving…";
  const secondaryTools = (
    <>
      <div
        className="revision-tool-group"
        role="group"
        aria-label="Document view"
      >
        <TipButton
          tip={
            formatted
              ? "Show Markdown without pending suggestions or comments."
              : "Show the formatted document."
          }
          data-testid="revision-format"
          aria-label={formatted ? "Show Markdown" : "Show formatted document"}
          aria-pressed={!formatted}
          size="icon"
          variant="ghost"
          onClick={() => {
            setMoreOpen(false);
            captures.current();
            if (formatted) currentDraft();
            setFormatted(!formatted);
          }}
        >
          <FileCode2 aria-hidden="true" />
        </TipButton>
        <TipButton
          tip="Copy Markdown without pending suggestions or comments."
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
          tip="Download Markdown without pending suggestions or comments."
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
      {buttonHandoff && (
        <div
          className="revision-tool-group"
          aria-label="Send feedback"
          role="group"
        >
          <TipButton
            tip="Send a snapshot and comments to the agent. This does not write a file."
            data-testid="revision-send"
            variant="outline"
            disabled={busy || reviewChanged}
            onClick={() => {
              setMoreOpen(false);
              setActionError("");
              setSendOpen(true);
            }}
          >
            Send feedback
          </TipButton>
        </div>
      )}
    </>
  );
  return (
    <TooltipProvider delay={300}>
      <header
        className="revision-header comparison-header-bar"
        ref={headerRef}
        data-testid="revision-header"
      >
        <div className="revision-header-inner">
          <div className="revision-identity" data-testid="revision-identity">
            <div className="revision-title-copy">
              <h1 data-testid="revision-path" title={initial.title}>
                {initial.title}
              </h1>
              {reference !== null && (
                <div className="revision-version-labels">
                  <span
                    data-testid="revision-before-label"
                    title={beforePath ?? beforeLabel}
                  >
                    {beforeLabel}
                  </span>
                  <span aria-hidden="true">→</span>
                  <span
                    data-testid="revision-after-label"
                    title={afterPath ?? afterLabel}
                  >
                    {afterLabel}
                  </span>
                </div>
              )}
            </div>
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Review details"
                    data-testid="revision-details"
                    title="Review details and file paths"
                  />
                }
              >
                <Info aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                collisionPadding={8}
                aria-label="Review details"
                data-testid="revision-details-content"
              >
                <p className="mb-3 font-semibold">{initial.title}</p>
                <dl className="revision-details-list">
                  {reference !== null && (
                    <>
                      <dt>{beforeLabel}</dt>
                      <dd data-testid="revision-details-before">
                        {beforePath ?? "Text supplied by the agent"}
                      </dd>
                    </>
                  )}
                  <dt>{afterLabel}</dt>
                  <dd data-testid="revision-details-after">
                    {afterPath ?? "Text supplied by the agent"}
                  </dd>
                  <dt>Autosave</dt>
                  <dd data-testid="revision-details-autosave">
                    {destination ??
                      "No Markdown file writes. Your review is saved for the agent."}
                  </dd>
                </dl>
              </PopoverContent>
            </Popover>
            <span
              className="revision-file-status"
              data-testid="revision-file-status"
              role="status"
              aria-label={fileState}
              title={
                saved
                  ? destination
                    ? `Saved to ${destination}`
                    : "Review saved for the agent. No Markdown file writes."
                  : fileState
              }
            >
              {saved ? <Check aria-hidden="true" /> : fileState}
            </span>
          </div>
          <div className="revision-tools">
            <Select<DocumentInteractionMode>
              value={interaction}
              onValueChange={(mode) => {
                if (mode !== "editing" && mode !== "suggesting") return;
                setInteraction(mode);
                setBlocked(false);
              }}
            >
              <SelectTrigger
                data-testid="revision-mode"
                aria-label="Editing mode"
                className="revision-mode-select"
                title={
                  blocked
                    ? "Use Edit for formatting or structural changes."
                    : "Edit directly or suggest changes for review."
                }
              >
                <SelectValue>
                  {interaction === "suggesting" ? "Suggest" : "Edit"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="editing"
                  label="Edit"
                  data-testid="revision-mode-edit"
                  className="min-h-11 text-sm"
                >
                  <SelectItemText>Edit</SelectItemText>
                </SelectItem>
                <SelectItem
                  value="suggesting"
                  label="Suggest"
                  data-testid="revision-mode-suggest"
                  className="min-h-11 text-sm"
                >
                  <SelectItemText>Suggest</SelectItemText>
                </SelectItem>
              </SelectContent>
            </Select>
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
              className="revision-tool-group revision-navigation"
              aria-label="Change navigation"
              role="group"
              onKeyDown={(event) => {
                const decision = reviewShortcut(event.nativeEvent);
                const id = activeChange;
                if (
                  !decision ||
                  !id ||
                  !navigation.includes(id) ||
                  decisionsDisabled
                )
                  return;
                event.preventDefault();
                if (event.repeat || deciding(id, decision === "accept")) return;
                editor?.view.dispatch(closeHistory(editor.state.tr));
                if (decision === "accept")
                  editor?.commands.acceptCriticChange(id);
                else editor?.commands.rejectCriticChange(id);
                editor?.view.dispatch(closeHistory(editor.state.tr));
              }}
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
              {formatted && count > 0 && (
                <>
                  <TipButton
                    tip={`Accept pending changes. Current change: ${reviewShortcutLabel("accept")}`}
                    variant="outline"
                    size="sm"
                    disabled={decisionsDisabled}
                    data-testid="revision-accept-all"
                    onClick={() => decideAll("accept")}
                  >
                    Accept all
                  </TipButton>
                  <TipButton
                    tip={`Reject pending changes. Current change: ${reviewShortcutLabel("reject")}`}
                    variant="outline"
                    size="sm"
                    disabled={decisionsDisabled}
                    data-testid="revision-reject-all"
                    onClick={() => decideAll("reject")}
                  >
                    Reject all
                  </TipButton>
                </>
              )}
            </div>
            {compactTools ? (
              <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      variant="outline"
                      aria-label="More actions"
                      data-testid="revision-more"
                    />
                  }
                >
                  <MoreHorizontal />
                  More
                </PopoverTrigger>
                <PopoverContent
                  className="revision-more-actions"
                  data-testid="revision-more-actions"
                  aria-label="More actions"
                >
                  {secondaryTools}
                </PopoverContent>
              </Popover>
            ) : (
              secondaryTools
            )}
          </div>
        </div>
      </header>
      <main
        className="revision-page comparison-page"
        data-testid="revision-page"
      >
        {(recoveryError || (actionError && !sendOpen)) && (
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
            {destination && (
              <Button
                variant="outline"
                data-testid="revision-inspect"
                onClick={() => void inspect().then(setDisk, reportError)}
              >
                Inspect file
              </Button>
            )}{" "}
            <Button
              variant="outline"
              data-testid="revision-recover"
              disabled={busy}
              onClick={() => void preserveReview()}
            >
              Preserve this review
            </Button>{" "}
            Save your complete feedback separately for the agent, without
            writing a Markdown file.
          </div>
        )}
        {preservedReview && (
          <p role="status" data-testid="revision-recovered">
            Your complete review is saved separately for the agent. Edits here
            save in this review without writing a Markdown file.
          </p>
        )}
        <div ref={documentRef}>
          <div hidden={!formatted}>
            <RichTextEditorSurface
              page={page}
              activeDocumentPath={sourcePath ? pathLeaf(sourcePath) : null}
              selected
              layout="default"
              focusRequestKey={null}
              sourceMarkdown={source.markdown}
              onMarkdownChange={changeMarkdown}
              interactionMode={interaction}
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
        open={buttonHandoff && sendOpen}
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
