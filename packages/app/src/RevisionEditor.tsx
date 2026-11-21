import {
  closeHistory,
  isHistoryTransaction,
  redoDepth,
  undoDepth,
} from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { cleanRoughdraftMarkdown } from "@roughdraft/rfm";
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
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
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
import { decideReviewChanges, suggestionDetail } from "./revision-bulk";
import { equalRevisionDraft } from "./revision-draft";
import {
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import { outcomeDocument } from "./revision-outcomes";
import {
  useRevisionPreferences,
  type RevisionView,
} from "./revision-preferences";
import {
  acceptedDocument,
  sameRevisionMarkup,
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
  referenceChangeIds,
  type ReferenceChange,
  referenceDecorations,
  revertReferenceChange,
} from "./revision-reference";
import {
  type InspectedDestination,
  type RevisionDraft,
  useRevisionSession,
} from "./revision-session";
import {
  documentMetadata,
  sameMetadata,
  withDocumentMetadata,
} from "./revision-metadata";
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

function referenceDocument(schema: Editor["schema"], markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  return schema.nodeFromJSON({
    ...parsed.doc,
    attrs: {
      ...parsed.doc.attrs,
      sourceMetadata: {
        markdown,
        frontmatter: parsed.frontmatter,
        endmatter: parsed.endmatter,
      },
    },
  });
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
            (!transaction.before.content.eq(transaction.doc.content) ||
              transaction.before.attrs.kept !== transaction.doc.attrs.kept ||
              transaction.before.attrs.reviewed !==
                transaction.doc.attrs.reviewed)
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
          const ids = new Set(changes.flatMap(referenceChangeIds));
          const currentKept = kept(current.doc);
          const next = new Set(
            currentKept.filter(
              (id) => ids.has(id) || id === "document-metadata",
            ),
          );
          const previousIds = new Set(old.flatMap(referenceChangeIds));
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
  const exactReview = useRef(source.markdown);
  const reviewSpelling = useRef<ReturnType<
    typeof createSourceSpellingPreserver
  > | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preferences, setPreferences] = useRevisionPreferences(initial.id);
  const { interaction, formatted, view } = preferences;
  const previewing = view !== "changes";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sourceReading, setSourceReading] = useState<{
    quote: string[];
    offset: number;
  } | null>(null);
  const sourceUpdateRef = useRef<
    ((markdown: string, previous?: string) => void) | null
  >(null);
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
    `${formatted}-${view}`,
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
  const previewPath =
    view === "rejected"
      ? (beforePath ?? sourcePath)
      : (afterPath ?? sourcePath);
  const previewBackend = useMemo(
    () =>
      new ApiBackend({
        kind: "local-files",
        label: "Local files",
        detail: previewPath,
        projectPath: documentProject(previewPath),
      }),
    [previewPath],
  );
  const page = useMemo(
    () => ({ id: initial.id, title: initial.title, content: source.markdown }),
    [initial, source.markdown],
  );
  const ownEditor = useRef<Editor | null>(null);
  const receiveEditor = useCallback(
    (next: Editor | null) => {
      ownEditor.current = next;
      if (next && !reviewSpelling.current) {
        const parsed = criticMarkdownToEditorState(
          exactReview.current,
          editableMarkdownOptions,
        );
        const comments = new Map(
          readDraft().reviewComments.map((comment) => [comment.id, comment]),
        );
        const canonical = editorStateToCriticMarkdown(
          next.getJSON(),
          comments,
          { frontmatter: parsed.frontmatter, endmatter: parsed.endmatter },
        );
        reviewSpelling.current = createSourceSpellingPreserver(
          exactReview.current,
          canonical,
        );
      }
      setEditor(next);
    },
    [readDraft],
  );

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
    (markdown: string, origin?: "source") => {
      setMarkdownQueued(false);
      const current = ownEditor.current?.state.doc;
      if (!current) return;
      const sourceClean = cleanRoughdraftMarkdown(markdown);
      const metadataChanged = !sameMetadata(
        documentMetadata(sourceClean),
        documentMetadata(exactClean.current),
      );
      const result =
        origin === "source" ? sourceClean : cleanRevisionMarkdown(markdown);
      preserveSource.current ??= createSourceSpellingPreserver(
        exactClean.current,
        canonical(exactClean.current),
      );
      const requested = canonical(result);
      const preserved = preserveSource.current(requested);
      let cleanMarkdown =
        origin === "source"
          ? result
          : preserved !== null && canonical(preserved) === requested
            ? preserved
            : result;
      if (metadataChanged && origin !== "source")
        cleanMarkdown = withDocumentMetadata(
          cleanMarkdown,
          documentMetadata(sourceClean),
        );
      if (origin === "source" || metadataChanged) {
        exactClean.current = cleanMarkdown;
        preserveSource.current = null;
      }
      let reviewMarkdown = markdown;
      if (origin !== "source") {
        const preserved = reviewSpelling.current?.(markdown);
        if (preserved != null && sameRevisionMarkup(preserved, markdown))
          reviewMarkdown = preserved;
      } else {
        exactReview.current = markdown;
        const parsed = criticMarkdownToEditorState(
          markdown,
          editableMarkdownOptions,
        );
        const comments = new Map(
          readDraft().reviewComments.map((comment) => [comment.id, comment]),
        );
        const canonical = editorStateToCriticMarkdown(
          current.toJSON(),
          comments,
          { frontmatter: parsed.frontmatter, endmatter: parsed.endmatter },
        );
        reviewSpelling.current = createSourceSpellingPreserver(
          markdown,
          canonical,
        );
      }
      updateDraft((previous) => ({
        ...previous,
        markdown: reviewMarkdown,
        cleanMarkdown,
        decisions: Object.fromEntries(kept(current).map((id) => [id, "kept"])),
        reviewed: reviewedChanges(current),
      }));
      setBlocked(false);
    },
    [updateDraft, readDraft],
  );

  const deciding = useCallback(
    (changeId: string, keep: boolean) => {
      const live = ownEditor.current;
      if (!live) return false;
      if (changeId === "document-metadata" && reference !== null) {
        const transaction = decideReviewChanges(
          live.state,
          referenceDocument(live.schema, reference),
          baseSide,
          keep ? "accept" : "reject",
          true,
          "metadata",
        );
        live.view.dispatch(
          closeHistory(transaction)
            .setMeta(referenceDecision, true)
            .setMeta(explicitReviewEdit, true),
        );
        live.view.dispatch(closeHistory(live.state.tr));
        return true;
      }
      const change = referenceKey
        .getState(live.state)
        ?.find((item) => item.item.changeId === changeId);
      const detail = change
        ? { ...change.item, from: change.from, to: change.to }
        : suggestionDetail(live.state.doc, changeId);
      if (!change && !suggestionPositions(live.state.doc).has(changeId))
        return false;
      const leaveAsIs = keep === (baseSide === "new");
      const transaction = !change
        ? live.state.tr
        : leaveAsIs
          ? live.state.tr.setDocAttribute("kept", [
              ...new Set([
                ...kept(live.state.doc),
                ...referenceChangeIds(change),
              ]),
            ])
          : revertReferenceChange(live.state, change);
      if (
        transaction &&
        !change &&
        !applySuggestionDecisions(
          transaction,
          [changeId],
          keep ? "accept" : "reject",
        )
      )
        return true;
      if (transaction) {
        recordReviewedChange(
          transaction,
          {
            decision: keep ? "accept" : "reject",
            oldText: detail.oldText,
            newText: detail.newText,
            ...(change && leaveAsIs
              ? { keptIds: referenceChangeIds(change) }
              : {}),
          },
          detail,
        );
        live.view.dispatch(
          closeHistory(transaction)
            .setMeta(referenceDecision, Boolean(change))
            .setMeta(explicitReviewEdit, true),
        );
        live.view.dispatch(closeHistory(live.state.tr));
      }
      return true;
    },
    [baseSide, reference],
  );

  const decideAll = useCallback(
    (decision: ReviewDecision) => {
      const live = ownEditor.current;
      if (!live) return;
      try {
        const other =
          reference === null ? null : referenceDocument(live.schema, reference);
        const transaction = decideReviewChanges(
          live.state,
          other,
          baseSide,
          decision,
          true,
        );
        if (!transaction.docChanged) return;
        live.view.dispatch(
          closeHistory(transaction).setMeta(explicitReviewEdit, true),
        );
        live.view.dispatch(closeHistory(live.state.tr));
        setActiveChange(null);
        setActionError("");
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [baseSide, reference],
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
    interaction === "viewing" ||
    previewing ||
    !formatted ||
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
      reviewed: source.reviewed,
      sourceUpdateRef,
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
      source.reviewed,
      updateComments,
      visibleChanges,
    ],
  );
  const editorDoc = editor?.state.doc;
  const workingSource =
    editorDoc?.attrs.sourceMetadata?.markdown ?? draft.markdown;
  const metadataPending =
    reference !== null &&
    !decisions.includes("document-metadata") &&
    !sameMetadata(documentMetadata(workingSource), documentMetadata(reference));
  const metadataOld = documentMetadata(
    baseSide === "new" ? (reference ?? workingSource) : workingSource,
  );
  const metadataNew = documentMetadata(
    baseSide === "new" ? workingSource : (reference ?? workingSource),
  );
  const reviewed = editorDoc
    ? reviewedChanges(editorDoc)
    : (source.reviewed ?? []);
  const preview = useMemo(() => {
    if (!editorDoc || view === "changes") return null;
    try {
      const other =
        reference === null
          ? null
          : referenceDocument(editorDoc.type.schema, reference);
      const doc = outcomeDocument(
        editorDoc,
        other,
        baseSide,
        view === "accepted" ? "accept" : "reject",
      );
      const metadata =
        doc.attrs.sourceMetadata ?? criticMarkdownToEditorState(draft.markdown);
      return {
        doc: doc.toJSON(),
        markdown: editorStateToCriticMarkdown(doc.toJSON(), new Map(), {
          frontmatter: metadata.frontmatter,
          endmatter: metadata.endmatter,
        }),
        error: "",
      };
    } catch (error) {
      return {
        doc: null,
        markdown: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [editorDoc, reference, baseSide, view, draft.markdown]);
  const navigation = useMemo(() => {
    const positions = new Map<string, number>();
    if (metadataPending) positions.set("document-metadata", -1);
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
  }, [decisions, editorDoc, renderedChanges, metadataPending]);
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
              ? "Show full Markdown source, including suggestions and comments. Source editing requires Edit mode."
              : "Show the formatted document."
          }
          data-testid="revision-format"
          aria-label={formatted ? "Show Markdown" : "Show formatted document"}
          aria-pressed={!formatted}
          size="icon"
          variant="ghost"
          onClick={() => {
            setMoreOpen(false);
            setSourceReading(captures.current() ?? null);
            if (formatted) currentDraft();
            setPreferences({ formatted: !formatted });
          }}
        >
          <FileCode2 aria-hidden="true" />
        </TipButton>
        <TipButton
          tip={
            previewing
              ? "Copy the visible outcome preview as Markdown."
              : "Copy Markdown without pending suggestions or comments."
          }
          aria-label="Copy Markdown"
          data-testid="revision-copy"
          variant="ghost"
          size="icon"
          onClick={() => {
            const draft = previewing ? null : currentDraft();
            void copyRevisionMarkdown(
              previewing
                ? (preview?.markdown ?? "")
                : (draft?.cleanMarkdown ?? draft?.markdown ?? ""),
            ).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }, reportError);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </TipButton>
        <TipButton
          tip={
            previewing
              ? "Download the visible outcome preview as Markdown."
              : "Download Markdown without pending suggestions or comments."
          }
          aria-label="Download Markdown"
          data-testid="revision-download"
          variant="ghost"
          size="icon"
          onClick={() => {
            const draft = previewing ? null : currentDraft();
            downloadRevisionMarkdown(
              previewing
                ? (preview?.markdown ?? "")
                : (draft?.cleanMarkdown ?? draft?.markdown ?? ""),
              filename,
            );
          }}
        >
          <Download />
        </TipButton>
      </div>
      <TipButton
        tip="Inspect reviewed changes and reopen a decision."
        aria-label="Reviewed changes"
        data-testid="revision-reviewed"
        variant="ghost"
        disabled={!reviewed.length}
        onClick={() => {
          setMoreOpen(false);
          setHistoryOpen(true);
        }}
      >
        Reviewed changes{reviewed.length ? ` (${reviewed.length})` : ""}
      </TipButton>
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
                if (
                  mode !== "editing" &&
                  mode !== "suggesting" &&
                  mode !== "viewing"
                )
                  return;
                currentDraft();
                setPreferences({ interaction: mode });
                setBlocked(false);
              }}
            >
              <SelectTrigger
                data-testid="revision-mode"
                aria-label="Editing mode"
                className="revision-mode-select"
                disabled={previewing}
                title={
                  blocked
                    ? "Use Edit for formatting or structural changes."
                    : "Read without editing, edit directly, or suggest changes for review."
                }
              >
                <SelectValue>
                  {interaction === "suggesting"
                    ? "Suggest"
                    : interaction === "viewing"
                      ? "Read"
                      : "Edit"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="viewing"
                  label="Read"
                  data-testid="revision-mode-read"
                  className="min-h-11 text-sm"
                >
                  <SelectItemText>Read</SelectItemText>
                </SelectItem>
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
            <Select<RevisionView>
              value={view}
              onValueChange={(next) => {
                if (
                  next !== "changes" &&
                  next !== "accepted" &&
                  next !== "rejected"
                )
                  return;
                setSourceReading(captures.current() ?? null);
                currentDraft();
                setPreferences({ view: next });
                setMoreOpen(false);
              }}
            >
              <SelectTrigger
                data-testid="revision-view"
                aria-label="Document view"
                className="revision-mode-select"
                title="Preview the original or final document without changing the review or file."
              >
                <SelectValue>
                  {view === "accepted"
                    ? "Final"
                    : view === "rejected"
                      ? "Original"
                      : "Changes"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="changes"
                  data-testid="revision-view-changes"
                  label="Changes"
                  className="min-h-11 text-sm"
                >
                  <SelectItemText>Changes</SelectItemText>
                </SelectItem>
                <SelectItem
                  value="rejected"
                  data-testid="revision-view-rejected"
                  label="Original"
                  className="min-h-11 text-sm"
                >
                  <SelectItemText>Original</SelectItemText>
                </SelectItem>
                <SelectItem
                  value="accepted"
                  data-testid="revision-view-accepted"
                  label="Final"
                  className="min-h-11 text-sm"
                >
                  <SelectItemText>Final</SelectItemText>
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
                disabled={
                  !editor ||
                  previewing ||
                  interaction === "viewing" ||
                  busy ||
                  writePaused ||
                  undoDepth(editor.state) === 0
                }
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
                disabled={
                  !editor ||
                  previewing ||
                  interaction === "viewing" ||
                  busy ||
                  writePaused ||
                  redoDepth(editor.state) === 0
                }
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
                disabled={!formatted || previewing || !count}
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
                disabled={!formatted || previewing || !count}
                onClick={() => navigate(1)}
              >
                <ArrowDown />
              </TipButton>
              {formatted &&
                !previewing &&
                interaction !== "viewing" &&
                count > 0 && (
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
          <div hidden={!formatted || previewing}>
            {metadataPending && (
              <section
                className="revision-metadata-change"
                data-testid="revision-metadata"
                data-review-rail-anchor="document-metadata"
              >
                <h2>Document metadata</h2>
                <p>YAML fields changed between these versions.</p>
                <div className="revision-metadata-versions">
                  <div>
                    <strong>Before</strong>
                    <pre>
                      {[metadataOld.frontmatter, metadataOld.endmatter]
                        .filter(Boolean)
                        .join("\n") || "No metadata"}
                    </pre>
                  </div>
                  <div>
                    <strong>After</strong>
                    <pre>
                      {[metadataNew.frontmatter, metadataNew.endmatter]
                        .filter(Boolean)
                        .join("\n") || "No metadata"}
                    </pre>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    data-testid="revision-metadata-accept"
                    disabled={decisionsDisabled}
                    onClick={() => deciding("document-metadata", true)}
                  >
                    Keep
                  </Button>
                  <Button
                    variant="outline"
                    data-testid="revision-metadata-reject"
                    disabled={decisionsDisabled}
                    onClick={() => deciding("document-metadata", false)}
                  >
                    Revert
                  </Button>
                </div>
              </section>
            )}
            <RichTextEditorSurface
              page={page}
              activeDocumentPath={sourcePath ? pathLeaf(sourcePath) : null}
              selected
              layout="default"
              focusRequestKey={null}
              sourceMarkdown={source.markdown}
              onMarkdownChange={changeMarkdown}
              interactionMode={previewing ? "viewing" : interaction}
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
          {previewing && (
            <div data-testid="revision-preview">
              <p className="revision-preview-label" role="status">
                {view === "accepted" ? "Final" : "Original"} · Read-only preview
              </p>
              {preview?.error && <p role="alert">{preview.error}</p>}
              {reviewed.some((change) => change.stale) && (
                <p className="revision-preview-label">
                  Some older decisions cannot be replayed because their passages
                  changed.
                </p>
              )}
              {formatted && preview?.doc && (
                <RichTextEditorSurface
                  page={{ ...page, id: `${page.id}-preview` }}
                  activeDocumentPath={
                    previewPath ? pathLeaf(previewPath) : null
                  }
                  selected
                  layout="default"
                  focusRequestKey={null}
                  sourceMarkdown={preview.markdown}
                  onMarkdownChange={() => {}}
                  interactionMode="viewing"
                  backend={previewBackend}
                  controlledReview={{
                    doc: preview.doc,
                    suggestions: [],
                    comments: new Map(),
                    blockHighlights: [],
                    canDecide: false,
                    disabled: true,
                    acceptLabel: "Keep",
                    rejectLabel: "Revert",
                    onAccept: () => {},
                    onReject: () => {},
                    onCreateComment: () => null,
                    onUpdateComment: () => {},
                    onDeleteComment: () => {},
                  }}
                />
              )}
            </div>
          )}
          {!formatted && (
            <>
              <div hidden={previewing}>
                <div className="review-layout-grid">
                  <div
                    className="review-layout-main revision-markdown"
                    data-comparison-anchor="unit-0"
                  >
                    <MarkdownCodeEditor
                      key="working-source"
                      sourceHistory={{
                        undo: () => {
                          if (
                            !previewing &&
                            interaction !== "viewing" &&
                            !busy &&
                            !writePaused &&
                            !disk &&
                            !sendOpen
                          )
                            editor?.commands.undo();
                        },
                        redo: () => {
                          if (
                            !previewing &&
                            interaction !== "viewing" &&
                            !busy &&
                            !writePaused &&
                            !disk &&
                            !sendOpen
                          )
                            editor?.commands.redo();
                        },
                      }}
                      readingPosition={previewing ? null : sourceReading}
                      testId="revision-markdown"
                      className="revision-source-text"
                      value={draft.markdown}
                      readOnly={previewing || interaction !== "editing"}
                      onChange={(next) => {
                        if (!previewing && interaction === "editing")
                          sourceUpdateRef.current?.(next, readDraft().markdown);
                      }}
                    />
                    {interaction === "suggesting" && (
                      <p className="text-sm text-muted-foreground">
                        Switch to Edit to change Markdown source. Suggest in the
                        formatted document.
                      </p>
                    )}
                  </div>
                </div>
              </div>
              {previewing && (
                <div className="review-layout-grid">
                  <div
                    className="review-layout-main revision-markdown"
                    data-comparison-anchor="unit-0"
                  >
                    <MarkdownCodeEditor
                      key="outcome-source"
                      readingPosition={sourceReading}
                      testId="revision-preview-markdown"
                      className="revision-source-text"
                      value={preview?.markdown ?? ""}
                      readOnly
                      onChange={() => {}}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          className="max-w-2xl"
          data-testid="revision-reviewed-dialog"
        >
          <DialogTitle>Reviewed changes</DialogTitle>
          <DialogDescription>
            Inspect previous decisions. Reopen a change to review it again;
            unrelated edits stay in place.
          </DialogDescription>
          <div className="revision-reviewed-list">
            {reviewed.map((change) => (
              <section key={change.id} className="revision-reviewed-item">
                <strong>
                  {change.decision === "accept" ? "Accepted" : "Rejected"}
                </strong>
                {change.oldText && (
                  <p>
                    <span className="text-muted-foreground">Before: </span>
                    {change.oldText}
                  </p>
                )}
                {change.newText && (
                  <p>
                    <span className="text-muted-foreground">After: </span>
                    {change.newText}
                  </p>
                )}
                {change.stale && (
                  <p className="text-sm text-muted-foreground">
                    This passage was edited after the decision. Reopening would
                    overwrite those edits.
                  </p>
                )}
                <Button
                  variant="outline"
                  disabled={change.stale || decisionsDisabled}
                  data-testid="revision-reopen-change"
                  onClick={() => {
                    if (!editor) return;
                    const transaction = reopenReviewedChange(
                      editor.state,
                      change.id,
                    );
                    if (!transaction) {
                      setActionError(
                        "This passage changed. Your newer edits have been preserved.",
                      );
                      return;
                    }
                    editor.view.dispatch(
                      closeHistory(transaction)
                        .setMeta(referenceDecision, true)
                        .setMeta(explicitReviewEdit, true),
                    );
                    editor.view.dispatch(closeHistory(editor.state.tr));
                    setHistoryOpen(false);
                  }}
                >
                  Reopen change
                </Button>
              </section>
            ))}
          </div>
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
