import type { Editor } from "@tiptap/react";
import { Check, Reply, X } from "lucide-react";
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CommentActionDefinition,
  type CommentActionsRenderContext,
  type CommentContentRenderContext,
  CommentEditorList,
} from "./CommentEditorList";
import type {
  CriticChangeAttrs,
  CriticChangeKind,
  CriticComment,
} from "./critic-markup";
import {
  buildCommentThreadRailItems,
  type CommentGroupAnchor,
  type CommentThreadRailItem,
  getPreferredCommentId,
  getRootThreadIdForCommentId,
  normalizeCommentMeasurement,
  resolveAnchoredRailLayouts,
} from "./document-comments";
import { SUGGESTED_PARAGRAPH_SENTINEL } from "./editor-extensions";
import { cn } from "./lib/utils";
import type { DraftSuggestionState } from "./PageCard";
import { reviewShortcutKeys, reviewShortcutLabel } from "./review-decisions";

const SUGGESTION_QUOTE_PREVIEW_LIMIT = 140;
const WINDOWED_RAIL_THRESHOLD = 60;
const RAIL_WINDOW_STEP = 200;
const RAIL_OVERSCAN = 600;

// Large reviews can have thousands of word-level changes. Keep their positions
// in the layout, but mount editors and action controls only near the viewport.
function useReviewRailWindow(enabled: boolean) {
  const railRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ top: -RAIL_OVERSCAN, bottom: 1600 });
  useLayoutEffect(() => {
    if (!enabled || !railRef.current) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rail = railRef.current;
      if (!rail) return;
      const offset = -rail.getBoundingClientRect().top;
      const top = Math.floor(offset / RAIL_WINDOW_STEP) * RAIL_WINDOW_STEP;
      const bottom =
        Math.ceil((offset + window.innerHeight) / RAIL_WINDOW_STEP) *
        RAIL_WINDOW_STEP;
      setRange((current) =>
        current.top === top - RAIL_OVERSCAN &&
        current.bottom === bottom + RAIL_OVERSCAN
          ? current
          : { top: top - RAIL_OVERSCAN, bottom: bottom + RAIL_OVERSCAN },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(railRef.current);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [enabled]);
  return { railRef, range };
}

export interface CriticChangeRailItem {
  changeId: string;
  change: CriticChangeAttrs;
  kind: CriticChangeKind;
  oldText: string;
  newText: string;
  commentIds: string[];
  anchorTop: number;
  anchorBottom: number;
  sourceChangeCount?: number;
  reviewStatus?: string;
}

interface DocumentReviewRailProps {
  commentGroups: CommentGroupAnchor[];
  comments: Map<string, CriticComment>;
  suggestions: CriticChangeRailItem[];
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
  selectedChangeId: string | null;
  hoveredChangeId: string | null;
  contentHeight: number;
  className?: string;
  layout?: "anchored" | "flow";
  testId?: string;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  autosaveComments?: boolean;
  onReplyComment: (commentId: string) => void;
  onSelectComment: (commentId: string) => void;
  onFocusComment: (commentId: string) => void;
  onHoverComment: (commentId: string | null) => void;
  onAcceptSuggestion: (changeId: string) => void;
  onRejectSuggestion: (changeId: string) => void;
  onReplySuggestion: (changeId: string) => void;
  onSelectSuggestion: (changeId: string) => void;
  onFocusSuggestion: (changeId: string) => void;
  onHoverSuggestion: (changeId: string | null) => void;
  pendingFocusCommentId?: string | null;
  newCommentDraftIds?: string[];
  onAutoFocusComment?: (commentId: string) => void;
  draftSuggestion?: DraftSuggestionState | null;
  onDraftSuggestionTextChange?: (text: string) => void;
  onApplyDraftSuggestion?: () => void;
  onCancelDraftSuggestion?: () => void;
  editor?: Editor | null;
  reviewControls?: {
    canDecide: boolean;
    disabled: boolean;
    acceptLabel: string | ((id: string) => string);
    rejectLabel: string | ((id: string) => string);
    allowDeleteThread?: boolean;
  };
}

function railLayoutItemClass(layout: "anchored" | "flow") {
  return cn(
    "left-0 right-0 rounded-xl border border-transparent bg-transparent shadow-none transition-all duration-200 ease-out will-change-transform",
    layout === "anchored" ? "absolute" : "relative",
  );
}

function railLayoutItemStyle(
  layout: "anchored" | "flow",
  railTop: number,
): CSSProperties | undefined {
  return layout === "anchored" ? { top: railTop } : undefined;
}

const OffscreenReviewCard = memo(function OffscreenReviewCard({
  anchor,
  layout,
  top,
  height,
}: {
  anchor?: string;
  layout: "anchored" | "flow";
  top: number;
  height: number;
}) {
  return (
    <div
      aria-hidden="true"
      data-review-rail-anchor={anchor}
      className={
        layout === "anchored"
          ? "absolute inset-x-0 pointer-events-none"
          : undefined
      }
      style={{ ...railLayoutItemStyle(layout, top), height }}
    />
  );
});

function getSuggestionPreview(suggestion: CriticChangeRailItem) {
  const oldText = suggestion.oldText.trim();
  const newText = suggestion.newText.trim();

  if (suggestion.kind === "addition") return newText || "Inserted text";
  if (suggestion.kind === "deletion") return oldText || "Deleted text";
  if (oldText && newText) return `${oldText} -> ${newText}`;
  return oldText || newText || "Changed text";
}

function getSuggestionRootComment(
  suggestion: CriticChangeRailItem,
): CriticComment {
  return {
    id: suggestion.changeId,
    content: getSuggestionPreview(suggestion),
    createdAt: suggestion.change.createdAt,
    authorType: suggestion.change.authorType,
    authorId: suggestion.change.authorId,
  };
}

function truncateSuggestionQuote(text: string) {
  if (text.length <= SUGGESTION_QUOTE_PREVIEW_LIMIT) return text;
  return `${text.slice(0, SUGGESTION_QUOTE_PREVIEW_LIMIT)}...`;
}

function renderQuotedSuggestionText(text: string, fallback: string) {
  const withoutParagraphSentinels = text.replaceAll(
    SUGGESTED_PARAGRAPH_SENTINEL,
    "",
  );
  const fullDisplayText =
    withoutParagraphSentinels.trim() ||
    (text.includes(SUGGESTED_PARAGRAPH_SENTINEL)
      ? "Inserted paragraph"
      : fallback);
  const displayText = truncateSuggestionQuote(fullDisplayText);

  return (
    <span className="italic text-slate-600 dark:text-slate-400">
      "{displayText}"
    </span>
  );
}

function SuggestionCommentContent({
  suggestion,
}: {
  suggestion: CriticChangeRailItem;
}) {
  const oldText = suggestion.oldText.trim();
  const newText = suggestion.newText.trim();

  if (suggestion.kind === "addition") {
    return (
      <>
        <span className="font-semibold text-slate-800 dark:text-slate-200">
          Insert:
        </span>{" "}
        {renderQuotedSuggestionText(newText, "Inserted text")}
      </>
    );
  }

  if (suggestion.kind === "deletion") {
    return (
      <>
        <span className="font-semibold text-slate-800 dark:text-slate-200">
          Delete:
        </span>{" "}
        {renderQuotedSuggestionText(oldText, "Deleted text")}
      </>
    );
  }

  return (
    <>
      <span className="font-semibold text-slate-800 dark:text-slate-200">
        Replace:
      </span>{" "}
      {renderQuotedSuggestionText(oldText, "Original text")}{" "}
      <span className="text-slate-500 dark:text-slate-400">with</span>{" "}
      {renderQuotedSuggestionText(newText, "Changed text")}
    </>
  );
}

export function DocumentReviewRail({
  commentGroups,
  comments,
  suggestions,
  selectedCommentId,
  hoveredCommentId,
  selectedChangeId,
  hoveredChangeId,
  contentHeight,
  className,
  layout: railLayout = "anchored",
  testId,
  onDeleteComment,
  onUpdateComment,
  autosaveComments = false,
  onReplyComment,
  onSelectComment,
  onFocusComment,
  onHoverComment,
  onAcceptSuggestion,
  onRejectSuggestion,
  onReplySuggestion,
  onSelectSuggestion,
  onFocusSuggestion,
  onHoverSuggestion,
  pendingFocusCommentId = null,
  newCommentDraftIds = [],
  onAutoFocusComment,
  draftSuggestion = null,
  onDraftSuggestionTextChange,
  onApplyDraftSuggestion,
  onCancelDraftSuggestion,
  editor = null,
  reviewControls,
}: DocumentReviewRailProps) {
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const resizeRef = useRef<ResizeObserver | null>(null);
  const keysByElement = useRef(new WeakMap<Element, string>());
  const focusedKey = useRef<string | null>(null);
  const [itemHeights, setItemHeights] = useState<Record<string, number>>({});

  const activeRootThreadId = useMemo(
    () => getRootThreadIdForCommentId(selectedCommentId, comments),
    [comments, selectedCommentId],
  );

  const suggestionCommentIds = useMemo(
    () => new Set(suggestions.flatMap((suggestion) => suggestion.commentIds)),
    [suggestions],
  );

  const visibleCommentThreads = useMemo(
    () =>
      buildCommentThreadRailItems(
        commentGroups
          .map((group) => ({
            ...group,
            commentIds: group.commentIds.filter(
              (commentId) => !suggestionCommentIds.has(commentId),
            ),
          }))
          .filter((group) => group.commentIds.length > 0),
        comments,
      )
        .map((item) => {
          const visibleComments = item.commentIds
            .map((commentId) => comments.get(commentId))
            .filter((comment): comment is CriticComment => Boolean(comment));

          if (visibleComments.length === 0) return null;

          return {
            ...item,
            visibleComments,
          };
        })
        .filter(
          (
            item,
          ): item is CommentThreadRailItem & {
            visibleComments: CriticComment[];
          } => Boolean(item),
        ),
    [commentGroups, comments, suggestionCommentIds],
  );

  const commentEntries = useMemo(
    () =>
      visibleCommentThreads.map((thread) => ({
        type: "comment" as const,
        key: thread.key,
        anchorTop: thread.anchorTop,
        anchorBottom: thread.anchorBottom,
        thread,
      })),
    [visibleCommentThreads],
  );

  const suggestionEntries = useMemo(
    () =>
      suggestions.map((suggestion) => ({
        type: "suggestion" as const,
        key: suggestion.changeId,
        anchorTop: suggestion.anchorTop,
        anchorBottom: suggestion.anchorBottom,
        suggestion,
      })),
    [suggestions],
  );

  const draftAnchorTop = useMemo(() => {
    if (!draftSuggestion || !editor) return 0;
    try {
      const editorElement = editor.view.dom as HTMLElement;
      const editorRect = editorElement.getBoundingClientRect();
      const coords = editor.view.coordsAtPos(draftSuggestion.from);
      return coords.top - editorRect.top;
    } catch {
      return 0;
    }
  }, [draftSuggestion, editor]);

  const draftEntry = useMemo(() => {
    if (!draftSuggestion) return null;
    return {
      type: "draft" as const,
      key: "__draft_suggestion__",
      anchorTop: draftAnchorTop,
      anchorBottom: draftAnchorTop + 20,
    };
  }, [draftSuggestion, draftAnchorTop]);

  const activeSuggestionIdForComment = useMemo(
    () =>
      selectedCommentId
        ? (suggestions.find((suggestion) =>
            suggestion.commentIds.includes(selectedCommentId),
          )?.changeId ?? null)
        : null,
    [selectedCommentId, suggestions],
  );

  const activeKey =
    draftEntry?.key ??
    selectedChangeId ??
    activeSuggestionIdForComment ??
    activeRootThreadId;
  const layouts = useMemo(() => {
    const entries = [
      ...suggestionEntries,
      ...commentEntries,
      ...(draftEntry ? [draftEntry] : []),
    ].sort((left, right) => left.anchorTop - right.anchorTop);
    if (railLayout !== "flow")
      return resolveAnchoredRailLayouts(entries, itemHeights, activeKey);
    // Match the CSS grid's gap so an unmounted card occupies the same space.
    let top = 0;
    return entries.map((entry) => {
      const height = itemHeights[entry.key] ?? 120;
      const railTop = top;
      const railBottom = top + height;
      top = railBottom + 12;
      return { ...entry, railTop, railBottom, height };
    });
  }, [
    activeKey,
    commentEntries,
    draftEntry,
    itemHeights,
    railLayout,
    suggestionEntries,
  ]);

  const windowed = layouts.length >= WINDOWED_RAIL_THRESHOLD;
  const { railRef, range } = useReviewRailWindow(windowed);

  const setItemRef = useCallback((key: string, node: HTMLDivElement | null) => {
    const previous = itemRefs.current.get(key);
    if (previous === node) return;
    if (previous) {
      resizeRef.current?.unobserve(previous);
      itemRefs.current.delete(key);
    }
    if (node) {
      itemRefs.current.set(key, node);
      keysByElement.current.set(node, key);
      resizeRef.current?.observe(node, { box: "border-box" });
    }
  }, []);

  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const sizes = new Map<string, number>();
      for (const entry of entries) {
        const key = keysByElement.current.get(entry.target);
        const size = entry.borderBoxSize[0]?.blockSize;
        if (
          key === undefined ||
          itemRefs.current.get(key) !== entry.target ||
          !size
        )
          continue;
        sizes.set(key, Math.ceil(normalizeCommentMeasurement(size, 1)));
      }
      if (!sizes.size) return;
      setItemHeights((current) => {
        let next = current;
        for (const [key, height] of sizes) {
          if (current[key] === height) continue;
          if (next === current) next = { ...current };
          next[key] = height;
        }
        return next;
      });
    });
    resizeRef.current = observer;
    for (const element of itemRefs.current.values())
      observer.observe(element, { box: "border-box" });
    return () => {
      resizeRef.current = null;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (draftSuggestion && draftTextareaRef.current) {
      draftTextareaRef.current.focus();
    }
  }, [draftSuggestion]);

  const railHeight =
    railLayout === "flow"
      ? undefined
      : Math.max(contentHeight, layouts.at(-1)?.railBottom ?? 0) + 24;

  const hasDraftOnly = layouts.length === 0 && !draftSuggestion;
  if (hasDraftOnly) {
    return <aside className={cn("min-w-0", className)} aria-hidden="true" />;
  }

  return (
    <aside className={cn("min-w-0", className)} data-testid={testId}>
      <div
        ref={railRef}
        className={
          railLayout === "flow" ? "grid gap-3" : "relative [contain:layout]"
        }
        style={railHeight ? { minHeight: railHeight } : undefined}
        onFocus={(event) => {
          focusedKey.current =
            event.target.closest<HTMLElement>("[data-review-rail-key]")?.dataset
              .reviewRailKey ?? null;
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            focusedKey.current = null;
        }}
      >
        {layouts.map((layout) => {
          if (
            windowed &&
            layout.key !== focusedKey.current &&
            layout.key !== activeKey &&
            layout.type !== "draft" &&
            (layout.railBottom < range.top || layout.railTop > range.bottom) &&
            !(
              pendingFocusCommentId &&
              (layout.type === "comment"
                ? layout.thread.commentIds
                : layout.suggestion.commentIds
              ).includes(pendingFocusCommentId)
            )
          ) {
            return (
              <OffscreenReviewCard
                key={layout.key}
                anchor={layout.type === "suggestion" ? layout.key : undefined}
                layout={railLayout}
                top={layout.railTop}
                height={layout.height}
              />
            );
          }
          if (layout.type === "comment") {
            const isSelected =
              !!activeRootThreadId &&
              layout.thread.rootCommentId === activeRootThreadId;
            const isExpanded = isSelected;
            const primaryCommentId =
              getPreferredCommentId(
                layout.thread.commentIds,
                selectedCommentId,
              ) ?? layout.thread.visibleComments[0]?.id;

            return (
              <div
                key={layout.key}
                ref={(node) => setItemRef(layout.key, node)}
                data-review-rail-key={layout.key}
                data-testid={`comment-thread-${layout.thread.rootCommentId}`}
                data-comment-thread-container="true"
                className={cn(
                  railLayoutItemClass(railLayout),
                  isSelected
                    ? "border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
                    : "",
                  isSelected && "-translate-x-2",
                  isExpanded ? "cursor-default" : "cursor-pointer",
                )}
                style={railLayoutItemStyle(railLayout, layout.railTop)}
                onMouseEnter={() => {
                  if (primaryCommentId) {
                    onHoverComment(primaryCommentId);
                  }
                }}
                onMouseLeave={() => onHoverComment(null)}
                onClick={() => {
                  if (isExpanded || !primaryCommentId) return;
                  onFocusComment(primaryCommentId);
                }}
              >
                <CommentEditorList
                  autosave={autosaveComments}
                  comments={layout.thread.visibleComments}
                  variant="rail"
                  className={cn(!isExpanded && "pointer-events-none")}
                  interactive={isExpanded}
                  readOnly={reviewControls?.disabled}
                  selectedCommentId={selectedCommentId}
                  hoveredCommentId={hoveredCommentId}
                  onDeleteComment={onDeleteComment}
                  onUpdateComment={onUpdateComment}
                  onReplyComment={onReplyComment}
                  onSelectComment={onSelectComment}
                  onFocusComment={onFocusComment}
                  onHoverComment={onHoverComment}
                  pendingFocusCommentId={pendingFocusCommentId}
                  newCommentDraftIds={newCommentDraftIds}
                  onAutoFocusComment={onAutoFocusComment}
                />
              </div>
            );
          }

          if (layout.type === "draft") {
            return (
              <div
                key={layout.key}
                ref={(node) => setItemRef(layout.key, node)}
                data-review-rail-key={layout.key}
                data-testid="draft-suggestion-thread"
                data-suggestion-thread-container="true"
                className={cn(
                  railLayoutItemClass(railLayout),
                  "-translate-x-2 border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card px-4 py-3 shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]",
                )}
                style={railLayoutItemStyle(railLayout, layout.railTop)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-stone-500 dark:text-stone-400 uppercase">
                      {draftSuggestion?.type === "replacement"
                        ? "Replacement"
                        : "Insertion"}
                    </div>
                    <div className="mt-1 text-sm leading-5 text-slate-700 dark:text-slate-300">
                      {draftSuggestion?.sourceText || "Current cursor position"}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="draft-suggestion-action-dismiss"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-stone-500 dark:text-stone-400 transition hover:bg-stone-100 dark:hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:focus-visible:ring-slate-600"
                    aria-label="Cancel suggestion"
                    onClick={() => onCancelDraftSuggestion?.()}
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <textarea
                  ref={draftTextareaRef}
                  data-testid="draft-suggestion-editor"
                  value={draftSuggestion?.text ?? ""}
                  rows={2}
                  className="mt-3 min-h-16 w-full resize-y rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm leading-6 text-slate-800 dark:text-slate-200 outline-none transition focus:border-emerald-300 dark:focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-900"
                  placeholder={
                    draftSuggestion?.type === "replacement"
                      ? "Replacement text"
                      : "Inserted text"
                  }
                  onChange={(event) => {
                    onDraftSuggestionTextChange?.(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key.toLowerCase() === "enter"
                    ) {
                      event.preventDefault();
                      onApplyDraftSuggestion?.();
                    }
                  }}
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    data-testid="draft-suggestion-action-cancel"
                    className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm font-medium text-stone-600 dark:text-stone-400 transition hover:bg-stone-100 dark:hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:focus-visible:ring-slate-600"
                    onClick={() => onCancelDraftSuggestion?.()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="draft-suggestion-action-apply"
                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 dark:bg-emerald-700 px-3 text-sm font-medium text-white transition hover:bg-emerald-700 dark:hover:bg-emerald-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 dark:focus-visible:ring-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!draftSuggestion?.text}
                    onClick={() => onApplyDraftSuggestion?.()}
                  >
                    <Check className="size-4" />
                    Suggest
                  </button>
                </div>
              </div>
            );
          }

          const suggestion = layout.suggestion;
          const isSelected = selectedChangeId === suggestion.changeId;
          const isHovered = hoveredChangeId === suggestion.changeId;
          const suggestionComments = suggestion.commentIds
            .map((commentId) => comments.get(commentId))
            .filter((comment): comment is CriticComment => Boolean(comment));
          const suggestionCommentIds = new Set(
            suggestionComments.map((comment) => comment.id),
          );
          const normalizedSuggestionComments = suggestionComments.map(
            (comment) =>
              comment.parentCommentId === suggestion.changeId ||
              (comment.parentCommentId &&
                suggestionCommentIds.has(comment.parentCommentId))
                ? comment
                : {
                    ...comment,
                    parentCommentId: suggestion.changeId,
                  },
          );
          const suggestionRootComment = getSuggestionRootComment(suggestion);
          const suggestionThreadComments = [
            suggestionRootComment,
            ...normalizedSuggestionComments,
          ];
          const renderCommentContent = ({
            comment,
            defaultContent,
          }: CommentContentRenderContext) =>
            comment.id === suggestion.changeId ? (
              <SuggestionCommentContent suggestion={suggestion} />
            ) : (
              defaultContent
            );
          const getCommentActions = ({
            comment,
            defaultActions,
          }: CommentActionsRenderContext): CommentActionDefinition[] =>
            comment.id === suggestion.changeId
              ? (
                  [
                    {
                      key: "accept",
                      label:
                        typeof reviewControls?.acceptLabel === "function"
                          ? reviewControls.acceptLabel(suggestion.changeId)
                          : (reviewControls?.acceptLabel ??
                            "Accept suggestion"),
                      shortcut: {
                        keys: reviewShortcutKeys("accept"),
                        label: reviewShortcutLabel("accept"),
                      },
                      icon: <Check className="size-3.5" />,
                      compact: true,
                      onClick: (event) => {
                        event.stopPropagation();
                        onAcceptSuggestion(suggestion.changeId);
                      },
                    },
                    {
                      key: "reject",
                      label:
                        typeof reviewControls?.rejectLabel === "function"
                          ? reviewControls.rejectLabel(suggestion.changeId)
                          : (reviewControls?.rejectLabel ??
                            "Reject suggestion"),
                      tone: "danger",
                      shortcut: {
                        keys: reviewShortcutKeys("reject"),
                        label: reviewShortcutLabel("reject"),
                      },
                      icon: <X className="size-3.5" />,
                      compact: true,
                      onClick: (event) => {
                        event.stopPropagation();
                        onRejectSuggestion(suggestion.changeId);
                      },
                    },
                    {
                      key: "reply",
                      label: "Reply",
                      icon: <Reply className="size-3.5" />,
                      compact: true,
                      onClick: (event) => {
                        event.stopPropagation();
                        onReplySuggestion(suggestion.changeId);
                      },
                    },
                  ] satisfies CommentActionDefinition[]
                ).filter(
                  (action) =>
                    action.key === "reply" ||
                    reviewControls?.canDecide !== false,
                )
              : defaultActions;

          return (
            <div
              key={layout.key}
              ref={(node) => setItemRef(layout.key, node)}
              data-review-rail-key={layout.key}
              data-testid={`suggestion-thread-${suggestion.changeId}`}
              data-suggestion-change-id={suggestion.changeId}
              data-review-rail-anchor={layout.key}
              data-suggestion-thread-container="true"
              className={cn(
                railLayoutItemClass(railLayout),
                isSelected
                  ? "-translate-x-2 border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
                  : "",
                isHovered && !isSelected && "cursor-pointer",
              )}
              style={railLayoutItemStyle(railLayout, layout.railTop)}
              onMouseEnter={() => onHoverSuggestion(suggestion.changeId)}
              onMouseLeave={() => onHoverSuggestion(null)}
              onPointerDown={() => onSelectSuggestion(suggestion.changeId)}
              onClick={() => {
                if (isSelected) return;
                onFocusSuggestion(suggestion.changeId);
              }}
            >
              {suggestion.reviewStatus ||
              (suggestion.sourceChangeCount ?? 0) > 1 ? (
                <div
                  className="px-4 pt-3 text-xs text-muted-foreground"
                  data-testid={`suggestion-status-${suggestion.changeId}`}
                >
                  {suggestion.reviewStatus}
                  {suggestion.reviewStatus &&
                  (suggestion.sourceChangeCount ?? 0) > 1
                    ? " · "
                    : null}
                  {(suggestion.sourceChangeCount ?? 0) > 1
                    ? `${suggestion.sourceChangeCount} linked changes`
                    : null}
                </div>
              ) : null}
              <CommentEditorList
                autosave={autosaveComments}
                readOnly={reviewControls?.disabled}
                allowDeleteThread={
                  reviewControls?.allowDeleteThread ?? !reviewControls
                }
                comments={suggestionThreadComments}
                variant="rail"
                selectedCommentId={
                  selectedCommentId ?? (isSelected ? suggestion.changeId : null)
                }
                hoveredCommentId={
                  hoveredCommentId ?? (isHovered ? suggestion.changeId : null)
                }
                onDeleteComment={onDeleteComment}
                onUpdateComment={onUpdateComment}
                onReplyComment={(commentId) => {
                  if (commentId === suggestion.changeId) {
                    onReplySuggestion(suggestion.changeId);
                    return;
                  }

                  onReplyComment(commentId);
                }}
                onSelectComment={(commentId) => {
                  if (commentId === suggestion.changeId) {
                    onSelectSuggestion(suggestion.changeId);
                    return;
                  }

                  onSelectComment(commentId);
                }}
                onFocusComment={(commentId) => {
                  if (commentId === suggestion.changeId) {
                    onFocusSuggestion(suggestion.changeId);
                    return;
                  }

                  onFocusComment(commentId);
                }}
                onHoverComment={(commentId) => {
                  if (commentId === suggestion.changeId) {
                    onHoverSuggestion(suggestion.changeId);
                    return;
                  }

                  onHoverComment(commentId);
                }}
                pendingFocusCommentId={pendingFocusCommentId}
                newCommentDraftIds={newCommentDraftIds}
                onAutoFocusComment={onAutoFocusComment}
                renderCommentContent={renderCommentContent}
                getCommentActions={getCommentActions}
              />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
