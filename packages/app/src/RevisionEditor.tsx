import {
  closeHistory,
  isHistoryTransaction,
  redoDepth,
  undoDepth,
} from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
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
import { MarkdownCodeEditor } from "./DeferredMarkdownCodeEditor";
import {
  type DocumentInteractionMode,
  RichTextEditorSurface,
} from "./PageCard";
import { RevisionConflictBanner } from "./RevisionConflictBanner";
import { RevisionOutdatedFeedback } from "./RevisionOutdatedFeedback";
import { RevisionRecoveryDialog } from "./RevisionRecoveryDialog";
import { RevisionSaveCopyDialog } from "./RevisionSaveCopyDialog";
import {
  applySuggestionDecisions,
  type ReviewDecision,
  reviewShortcut,
  reviewShortcutLabel,
} from "./review-decisions";
import { decideReviewChanges, suggestionDetail } from "./revision-bulk";
import {
  cleanRevisionNode,
  cleanSourceFromNode,
  projectCleanRevisionNode,
} from "./revision-clean-cache";
import {
  type CommentHistoryEntry,
  remapCommentHistory,
  restoreCommentHistory,
} from "./revision-comment-history";
import {
  adoptRevisionDisk,
  adoptRevisionDiskAsync,
} from "./revision-disk-adoption";
import { equalRevisionDraft } from "./revision-draft";
import {
  recordReviewedChange,
  reopenReviewedChange,
  reviewedChanges,
} from "./revision-history";
import {
  cleanRevisionMarkdown,
  cleanRevisionSourceMarkdown,
  copyRevisionMarkdown,
  createSourceSpellingPreserver,
  downloadRevisionMarkdown,
  editableMarkdownOptions,
} from "./revision-markdown";
import {
  documentMetadata,
  sameMetadata,
  withDocumentMetadata,
} from "./revision-metadata";
import { outcomeDocument } from "./revision-outcomes";
import { measureRevision, measureRevisionAsync } from "./revision-performance";
import {
  type RevisionView,
  useRevisionPreferences,
} from "./revision-preferences";
import { prepareRevisionEditorDraft } from "./revision-prepare";
import {
  containsReviewIdentity,
  resolvePrivateCommentAnchor,
} from "./revision-private-anchors";
import { publicRevisionNode } from "./revision-private-comments";
import { suggestionPositions } from "./revision-projection";
import {
  type BaseSide,
  createReferenceComparison,
  type ReferenceChange,
  referenceChangeIds,
  referenceDecorations,
  revertReferenceChange,
} from "./revision-reference";
import { serializeRevisionNode } from "./revision-review-cache";
import type { RevisionRemoteAdapter } from "./revision-session";
import {
  type InspectedDestination,
  type RevisionDraft,
  useRevisionSession,
} from "./revision-session";
import {
  RevisionCanonicalSpellingProof,
  RevisionSpellingProof,
} from "./revision-spelling-proof";
import {
  type CommentDraftState,
  commentDraftMatchesTarget,
  privateRootTarget,
  RevisionUiDraftContext,
  RevisionUiDraftStore,
} from "./revision-ui-drafts";
import { useRevisionToolbar } from "./useRevisionToolbar";
import "./RevisionEditor.css";

const referenceKey = new PluginKey<ReferenceChange[]>(
  "roughdraftFixedReference",
);
const referenceDecision = "roughdraftReferenceDecision";
const noChanges: ReferenceChange[] = [];

function kept(doc: ProseMirrorNode): string[] {
  return doc.attrs.kept ?? [];
}

