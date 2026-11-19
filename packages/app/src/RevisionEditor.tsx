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
  preserveSourceSpelling,
} from "./revision-markdown";
import {
  type ReferenceChange,
  referenceChanges,
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
  mode: DocumentInteractionMode,
  beforeBackend: ApiBackend,
) {
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (!editor || markdown === null) return;
    const parsed = criticMarkdownToEditorState(markdown, {
      resolveFileUrl: (filename) => beforeBackend.resolveFileUrl(filename),
    });
    const reference = editor.schema.nodeFromJSON(acceptedDocument(parsed.doc));
    editor.registerPlugin(
      new Plugin({
        key: referenceKey,
        state: {
          init: (_, state) => referenceChanges(reference, state.doc),
          apply: (transaction, previous) =>
            transaction.docChanged &&
            !transaction.before.content.eq(transaction.doc.content)
              ? referenceChanges(reference, transaction.doc)
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
            const choices = new Set(kept(state.doc));
            const changes = (referenceKey.getState(state) ?? noChanges).filter(
              (change) => !choices.has(change.item.changeId),
            );
            if (!changes.length) return DecorationSet.empty;
            const highlighted = criticChangeHighlightPluginKey.getState(state);
            return referenceDecorations(state.doc, changes, {
              activeId: highlighted?.selectedChangeId,
              hoveredId: highlighted?.hoveredChangeId,
            });
          },
        },
      }),
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(referenceKey);
    };
  }, [editor, markdown, beforeBackend]);
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
  const reference = initial.mode === "document" ? null : initial.beforeText;
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
    run,
    inspect,
    recoveryError,
    recoveryPending,
  } = useRevisionSession(initial, seed);
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
  const exactCanonical = useRef<string | null>(null);
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
  const sourcePath = initial.afterLabel.startsWith("/")
    ? initial.afterLabel
    : (initial.targetPath ?? "");
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
  const beforeBackend = useMemo(
    () =>
      new ApiBackend({
        kind: "local-files",
        label: "Local files",
        detail: initial.beforeLabel,
        projectPath:
          documentProject(initial.beforeLabel) ?? documentProject(sourcePath),
      }),
    [initial.beforeLabel, sourcePath],
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
  useReference(editor, reference, interaction, beforeBackend);

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
      const current = ownEditor.current?.state.doc;
      if (!current) return;
      const result = cleanRevisionMarkdown(markdown);
      exactCanonical.current ??= canonical(exactClean.current);
      const requested = canonical(result);
      const preserved = preserveSourceSpelling(
        exactClean.current,
        exactCanonical.current,
        requested,
      );
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

  const deciding = useCallback((changeId: string, keep: boolean) => {
    const live = ownEditor.current;
    if (!live) return false;
    const change = referenceKey
      .getState(live.state)
      ?.find((item) => item.item.changeId === changeId);
    if (!change) return false;
    const transaction = keep
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
  }, []);

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
      comments: commentMap,
      onCommentsChange: updateComments,
      onAccept: (id: string) => deciding(id, true),
      onReject: (id: string) => deciding(id, false),
      onBlockedSuggestionEdit: () => setBlocked(true),
    }),
    [commentMap, deciding, decisions, updateComments, visibleChanges],
  );
  const positions = new Map<string, number>();
  for (const change of renderedChanges) {
    const id = change.item.changeId;
    if (!change.overlapsSuggestion && !decisions.includes(id))
      positions.set(id, change.from);
  }
  editor?.state.doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      if (mark.type.name !== "criticChange") continue;
      const id = mark.attrs.changeId;
      if (!positions.has(id)) positions.set(id, pos);
    }
  });
  const navigation = [...positions.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
  const count = navigation.length;
  const markdown = draft.cleanMarkdown ?? draft.markdown;
  const saved =
    destination !== null &&
    destination === session.savedPath &&
    markdown === session.savedText &&
    !conflict &&
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
      [
        ...(documentRef.current?.querySelectorAll<HTMLElement>(
          '[data-suggestion-thread-container="true"]',
        ) ?? []),
      ].find((item) => item.dataset.testid === `suggestion-thread-${id}`);
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
    setActionError("");
    setSavePath(destination ?? sourcePath);
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
      await run(
        "save",
        draft,
        output && { path: output.path, expectedVersion: output.version },
      );
      setConflict(false);
      setSaveAs(false);
    } catch (error) {
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
      if (output.version === null) await save(output);
      else setReplace(output);
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
      await run("send", draft, { comment: comment.trim() });
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
      if (!busy && !saveAs && !sendOpen && !disk) void save();
    };
    document.addEventListener("keydown", onSave);
    return () => document.removeEventListener("keydown", onSave);
  });

  const fileState = saved
    ? "Saved"
    : conflict || session.targetChanged
      ? "File changed"
      : destination
        ? "Unsaved"
        : "Draft";
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
              {destination ??
                (initial.mode === "compare" && sourcePath
                  ? `Draft from ${sourcePath}`
                  : "Untitled")}
            </h1>
            {reference !== null && (
              <span>Comparing with {initial.beforeLabel}</span>
            )}
          </div>
          <div className="revision-tools">
            <div
              className="revision-tool-group"
              aria-label="Editing mode"
              role="group"
            >
              <TipButton
                tip="Apply typing to the draft immediately."
                data-testid="revision-edit"
                variant={interaction === "editing" ? "secondary" : "ghost"}
                aria-pressed={interaction === "editing"}
                onClick={() => {
                  setInteraction("editing");
                  setBlocked(false);
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
                onClick={() =>
                  void copyRevisionMarkdown(markdown).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1400);
                  }, reportError)
                }
              >
                {copied ? <Check /> : <Copy />}
              </TipButton>
              <TipButton
                tip="Download the Markdown that Save would write."
                aria-label="Download Markdown"
                data-testid="revision-download"
                variant="ghost"
                size="icon"
                onClick={() => downloadRevisionMarkdown(markdown, filename)}
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
                    ? "Saving recovery draft. The file is unchanged."
                    : "File status. Recovery drafts are saved separately."
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
                disabled={busy}
                onClick={() => {
                  setActionError("");
                  setSendOpen(true);
                }}
              >
                Send feedback
              </TipButton>
              <TipButton
                tip="Choose where to save the current Markdown."
                data-testid="revision-save-as"
                variant="ghost"
                disabled={busy}
                onClick={showSaveAs}
              >
                Save As
              </TipButton>
              <TipButton
                tip="Write the current Markdown. Review choices stay as they are."
                data-testid="revision-save"
                disabled={busy || saved || conflict || session.targetChanged}
                onClick={() => void save()}
              >
                Save
              </TipButton>
            </div>
          </div>
        </div>
      </header>
      <main
        className="revision-page comparison-page"
        data-testid="revision-page"
      >
        {(recoveryError || (actionError && !saveAs && !sendOpen)) && (
          <p
            role="alert"
            className="comparison-error"
            data-testid="revision-error"
          >
            {actionError || recoveryError}
          </p>
        )}
        {(conflict || session.targetChanged) && (
          <div className="comparison-conflict" data-testid="revision-conflict">
            <strong>The destination changed on disk.</strong>{" "}
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
              page={page}
              activeDocumentPath={sourcePath ? pathLeaf(sourcePath) : null}
              selected
              layout="default"
              focusRequestKey={null}
              sourceMarkdown={source.markdown}
              onMarkdownChange={changeMarkdown}
              interactionMode={interaction}
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
        open={saveAs}
        onOpenChange={(open) => {
          if (!busy) setSaveAs(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Save As</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the Markdown file to write.
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