function rebaseCommentSnapshots(
  snapshots: ComparisonReviewComment[][],
  previous: ComparisonReviewComment[],
  current: ComparisonReviewComment[],
) {
  const before = new Map(previous.map((comment) => [comment.id, comment]));
  const moves = new Map(
    current.flatMap((comment) => {
      const old = before.get(comment.id);
      return old &&
        (old.parentCommentId ?? null) !== (comment.parentCommentId ?? null)
        ? [
            [
              comment.id,
              { from: old.parentCommentId, to: comment.parentCommentId },
            ] as const,
          ]
        : [];
    }),
  );
  if (!moves.size) return snapshots;
  return snapshots.map((snapshot) => {
    let changed = false;
    const moved = snapshot.map((comment) => {
      const move = moves.get(comment.id);
      if (!move || (comment.parentCommentId ?? null) !== (move.from ?? null))
        return comment;
      changed = true;
      return { ...comment, parentCommentId: move.to };
    });
    if (!changed) return snapshot;
    const byId = new Map(moved.map((comment) => [comment.id, comment]));
    return moved.map((comment) => ({
      ...comment,
      changeId:
        byId.get(comment.parentCommentId ?? "")?.parentCommentId ??
        comment.parentCommentId ??
        "document",
    }));
  });
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
    const parsed = measureRevision("seed-parse", () =>
      criticMarkdownToEditorState(initial.afterText),
    );
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
    browserRecoveryWarning,
    recoveryPending,
    fileWritePending,
    writePaused,
    reviewChanged,
    flush,
    conflict: liveConflict,
    notice: syncNotice,
    copyLocked,
    registerAdapter,
    resolveConflict,
    reloadFromFile,
    retrySync,
    inspectCopy,
    saveCopy,
    setCopyLocked,
    checkCopyStatus,
    acknowledgeCopyResult,
    orphans,
    inspectRecovery,
    inspectOrphan,
    restoreOrphan,
    dismissOrphan,
    restoreRecoveryUi,
    recoverPublication,
    recreateFile,
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
  const [uiDraftStore] = useState(() => new RevisionUiDraftStore());
  const [copyOpen, setCopyOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  useEffect(() => {
    if (!liveConflict) setAttentionOpen(false);
  }, [liveConflict]);
  const remoteUpdateRef = useRef<RevisionRemoteAdapter["apply"] | null>(null);
  const commentHistory = useRef<{
    past: CommentHistoryEntry[];
    future: CommentHistoryEntry[];
  }>({ past: [], future: [] });
  const reviewComments = draft.reviewComments ?? [];
  const commentMap = useMemo(
    () => new Map(reviewComments.map((comment) => [comment.id, comment])),
    [reviewComments],
  );
  const updateComments = useCallback(
    (next: Map<string, CriticComment>, origin?: "document") => {
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
        if (origin === "document") {
          // Parent moves belong to document history. Rebase both comment stacks
          // so older text edits keep their attachment through document Undo.
          const rebase = (entry: CommentHistoryEntry) => {
            const [before, after] = rebaseCommentSnapshots(
              [entry.before, entry.after],
              previous,
              comments,
            );
            return { before, after };
          };
          commentHistory.current.past = commentHistory.current.past.map(rebase);
          commentHistory.current.future =
            commentHistory.current.future.map(rebase);
        } else {
          commentHistory.current.past.push({
            before: previous,
            after: comments,
          });
          commentHistory.current.future = [];
        }
        return { ...current, reviewComments: comments };
      });
    },
    [updateDraft],
  );
  function moveCommentHistory(direction: "past" | "future") {
    const history = commentHistory.current;
    const entry = history[direction].at(-1);
    if (!entry) return;
    updateDraft((current) => {
      const next = restoreCommentHistory(
        current.reviewComments,
        entry,
        direction === "past" ? "undo" : "redo",
      );
      if (!next) {
        setActionError(
          "That comment changed in another page. Its current feedback is preserved; this older comment step cannot be restored safely.",
        );
        return current;
      }
      history[direction].pop();
      history[direction === "past" ? "future" : "past"].push(entry);
      return { ...current, reviewComments: next };
    });
  }
  const [initialClean] = useState(() =>
    initial.draft
      ? (source.cleanMarkdown ?? cleanRevisionMarkdown(source.markdown))
      : measureRevision("initial-source-projection", () =>
          cleanRevisionSourceMarkdown(source.markdown),
        ),
  );
  const exactClean = useRef(initialClean);
  const lastCleanProjection = useRef<{
    canonical: string;
    source: string;
  } | null>(null);
  const canonicalCleanBaseline = useRef<string | null>(null);
  const preserveSource = useRef<ReturnType<
    typeof createSourceSpellingPreserver
  > | null>(null);
  const exactReview = useRef(source.markdown);
  const reviewSpelling = useRef<ReturnType<
    typeof createSourceSpellingPreserver
  > | null>(null);
  const acceptedSpellingProof = useRef(new RevisionSpellingProof());
  const canonicalSpellingProof = useRef(new RevisionCanonicalSpellingProof());
  const reviewSpellingProof = useRef(new RevisionSpellingProof());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preferences, setPreferences] = useRevisionPreferences(session.id);
  const { interaction, formatted, view } = preferences;
  const previewing = view !== "changes";
  const [historyOpen, setHistoryOpen] = useState(false);
  const reopenedPassage = useRef<{
    position: number;
    metadata: boolean;
  } | null>(null);
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
  const {
    containerRef: toolbarContainerRef,
    toolsRef,
    measureRef: measuredToolsRef,
    compact: compactTools,
    visible: visibleTools,
  } = useRevisionToolbar();
  const moreLayoutRef = useRef(visibleTools);
  useEffect(() => {
    if (moreLayoutRef.current !== visibleTools) {
      moreLayoutRef.current = visibleTools;
      setMoreOpen(false);
    }
  }, [visibleTools]);
  const [disk, setDisk] = useState<InspectedDestination | null>(null);
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
        const canonical = serializeRevisionNode(
          next.state.doc,
          comments,
          {
            frontmatter: parsed.frontmatter,
            endmatter: parsed.endmatter,
          },
          uiDraftStore.privateCommentIds(comments),
        );
        reviewSpelling.current = measureRevision("review-spelling-align", () =>
          createSourceSpellingPreserver(exactReview.current, canonical),
        );
        reviewSpellingProof.current.matches(
          exactReview.current,
          publicRevisionNode(
            next.state.doc,
            uiDraftStore.privateCommentIds(comments),
          ),
          next.state,
        );
        const accepted = projectCleanRevisionNode(next.state.doc);
        if (
          !acceptedSpellingProof.current.matches(
            exactClean.current,
            accepted,
            next.state,
          )
        ) {
          // Prepare the existing fallback once while the document opens, so
          // its first plain edit does not validate the complete source again.
          canonicalSpellingProof.current.matches(
            exactClean.current,
            cleanRevisionNode(next.state.doc),
            accepted,
            next.state,
          );
        }
      }
      if (next)
        canonicalCleanBaseline.current ??= cleanRevisionNode(next.state.doc);
      setEditor(next);
    },
    [readDraft, uiDraftStore],
  );

  useEffect(() => {
    if (!editor) return;
    const adapter: RevisionRemoteAdapter = {
      rebasesBufferedDocument: true,
      prepare: (draft, options) =>
        measureRevision("detached-prepare", () =>
          prepareRevisionEditorDraft(draft, editor, options),
        ),
      canRestorePrivateComment: (id, value) => {
        const draft = value as CommentDraftState;
        const root = privateRootTarget(id, draft);
        if (!root || !draft.anchor) return false;
        const existing = uiDraftStore.getSnapshot().comments[id];
        if (
          containsReviewIdentity(editor.state.doc, id) &&
          (!privateRootTarget(id, existing) ||
            !commentDraftMatchesTarget(existing, root) ||
            JSON.stringify(existing.anchor) !== JSON.stringify(draft.anchor))
        )
          return false;
        return Boolean(
          resolvePrivateCommentAnchor(editor.state.doc, draft.anchor),
        );
      },
      apply: (next, options) => {
        const result =
          remoteUpdateRef.current?.(next, {
            ...options,
            currentCleanMarkdown: readDraft().cleanMarkdown,
          }) ?? null;
        if (result) {
          if (options?.idRemap && Object.keys(options.idRemap).length) {
            const remap = (entry: CommentHistoryEntry) =>
              remapCommentHistory(entry, options.idRemap ?? {});
            commentHistory.current.past =
              commentHistory.current.past.map(remap);
            commentHistory.current.future =
              commentHistory.current.future.map(remap);
          }
          exactReview.current = result.markdown;
          exactClean.current = result.cleanMarkdown ?? result.markdown;
          canonicalCleanBaseline.current = cleanRevisionNode(editor.state.doc);
          lastCleanProjection.current = {
            canonical: canonicalCleanBaseline.current,
            source: exactClean.current,
          };
          preserveSource.current = measureRevision(
            "remote-accepted-align",
            () =>
              createSourceSpellingPreserver(
                exactClean.current,
                canonicalCleanBaseline.current as string,
              ),
          );
          const metadata = editor.state.doc.attrs.sourceMetadata;
          reviewSpelling.current = measureRevision("remote-review-align", () =>
            createSourceSpellingPreserver(
              result.markdown,
              serializeRevisionNode(
                editor.state.doc,
                new Map(
                  result.reviewComments.map((comment) => [comment.id, comment]),
                ),
                {
                  frontmatter: metadata?.frontmatter,
                  endmatter: metadata?.endmatter,
                },
                uiDraftStore.privateCommentIds(
                  new Map(
                    result.reviewComments.map((comment) => [
                      comment.id,
                      comment,
                    ]),
                  ),
                ),
              ),
            ),
          );
        }
        return result;
      },
      adopt: (base, markdown, force, diskBase) =>
        measureRevision("disk-adoption", () =>
          adoptRevisionDisk(
            base,
            markdown,
            editor.schema,
            force,
            diskBase,
            editor.state.doc,
          ),
        ),
      adoptAsync: (base, markdown, force, diskBase, compare) =>
        measureRevisionAsync("disk-adoption", () =>
          adoptRevisionDiskAsync(
            base,
            markdown,
            editor.schema,
            force,
            diskBase,
            editor.state.doc,
            compare,
          ),
        ),
      readUiDrafts: uiDraftStore.read,
      restoreUiDrafts: uiDraftStore.restore,
      subscribeUiDrafts: uiDraftStore.subscribe,
      flush: () => markdownFlushRef.current?.(),
    };
    registerAdapter(adapter);
    const blockedHistory = () =>
      setActionError(
        "That older undo step cannot be safely restored after the review IDs changed. Your current work and recovery copy are preserved.",
      );
    window.addEventListener("roughdraft-history-blocked", blockedHistory);
    return () => {
      registerAdapter(null);
      window.removeEventListener("roughdraft-history-blocked", blockedHistory);
    };
  }, [editor, registerAdapter, uiDraftStore, readDraft]);

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
    (markdown: string, origin?: "source") =>
      measureRevision("draft-change", () => {
        setMarkdownQueued(false);
        const editorState = ownEditor.current?.state;
        if (!editorState) return;
        const current = editorState.doc;
        const previous = readDraft();
        const privateIds = uiDraftStore.privateCommentIds(
          new Map(
            previous.reviewComments.map((comment) => [comment.id, comment]),
          ),
        );
        const publicCurrent = publicRevisionNode(current, privateIds);
        const metadata = documentMetadata(markdown);
        const previousMetadata = documentMetadata(exactClean.current);
        const metadataChanged = current.attrs.frontmatterInContent
          ? metadata.endmatter !== previousMetadata.endmatter
          : !sameMetadata(metadata, previousMetadata);
        const canonicalClean = measureRevision("accepted-cache", () =>
          cleanRevisionNode(current),
        );
        const result =
          origin === "source"
            ? cleanSourceFromNode(
                markdown,
                current,
                new Map(previous.reviewComments.map((item) => [item.id, item])),
                privateIds,
              )
            : canonicalClean;
        preserveSource.current ??= measureRevision(
          "accepted-spelling-align",
          () =>
            createSourceSpellingPreserver(
              exactClean.current,
              canonicalCleanBaseline.current ?? canonicalClean,
            ),
        );
        let cleanMarkdown = result;
        const unchangedAccepted =
          origin !== "source" &&
          !metadataChanged &&
          lastCleanProjection.current?.canonical === canonicalClean;
        if (unchangedAccepted && lastCleanProjection.current)
          cleanMarkdown = lastCleanProjection.current.source;
        const preserved =
          origin === "source" || unchangedAccepted
            ? null
            : measureRevision(
                "accepted-spelling",
                () => preserveSource.current?.(canonicalClean) ?? null,
              );
        if (preserved !== null) {
          if (
            preserved === canonicalClean ||
            measureRevision("accepted-parse", () =>
              acceptedSpellingProof.current.matches(
                preserved,
                measureRevision("accepted-model", () =>
                  projectCleanRevisionNode(current),
                ),
                editorState,
              ),
            ) ||
            canonicalSpellingProof.current.matches(
              preserved,
              canonicalClean,
              projectCleanRevisionNode(current),
              editorState,
            )
          )
            cleanMarkdown = preserved;
        }
        if (metadataChanged && origin !== "source")
          cleanMarkdown = withDocumentMetadata(cleanMarkdown, {
            ...metadata,
            // Editable YAML is already projected from the accepted model.
            // Only out-of-tree endmatter may be restored from review source.
            frontmatter: current.attrs.frontmatterInContent
              ? documentMetadata(cleanMarkdown).frontmatter
              : metadata.frontmatter,
          });
        if (origin === "source" || metadataChanged) {
          exactClean.current = cleanMarkdown;
          canonicalCleanBaseline.current = canonicalClean;
          preserveSource.current = null;
        }
        lastCleanProjection.current = {
          canonical: canonicalClean,
          source: cleanMarkdown,
        };
        let reviewMarkdown = markdown;
        if (origin !== "source") {
          const retained = measureRevision("review-spelling", () =>
            reviewSpelling.current?.(markdown),
          );
          if (
            retained != null &&
            (retained === markdown ||
              measureRevision("review-parse", () =>
                reviewSpellingProof.current.matches(
                  retained,
                  publicCurrent,
                  editorState,
                ),
              ))
          )
            reviewMarkdown = retained;
        } else {
          exactReview.current = markdown;
          const sourceMetadata = current.attrs.sourceMetadata;
          const canonicalReview = serializeRevisionNode(
            current,
            new Map(
              readDraft().reviewComments.map((comment) => [
                comment.id,
                comment,
              ]),
            ),
            {
              frontmatter: sourceMetadata?.frontmatter,
              endmatter: sourceMetadata?.endmatter,
            },
            privateIds,
          );
          reviewSpelling.current = createSourceSpellingPreserver(
            markdown,
            canonicalReview,
          );
        }
        updateDraft(
          (previous) => ({
            ...previous,
            markdown: reviewMarkdown,
            cleanMarkdown,
            decisions: Object.fromEntries(
              kept(current).map((id) => [id, "kept"]),
            ),
            reviewed: reviewedChanges(publicCurrent),
          }),
          { readyToSave: origin !== "source" },
        );
        setBlocked(false);
      }),
    [updateDraft, readDraft, uiDraftStore],
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
            keptIds: change ? referenceChangeIds(change) : [changeId],
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
    copyLocked;
  const reviewSurface = useMemo(
    () => ({
      suggestions: visibleChanges,
      disabled: decisionsDisabled,
      activeChangeId: activeChange,
      decisions,
      reviewed: source.reviewed,
      sourceUpdateRef,
      remoteUpdateRef,
      uiDraftStore,
      cleanMarkdown: draft.cleanMarkdown,
      copyLocked,
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
      uiDraftStore,
      draft.cleanMarkdown,
      copyLocked,
      updateComments,
      visibleChanges,
    ],
  );
  const editorDoc = editor?.state.doc;
  const workingSource =
    editorDoc?.attrs.sourceMetadata?.markdown ?? draft.markdown;
  const workingMetadata = useMemo(
    () => documentMetadata(workingSource),
    [workingSource],
  );
  const referenceMetadata = useMemo(
    () => (reference === null ? null : documentMetadata(reference)),
    [reference],
  );
  const metadataPending =
    referenceMetadata !== null &&
    !decisions.includes("document-metadata") &&
    workingMetadata.endmatter !== referenceMetadata.endmatter;
  const metadataOld =
    baseSide === "new"
      ? (referenceMetadata ?? workingMetadata)
      : workingMetadata;
  const metadataNew =
    baseSide === "new"
      ? workingMetadata
      : (referenceMetadata ?? workingMetadata);
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
    !fileWritePending &&
    (!destination || destination === session.savedPath) &&
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

  function revealReopenedPassage() {
    const passage = reopenedPassage.current;
    reopenedPassage.current = null;
    if (!passage || !editor || editor.isDestroyed || !formatted) return;
    const offset = (headerRef.current?.offsetHeight ?? 0) + 16;
    const position = Math.min(passage.position, editor.state.doc.content.size);
    const top = passage.metadata
      ? (documentRef.current
          ?.querySelector<HTMLElement>(
            '[data-review-rail-anchor="document-metadata"]',
          )
          ?.getBoundingClientRect().top ?? 0)
      : editor.view.coordsAtPos(position).top;
    window.scrollTo({
      top: Math.max(0, top + window.scrollY - offset),
      behavior: "instant",
    });
  }

  const reportError = (error: unknown) =>
    setActionError(error instanceof Error ? error.message : String(error));
  async function save() {
    setBusy(true);
    setActionError("");
    try {
      await run("sync", currentDraft());
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
      if (!busy && !sendOpen && !disk && !writePaused) void save();
    };
    document.addEventListener("keydown", onSave);
    return () => document.removeEventListener("keydown", onSave);
  });

  const fileState = liveConflict
    ? "Review update"
    : saved
      ? destination
        ? "Saved to file"
        : "Review saved"
      : session.targetChanged
        ? "File changed"
        : writePaused
          ? "Paused"
          : "Saving…";
  const secondaryTools = (measuring = false, overflow = false) => {
    const show = (index: number) =>
      measuring || (overflow ? index >= visibleTools : index < visibleTools);
    return (
      <>
        {(show(0) || show(1) || show(2)) && (
          <div
            className="revision-tool-group"
            role="group"
            aria-label="Document view"
          >
            {show(0) && (
              <TipButton
                tip={
                  formatted
                    ? "Show full Markdown source, including suggestions and comments. Source editing requires Edit mode."
                    : "Show the formatted document."
                }
                data-testid={measuring ? undefined : "revision-format"}
                data-toolbar-secondary={measuring ? "format" : undefined}
                aria-label={
                  formatted ? "Show Markdown" : "Show formatted document"
                }
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
            )}
            {show(1) && (
              <TipButton
                tip={
                  previewing
                    ? "Copy the visible outcome preview as Markdown."
                    : "Copy Markdown without pending suggestions or comments."
                }
                aria-label="Copy Markdown"
                data-testid={measuring ? undefined : "revision-copy"}
                data-toolbar-secondary={measuring ? "copy" : undefined}
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
            )}
            {show(2) && (
              <TipButton
                tip={
                  previewing
                    ? "Download the visible outcome preview as Markdown."
                    : "Download Markdown without pending suggestions or comments."
                }
                aria-label="Download Markdown"
                data-testid={measuring ? undefined : "revision-download"}
                data-toolbar-secondary={measuring ? "download" : undefined}
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
            )}
          </div>
        )}
        {show(3) && (
          <TipButton
            tip="Inspect reviewed changes and reopen a decision."
            aria-label="History"
            data-testid={measuring ? undefined : "revision-reviewed"}
            data-toolbar-secondary={measuring ? "history" : undefined}
            variant="ghost"
            disabled={!reviewed.length}
            onClick={() => {
              setMoreOpen(false);
              setHistoryOpen(true);
            }}
          >
            History{reviewed.length ? ` (${reviewed.length})` : ""}
          </TipButton>
        )}
        {buttonHandoff && show(4) && (
          <div
            className="revision-tool-group"
            aria-label="Send feedback"
            role="group"
          >
            <TipButton
              tip="Send a snapshot and comments to the agent. This does not write a file."
              data-testid={measuring ? undefined : "revision-send"}
              data-toolbar-secondary={measuring ? "send" : undefined}
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
  };
  const conflictBanner = liveConflict && (
    <RevisionConflictBanner
      conflict={liveConflict}
      local={draft}
      disabled={copyLocked}
      viewLabel={
        previewing ? (view === "accepted" ? "Final" : "Original") : undefined
      }
      onResolve={resolveConflict}
      onSaveSeparately={() => {
        setAttentionOpen(false);
        setCopyOpen(true);
      }}
      onRetry={retrySync}
      onReload={reloadFromFile}
      onRecover={recoverPublication}
      onRecreate={recreateFile}
      onInspect={
        destination
          ? () => {
              setAttentionOpen(false);
              void inspect().then(setDisk, reportError);
            }
          : undefined
      }
    />
  );
  return (
    <RevisionUiDraftContext.Provider value={uiDraftStore}>
      <TooltipProvider delay={300}>
        <header
          className="revision-header comparison-header-bar"
          ref={headerRef}
          data-testid="revision-header"
        >
          <div
            className="revision-header-inner"
            ref={toolbarContainerRef}
            data-compact-tools={compactTools}
            data-visible-tools={visibleTools}
          >
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
              <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
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
                  <Button
                    className="mt-3 min-h-11"
                    variant="outline"
                    data-testid="revision-recovery-copies"
                    onClick={() => {
                      setDetailsOpen(false);
                      setRecoveryOpen(true);
                    }}
                  >
                    Recovery copies
                    {session.recoveryCheckpoints?.length
                      ? ` (${session.recoveryCheckpoints.length})`
                      : ""}
                  </Button>
                </PopoverContent>
              </Popover>
              {liveConflict ? (
                <Button
                  className="min-h-11 shrink-0"
                  variant="outline"
                  data-testid="revision-update-attention"
                  aria-haspopup="dialog"
                  aria-expanded={attentionOpen}
                  onClick={() => setAttentionOpen(true)}
                >
                  <span
                    role="status"
                    data-testid="revision-file-status"
                    aria-label={fileState}
                  >
                    Review update
                  </span>
                </Button>
              ) : (
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
              )}
            </div>
            <div className="revision-tools" ref={toolsRef}>
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
                  data-toolbar-primary
                  data-testid="revision-mode"
                  aria-label="Editing mode"
                  className="revision-mode-select"
                  disabled={previewing}
                  title={
                    blocked
                      ? "This edit could not be recorded as a suggestion. Try again, or use Edit."
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
                  data-toolbar-primary
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
                data-toolbar-primary
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
                    copyLocked ||
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
                    copyLocked ||
                    redoDepth(editor.state) === 0
                  }
                  onClick={() => editor?.commands.redo()}
                >
                  <Redo2 />
                </TipButton>
              </div>
              <div
                data-toolbar-primary
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
                  if (event.repeat || deciding(id, decision === "accept"))
                    return;
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
              {secondaryTools()}
              {compactTools && (
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
                    {secondaryTools(false, true)}
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <div className="revision-toolbar-measure" aria-hidden="true" inert>
              <div
                className="revision-tools revision-measured-tools"
                ref={measuredToolsRef}
              >
                <div className="revision-tool-group" />
                {secondaryTools(true)}
                <Button variant="outline" data-toolbar-overflow>
                  <MoreHorizontal />
                  More
                </Button>
              </div>
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
          {browserRecoveryWarning && (
            <p
              role="status"
              className="comparison-conflict text-sm"
              data-testid="revision-browser-recovery-warning"
            >
              {browserRecoveryWarning}
            </p>
          )}
          {!attentionOpen && conflictBanner}
          {session.fileObservationWarning && (
            <p
              role="status"
              className="comparison-conflict text-sm"
              data-testid="revision-file-observation-warning"
            >
              {session.fileObservationWarning}
            </p>
          )}
          {syncNotice && (
            <div role="status" className="comparison-error">
              {syncNotice}
              {syncNotice.includes("Recovery copies") && (
                <Button
                  className="ml-2 min-h-11"
                  variant="outline"
                  onClick={() => setRecoveryOpen(true)}
                >
                  Recovery copies
                </Button>
              )}
            </div>
          )}
          {orphans.length > 0 && (
            <section className="comparison-conflict">
              <p>
                This work may still be open in another tab. A quiet tab has
                recoverable edits.
              </p>
              <Button
                className="min-h-11"
                variant="outline"
                onClick={() => setRecoveryOpen(true)}
                data-testid="revision-browser-recovery-inspect"
              >
                Inspect recoverable work
              </Button>
            </section>
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
                  <p>Document endmatter changed between these versions.</p>
                  <div className="revision-metadata-versions">
                    <div>
                      <strong>Before</strong>
                      <pre>
                        {[metadataOld.endmatter].filter(Boolean).join("\n") ||
                          "No metadata"}
                      </pre>
                    </div>
                    <div>
                      <strong>After</strong>
                      <pre>
                        {[metadataNew.endmatter].filter(Boolean).join("\n") ||
                          "No metadata"}
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
                  {view === "accepted" ? "Final" : "Original"} · Read-only
                  preview
                </p>
                {preview?.error && <p role="alert">{preview.error}</p>}
                {reviewed.some((change) => change.stale) && (
                  <p className="revision-preview-label">
                    Some older decisions cannot be replayed because their
                    passages changed.
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
                        onCompositionEnd={() => {
                          if (liveConflict?.kind === "waiting")
                            void retrySync().catch(reportError);
                        }}
                        readOnly={
                          previewing || interaction !== "editing" || copyLocked
                        }
                        onChange={(next) => {
                          if (!previewing && interaction === "editing")
                            sourceUpdateRef.current?.(
                              next,
                              readDraft().markdown,
                            );
                        }}
                      />
                      {interaction === "suggesting" && (
                        <p className="text-sm text-muted-foreground">
                          Switch to Edit to change Markdown source. Suggest in
                          the formatted document.
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
          <RevisionOutdatedFeedback draft={draft} />
        </main>
        <Dialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          onOpenChangeComplete={(open) => {
            if (!open) revealReopenedPassage();
          }}
        >
          <DialogContent
            className="max-w-2xl"
            data-testid="revision-reviewed-dialog"
          >
            <DialogTitle>History</DialogTitle>
            <DialogDescription>
              Inspect previous decisions. Reopen a change to review it again;
              unrelated edits stay in place.
            </DialogDescription>
            <div className="revision-reviewed-list">
              {reviewed.map((change) => (
                <section
                  key={change.id}
                  className="revision-reviewed-item"
                  data-testid="revision-reviewed-entry"
                >
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
                      This passage was edited after the decision. Reopening
                      would overwrite those edits.
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
                      reopenedPassage.current = {
                        position: transaction.mapping.map(
                          change.guard.from,
                          -1,
                        ),
                        metadata: Boolean(change.metadata),
                      };
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
          {copied
            ? "Markdown copied."
            : session.feedback
              ? "Feedback sent."
              : ""}
        </div>
        <RevisionSaveCopyDialog
          open={copyOpen}
          onOpenChange={setCopyOpen}
          inspect={inspectCopy}
          save={saveCopy}
          unlock={() => setCopyLocked(false)}
          checkStatus={checkCopyStatus}
          onSavedResultShown={acknowledgeCopyResult}
          viewLabel={
            previewing
              ? view === "accepted"
                ? "Final"
                : "Original"
              : undefined
          }
        />
        <Dialog
          open={Boolean(attentionOpen && liveConflict)}
          onOpenChange={setAttentionOpen}
        >
          <DialogContent
            data-testid="revision-update-dialog"
            className="max-w-4xl"
          >
            <DialogTitle>Review update</DialogTitle>
            <DialogDescription>
              Inspect the waiting update and choose what to keep. Your working
              draft and unfinished feedback stay here.
            </DialogDescription>
            {attentionOpen && conflictBanner}
          </DialogContent>
        </Dialog>
        <RevisionRecoveryDialog
          open={recoveryOpen}
          onOpenChange={setRecoveryOpen}
          copies={session.recoveryCheckpoints ?? []}
          orphans={orphans}
          onInspect={inspectRecovery}
          onInspectOrphan={inspectOrphan}
          onClaimOrphan={restoreOrphan}
          onDismissOrphan={dismissOrphan}
          onRestore={restoreRecoveryUi}
        />
      </TooltipProvider>
    </RevisionUiDraftContext.Provider>
  );
}
