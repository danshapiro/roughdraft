import { EditorView as CodeMirrorView } from "@codemirror/view";
import { reviewHistoryProposalIds } from "@roughdraft/rfm";
import { Extension, type JSONContent } from "@tiptap/core";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type {
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import {
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildLocationForLinkedMarkdownDocument } from "./app-navigation";
import { CommentEditorList } from "./CommentEditorList";
import type { ReviewedChange } from "./comparison-types";
import { Button } from "./components/ui/button";
import {
  beginNativeComposition,
  cancelCompositionTimer,
  finishNativeComposition,
  type NativeCompositionSession,
  scheduleCompositionFinish,
} from "./composition-suggestions";
import type { ControlledDocumentReview } from "./controlled-review";
import {
  type CriticChangeAttrs,
  type CriticComment,
  createCriticChange,
  createCriticComment,
  criticMarkdownHasReviewRail,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
  getCommentDescendantIds,
} from "./critic-markup";
import {
  type CriticChangeRailItem,
  DocumentReviewRail,
} from "./DocumentReviewRail";
import {
  getPreferredCommentId,
  getRootThreadIdForCommentId,
  parseCommentIds,
} from "./document-comments";
import { EditorContextMenu } from "./EditorContextMenu";
import {
  commentHighlightPluginKey,
  createEditorExtensions,
  criticChangeHighlightPluginKey,
  explicitReviewEdit,
  markdownPreviewUrlsKey,
  markdownPreviewUrlsPlugin,
  readCriticBlockChange,
} from "./editor-extensions";
import { LinkAffordances } from "./LinkAffordances";
import { cn } from "./lib/utils";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { splitYamlDocumentMetadata, toHtml } from "./markdown";
import { resolveSuggestionsSource } from "./resolve-suggestion";
import {
  applySuggestionDecisions,
  type ReviewDecision,
  reviewShortcut,
} from "./review-decisions";
import { cleanRevisionNode, cleanSourceFromNode } from "./revision-clean-cache";
import {
  createReviewedChangesPlugin,
  mapRemoteReviewedChanges,
  reviewedChanges,
} from "./revision-history";
import {
  createReviewIdentityPlugin,
  remapReviewIdentity,
  reviewIdentityGeneration,
} from "./revision-identity";
import {
  createSourceSpellingPreserver,
  editableMarkdownOptions,
  sameRevisionMarkup,
} from "./revision-markdown";
import { measureRevision } from "./revision-performance";
import {
  capturePrivateCommentAnchor,
  resolvePrivateCommentAnchor,
} from "./revision-private-anchors";
import { publicRevisionNode } from "./revision-private-comments";
import { suggestionPositions } from "./revision-projection";
import { documentProposalIdentities } from "./revision-proposal-identities";
import { rebaseRemoteMetadata } from "./revision-remote-metadata";
import {
  parseRemoteRevision,
  replaceRevisionContent,
} from "./revision-remote-source";
import {
  outsideComposition,
  rebaseRemoteTransaction,
} from "./revision-remote-steps";
import { serializeRevisionNode } from "./revision-review-cache";
import type { RevisionRemoteAdapter } from "./revision-session";
import {
  mergeSourceHistoryComments,
  RevisionSource,
  replaceRevisionSource,
  revisionSourceComments,
  revisionSourceMetadata,
  sameSourceContent,
} from "./revision-source";
import {
  createPrivateCommentId,
  privateReplyTarget,
  privateRootTarget,
  type RevisionUiDraftStore,
} from "./revision-ui-drafts";
import type { Page, StorageBackend } from "./storage";
import {
  graphemeBoundary,
  type SuggestionCommentParents,
  structuralSuggestionsKey,
  structuralSuggestionsPlugin,
} from "./structural-suggestions";
import { useCommentAnchorLayout } from "./useCommentAnchorLayout";
import { useReviewLayoutShiftAnimation } from "./useReviewLayoutShiftAnimation";

export type DocumentSaveState = "saved" | "unsaved" | "saving" | "error";

export type ManualSaveResult =
  | { status: "saved" }
  | { status: "blocked" }
  | { status: "error"; error: unknown };

export interface DocumentSaveController {
  flushSave: () => Promise<ManualSaveResult>;
}

type EditorViewMode = "rich-text" | "code";
export type DocumentInteractionMode = "viewing" | "suggesting" | "editing";

interface PageCardProps {
  page: Page;
  activeDocumentPath?: string | null;
  selected?: boolean;
  layout?: "default" | "embedded-demo";
  focusRequestKey?: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange?: (state: DocumentSaveState) => void;
  editorViewMode?: EditorViewMode;
  interactionMode?: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
}

interface PageCardEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange: (state: DocumentSaveState) => void;
  editorViewMode: EditorViewMode;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
}

interface RichTextEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  sourceMarkdown: string;
  onMarkdownChange: (markdown: string, origin?: "source") => void;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  controlledReview?: ControlledDocumentReview;
  beforeNavigate?: () => Promise<boolean>;
  editableReview?: EditableReviewSurface;
}

interface EditableReviewSurface {
  suggestions: CriticChangeRailItem[];
  disabled?: boolean;
  activeChangeId?: string | null;
  decisions: string[];
  reviewed?: ReviewedChange[];
  comments: ReadonlyMap<string, CriticComment>;
  onCommentsChange: (
    comments: Map<string, CriticComment>,
    origin?: "document",
  ) => void;
  // Return true to handle or defer the action; false uses the native command.
  onAccept: (changeId: string, applyNative: () => void) => boolean;
  onReject: (changeId: string, applyNative: () => void) => boolean;
  onBlockedSuggestionEdit: () => void;
  markdownFlushRef?: RefObject<(() => void) | null>;
  sourceUpdateRef?: RefObject<
    ((markdown: string, previous?: string) => void) | null
  >;
  onMarkdownQueued?: () => void;
  remoteUpdateRef?: RefObject<RevisionRemoteAdapter["apply"] | null>;
  uiDraftStore?: RevisionUiDraftStore;
  cleanMarkdown?: string;
  copyLocked?: boolean;
}

const ReviewDecisions = Extension.create({
  name: "reviewDecisions",
  addGlobalAttributes: () => [
    {
      types: ["doc"],
      attributes: {
        kept: { default: [], rendered: false },
        reviewed: { default: [], rendered: false },
      },
    },
  ],
  addProseMirrorPlugins: () => [
    createReviewedChangesPlugin(),
    createReviewIdentityPlugin(() =>
      window.dispatchEvent(new Event("roughdraft-history-blocked")),
    ),
  ],
});

interface CodeEditorSurfaceProps {
  markdown: string;
  hasCommentRailSpace: boolean;
  interactionMode: DocumentInteractionMode;
  layout: "default" | "embedded-demo";
  onMarkdownChange: (markdown: string) => void;
}

export interface DraftSuggestionState {
  type: "insertion" | "replacement";
  from: number;
  to: number;
  sourceText: string;
  text: string;
}

function rangesOfId(doc: ProseMirrorNode, id: string) {
  let found = false;
  doc.descendants((node) => {
    if (
      node.attrs.change?.changeId === id ||
      node.attrs.changeId === id ||
      node.marks.some(
        (mark) =>
          mark.attrs.changeId === id || mark.attrs.commentIds?.includes(id),
      )
    )
      found = true;
  });
  return found;
}

function areCommentIdListsEqual(
  current: string[] | null | undefined,
  next: string[] | null | undefined,
) {
  if (!current || !next) return current === next;
  if (current.length !== next.length) return false;
  return current.every((commentId, index) => commentId === next[index]);
}

function highlightTransaction(editor: Editor) {
  const { view } = editor;
  const transaction = editor.state.tr;
  const selection = view.dom.ownerDocument.getSelection();
  if (
    view.composing ||
    !view.hasFocus() ||
    !selection?.anchorNode ||
    !selection.focusNode ||
    !view.dom.contains(selection.anchorNode) ||
    !view.dom.contains(selection.focusNode) ||
    (selection.anchorNode.nodeType !== Node.TEXT_NODE &&
      selection.focusNode.nodeType !== Node.TEXT_NODE)
  )
    return transaction;

  // A click can update the browser caret before ProseMirror receives its
  // selectionchange event. Redrawing highlights must retain that newer text
  // selection, rather than restore the previous editor-state selection.
  const nativeSelection = TextSelection.between(
    transaction.doc.resolve(
      view.posAtDOM(selection.anchorNode, selection.anchorOffset),
    ),
    transaction.doc.resolve(
      view.posAtDOM(selection.focusNode, selection.focusOffset),
    ),
  );
  if (!nativeSelection.eq(transaction.selection))
    transaction.setSelection(nativeSelection);
  return transaction;
}

function getSelectionCommentIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directAttributes = editor.getAttributes("commentRef").commentIds;

  if (Array.isArray(directAttributes) && directAttributes.length > 0) {
    return directAttributes;
  }

  const { from, to, empty, $from } = editor.state.selection;
  const commentIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "commentRef") continue;

      for (const commentId of mark.attrs.commentIds ?? []) {
        commentIds.add(commentId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "commentRef") continue;

        for (const commentId of mark.attrs.commentIds ?? []) {
          commentIds.add(commentId);
        }
      }
    });
  }

  return [...commentIds];
}

function getSelectionCriticChangeIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directChangeId = editor.getAttributes("criticChange").changeId;

  if (typeof directChangeId === "string" && directChangeId.length > 0) {
    return [directChangeId];
  }

  const { from, to, empty, $from } = editor.state.selection;
  const changeIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "criticChange") continue;
      if (typeof mark.attrs.changeId === "string") {
        changeIds.add(mark.attrs.changeId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "criticChange") continue;
        if (typeof mark.attrs.changeId === "string") {
          changeIds.add(mark.attrs.changeId);
        }
      }
    });
  }

  return [...changeIds];
}

function getPreferredCriticChangeId(
  changeIds: string[],
  currentChangeId: string | null,
): string | null {
  if (currentChangeId && changeIds.includes(currentChangeId)) {
    return currentChangeId;
  }

  return changeIds[0] ?? null;
}

function findCommentRange(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  if (!commentMarkType) return null;

  let from: number | null = null;
  let to: number | null = null;
  let closed = false;

  editor.state.doc.descendants((node, pos) => {
    if (closed || !node.isText) return false;

    const hasCommentId = node.marks.some(
      (mark) =>
        mark.type === commentMarkType &&
        Array.isArray(mark.attrs.commentIds) &&
        mark.attrs.commentIds.includes(commentId),
    );

    if (!hasCommentId) {
      if (from != null && to != null && pos >= to) {
        closed = true;
      }
      return;
    }

    if (from == null || to == null) {
      from = pos;
      to = pos + node.nodeSize;
      return;
    }

    if (pos <= to) {
      to = pos + node.nodeSize;
      return;
    }

    closed = true;
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function replacementCommentMark(
  doc: ProseMirrorNode,
  from: number,
  to: number,
) {
  if (from === to) return null;
  const markType = doc.type.schema.marks.commentRef;
  if (!markType) return null;
  const ids = new Set<string>();
  doc.nodesBetween(from, to, (node) => {
    const mark = markType.isInSet(node.marks);
    for (const id of mark?.attrs.commentIds ?? []) ids.add(id);
  });
  return ids.size ? markType.create({ commentIds: [...ids] }) : null;
}

function needsBlockSuggestion(
  state: EditorState,
  from = state.selection.from,
  to = state.selection.to,
) {
  const $from = state.doc.resolve(from);
  if (
    !(state.selection instanceof TextSelection) ||
    $from.parent.type.name === "codeBlock" ||
    !$from.sameParent(state.doc.resolve(to))
  )
    return true;
  let hasAtom = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) hasAtom = true;
  });
  return hasAtom;
}

function findCommentAnchorElement(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const anchors = editor.view.dom.querySelectorAll<HTMLElement>(
    ".comment-anchor[data-comment-ids]",
  );

  return (
    [...anchors].find((anchor) =>
      parseCommentIds(anchor.dataset.commentIds).includes(commentId),
    ) ?? null
  );
}

function addCommentIdsToAnchor(
  editor: Editor | null,
  anchorCommentId: string,
  commentIdsToAdd: string[],
  separateHistory = false,
): string[] | null {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  if (!commentMarkType) return null;

  let found = false;
  const anchorCommentIds = new Set<string>();
  const tr = editor.state.tr;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const mark = node.marks.find(
      (candidate) =>
        candidate.type === commentMarkType &&
        Array.isArray(candidate.attrs.commentIds) &&
        candidate.attrs.commentIds.includes(anchorCommentId),
    );

    if (!mark) return;

    found = true;
    const nextCommentIds = [
      ...new Set([...mark.attrs.commentIds, ...commentIdsToAdd]),
    ];
    for (const id of nextCommentIds) anchorCommentIds.add(id);

    const from = pos;
    const to = pos + node.nodeSize;
    tr.removeMark(from, to, commentMarkType);
    tr.addMark(
      from,
      to,
      commentMarkType.create({ ...mark.attrs, commentIds: nextCommentIds }),
    );
  });

  if (!found) return null;

  editor.view.dispatch(
    separateHistory ? tr.setMeta("addToHistory", false) : tr,
  );
  return [...anchorCommentIds];
}

function getDocumentCriticChanges(
  editor: Editor,
): Array<Pick<CriticChangeAttrs, "changeId">> {
  return documentProposalIdentities(editor.state.doc);
}

function suggestionText(
  state: EditorState,
  text: string,
  reviewMark: ProseMirrorMark,
  from: number,
  to: number,
) {
  const $from = state.doc.resolve(from);
  const inherited =
    state.storedMarks ??
    (from === to ? $from.marks() : $from.marksAcross(state.doc.resolve(to))) ??
    [];
  let marks = state.schema.marks.criticChange.removeFromSet(inherited);
  const comment = replacementCommentMark(state.doc, from, to);
  if (comment) marks = comment.addToSet(marks);
  return state.schema.text(text, reviewMark.addToSet(marks));
}

function getReusableSuggestionInputMark(
  editor: Editor,
  position: number,
): ProseMirrorMark | null {
  const markType = editor.state.schema.marks.criticChange;
  if (!markType) return null;

  const isReusableSuggestionMark = (mark: ProseMirrorMark) =>
    mark.type === markType &&
    (mark.attrs.kind === "addition" || mark.attrs.kind === "substitution-new");
  const $position = editor.state.doc.resolve(position);
  const previousMark = $position.nodeBefore?.marks.find(
    isReusableSuggestionMark,
  );

  if (previousMark) return previousMark;

  return $position.nodeAfter?.marks.find(isReusableSuggestionMark) ?? null;
}

function getReusableSuggestionDeletionMark(
  editor: Editor,
  from: number,
  to: number,
): ProseMirrorMark | null {
  const markType = editor.state.schema.marks.criticChange;
  if (!markType) return null;

  const isReusableDeletionMark = (mark: ProseMirrorMark) =>
    mark.type === markType && mark.attrs.kind === "deletion";
  const beforeRange = editor.state.doc
    .resolve(from)
    .nodeBefore?.marks.find(isReusableDeletionMark);

  if (beforeRange) return beforeRange;

  return (
    editor.state.doc
      .resolve(to)
      .nodeAfter?.marks.find(isReusableDeletionMark) ?? null
  );
}

function getDocumentCriticChangeRailItems(
  editor: Editor | null,
  comments: ReadonlyMap<string, CriticComment>,
  suppliedSuggestions?: CriticChangeRailItem[],
  mergeNative = false,
): CriticChangeRailItem[] {
  if (!editor) return [];

  const changes = new Map<string, CriticChangeRailItem>(
    suppliedSuggestions?.map((item) => [item.changeId, { ...item }]),
  );
  const anchors = new Map<
    string,
    {
      anchorTop: number;
      anchorBottom: number;
    }
  >();
  let editorElement: HTMLElement;

  try {
    editorElement = editor.view.dom as HTMLElement;
  } catch {
    return [];
  }

  const changeElements = editorElement.querySelectorAll<HTMLElement>(
    ".critic-change[data-critic-change-id], .critic-change-block[data-critic-block]",
  );
  const editorRect = editorElement.getBoundingClientRect();

  for (const element of changeElements) {
    const changeId =
      element.dataset.criticChangeId ??
      readCriticBlockChange(element)?.changeId;
    if (!changeId) continue;

    const rect = element.getBoundingClientRect();
    const existing = anchors.get(changeId);
    const anchorTop = rect.top - editorRect.top;
    const anchorBottom = rect.bottom - editorRect.top;

    if (existing) {
      existing.anchorTop = Math.min(existing.anchorTop, anchorTop);
      existing.anchorBottom = Math.max(existing.anchorBottom, anchorBottom);
    } else {
      anchors.set(changeId, {
        anchorTop,
        anchorBottom,
      });
    }
  }

  editor.state.doc.descendants((node) => {
    if (suppliedSuggestions && !mergeNative) return false;
    const blockChange =
      node.type.name === "criticChangeBlock"
        ? (node.attrs.change as CriticChangeAttrs)
        : null;
    if (!blockChange && (!node.isText || !node.text)) return;
    const changeMark = node.marks.find(
      (mark) =>
        mark.type.name === "criticChange" &&
        typeof mark.attrs.changeId === "string",
    );
    const change =
      blockChange ?? (changeMark?.attrs as CriticChangeAttrs | undefined);
    if (!change) return;
    const text = blockChange
      ? node.textBetween(0, node.content.size, "\n")
      : node.text;
    const changeId = change.changeId;
    const kind =
      change.kind === "substitution-new" ? "substitution-old" : change.kind;
    const existing =
      changes.get(changeId) ??
      ({
        changeId,
        change,
        kind,
        oldText: "",
        newText: "",
        commentIds: [],
        anchorTop: anchors.get(changeId)?.anchorTop ?? 0,
        anchorBottom: anchors.get(changeId)?.anchorBottom ?? 24,
      } satisfies CriticChangeRailItem);

    existing.change = {
      ...change,
      kind,
    };
    existing.kind = kind;

    if (change.kind === "addition" || change.kind === "substitution-new") {
      existing.newText += text;
    } else {
      existing.oldText += text;
    }

    for (const mark of node.marks) {
      if (mark.type.name !== "commentRef") continue;
      if (!Array.isArray(mark.attrs.commentIds)) continue;

      existing.commentIds = [
        ...new Set([...existing.commentIds, ...mark.attrs.commentIds]),
      ];
    }

    if (blockChange)
      existing.commentIds = [
        ...new Set([...existing.commentIds, ...(node.attrs.commentIds ?? [])]),
      ];
    changes.set(changeId, existing);
    if (blockChange) return false;
  });

  for (const change of changes.values()) {
    Object.assign(change, anchors.get(change.changeId));
    const rootCommentIds = [...comments.values()]
      .filter((comment) =>
        [change.changeId, ...(change.sourceChangeIds ?? [])].includes(
          comment.parentCommentId ?? "",
        ),
      )
      .map((comment) => comment.id);
    const descendantIds = rootCommentIds.flatMap((commentId) =>
      getCommentDescendantIds(commentId, comments),
    );

    change.commentIds = [
      ...new Set([...change.commentIds, ...rootCommentIds, ...descendantIds]),
    ];
  }

  return [...changes.values()].sort(
    (left, right) => left.anchorTop - right.anchorTop,
  );
}

function getCriticChangeRange(editor: Editor | null, changeId: string) {
  if (!editor) return null;

  let from: number | null = null;
  let to: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const hasChange = node.marks.some(
      (mark) =>
        mark.type.name === "criticChange" && mark.attrs.changeId === changeId,
    );
    if (!hasChange) return;

    from = from == null ? pos : Math.min(from, pos);
    to = to == null ? pos + node.nodeSize : Math.max(to, pos + node.nodeSize);
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function addCommentIdsToCriticChange(
  editor: Editor | null,
  changeId: string,
  commentIdsToAdd: string[],
  separateHistory = false,
) {
  if (!editor) return false;

  const commentMarkType = editor.state.schema.marks.commentRef;
  if (!commentMarkType) return false;

  let found = false;
  const tr = editor.state.tr;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const hasChange = node.marks.some(
      (mark) =>
        mark.type.name === "criticChange" && mark.attrs.changeId === changeId,
    );
    if (!hasChange) return;

    found = true;
    const existingMark = node.marks.find(
      (mark) => mark.type === commentMarkType,
    );
    const existingCommentIds = Array.isArray(existingMark?.attrs.commentIds)
      ? existingMark.attrs.commentIds
      : [];
    const nextCommentIds = [
      ...new Set([...existingCommentIds, ...commentIdsToAdd]),
    ];
    const from = pos;
    const to = pos + node.nodeSize;

    if (existingMark) {
      tr.removeMark(from, to, commentMarkType);
    }
    tr.addMark(
      from,
      to,
      commentMarkType.create({ commentIds: nextCommentIds }),
    );
  });

  if (!found) return false;

  editor.view.dispatch(
    separateHistory ? tr.setMeta("addToHistory", false) : tr,
  );
  return true;
}

export function shouldDismissCommentThread(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;

  return !target.closest(
    '[data-comment-thread-container="true"], [data-suggestion-thread-container="true"], .comment-anchor[data-comment-ids], .critic-change[data-critic-change-id]',
  );
}

const controlledReviewHighlightKey = new PluginKey("controlledReviewHighlight");

export const RichTextEditorSurface = memo(function RichTextEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  sourceMarkdown,
  onMarkdownChange,
  interactionMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  controlledReview,
  beforeNavigate,
  editableReview,
}: RichTextEditorSurfaceProps) {
  const editorRef = useRef<Editor | null>(null);
  const controlledReviewRef = useRef(controlledReview);
  const lastControlledDocumentRef = useRef<{
    editor: Editor;
    doc: ProseMirrorNode;
  } | null>(null);
  controlledReviewRef.current = controlledReview;
  const isControlled = Boolean(controlledReview);
  const editableReviewRef = useRef(editableReview);
  editableReviewRef.current = editableReview;
  const isEditableReview = Boolean(editableReview);
  const hoveredChangeIdRef = useRef<string | null>(null);
  const hoveredCommentIdRef = useRef<string | null>(null);
  const [isWideReview, setIsWideReview] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1100px)").matches
      : true,
  );
  useEffect(() => {
    if (
      (!isControlled && !isEditableReview) ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(min-width: 1100px)");
    const update = () => setIsWideReview(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [isControlled, isEditableReview]);
  const criticChangeFrameRef = useRef<number | null>(null);
  const interactionModeRef = useRef<DocumentInteractionMode>(interactionMode);
  const commentsRef = useRef<Map<string, CriticComment>>(new Map());
  const suppressNextMarkdownUpdateRef = useRef(false);
  const resolvingSuggestionRef = useRef(false);
  const currentMarkdownRef = useRef(sourceMarkdown);
  const sourceDocSnapshots = useRef(new Map<string, ProseMirrorNode>());
  const markdownTimer = useRef<number | null>(null);
  const compositionSessionRef = useRef<NativeCompositionSession | null>(null);
  const lastFocusRequestKeyRef = useRef<string | null>(null);
  const selectedCommentIdRef = useRef<string | null>(null);
  const selectedChangeIdRef = useRef<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null,
  );
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [hoveredChangeId, setHoveredChangeId] = useState<string | null>(null);
  const [criticChanges, setCriticChanges] = useState<CriticChangeRailItem[]>(
    [],
  );
  const [draftSuggestion, setDraftSuggestion] =
    useState<DraftSuggestionState | null>(null);
  const [pendingFocusCommentId, setPendingFocusCommentId] = useState<
    string | null
  >(null);
  const [newCommentDraftIds, setNewCommentDraftIds] = useState<string[]>([]);

  const resolveFileUrl = useCallback(
    (path: string) => backend.resolveFileUrl(path),
    [backend],
  );
  const resolveLinkUrl = useCallback(
    (path: string) =>
      buildLocationForLinkedMarkdownDocument({
        projectPath: backend.info.projectPath,
        currentDocumentPath: activeDocumentPath,
        href: path,
        unified: isEditableReview,
      }),
    [activeDocumentPath, backend, isEditableReview],
  );

  const parsedContent = useMemo(
    () =>
      measureRevision("page-content-parse", () =>
        criticMarkdownToEditorState(
          sourceMarkdown,
          isEditableReview
            ? editableMarkdownOptions
            : { resolveFileUrl, resolveLinkUrl },
        ),
      ),
    [isEditableReview, resolveFileUrl, resolveLinkUrl, sourceMarkdown],
  );
  const [localComments, setComments] = useState<Map<string, CriticComment>>(
    () =>
      controlledReview?.comments ??
      (editableReview
        ? new Map(editableReview.comments)
        : parsedContent.comments),
  );
  // The controlled map and a newly selected reply arrive in the same render.
  // Reading a delayed local copy would clear that reply as "missing" and
  // collapse its native feedback thread before the editor can receive focus.
  const comments = controlledReview?.comments ?? localComments;
  const suppliedSuggestions = controlledReview?.suggestions;
  const reviewSuggestions = useMemo(() => {
    if (isEditableReview) {
      return criticChanges.map((suggestion) => {
        const rootIds = [...comments.values()]
          .filter((comment) =>
            [
              suggestion.changeId,
              ...(suggestion.sourceChangeIds ?? []),
            ].includes(comment.parentCommentId ?? ""),
          )
          .map((comment) => comment.id);
        return {
          ...suggestion,
          commentIds: [
            ...new Set([
              ...suggestion.commentIds.filter((id) => comments.has(id)),
              ...rootIds,
              ...rootIds.flatMap((id) => getCommentDescendantIds(id, comments)),
            ]),
          ],
        };
      });
    }
    if (!suppliedSuggestions) return criticChanges;
    const measured = new Map(
      criticChanges.map((change) => [change.changeId, change]),
    );
    // Membership and comments must follow the model immediately. Only visual
    // coordinates can lag a frame; moving a new reply between lists loses its
    // native draft editor after it has already received focus.
    return suppliedSuggestions.map((suggestion) => {
      const anchor = measured.get(suggestion.changeId);
      return anchor
        ? {
            ...suggestion,
            anchorTop: anchor.anchorTop,
            anchorBottom: anchor.anchorBottom,
          }
        : suggestion;
    });
  }, [suppliedSuggestions, criticChanges, isEditableReview, comments]);
  const frontmatterRef = useRef<string | null>(parsedContent.frontmatter);
  const endmatterRef = useRef<string | null>(parsedContent.endmatter);
  const sourceCommentsRef = useRef<Map<string, CriticComment> | null>(null);

  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  useEffect(() => {
    onCommentRailPresenceChange?.(
      comments.size > 0 || reviewSuggestions.length > 0,
    );
  }, [comments.size, reviewSuggestions.length, onCommentRailPresenceChange]);

  const refreshCriticChanges = useCallback(() => {
    if (criticChangeFrameRef.current !== null || markdownTimer.current !== null)
      return;
    criticChangeFrameRef.current = requestAnimationFrame(() => {
      criticChangeFrameRef.current = null;
      if (markdownTimer.current !== null) return;
      setCriticChanges(
        measureRevision("rail-layout", () =>
          getDocumentCriticChangeRailItems(
            editorRef.current,
            commentsRef.current,
            controlledReviewRef.current?.suggestions ??
              editableReviewRef.current?.suggestions,
            Boolean(editableReviewRef.current),
          ),
        ),
      );
    });
  }, []);

  const emitMarkdownChange = useCallback(
    (doc?: JSONContent, nextComments?: Map<string, CriticComment>) => {
      if (controlledReviewRef.current || compositionSessionRef.current) return;
      if (markdownTimer.current !== null) {
        window.clearTimeout(markdownTimer.current);
        markdownTimer.current = null;
      }
      const currentEditor = editorRef.current;
      if (!doc && !currentEditor) return;

      const sourceMetadata = currentEditor
        ? revisionSourceMetadata(currentEditor.state.doc)
        : null;
      const serializationOptions = {
        frontmatter: sourceMetadata
          ? sourceMetadata.frontmatter
          : frontmatterRef.current,
        endmatter: sourceMetadata
          ? sourceMetadata.endmatter
          : endmatterRef.current,
      };
      const nextMarkdown = measureRevision("review-serialize", () =>
        currentEditor
          ? serializeRevisionNode(
              currentEditor.state.doc,
              nextComments ?? commentsRef.current,
              serializationOptions,
              editableReviewRef.current?.uiDraftStore?.privateCommentIds(
                nextComments ?? commentsRef.current,
              ),
            )
          : editorStateToCriticMarkdown(
              doc ?? { type: "doc", content: [] },
              nextComments ?? commentsRef.current,
              serializationOptions,
            ),
      );
      currentMarkdownRef.current = nextMarkdown;
      // Serializing a native edit does not change the editor document. Keep
      // its snapshot here; an actual source edit installs the exact baseline
      // in sourceUpdateRef so source Undo still restores the original spelling.
      if (currentEditor) {
        sourceDocSnapshots.current.set(
          nextMarkdown,
          publicRevisionNode(
            currentEditor.state.doc,
            editableReviewRef.current?.uiDraftStore?.privateCommentIds(
              nextComments ?? commentsRef.current,
            ),
          ),
        );
        while (sourceDocSnapshots.current.size > 16)
          sourceDocSnapshots.current.delete(
            sourceDocSnapshots.current.keys().next().value as string,
          );
      }
      onMarkdownChange(nextMarkdown);
    },
    [onMarkdownChange],
  );

  const compositionFinished = useCallback(
    (session: NativeCompositionSession) => {
      if (compositionSessionRef.current !== session) return;
      compositionSessionRef.current = null;
      emitMarkdownChange();
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges],
  );

  const flushPendingMarkdown = useCallback(() => {
    const session = compositionSessionRef.current;
    const view = editorRef.current?.view;
    if (session && view && !view.composing)
      finishNativeComposition(view, session, () =>
        compositionFinished(session),
      );
    if (compositionSessionRef.current) return;
    if (markdownTimer.current === null) return;
    emitMarkdownChange();
    refreshCriticChanges();
  }, [compositionFinished, emitMarkdownChange, refreshCriticChanges]);

  const markdownFlushRef = editableReview?.markdownFlushRef;
  useLayoutEffect(() => {
    if (!markdownFlushRef) return;
    markdownFlushRef.current = flushPendingMarkdown;
    return () => {
      markdownFlushRef.current = null;
      if (markdownTimer.current !== null) {
        window.clearTimeout(markdownTimer.current);
        markdownTimer.current = null;
      }
    };
  }, [flushPendingMarkdown, markdownFlushRef]);

  const lastReviewComments = useRef(editableReview?.comments);
  useEffect(() => {
    if (
      !editableReview?.comments ||
      editableReview.comments === lastReviewComments.current
    )
      return;
    lastReviewComments.current = editableReview.comments;
    const next = new Map(editableReview.comments);
    // Unsubmitted comment editors retain their local drafts.
    for (const [id, comment] of commentsRef.current) {
      if (!comment.content.trim() && !next.has(id)) next.set(id, comment);
    }
    commentsRef.current = next;
    setComments(next);
    const sourceComments = sourceCommentsRef.current;
    sourceCommentsRef.current = null;
    if (
      sourceComments &&
      sourceComments.size === next.size &&
      [...sourceComments].every(([id, comment]) => {
        const saved = next.get(id);
        return (
          saved?.content === comment.content &&
          saved?.createdAt === comment.createdAt &&
          saved?.parentCommentId === comment.parentCommentId &&
          saved?.authorType === comment.authorType &&
          saved?.authorId === comment.authorId &&
          saved?.scope === comment.scope
        );
      })
    )
      return;
    emitMarkdownChange(undefined, next);
  }, [editableReview?.comments, emitMarkdownChange]);

  const insertFiles = useCallback(
    async (files: File[]) => {
      const currentEditor = editorRef.current;
      if (controlledReviewRef.current || !currentEditor || files.length === 0)
        return;

      const assets = await Promise.all(
        files.map((file) => backend.saveAsset(file)),
      );
      const markdown = assets
        .map((asset, index) => {
          const file = files[index];
          if (asset.mimeType.startsWith("image/")) {
            return `![${file?.name || "Image"}](${asset.markdownPath})`;
          }
          return `[${file?.name || "Attachment"}](${asset.markdownPath})`;
        })
        .join("\n\n");

      currentEditor
        .chain()
        .focus()
        .insertContent(
          toHtml(
            markdown,
            isEditableReview
              ? editableMarkdownOptions
              : { resolveFileUrl, resolveLinkUrl },
          ),
        )
        .run();
    },
    [backend, isEditableReview, resolveFileUrl, resolveLinkUrl],
  );

  useEffect(() => {
    return () => {
      if (criticChangeFrameRef.current !== null) {
        cancelAnimationFrame(criticChangeFrameRef.current);
        criticChangeFrameRef.current = null;
      }
    };
  }, []);

  const editor = useEditor(
    {
      extensions: [
        ...createEditorExtensions("Start writing..."),
        ...(isEditableReview ? [ReviewDecisions, RevisionSource] : []),
      ],
      content:
        controlledReview?.doc ??
        (editableReview
          ? {
              ...parsedContent.doc,
              attrs: {
                kept: editableReview.decisions,
                reviewed: editableReview.reviewed ?? [],
                sourceMetadata: {
                  markdown: sourceMarkdown,
                  sourceSpelling: sourceMarkdown,
                  sourceComments: [...editableReview.comments.values()],
                  frontmatter: parsedContent.frontmatter,
                  endmatter: parsedContent.endmatter,
                },
              },
            }
          : parsedContent.doc),
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        handleDOMEvents: {
          compositionstart: (view) => {
            const previous = compositionSessionRef.current;
            if (previous && view.composing) return false;
            if (previous)
              finishNativeComposition(view, previous, () =>
                compositionFinished(previous),
              );
            flushPendingMarkdown();
            compositionSessionRef.current = beginNativeComposition(view);
            return false;
          },
          compositionend: (view, event) => {
            const session = compositionSessionRef.current;
            if (session)
              scheduleCompositionFinish(view, session, event.data, () =>
                compositionFinished(session),
              );
            return false;
          },
        },
        attributes: {
          class: "tiptap min-h-[70vh]",
          tabindex: "0",
          ...(isEditableReview ? { "data-comparison-anchor": "unit-0" } : {}),
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(files);
          return true;
        },
        handlePaste: (view, event, slice) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void insertFiles(files);
            return true;
          }

          if (interactionModeRef.current !== "suggesting") {
            const { from, to } = view.state.selection;
            const mark = replacementCommentMark(view.state.doc, from, to);
            if (!mark || !slice.size) return false;
            const tr = view.state.tr.replaceSelection(slice);
            tr.addMark(tr.mapping.map(from, -1), tr.selection.to, mark);
            event.preventDefault();
            view.dispatch(tr.setMeta("uiEvent", "paste").scrollIntoView());
            return true;
          }

          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;
          if (text.includes("\n") || needsBlockSuggestion(view.state))
            return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          event.preventDefault();

          const { selection } = view.state;
          const from = selection.from;
          const to = selection.to;
          const tr = view.state.tr;

          if (from !== to) {
            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const hasOriginalText = segments.some((s) => !s.isAddition);

            if (hasOriginalText) {
              const oldChange = createCriticChange(
                "substitution-old",
                undefined,
                {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                },
              );
              const newMark = view.state.schema.marks.criticChange.create({
                ...oldChange,
                kind: "substitution-new",
              });

              for (const seg of [...segments].reverse()) {
                if (seg.isAddition) {
                  tr.delete(seg.from, seg.to);
                } else {
                  tr.addMark(
                    seg.from,
                    seg.to,
                    view.state.schema.marks.criticChange.create(oldChange),
                  );
                }
              }

              const insertPos = tr.mapping.map(to, -1);
              tr.insert(
                insertPos,
                suggestionText(view.state, text, newMark, from, to),
              );
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            } else {
              for (const seg of [...segments].reverse()) {
                tr.delete(seg.from, seg.to);
              }
              const insertPos = tr.mapping.map(from, -1);
              const existingMark = getReusableSuggestionInputMark(
                currentEditor,
                insertPos,
              );
              const mark =
                existingMark ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("addition", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.insert(
                insertPos,
                suggestionText(view.state, text, mark, from, to),
              );
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            }
          } else {
            const existingMark = getReusableSuggestionInputMark(
              currentEditor,
              from,
            );
            const mark =
              existingMark ??
              view.state.schema.marks.criticChange.create(
                createCriticChange("addition", undefined, {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                }),
              );
            tr.insert(from, suggestionText(view.state, text, mark, from, to));
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          }

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleTextInput: (view, from, to, text) => {
          if (compositionSessionRef.current || view.composing) return false;
          if (!text) return false;
          if (interactionModeRef.current !== "suggesting") {
            const mark =
              replacementCommentMark(view.state.doc, from, to) ??
              view.state.storedMarks?.find(
                (mark) => mark.type.name === "commentRef",
              );
            if (!mark) return false;
            const tr = view.state.tr.insertText(text, from, to);
            tr.addMark(from, from + text.length, mark);
            tr.ensureMarks(
              mark.addToSet(tr.storedMarks ?? tr.selection.$from.marks()),
            );
            view.dispatch(tr.scrollIntoView());
            return true;
          }

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;
          if (needsBlockSuggestion(view.state, from, to)) return false;

          const tr = view.state.tr;

          if (from !== to) {
            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const hasOriginalText = segments.some((s) => !s.isAddition);

            if (hasOriginalText) {
              const oldChange = createCriticChange(
                "substitution-old",
                undefined,
                {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                },
              );
              const newMark = view.state.schema.marks.criticChange.create({
                ...oldChange,
                kind: "substitution-new",
              });

              for (const seg of [...segments].reverse()) {
                if (seg.isAddition) {
                  tr.delete(seg.from, seg.to);
                } else {
                  tr.addMark(
                    seg.from,
                    seg.to,
                    view.state.schema.marks.criticChange.create(oldChange),
                  );
                }
              }

              const insertPos = tr.mapping.map(to, -1);
              tr.insert(
                insertPos,
                suggestionText(view.state, text, newMark, from, to),
              );
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            } else {
              for (const seg of [...segments].reverse()) {
                tr.delete(seg.from, seg.to);
              }
              const insertPos = tr.mapping.map(from, -1);
              const existingMark = getReusableSuggestionInputMark(
                currentEditor,
                insertPos,
              );
              const mark =
                existingMark ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("addition", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.insert(
                insertPos,
                suggestionText(view.state, text, mark, from, to),
              );
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            }
          } else {
            const existingMark = getReusableSuggestionInputMark(
              currentEditor,
              from,
            );
            const mark =
              existingMark ??
              view.state.schema.marks.criticChange.create(
                createCriticChange("addition", undefined, {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                }),
              );
            tr.insert(from, suggestionText(view.state, text, mark, from, to));
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          }

          const insertedMarks = tr.selection.$from.nodeBefore?.marks ?? [];
          if (insertedMarks.some((mark) => mark.type.name === "commentRef"))
            tr.ensureMarks(
              insertedMarks.filter((mark) => mark.type.name !== "criticChange"),
            );
          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleKeyDown: (view, event) => {
          if (interactionModeRef.current !== "suggesting") return false;

          if (event.isComposing) return false;
          // Let native commands handle code, selected images and structural
          // selections; the block proposal tracks their complete result.
          if (needsBlockSuggestion(view.state)) return false;

          // Handle Cut (Ctrl+X / Cmd+X)
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "x"
          ) {
            const { selection } = view.state;
            if (
              selection.empty ||
              !selection.$from.sameParent(selection.$to) ||
              !navigator.clipboard
            )
              return false;

            const currentEditor = editorRef.current;
            if (!currentEditor) return false;

            event.preventDefault();
            const from = selection.from;
            const to = selection.to;
            const selectedText = view.state.doc.textBetween(from, to, "\n\n");
            void navigator.clipboard.writeText(selectedText);

            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const tr = view.state.tr;
            for (const seg of [...segments].reverse()) {
              if (seg.isAddition) {
                tr.delete(seg.from, seg.to);
              } else {
                const deletionMark =
                  getReusableSuggestionDeletionMark(
                    currentEditor,
                    seg.from,
                    seg.to,
                  ) ??
                  view.state.schema.marks.criticChange.create(
                    createCriticChange("deletion", undefined, {
                      existingChanges: getDocumentCriticChanges(currentEditor),
                    }),
                  );
                tr.addMark(seg.from, seg.to, deletionMark);
              }
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          }

          if (event.key !== "Backspace" && event.key !== "Delete") return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const { selection } = view.state;
          let from = selection.from;
          let to = selection.to;
          if (!selection.$from.sameParent(selection.$to)) return false;

          if (selection.empty) {
            const $pos = view.state.doc.resolve(selection.from);
            const blockStart = $pos.start($pos.depth);
            const blockEnd = $pos.end($pos.depth);

            if (event.key === "Backspace") {
              if (event.ctrlKey || event.altKey) {
                const textBefore = view.state.doc.textBetween(
                  blockStart,
                  selection.from,
                );
                const match = textBefore.match(/\S+\s*$/);
                from = match
                  ? selection.from - match[0].length
                  : Math.max(blockStart, selection.from - 1);
              } else {
                const text = $pos.parent.textBetween(
                  0,
                  $pos.parent.content.size,
                  "\n",
                  "\ufffc",
                );
                from =
                  blockStart +
                  graphemeBoundary(text, selection.from - blockStart, true);
              }
            } else {
              if (event.ctrlKey || event.altKey) {
                const textAfter = view.state.doc.textBetween(
                  selection.to,
                  blockEnd,
                );
                const match = textAfter.match(/^\s*\S+/);
                to = match
                  ? selection.to + match[0].length
                  : Math.min(blockEnd, selection.to + 1);
              } else {
                const text = $pos.parent.textBetween(
                  0,
                  $pos.parent.content.size,
                  "\n",
                  "\ufffc",
                );
                to =
                  blockStart +
                  graphemeBoundary(text, selection.to - blockStart, false);
              }
            }
          }

          if (from === to) return false;
          if (needsBlockSuggestion(view.state, from, to)) return false;

          event.preventDefault();

          const criticMarkType = view.state.schema.marks.criticChange;
          const isAdditionKind = (m: ProseMirrorMark) =>
            m.type === criticMarkType &&
            (m.attrs.kind === "addition" ||
              m.attrs.kind === "substitution-new");

          // Collect segments, distinguishing suggested-insertion text
          // from original text so we can delete the former and mark the
          // latter.
          type Segment = {
            from: number;
            to: number;
            isAddition: boolean;
          };
          const segments: Segment[] = [];
          view.state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isText) return;
            const segFrom = Math.max(pos, from);
            const segTo = Math.min(pos + node.nodeSize, to);
            if (segFrom >= segTo) return;
            const isAdd = node.marks.some(isAdditionKind);
            const prev = segments[segments.length - 1];
            if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
              prev.to = segTo;
            } else {
              segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
            }
          });

          const tr = view.state.tr;

          // Process right-to-left so earlier positions stay valid.
          for (const seg of [...segments].reverse()) {
            if (seg.isAddition) {
              tr.delete(seg.from, seg.to);
            } else {
              const deletionMark =
                getReusableSuggestionDeletionMark(
                  currentEditor,
                  seg.from,
                  seg.to,
                ) ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("deletion", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.addMark(seg.from, seg.to, deletionMark);
            }
          }

          const basePos = event.key === "Backspace" ? from : to;
          const mappedPos = tr.mapping.map(basePos, -1);
          tr.setSelection(TextSelection.create(tr.doc, mappedPos));
          tr.scrollIntoView();

          view.dispatch(tr);
          return true;
        },
      },
      onUpdate: ({ editor: currentEditor, transaction }) => {
        if (
          controlledReviewRef.current ||
          transaction.getMeta("roughdraftProjection") ||
          resolvingSuggestionRef.current ||
          compositionSessionRef.current
        )
          return;
        if (suppressNextMarkdownUpdateRef.current) {
          suppressNextMarkdownUpdateRef.current = false;
          return;
        }

        const before = transaction.before;
        const after = currentEditor.state.doc;
        const sourceMetadata = revisionSourceMetadata(after);
        if (
          isHistoryTransaction(transaction) &&
          sourceMetadata &&
          sourceMetadata.markdown !== undefined &&
          before.attrs.sourceMetadata !== after.attrs.sourceMetadata
        ) {
          const nextComments = mergeSourceHistoryComments(
            revisionSourceMetadata(before)?.sourceComments,
            sourceMetadata.sourceComments,
            commentsRef.current,
          );
          const options = {
            frontmatter: sourceMetadata.frontmatter,
            endmatter: sourceMetadata.endmatter,
          };
          const canonicalNext = editorStateToCriticMarkdown(
            after.toJSON(),
            nextComments,
            options,
          );
          const raw = sourceMetadata.sourceSpelling;
          const canRestoreRaw =
            raw !== undefined &&
            sameSourceContent(
              replaceRevisionSource(currentEditor.state, raw).transaction.doc,
              after,
            );
          let markdown = canonicalNext;
          if (canRestoreRaw && raw !== undefined) {
            const parsed = criticMarkdownToEditorState(
              raw,
              editableMarkdownOptions,
            );
            const beforeComments = new Map(
              [...parsed.comments].map(([id, comment]) => [
                id,
                {
                  ...comment,
                  createdAt:
                    nextComments.get(id)?.createdAt ?? comment.createdAt,
                },
              ]),
            );
            const canonicalBefore = editorStateToCriticMarkdown(
              after.toJSON(),
              beforeComments,
              options,
            );
            const preserved = createSourceSpellingPreserver(
              raw,
              canonicalBefore,
            )(canonicalNext);
            if (
              preserved !== null &&
              sameRevisionMarkup(preserved, canonicalNext)
            )
              markdown = preserved;
          }
          frontmatterRef.current = sourceMetadata.frontmatter;
          endmatterRef.current = sourceMetadata.endmatter;
          commentsRef.current = nextComments;
          setComments(nextComments);
          sourceCommentsRef.current = nextComments;
          editableReviewRef.current?.onCommentsChange(nextComments);
          if (sourceMetadata.markdown !== markdown) {
            resolvingSuggestionRef.current = true;
            try {
              currentEditor.view.dispatch(
                currentEditor.state.tr
                  .setDocAttribute("sourceMetadata", {
                    ...sourceMetadata,
                    markdown,
                  })
                  .setMeta("addToHistory", false),
              );
            } finally {
              resolvingSuggestionRef.current = false;
            }
          }
          currentMarkdownRef.current = markdown;
          onMarkdownChange(markdown, canRestoreRaw ? "source" : undefined);
          refreshCriticChanges();
          return;
        }
        const trailing = after.lastChild;
        // StarterKit adds an empty typing paragraph after an endnote, table or
        // other final block. This reading-only normalization must not serialize
        // the source; actual edits still pass through the ordinary save path.
        if (
          before.eq(after) ||
          (after.childCount === before.childCount + 1 &&
            trailing?.type.name === "paragraph" &&
            trailing.content.size === 0 &&
            after.content
              .cut(0, after.content.size - trailing.nodeSize)
              .eq(before.content))
        ) {
          refreshCriticChanges();
          return;
        }

        const review = editableReviewRef.current;
        if (
          review?.markdownFlushRef &&
          !transaction.getMeta(explicitReviewEdit)
        ) {
          // Serialize and remeasure at a fixed cadence while typing. The live
          // editor still owns selection, decisions and navigation positions.
          // Explicit file/export actions flush the draft before reading it.
          if (markdownTimer.current === null) {
            review.onMarkdownQueued?.();
            markdownTimer.current = window.setTimeout(
              flushPendingMarkdown,
              225,
            );
          }
        } else {
          emitMarkdownChange(currentEditor.getJSON());
        }
        refreshCriticChanges();
      },
    },
    [page.id],
  );

  editorRef.current = editor;
  useEffect(() => {
    const store = editableReview?.uiDraftStore;
    if (!store) return;
    const restorePrivateReplies = () => {
      let next: Map<string, CriticComment> | undefined;
      let anchors: Transaction | undefined;
      const added: string[] = [];
      for (const [id, value] of Object.entries(store.getSnapshot().comments)) {
        if (commentsRef.current.has(id)) continue;
        const root = privateRootTarget(id, value);
        const target = privateReplyTarget(id, value) ?? root;
        if (root) {
          if (!editor || rangesOfId(editor.state.doc, id)) continue;
          const anchor =
            value.anchor &&
            resolvePrivateCommentAnchor(editor.state.doc, value.anchor);
          const markType = editor.schema.marks.commentRef;
          if (!anchor || !markType) continue;
          anchors ??= editor.state.tr;
          anchors.doc.nodesBetween(anchor.from, anchor.to, (node, pos) => {
            if (!node.isText) return;
            const previous = markType.isInSet(node.marks);
            anchors?.addMark(
              Math.max(anchor.from, pos),
              Math.min(anchor.to, pos + node.nodeSize),
              markType.create({
                commentIds: [
                  ...new Set([...(previous?.attrs.commentIds ?? []), id]),
                ],
              }),
            );
          });
        }
        const parent = target?.parentCommentId ?? "";
        const parentSuggestion =
          target && editor && suggestionPositions(editor.state.doc).has(parent);
        if (
          !target ||
          (!root &&
            !parentSuggestion &&
            (!comments.has(parent) || !commentsRef.current.has(parent)))
        )
          continue;
        next ??= new Map(commentsRef.current);
        next.set(id, target);
        added.push(id);
      }
      if (!next) return;
      commentsRef.current = next;
      if (anchors && editor) {
        resolvingSuggestionRef.current = true;
        try {
          editor.view.dispatch(
            anchors
              .setMeta("addToHistory", false)
              .setMeta(explicitReviewEdit, true),
          );
        } finally {
          resolvingSuggestionRef.current = false;
        }
      }
      setComments(next);
      setNewCommentDraftIds((ids) => [...new Set([...ids, ...added])]);
      setSelectedCommentId((id) => id ?? added[0] ?? null);
      // Recreate editors only. Save is the operation that submits their text.
    };
    restorePrivateReplies();
    return store.subscribe(restorePrivateReplies);
  }, [editableReview?.uiDraftStore, comments, editor]);
  useEffect(() => {
    if (!editor) return;
    return () => {
      const session = compositionSessionRef.current;
      if (session) cancelCompositionTimer(session);
      compositionSessionRef.current = null;
    };
  }, [editor]);
  selectedCommentIdRef.current = selectedCommentId;
  selectedChangeIdRef.current = selectedChangeId;
  hoveredChangeIdRef.current = hoveredChangeId;
  hoveredCommentIdRef.current = hoveredCommentId;

  const sourceUpdateRef = editableReview?.sourceUpdateRef;
  useLayoutEffect(() => {
    if (!sourceUpdateRef || !editor) return;
    sourceUpdateRef.current = (markdown, previous) => {
      const review = editableReviewRef.current;
      if (
        !review ||
        editor.isDestroyed ||
        interactionModeRef.current !== "editing"
      )
        return;
      flushPendingMarkdown();
      const baseline = previous ?? currentMarkdownRef.current;
      resolvingSuggestionRef.current = true;
      try {
        const snapshot = revisionSourceMetadata(editor.state.doc);
        if (
          snapshot?.markdown !== baseline ||
          JSON.stringify(snapshot.sourceComments ?? []) !==
            JSON.stringify([...commentsRef.current.values()])
        ) {
          const baselineMetadata = criticMarkdownToEditorState(
            baseline,
            editableMarkdownOptions,
          );
          editor.view.dispatch(
            closeHistory(
              editor.state.tr.setDocAttribute("sourceMetadata", {
                markdown: baseline,
                sourceSpelling: baseline,
                frontmatter: baselineMetadata.frontmatter,
                endmatter: baselineMetadata.endmatter,
                sourceComments: [...commentsRef.current.values()],
              }),
            )
              .setMeta("addToHistory", false)
              .setMeta(explicitReviewEdit, true),
          );
        }
        const parsed = replaceRevisionSource(editor.state, markdown);
        const nextComments = revisionSourceComments(
          markdown,
          currentMarkdownRef.current,
          parsed.comments,
          commentsRef.current,
        );
        frontmatterRef.current = parsed.frontmatter;
        endmatterRef.current = parsed.endmatter;
        commentsRef.current = nextComments;
        setComments(nextComments);
        sourceCommentsRef.current = nextComments;
        editor.view.dispatch(
          parsed.transaction
            .setDocAttribute("sourceMetadata", {
              ...parsed.transaction.doc.attrs.sourceMetadata,
              sourceSpelling: markdown,
              sourceComments: [...nextComments.values()],
            })
            .setMeta(explicitReviewEdit, true),
        );
        review.onCommentsChange(nextComments);
        currentMarkdownRef.current = markdown;
        sourceDocSnapshots.current.set(
          markdown,
          publicRevisionNode(
            editor.state.doc,
            editableReviewRef.current?.uiDraftStore?.privateCommentIds(
              nextComments,
            ),
          ),
        );
        while (sourceDocSnapshots.current.size > 16)
          sourceDocSnapshots.current.delete(
            sourceDocSnapshots.current.keys().next().value as string,
          );
        onMarkdownChange(markdown, "source");
        refreshCriticChanges();
      } finally {
        resolvingSuggestionRef.current = false;
      }
    };
    return () => {
      sourceUpdateRef.current = null;
    };
  }, [
    editor,
    flushPendingMarkdown,
    onMarkdownChange,
    refreshCriticChanges,
    sourceUpdateRef,
  ]);

  const remoteUpdateRef = editableReview?.remoteUpdateRef;
  useLayoutEffect(() => {
    if (!remoteUpdateRef || !editor) return;
    sourceDocSnapshots.current.set(
      currentMarkdownRef.current,
      publicRevisionNode(
        editor.state.doc,
        editableReviewRef.current?.uiDraftStore?.privateCommentIds(
          commentsRef.current,
        ),
      ),
    );
    remoteUpdateRef.current = (draft, options) => {
      const blocked = (reason: string) => {
        measureRevision(`remote-blocked-${reason}`, () => {});
        return null;
      };
      if (editor.isDestroyed) return blocked("destroyed");
      const active = document.activeElement;
      const sourceHost =
        active instanceof HTMLElement ? active.closest(".cm-editor") : null;
      const source =
        sourceHost instanceof HTMLElement
          ? CodeMirrorView.findFromDOM(sourceHost)
          : null;
      if (source?.composing || source?.compositionStarted)
        return blocked("source-composing");
      if (
        options?.idRemap &&
        (compositionSessionRef.current ||
          editor.view.composing ||
          (active instanceof HTMLTextAreaElement &&
            active.dataset.composing === "true"))
      )
        return blocked("composing-identity");
      const previous = editor.state;
      const previousMarkdown = currentMarkdownRef.current;
      // Source spelling belongs to the last serialized snapshot. The live
      // document may already contain buffered keystrokes absent from that
      // source; aligning against it would silently omit those newer edits.
      let previousSourceDoc = sourceDocSnapshots.current.get(previousMarkdown);
      if (!previousSourceDoc) {
        const parsedSource = parseRemoteRevision(previousMarkdown, previous);
        previousSourceDoc = parsedSource.doc.type.create(
          {
            ...parsedSource.doc.attrs,
            sourceMetadata: {
              markdown: previousMarkdown,
              frontmatter: parsedSource.frontmatter,
              endmatter: parsedSource.endmatter,
            },
          },
          parsedSource.doc.content,
        );
      }
      const previousClean = cleanRevisionNode(previousSourceDoc);
      const previousComments = new Map(commentsRef.current);
      const previousPrivateIds =
        editableReviewRef.current?.uiDraftStore?.privateCommentIds(
          previousComments,
        );
      const nextPrivateIds =
        previousPrivateIds &&
        new Set(
          [...previousPrivateIds].map((id) => options?.idRemap?.[id] ?? id),
        );
      if (options?.localBase) {
        const rebased = rebaseRemoteMetadata(
          options.localBase.markdown,
          previousMarkdown,
          draft.markdown,
        );
        if (rebased === null) return blocked("metadata");
        if (rebased !== draft.markdown)
          draft = { ...draft, markdown: rebased, cleanMarkdown: undefined };
      }
      let baseDoc = options?.localBase
        ? (sourceDocSnapshots.current.get(options.localBase.markdown) ??
          parseRemoteRevision(options.localBase.markdown, previous).doc)
        : previousSourceDoc;
      if (options?.idRemap)
        for (const target of Object.values(options.idRemap)) {
          const existing = rangesOfId(previous.doc, target);
          if (existing && !rangesOfId(baseDoc, target))
            return blocked("identity-target");
        }
      const parsed = measureRevision("remote-parse", () =>
        parseRemoteRevision(draft.markdown, previous),
      );
      let identityState = previous;
      let identityComments = previousComments;
      let commitIdentity = () => {};
      resolvingSuggestionRef.current = true;
      try {
        if (options?.idRemap && Object.keys(options.idRemap).length) {
          const ids = options.idRemap;
          const identityTransaction = remapReviewIdentity(previous, ids);
          identityState = previous.apply(identityTransaction);
          identityComments = new Map(
            [...commentsRef.current].map(([id, comment]) => [
              ids[id] ?? id,
              {
                ...comment,
                id: ids[id] ?? id,
                parentCommentId: comment.parentCommentId
                  ? (ids[comment.parentCommentId] ?? comment.parentCommentId)
                  : comment.parentCommentId,
              },
            ]),
          );
          commitIdentity = () => {
            const activeId = selectedCommentIdRef.current;
            editableReviewRef.current?.uiDraftStore?.remap(ids);
            commentsRef.current = identityComments;
            if (activeId && ids[activeId]) {
              setSelectedCommentId(ids[activeId]);
              selectedCommentIdRef.current = ids[activeId];
              if (active instanceof HTMLTextAreaElement)
                setPendingFocusCommentId(ids[activeId]);
            }
            setPendingFocusCommentId((id) => (id ? (ids[id] ?? id) : id));
            setNewCommentDraftIds((current) =>
              current.map((id) => ids[id] ?? id),
            );
            setSelectedChangeId((id) => (id ? (ids[id] ?? id) : id));
            editor.view.dispatch(identityTransaction);
          };
          const baseState = EditorState.create({
            schema: editor.schema,
            doc: baseDoc,
          });
          baseDoc = baseState.apply(remapReviewIdentity(baseState, ids)).doc;
        }
        const baseState = EditorState.create({
          schema: editor.schema,
          doc: baseDoc,
        });
        // A proposal can be created in the native buffer after the worker's
        // snapshot. Defer its ID collision before any document/UI mutation;
        // the coalesced source will resume browser renumbering automatically.
        const originalIds = new Set([
          ...documentProposalIdentities(baseDoc).map((item) => item.changeId),
          // A parsed Markdown base has no sidecar History attributes. Its
          // known inverse IDs still belong to the same original proposals.
          ...[...reviewHistoryProposalIds(options?.localBase?.reviewed)].map(
            (id) => options?.idRemap?.[id] ?? id,
          ),
        ]);
        const liveIds = new Set(
          documentProposalIdentities(identityState.doc).map(
            (item) => item.changeId,
          ),
        );
        const incomingDoc = parsed.doc.type.create(
          { ...parsed.doc.attrs, reviewed: draft.reviewed ?? [] },
          parsed.doc.content,
        );
        if (
          documentProposalIdentities(incomingDoc).some(
            (item) =>
              !originalIds.has(item.changeId) && liveIds.has(item.changeId),
          )
        )
          return blocked("new-proposal-identity");
        const newerLocal = !baseDoc.content.eq(identityState.doc.content);
        const transaction = rebaseRemoteTransaction(
          baseState,
          identityState,
          parsed.doc,
        );
        if (!transaction) return blocked("document-rebase");
        const composing = compositionSessionRef.current;
        if (composing || editor.view.composing) {
          const $from = editor.state.selection.$from;
          const depth = Math.max(1, $from.depth);
          const from = $from.before(depth);
          const to = $from.after(depth);
          const partial = outsideComposition(editor.state, transaction, {
            from,
            to,
          });
          if (!partial) return null;
          if (partial.docChanged) {
            if (composing) {
              const native = replaceRevisionContent(
                composing.before,
                editor.state.doc,
              );
              let mapping = native.mapping.invert();
              const before = composing.before.tr;
              for (const step of partial.steps) {
                const mapped = step.map(mapping);
                if (!mapped || before.maybeStep(mapped).failed) return null;
                const next = new Mapping();
                next.appendMap(step.getMap().invert());
                next.appendMapping(mapping);
                next.appendMap(mapped.getMap());
                mapping = next;
              }
              composing.before = composing.before.apply(before);
            }
            editor.view.dispatch(
              partial
                .setMeta("addToHistory", false)
                .setMeta(explicitReviewEdit, true),
            );
          }
          return null;
        }
        transaction.setDocAttribute("sourceMetadata", {
          ...transaction.doc.attrs.sourceMetadata,
          markdown: draft.markdown,
          frontmatter: parsed.frontmatter,
          endmatter: parsed.endmatter,
        });
        const localHistory = new Map(
          mapRemoteReviewedChanges(
            reviewedChanges(identityState.doc),
            transaction,
          ).map((change) => [change.id, change]),
        );
        const history = (draft.reviewed ?? []).map((change) => {
          const local = localHistory.get(change.id);
          if (local && local.decision === change.decision) return local;
          const origin = change.originSignature
            ? options?.originDrafts?.[change.originSignature]
            : undefined;
          if (!origin && !newerLocal)
            return change.staleReason === "needs-remap"
              ? { ...change, stale: true }
              : change;
          if (!origin && change.staleReason === "needs-remap")
            return { ...change, stale: true };
          const source = origin
            ? parseRemoteRevision(origin.markdown, identityState)
            : parsed;
          const originState = EditorState.create({
            schema: editor.schema,
            doc: source.doc.type.create(
              {
                ...source.doc.attrs,
                sourceMetadata: {
                  markdown: origin?.markdown ?? draft.markdown,
                  frontmatter: source.frontmatter,
                  endmatter: source.endmatter,
                },
              },
              source.doc.content,
            ),
          });
          const mapping = replaceRevisionContent(originState, transaction.doc);
          return mapRemoteReviewedChanges([change], mapping)[0];
        });
        const nextComments = new Map(
          draft.reviewComments.map((comment) => [comment.id, comment]),
        );
        // Empty unsubmitted comments remain UI drafts and keep their semantic target.
        for (const [id, comment] of identityComments)
          if (!comment.content.trim() && !nextComments.has(id))
            nextComments.set(
              id,
              comment as (typeof draft.reviewComments)[number],
            );
        const nextMarkdown = newerLocal
          ? (createSourceSpellingPreserver(
              previousMarkdown,
              serializeRevisionNode(
                previousSourceDoc,
                previousComments,
                {
                  frontmatter:
                    revisionSourceMetadata(previousSourceDoc)?.frontmatter,
                  endmatter:
                    revisionSourceMetadata(previousSourceDoc)?.endmatter,
                },
                previousPrivateIds,
              ),
            )(
              serializeRevisionNode(
                transaction.doc,
                nextComments,
                {
                  frontmatter: parsed.frontmatter,
                  endmatter: parsed.endmatter,
                },
                nextPrivateIds,
              ),
            ) ??
            serializeRevisionNode(
              transaction.doc,
              nextComments,
              {
                frontmatter: parsed.frontmatter,
                endmatter: parsed.endmatter,
              },
              nextPrivateIds,
            ))
          : draft.markdown;
        transaction
          .setDocAttribute("kept", Object.keys(draft.decisions))
          .setDocAttribute("reviewed", history)
          .setDocAttribute("sourceMetadata", {
            markdown: nextMarkdown,
            frontmatter: parsed.frontmatter,
            endmatter: parsed.endmatter,
            sourceSpelling: nextMarkdown,
            sourceComments: [...nextComments.values()],
            identityGeneration: reviewIdentityGeneration(identityState),
          });
        const canonicalClean = cleanRevisionNode(transaction.doc);
        const sourceClean = options?.forceCleanProjection
          ? measureRevision("accepted-source-projection", () =>
              cleanSourceFromNode(
                nextMarkdown,
                transaction.doc,
                nextComments,
                nextPrivateIds,
              ),
            )
          : newerLocal || draft.cleanMarkdown === undefined
            ? (createSourceSpellingPreserver(
                options?.currentCleanMarkdown ??
                  editableReviewRef.current?.cleanMarkdown ??
                  previousClean,
                previousClean,
              )(canonicalClean) ?? canonicalClean)
            : draft.cleanMarkdown;
        commitIdentity();
        frontmatterRef.current = parsed.frontmatter;
        endmatterRef.current = parsed.endmatter;
        commentsRef.current = nextComments;
        sourceCommentsRef.current = nextComments;
        setComments(nextComments);
        editor.view.dispatch(
          transaction
            .setMeta("addToHistory", false)
            .setMeta(explicitReviewEdit, true)
            .setMeta("roughdraftRemote", true),
        );
        currentMarkdownRef.current = nextMarkdown;
        sourceDocSnapshots.current.set(
          nextMarkdown,
          publicRevisionNode(editor.state.doc, nextPrivateIds),
        );
        while (sourceDocSnapshots.current.size > 16)
          sourceDocSnapshots.current.delete(
            sourceDocSnapshots.current.keys().next().value as string,
          );
        refreshCriticChanges();
        return {
          ...draft,
          markdown: nextMarkdown,
          cleanMarkdown: sourceClean,
          reviewed: reviewedChanges(
            publicRevisionNode(transaction.doc, nextPrivateIds),
          ),
        };
      } finally {
        resolvingSuggestionRef.current = false;
      }
    };
    return () => {
      remoteUpdateRef.current = null;
    };
  }, [editor, remoteUpdateRef, refreshCriticChanges]);

  useEffect(() => {
    editor?.setEditable(
      !isControlled &&
        interactionMode !== "viewing" &&
        !editableReview?.copyLocked,
      false,
    );
  }, [editor, interactionMode, isControlled, editableReview?.copyLocked]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (!isEditableReview) {
      editor.unregisterPlugin(markdownPreviewUrlsKey);
      return;
    }
    editor.registerPlugin(
      markdownPreviewUrlsPlugin({ resolveFileUrl, resolveLinkUrl }),
      (next, plugins) => [
        ...plugins.filter(
          (plugin) => plugin.spec.key !== markdownPreviewUrlsKey,
        ),
        next,
      ],
    );
  }, [editor, isEditableReview, resolveFileUrl, resolveLinkUrl]);

  useEffect(() => {
    if (!editor || isControlled) return;
    editor.registerPlugin(
      structuralSuggestionsPlugin({
        enabled: () =>
          interactionModeRef.current === "suggesting" &&
          (!compositionSessionRef.current ||
            compositionSessionRef.current.finishing) &&
          !resolvingSuggestionRef.current,
        onMerged: (ids, changeId) => {
          const merged = new Set(ids.filter((id) => id !== changeId));
          const moves: SuggestionCommentParents = {};
          for (const [id, comment] of commentsRef.current) {
            if (comment.parentCommentId && merged.has(comment.parentCommentId))
              moves[id] = { from: comment.parentCommentId, to: changeId };
          }
          return moves;
        },
        onBlocked: () => editableReviewRef.current?.onBlockedSuggestionEdit(),
      }),
    );
    let previousParents: SuggestionCommentParents =
      editor.state.doc.attrs.suggestionCommentParents ?? {};
    const reconcileParents = ({
      transaction,
    }: {
      transaction: import("@tiptap/pm/state").Transaction;
    }) => {
      if (!transaction.docChanged) return;
      const nextParents: SuggestionCommentParents =
        editor.state.doc.attrs.suggestionCommentParents ?? {};
      const previous = previousParents;
      previousParents = nextParents;
      if (transaction.getMeta("preventUpdate")) return;
      const nextComments = new Map(commentsRef.current);
      let changed = false;
      for (const id of new Set([
        ...Object.keys(previous),
        ...Object.keys(nextParents),
      ])) {
        const from = previous[id]?.to ?? nextParents[id]?.from;
        const to = nextParents[id]?.to ?? previous[id]?.from;
        const comment = nextComments.get(id);
        if (
          !comment ||
          from === to ||
          (comment.parentCommentId ?? null) !== from
        )
          continue;
        nextComments.set(id, { ...comment, parentCommentId: to });
        changed = true;
      }
      if (!changed) return;
      commentsRef.current = nextComments;
      setComments(nextComments);
      editableReviewRef.current?.onCommentsChange(nextComments, "document");
    };
    editor.on("transaction", reconcileParents);
    return () => {
      editor.off("transaction", reconcileParents);
      editor.unregisterPlugin(structuralSuggestionsKey);
    };
  }, [editor, isControlled]);

  useEffect(() => {
    if (editableReview?.suggestions) refreshCriticChanges();
  }, [editableReview?.suggestions, refreshCriticChanges]);

  useEffect(() => {
    if (!editor || !isControlled) return;
    editor.registerPlugin(
      new Plugin({
        key: controlledReviewHighlightKey,
        props: {
          decorations: (state) => {
            const review = controlledReviewRef.current;
            if (!review) return DecorationSet.empty;
            const highlights = review.blockHighlights;
            return DecorationSet.create(
              state.doc,
              highlights.flatMap((item) => {
                if (
                  item.from < 0 ||
                  item.to > state.doc.content.size ||
                  item.to <= item.from
                )
                  return [];
                const isSuggestion = review?.suggestions.some(
                  (suggestion) => suggestion.changeId === item.changeId,
                );
                const directCommentIds = [...(review?.comments.values() ?? [])]
                  .filter(
                    (comment) => comment.parentCommentId === item.changeId,
                  )
                  .map((comment) => comment.id);
                const commentIds = [
                  ...new Set(
                    directCommentIds.flatMap((id) => [
                      id,
                      ...getCommentDescendantIds(id, review.comments),
                    ]),
                  ),
                ];
                const commentActive = Boolean(
                  selectedCommentIdRef.current &&
                    commentIds.includes(selectedCommentIdRef.current),
                );
                const commentHovered = Boolean(
                  hoveredCommentIdRef.current &&
                    commentIds.includes(hoveredCommentIdRef.current),
                );
                const active = selectedChangeIdRef.current === item.changeId;
                const hovered = hoveredChangeIdRef.current === item.changeId;
                return [
                  Decoration.node(item.from, item.to, {
                    class: cn(
                      isSuggestion && [
                        "critic-change",
                        `critic-change-${item.kind}`,
                        active
                          ? "critic-change-decoration-active"
                          : hovered
                            ? "critic-change-decoration-hovered"
                            : null,
                        (active || hovered) &&
                          `critic-change-decoration-${item.kind}`,
                      ],
                      commentIds.length > 0 && [
                        "comment-anchor",
                        "comment-decoration",
                        commentActive
                          ? "comment-decoration-active"
                          : commentHovered
                            ? "comment-decoration-hovered"
                            : null,
                      ],
                    ),
                    "data-comment-ids": JSON.stringify(commentIds),
                    "data-critic-change-id": item.changeId,
                    "data-critic-change-kind": item.kind,
                  }),
                ];
              }),
            );
          },
        },
      }),
    );
    return () => {
      editor.unregisterPlugin(controlledReviewHighlightKey);
    };
  }, [editor, isControlled]);

  useEffect(() => {
    if (!editor || !isControlled) return;
    editor.view.dispatch(
      highlightTransaction(editor).setMeta(controlledReviewHighlightKey, {
        blockHighlights: controlledReview?.blockHighlights,
        suggestions: controlledReview?.suggestions,
        comments: controlledReview?.comments,
      }),
    );
    refreshCriticChanges();
  }, [
    editor,
    isControlled,
    controlledReview?.blockHighlights,
    controlledReview?.suggestions,
    controlledReview?.comments,
    refreshCriticChanges,
  ]);

  const activeCommentIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCommentIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];
  const activeChangeIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCriticChangeIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];

  const { commentGroups, contentHeight, measureLayout } =
    useCommentAnchorLayout(editor, comments.size > 0);

  const reviewCommentGroups = useMemo(() => {
    if (!isControlled && !isEditableReview) return commentGroups;
    const suggestionIds = new Set(
      reviewSuggestions.flatMap((change) => change.commentIds),
    );
    const threads = new Map<string, string[]>();
    for (const id of comments.keys()) {
      if (suggestionIds.has(id)) continue;
      const rootId = getRootThreadIdForCommentId(id, comments) ?? id;
      const ids = threads.get(rootId) ?? [];
      ids.push(id);
      threads.set(rootId, ids);
    }
    // Keep every thread together while DOM measurements catch up to new reply
    // anchors. A partial anchor group must not briefly mount a second list.
    return [...threads].map(([rootId, ids]) => {
      const anchor = commentGroups.find((group) =>
        group.commentIds.some((id) => ids.includes(id)),
      );
      return {
        key: rootId,
        commentIds: ids,
        anchorTop: anchor?.anchorTop ?? contentHeight + 24,
        anchorBottom: anchor?.anchorBottom ?? contentHeight + 48,
      };
    });
  }, [
    isControlled,
    isEditableReview,
    commentGroups,
    comments,
    reviewSuggestions,
    contentHeight,
  ]);

  useEffect(() => {
    if (!editor || !isControlled) return;
    const update = () => {
      measureLayout();
      refreshCriticChanges();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(editor.view.dom);
    return () => observer.disconnect();
  }, [editor, isControlled, measureLayout, refreshCriticChanges]);

  useEffect(() => {
    onEditorReady?.(editor);

    return () => {
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady]);

  useEffect(() => {
    setSelectedCommentId((current) =>
      getPreferredCommentId(activeCommentIds, current),
    );
  }, [activeCommentIds]);

  useEffect(() => {
    setSelectedChangeId((current) =>
      getPreferredCriticChangeId(activeChangeIds, current),
    );
  }, [activeChangeIds]);

  useEffect(() => {
    if (!editor || isControlled || isEditableReview) return;

    frontmatterRef.current = parsedContent.frontmatter;
    endmatterRef.current = parsedContent.endmatter;
    commentsRef.current = parsedContent.comments;
    setComments(parsedContent.comments);
    setSelectedCommentId(null);
    setHoveredCommentId(null);
    setSelectedChangeId(null);
    setHoveredChangeId(null);
    setDraftSuggestion(null);
    setPendingFocusCommentId(null);

    const nextDoc = parsedContent.doc;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)) {
      editor.commands.setContent(nextDoc, { emitUpdate: false });
    }

    refreshCriticChanges();
  }, [
    editor,
    isControlled,
    isEditableReview,
    parsedContent,
    refreshCriticChanges,
  ]);

  useLayoutEffect(() => {
    if (!editor || !controlledReview?.doc) {
      lastControlledDocumentRef.current = null;
      return;
    }
    // Compare supplied schema nodes: native plugins add default attributes and
    // a trailing paragraph. Those normalizations must not reset selection when
    // an unrelated comment is saved.
    const nextDoc = editor.schema.nodeFromJSON(controlledReview.doc);
    const previous = lastControlledDocumentRef.current;
    if (previous?.editor === editor && previous.doc.eq(nextDoc)) return;
    lastControlledDocumentRef.current = { editor, doc: nextDoc };
    if (!editor.state.doc.eq(nextDoc)) {
      editor.commands.setContent(controlledReview.doc, { emitUpdate: false });
    }
    refreshCriticChanges();
    measureLayout();
  }, [editor, controlledReview?.doc, refreshCriticChanges, measureLayout]);

  useEffect(() => {
    if (!controlledReview?.comments) return;
    commentsRef.current = controlledReview.comments;
    refreshCriticChanges();
    measureLayout();
  }, [controlledReview?.comments, refreshCriticChanges, measureLayout]);

  useEffect(() => {
    if (!editor || !selected || !focusRequestKey) return;
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;

    requestAnimationFrame(() => {
      editor.chain().focus("end").run();
    });
  }, [editor, focusRequestKey, selected]);

  useEffect(() => {
    if (selectedCommentId && !comments.has(selectedCommentId)) {
      setSelectedCommentId(null);
    }

    if (hoveredCommentId && !comments.has(hoveredCommentId)) {
      setHoveredCommentId(null);
    }
    refreshCriticChanges();
  }, [comments, hoveredCommentId, refreshCriticChanges, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredCommentId = selectedCommentId
      ? hoveredCommentId
      : null;

    editor.view.dispatch(
      highlightTransaction(editor).setMeta(commentHighlightPluginKey, {
        selectedCommentId,
        hoveredCommentId: effectiveHoveredCommentId,
      }),
    );
  }, [editor, hoveredCommentId, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredChangeId = selectedChangeId ? hoveredChangeId : null;

    editor.view.dispatch(
      highlightTransaction(editor).setMeta(criticChangeHighlightPluginKey, {
        selectedChangeId,
        hoveredChangeId: effectiveHoveredChangeId,
      }),
    );
  }, [editor, hoveredChangeId, selectedChangeId]);

  useEffect(() => {
    if (!editor) return;
    const root = editor.view.dom;
    // Delegate events so new rendered nodes work without resetting selection or
    // reattaching handlers whenever controlled comments/decisions are saved.
    const findAnchor = (target: EventTarget | null, selector: string) => {
      if (!(target instanceof Element)) return null;
      const element = target.closest<HTMLElement>(selector);
      return element && root.contains(element) ? element : null;
    };
    const handleMouseOver = (event: MouseEvent) => {
      const comment = findAnchor(
        event.target,
        ".comment-anchor[data-comment-ids]",
      );
      const ids = parseCommentIds(comment?.dataset.commentIds);
      const commentId = getPreferredCommentId(
        ids,
        selectedCommentIdRef.current,
      );
      if (commentId) setHoveredCommentId(commentId);
      const change = findAnchor(
        event.target,
        ".critic-change[data-critic-change-id]",
      );
      if (change?.dataset.criticChangeId)
        setHoveredChangeId(change.dataset.criticChangeId);
    };
    const handleMouseOut = (event: MouseEvent) => {
      const comment = findAnchor(
        event.target,
        ".comment-anchor[data-comment-ids]",
      );
      if (
        comment &&
        (!(event.relatedTarget instanceof Node) ||
          !comment.contains(event.relatedTarget))
      ) {
        const ids = parseCommentIds(comment.dataset.commentIds);
        setHoveredCommentId((current) =>
          current && ids.includes(current) ? null : current,
        );
      }
      const change = findAnchor(
        event.target,
        ".critic-change[data-critic-change-id]",
      );
      if (
        change &&
        (!(event.relatedTarget instanceof Node) ||
          !change.contains(event.relatedTarget))
      ) {
        setHoveredChangeId((current) =>
          current === change.dataset.criticChangeId ? null : current,
        );
      }
    };
    const handleClick = (event: MouseEvent) => {
      const comment = findAnchor(
        event.target,
        ".comment-anchor[data-comment-ids]",
      );
      const id = getPreferredCommentId(
        parseCommentIds(comment?.dataset.commentIds),
        selectedCommentIdRef.current,
      );
      if (id) setSelectedCommentId(id);
      const change = findAnchor(
        event.target,
        ".critic-change[data-critic-change-id]",
      );
      if (change?.dataset.criticChangeId)
        setSelectedChangeId(change.dataset.criticChangeId);
    };
    root.addEventListener("mouseover", handleMouseOver);
    root.addEventListener("mouseout", handleMouseOut);
    root.addEventListener("click", handleClick);
    return () => {
      root.removeEventListener("mouseover", handleMouseOver);
      root.removeEventListener("mouseout", handleMouseOut);
      root.removeEventListener("click", handleClick);
    };
  }, [editor]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!selectedCommentIdRef.current && !selectedChangeIdRef.current) return;
      if (!shouldDismissCommentThread(event.target)) return;

      setSelectedCommentId(null);
      setHoveredCommentId(null);
      setSelectedChangeId(null);
      setHoveredChangeId(null);
      setPendingFocusCommentId(null);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
    };
  }, []);

  const handleAddComment = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const comment = createCriticComment(
      editableReviewRef.current ? { id: createPrivateCommentId() } : undefined,
      {
        existingComments: commentsRef.current.values(),
      },
    );
    const anchor = capturePrivateCommentAnchor(
      currentEditor.state.doc,
      currentEditor.state.selection.from,
      currentEditor.state.selection.to,
    );
    const nextComments = new Map(commentsRef.current);
    nextComments.set(comment.id, comment);
    commentsRef.current = nextComments;
    if (anchor)
      editableReviewRef.current?.uiDraftStore?.setComment(comment.id, {
        value: "",
        original: "",
        editing: true,
        target: comment,
        anchor,
      });
    setComments(nextComments);
    setNewCommentDraftIds((current) =>
      current.includes(comment.id) ? current : [...current, comment.id],
    );

    suppressNextMarkdownUpdateRef.current = true;
    const chain = currentEditor.chain().focus();
    if (editableReviewRef.current) chain.setMeta("addToHistory", false);
    chain.setCommentRef({ commentIds: [comment.id] }).run();
    if (suppressNextMarkdownUpdateRef.current) {
      suppressNextMarkdownUpdateRef.current = false;
    }

    setSelectedCommentId(comment.id);
    setPendingFocusCommentId(comment.id);
    requestAnimationFrame(() => {
      measureLayout();
    });
  }, [measureLayout]);

  const handleSuggestDeletion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const change = createCriticChange("deletion", undefined, {
      existingChanges: getDocumentCriticChanges(currentEditor),
    });

    currentEditor.chain().focus().setCriticChange(change).run();
    emitMarkdownChange(currentEditor.getJSON());
    refreshCriticChanges();
  }, [emitMarkdownChange, refreshCriticChanges]);

  const handleSuggestReplacement = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const { from, to } = currentEditor.state.selection;
    setDraftSuggestion({
      type: "replacement",
      from,
      to,
      sourceText: currentEditor.state.doc.textBetween(from, to, "\n"),
      text: "",
    });
  }, []);

  const applyDraftSuggestion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || !draftSuggestion) return;

    const nextText = draftSuggestion.text;
    if (!nextText) {
      setDraftSuggestion(null);
      return;
    }

    if (draftSuggestion.type === "insertion") {
      const change = createCriticChange("addition", undefined, {
        existingChanges: getDocumentCriticChanges(currentEditor),
      });

      currentEditor
        .chain()
        .focus()
        .insertContentAt(draftSuggestion.from, {
          type: "text",
          text: nextText,
          marks: [
            {
              type: "criticChange",
              attrs: change,
            },
          ],
        })
        .run();
      setSelectedChangeId(change.changeId);
      setDraftSuggestion(null);
      emitMarkdownChange(currentEditor.getJSON());
      refreshCriticChanges();
      return;
    }

    const change = createCriticChange("substitution-old", undefined, {
      existingChanges: getDocumentCriticChanges(currentEditor),
    });
    const replacementChange: CriticChangeAttrs = {
      ...change,
      kind: "substitution-new",
    };

    currentEditor
      .chain()
      .focus()
      .setTextSelection({ from: draftSuggestion.from, to: draftSuggestion.to })
      .setCriticChange(change)
      .insertContentAt(draftSuggestion.to, {
        type: "text",
        text: nextText,
        marks: [
          {
            type: "criticChange",
            attrs: replacementChange,
          },
        ],
      })
      .run();
    setSelectedChangeId(change.changeId);
    setDraftSuggestion(null);
    emitMarkdownChange(currentEditor.getJSON());
    refreshCriticChanges();
  }, [draftSuggestion, emitMarkdownChange, refreshCriticChanges]);

  const handleSuggestInsertion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    const { from } = currentEditor.state.selection;
    const before = currentEditor.state.doc.textBetween(
      Math.max(1, from - 24),
      from,
      " ",
    );
    const after = currentEditor.state.doc.textBetween(
      from,
      Math.min(currentEditor.state.doc.content.size, from + 24),
      " ",
    );

    setDraftSuggestion({
      type: "insertion",
      from,
      to: from,
      sourceText: `${before}▮${after}`.trim(),
      text: "",
    });
  }, []);

  const updateComment = useCallback(
    (commentId: string, updater: (comment: CriticComment) => CriticComment) => {
      const existingComment = commentsRef.current.get(commentId);
      if (!existingComment) return;
      const controlled = controlledReviewRef.current;
      if (controlled) {
        if (!controlled.disabled)
          controlled.onUpdateComment(
            commentId,
            updater(existingComment).content,
          );
        setNewCommentDraftIds((current) =>
          current.filter((id) => id !== commentId),
        );
        return;
      }

      const nextComments = new Map(commentsRef.current);
      nextComments.set(commentId, updater(existingComment));
      commentsRef.current = nextComments;
      setComments(nextComments);
      setNewCommentDraftIds((current) =>
        current.filter((currentCommentId) => currentCommentId !== commentId),
      );
      editableReviewRef.current?.onCommentsChange(nextComments);
      emitMarkdownChange(undefined, nextComments);
    },
    [emitMarkdownChange],
  );

  const createControlledReply = useCallback(
    (changeId: string | null, parentId: string) => {
      const controlled = controlledReviewRef.current;
      if (!controlled || controlled.disabled) return;
      const id = controlled.onCreateComment(changeId, parentId);
      if (!id) return;
      setSelectedCommentId(id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(id);
      setNewCommentDraftIds((current) => [...current, id]);
      if (changeId) setSelectedChangeId(changeId);
    },
    [],
  );

  const replyToComment = useCallback(
    (commentId: string) => {
      if (controlledReviewRef.current) {
        createControlledReply(null, commentId);
        return;
      }
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const comment = createCriticComment(
        {
          parentCommentId: commentId,
          ...(editableReviewRef.current
            ? { id: createPrivateCommentId() }
            : {}),
        },
        {
          existingComments: commentsRef.current.values(),
        },
      );
      suppressNextMarkdownUpdateRef.current = true;
      const nextAnchorCommentIds = addCommentIdsToAnchor(
        currentEditor,
        commentId,
        [comment.id],
        Boolean(editableReviewRef.current),
      );
      if (suppressNextMarkdownUpdateRef.current) {
        suppressNextMarkdownUpdateRef.current = false;
      }
      if (!nextAnchorCommentIds && !editableReviewRef.current) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      if (editableReviewRef.current)
        setNewCommentDraftIds((ids) => [...ids, comment.id]);
      editableReviewRef.current?.uiDraftStore?.setComment(comment.id, {
        value: "",
        original: "",
        editing: true,
        target: comment,
      });
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [createControlledReply, measureLayout],
  );

  const decideNativeSuggestions = useCallback(
    (changeIds: string[], decision: ReviewDecision) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || !changeIds.length) return false;
      const tr = currentEditor.state.tr;
      if (!applySuggestionDecisions(tr, changeIds, decision)) return false;

      const resolvedSource = resolveSuggestionsSource(
        currentMarkdownRef.current,
        changeIds,
        decision,
      );
      const existing = commentsRef.current;
      const resolvedIds = new Set(changeIds);
      const removedIds = new Set<string>();
      for (const { id, parentCommentId } of existing.values()) {
        if (!parentCommentId || !resolvedIds.has(parentCommentId)) continue;
        removedIds.add(id);
        for (const replyId of getCommentDescendantIds(id, existing))
          removedIds.add(replyId);
      }
      let nextComments = existing;
      const markType = tr.doc.type.schema.marks.commentRef;
      if (removedIds.size > 0) {
        nextComments = new Map(existing);
        for (const id of removedIds) nextComments.delete(id);
        if (markType) {
          tr.doc.descendants((node, pos) => {
            if (!node.isText) return;
            const mark = markType.isInSet(node.marks);
            if (!mark) return;
            const ids = mark.attrs.commentIds as string[];
            const remaining = ids.filter((id) => !removedIds.has(id));
            if (remaining.length === ids.length) return;
            tr.removeMark(pos, pos + node.nodeSize, mark);
            if (remaining.length > 0) {
              tr.addMark(
                pos,
                pos + node.nodeSize,
                markType.create({ commentIds: remaining }),
              );
            }
          });
        }
      }

      // Save once, with the matching source and reply metadata. The complete
      // operation is a single editor history event.
      resolvingSuggestionRef.current = true;
      try {
        currentEditor.view.dispatch(
          closeHistory(tr).setMeta(explicitReviewEdit, true),
        );
        currentEditor.view.dispatch(closeHistory(currentEditor.state.tr));
        currentEditor.commands.focus();
        if (nextComments !== existing) {
          commentsRef.current = nextComments;
          setComments(nextComments);
        }
        if (resolvedSource !== null) {
          currentMarkdownRef.current = resolvedSource;
          endmatterRef.current =
            splitYamlDocumentMetadata(resolvedSource).endmatter;
          onMarkdownChange(resolvedSource);
        } else {
          emitMarkdownChange(currentEditor.getJSON(), nextComments);
        }
        setSelectedChangeId((id) => (id && resolvedIds.has(id) ? null : id));
        setHoveredChangeId((id) => (id && resolvedIds.has(id) ? null : id));
        refreshCriticChanges();
        return true;
      } finally {
        resolvingSuggestionRef.current = false;
      }
    },
    [emitMarkdownChange, onMarkdownChange, refreshCriticChanges],
  );

  const decideSuggestion = useCallback(
    (changeId: string, decision: ReviewDecision) => {
      const controlled = controlledReviewRef.current;
      if (controlled) {
        if (controlled.canDecide && !controlled.disabled) {
          if (decision === "accept") controlled.onAccept(changeId);
          else controlled.onReject(changeId);
        }
        return;
      }
      const currentEditor = editorRef.current;
      if (!currentEditor) return;
      const live = editableReviewRef.current;
      if (!live) {
        decideNativeSuggestions([changeId], decision);
        return;
      }
      if (live.disabled) return;
      const applyNative = () => {
        if (currentEditor.isDestroyed) return;
        const command =
          decision === "accept" ? "acceptCriticChange" : "rejectCriticChange";
        currentEditor.view.dispatch(closeHistory(currentEditor.state.tr));
        currentEditor.commands[command](changeId);
        currentEditor.view.dispatch(closeHistory(currentEditor.state.tr));
      };
      const handle = decision === "accept" ? live.onAccept : live.onReject;
      if (!handle(changeId, applyNative)) applyNative();
      setSelectedChangeId((id) => (id === changeId ? null : id));
      setHoveredChangeId((id) => (id === changeId ? null : id));
      refreshCriticChanges();
    },
    [decideNativeSuggestions, refreshCriticChanges],
  );

  function decideAllNativeSuggestions(decision: ReviewDecision) {
    const currentEditor = editorRef.current;
    if (currentEditor) {
      decideNativeSuggestions(
        [...suggestionPositions(currentEditor.state.doc).keys()],
        decision,
      );
    }
  }

  const acceptSuggestion = useCallback(
    (changeId: string) => decideSuggestion(changeId, "accept"),
    [decideSuggestion],
  );
  const rejectSuggestion = useCallback(
    (changeId: string) => decideSuggestion(changeId, "reject"),
    [decideSuggestion],
  );

  const replyToSuggestion = useCallback(
    (changeId: string) => {
      if (controlledReviewRef.current) {
        createControlledReply(changeId, changeId);
        return;
      }
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const comment = createCriticComment(
        {
          parentCommentId: changeId,
          ...(editableReviewRef.current
            ? { id: createPrivateCommentId() }
            : {}),
        },
        {
          existingComments: commentsRef.current.values(),
        },
      );
      suppressNextMarkdownUpdateRef.current = true;
      const didAddCommentId = addCommentIdsToCriticChange(
        currentEditor,
        changeId,
        [comment.id],
        Boolean(editableReviewRef.current),
      );
      if (suppressNextMarkdownUpdateRef.current) {
        suppressNextMarkdownUpdateRef.current = false;
      }
      if (!didAddCommentId && !editableReviewRef.current) {
        return;
      }

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      editableReviewRef.current?.uiDraftStore?.setComment(comment.id, {
        value: "",
        original: "",
        editing: true,
        target: comment,
      });
      setComments(nextComments);
      setSelectedChangeId(changeId);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      if (editableReviewRef.current)
        setNewCommentDraftIds((ids) => [...ids, comment.id]);
      refreshCriticChanges();
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [createControlledReply, measureLayout, refreshCriticChanges],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      const controlled = controlledReviewRef.current;
      if (controlled) {
        if (!controlled.disabled) controlled.onDeleteComment(commentId);
        return;
      }
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const descendantIds = getCommentDescendantIds(
        commentId,
        commentsRef.current,
      );
      const commentIdsToDelete = [commentId, ...descendantIds];
      const deletedIds = new Set(commentIdsToDelete);
      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }
      commentsRef.current = nextComments;
      setComments(nextComments);

      if (editableReviewRef.current) {
        editableReviewRef.current.onCommentsChange(nextComments);
      } else {
        const chain = currentEditor.chain().focus();
        for (const id of commentIdsToDelete) chain.removeCommentId(id);
        chain.run();
      }
      setSelectedCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setHoveredCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setPendingFocusCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setNewCommentDraftIds((current) =>
        current.filter((commentId) => !deletedIds.has(commentId)),
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [emitMarkdownChange, measureLayout],
  );

  const selectComment = useCallback((commentId: string) => {
    setSelectedCommentId(commentId);
  }, []);

  const selectSuggestion = useCallback((changeId: string) => {
    setSelectedChangeId(changeId);
    setSelectedCommentId(null);
  }, []);

  const focusComment = useCallback((commentId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedCommentId(commentId);

    const range = findCommentRange(currentEditor, commentId);
    if (range) {
      currentEditor.commands.focus(undefined, { scrollIntoView: false });
      currentEditor.view.dispatch(
        currentEditor.state.tr.setSelection(
          TextSelection.create(currentEditor.state.doc, range.from, range.to),
        ),
      );
      return;
    }

    if (!findCommentAnchorElement(currentEditor, commentId)) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
  }, []);

  const focusSuggestion = useCallback((changeId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedChangeId(changeId);
    setSelectedCommentId(null);

    const range = getCriticChangeRange(currentEditor, changeId);
    if (!range) {
      const element = [
        ...currentEditor.view.dom.querySelectorAll<HTMLElement>(
          ".critic-change[data-critic-change-id]",
        ),
      ].find((item) => item.dataset.criticChangeId === changeId);
      element?.scrollIntoView?.({ block: "nearest" });
      return;
    }

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
    currentEditor.view.dispatch(
      currentEditor.state.tr.setSelection(
        TextSelection.create(currentEditor.state.doc, range.from, range.to),
      ),
    );
  }, []);

  const hasReviewRail = comments.size > 0 || reviewSuggestions.length > 0;
  // Comparison versions share one reading column, even without visible cards.
  const hasReviewColumn = isControlled || isEditableReview || hasReviewRail;
  const documentShellRef =
    useReviewLayoutShiftAnimation<HTMLDivElement>(hasReviewColumn);
  useEffect(() => {
    const shell = documentShellRef.current;
    if (!shell || !editor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const decision = reviewShortcut(event);
      const target = event.target;
      if (!decision || !(target instanceof Element)) return;
      if (target.closest("input, textarea, select, [role=dialog]")) return;
      const card = target.closest<HTMLElement>("[data-suggestion-change-id]");
      if (!card && !editor.view.dom.contains(target)) return;
      if (card && target.closest("[contenteditable=true]")) return;
      const controlled = controlledReviewRef.current;
      const live = editableReviewRef.current;
      if (
        (controlled && (!controlled.canDecide || controlled.disabled)) ||
        live?.disabled
      )
        return;
      const isPending = (id: string | null | undefined): id is string =>
        !!id &&
        (controlled
          ? controlled.suggestions.some((item) => item.changeId === id)
          : live?.suggestions.some((item) => item.changeId === id) ||
            suggestionPositions(editor.state.doc).has(id));
      const id = [
        card?.dataset.suggestionChangeId,
        selectedChangeIdRef.current,
        ...getSelectionCriticChangeIds(editor),
        live?.activeChangeId ?? controlled?.activeChangeId,
      ].find(isPending);
      if (!id) return;
      event.preventDefault();
      if (!event.repeat) decideSuggestion(id, decision);
    };
    shell.addEventListener("keydown", onKeyDown);
    return () => shell.removeEventListener("keydown", onKeyDown);
  }, [decideSuggestion, documentShellRef, editor]);

  const activeComments = activeCommentIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is CriticComment => Boolean(comment));
  const contentCardClass =
    "rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-800 bg-white dark:bg-card shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)]";
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "review-layout-grid",
    !hasReviewColumn && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasReviewColumn &&
      "review-layout-grid--centered",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo"
      ? "max-w-none"
      : "review-layout-main max-w-[46.5rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const fallbackClass = cn(
    "document-comment-fallback mb-4",
    isControlled || isEditableReview || layout === "embedded-demo"
      ? "hidden"
      : "min-[1100px]:hidden",
  );
  const reviewRailClass = cn(
    "document-comment-rail",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : isControlled || isEditableReview
        ? "review-layout-rail block pb-6"
        : "review-layout-rail hidden min-[1100px]:block",
  );

  return (
    <div
      className="cursor-text bg-transparent"
      data-testid="page-card-rich-text"
    >
      <div
        ref={documentShellRef}
        data-testid="document-page-shell"
        className={documentShellClass}
      >
        <div className={documentMainClass}>
          {!isControlled &&
            !isEditableReview &&
            reviewSuggestions.length > 0 && (
              <div
                className="mb-3 flex flex-wrap gap-2"
                role="group"
                aria-label="Review suggestions"
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="document-accept-all"
                  onClick={() => decideAllNativeSuggestions("accept")}
                >
                  Accept all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="document-reject-all"
                  onClick={() => decideAllNativeSuggestions("reject")}
                >
                  Reject all
                </Button>
              </div>
            )}
          {activeComments.length > 0 ? (
            <CommentEditorList
              autosave={isEditableReview}
              comments={activeComments}
              readOnly={controlledReview?.disabled}
              className={fallbackClass}
              testId="document-comment-fallback"
              selectedCommentId={selectedCommentId}
              hoveredCommentId={hoveredCommentId}
              onDeleteComment={deleteComment}
              onUpdateComment={(commentId, nextContent) => {
                updateComment(commentId, (current) => ({
                  ...current,
                  content: nextContent,
                }));
              }}
              onReplyComment={replyToComment}
              onSelectComment={selectComment}
              onHoverComment={setHoveredCommentId}
              pendingFocusCommentId={pendingFocusCommentId}
              newCommentDraftIds={newCommentDraftIds}
              onAutoFocusComment={(commentId) => {
                setPendingFocusCommentId((current) =>
                  current === commentId ? null : current,
                );
              }}
            />
          ) : null}
          <div className={contentInsetClass}>
            <div
              data-testid="document-content-card"
              className={cn(
                contentCardClass,
                "document-content-card px-10 py-10 sm:px-14 sm:py-14",
              )}
            >
              <EditorContextMenu
                editor={isControlled ? null : editor}
                backend={backend}
                resolveLinkUrl={resolveLinkUrl}
                onAddComment={
                  isControlled || interactionMode === "viewing"
                    ? undefined
                    : handleAddComment
                }
                onSuggestDeletion={
                  isControlled || interactionMode === "viewing"
                    ? undefined
                    : handleSuggestDeletion
                }
                onSuggestReplacement={
                  isControlled || interactionMode === "viewing"
                    ? undefined
                    : handleSuggestReplacement
                }
                onSuggestInsertion={
                  isControlled || interactionMode === "viewing"
                    ? undefined
                    : handleSuggestInsertion
                }
              >
                <div data-testid="rich-text-editor">
                  <LinkAffordances
                    editor={editor}
                    backend={backend}
                    beforeNavigate={beforeNavigate}
                  >
                    <EditorContent editor={editor} />
                  </LinkAffordances>
                </div>
              </EditorContextMenu>
            </div>
          </div>
        </div>
        <DocumentReviewRail
          className={reviewRailClass}
          layout={
            layout === "embedded-demo" ||
            ((isControlled || isEditableReview) && !isWideReview)
              ? "flow"
              : "anchored"
          }
          reviewControls={
            controlledReview
              ? {
                  canDecide: controlledReview.canDecide,
                  disabled: controlledReview.disabled,
                  acceptLabel: controlledReview.acceptLabel,
                  rejectLabel: controlledReview.rejectLabel,
                }
              : isEditableReview
                ? {
                    canDecide: true,
                    disabled: Boolean(editableReview?.disabled),
                    acceptLabel: (id) =>
                      editableReview?.suggestions.some(
                        (item) => item.changeId === id,
                      )
                        ? "Keep change: use New wording"
                        : "Keep suggested edit",
                    rejectLabel: (id) =>
                      editableReview?.suggestions.some(
                        (item) => item.changeId === id,
                      )
                        ? "Revert change: use Old wording"
                        : "Revert suggested edit",
                    allowDeleteThread: true,
                  }
                : undefined
          }
          testId="document-review-rail"
          autosaveComments={false}
          commentGroups={reviewCommentGroups}
          comments={comments}
          suggestions={reviewSuggestions}
          selectedCommentId={selectedCommentId}
          hoveredCommentId={hoveredCommentId}
          selectedChangeId={selectedChangeId}
          hoveredChangeId={hoveredChangeId}
          contentHeight={contentHeight}
          onDeleteComment={deleteComment}
          onUpdateComment={(commentId, nextContent) => {
            updateComment(commentId, (current) => ({
              ...current,
              content: nextContent,
            }));
          }}
          onReplyComment={replyToComment}
          onSelectComment={selectComment}
          onFocusComment={focusComment}
          onHoverComment={setHoveredCommentId}
          onAcceptSuggestion={acceptSuggestion}
          onRejectSuggestion={rejectSuggestion}
          onReplySuggestion={replyToSuggestion}
          onSelectSuggestion={selectSuggestion}
          onFocusSuggestion={focusSuggestion}
          onHoverSuggestion={setHoveredChangeId}
          pendingFocusCommentId={pendingFocusCommentId}
          newCommentDraftIds={newCommentDraftIds}
          onAutoFocusComment={(commentId) => {
            setPendingFocusCommentId((current) =>
              current === commentId ? null : current,
            );
          }}
          draftSuggestion={draftSuggestion}
          onDraftSuggestionTextChange={(text) => {
            setDraftSuggestion((current) =>
              current ? { ...current, text } : current,
            );
          }}
          onApplyDraftSuggestion={applyDraftSuggestion}
          onCancelDraftSuggestion={() => setDraftSuggestion(null)}
          editor={editor}
        />
      </div>
    </div>
  );
});

const CodeEditorSurface = memo(function CodeEditorSurface({
  markdown,
  hasCommentRailSpace,
  interactionMode,
  layout,
  onMarkdownChange,
}: CodeEditorSurfaceProps) {
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "review-layout-grid",
    !hasCommentRailSpace && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasCommentRailSpace &&
      "review-layout-grid--centered",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo"
      ? "max-w-none"
      : "review-layout-main max-w-[46.5rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const reviewRailClass = cn(
    "document-comment-rail pointer-events-none invisible",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : "review-layout-rail hidden min-[1100px]:block",
  );
  const documentShellRef =
    useReviewLayoutShiftAnimation<HTMLDivElement>(hasCommentRailSpace);

  return (
    <div className="cursor-text bg-transparent" data-testid="page-card-code">
      <div
        ref={documentShellRef}
        data-testid="document-page-shell"
        className={documentShellClass}
      >
        <div className={documentMainClass}>
          <div className={contentInsetClass}>
            <div
              className="min-h-[calc(70vh+4rem)] rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-800 bg-white dark:bg-card py-10 pr-6 pl-5 shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)] sm:py-14 sm:pr-10 sm:pl-8"
              data-testid="document-content-card"
            >
              <MarkdownCodeEditor
                testId="markdown-code-editor"
                value={markdown}
                onChange={onMarkdownChange}
                readOnly={interactionMode === "viewing"}
                autoFocus
              />
            </div>
          </div>
        </div>
        {hasCommentRailSpace ? (
          <div
            data-testid="document-review-rail"
            className={reviewRailClass}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
});

const PageCardEditorSurface = memo(function PageCardEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  onSave,
  onSaveStateChange,
  editorViewMode,
  interactionMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
  saveBlocked = false,
  forceResetKey = null,
}: PageCardEditorSurfaceProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSaveRef = useRef<Promise<ManualSaveResult> | null>(null);
  const pendingMarkdownRef = useRef(page.content);
  const recentMarkdownRef = useRef<Set<string>>(new Set());
  const previousEditorViewModeRef = useRef<EditorViewMode>(editorViewMode);
  const lastAcceptedMarkdownRef = useRef(page.content);
  const localDirtyRef = useRef(false);
  const forceResetKeyRef = useRef(forceResetKey);
  const [markdown, setMarkdown] = useState(page.content);
  const [richTextSourceMarkdown, setRichTextSourceMarkdown] = useState(
    page.content,
  );
  const [richTextSourceVersion, setRichTextSourceVersion] = useState(0);

  const reportDirtyState = useCallback(
    (isDirty: boolean) => {
      if (localDirtyRef.current === isDirty) return;
      localDirtyRef.current = isDirty;
      onDirtyStateChange?.(isDirty);
    },
    [onDirtyStateChange],
  );

  const acceptMarkdown = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      lastAcceptedMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      setRichTextSourceMarkdown(nextMarkdown);
      setRichTextSourceVersion((current) => current + 1);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(false);
      onSaveStateChange("saved");
    },
    [onLocalContentChange, onSaveStateChange, reportDirtyState],
  );

  const rememberRecentMarkdown = useCallback((nextMarkdown: string) => {
    recentMarkdownRef.current.add(nextMarkdown);
    if (recentMarkdownRef.current.size > 10) {
      const iterator = recentMarkdownRef.current.values();
      recentMarkdownRef.current.delete(iterator.next().value as string);
    }
  }, []);

  const performSave = useCallback(
    async (nextMarkdown: string): Promise<ManualSaveResult> => {
      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return { status: "blocked" };
      }

      rememberRecentMarkdown(nextMarkdown);
      onSaveStateChange("saving");

      try {
        await onSave(page.id, nextMarkdown);
        lastAcceptedMarkdownRef.current = nextMarkdown;
        reportDirtyState(pendingMarkdownRef.current !== nextMarkdown);
        onSaveStateChange(
          pendingMarkdownRef.current === nextMarkdown ? "saved" : "saving",
        );
        return { status: "saved" };
      } catch (error) {
        console.error(
          JSON.stringify({
            severity: "error",
            event: "document.save.failed",
            documentId: page.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        onSaveStateChange("error");
        return { status: "error", error };
      }
    },
    [
      onSave,
      onSaveStateChange,
      page.id,
      rememberRecentMarkdown,
      reportDirtyState,
      saveBlocked,
    ],
  );

  const performSaveRef = useRef(performSave);
  performSaveRef.current = performSave;

  const flushSave = useCallback((): Promise<ManualSaveResult> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    if (inFlightSaveRef.current) return inFlightSaveRef.current;

    const savePending = async (): Promise<ManualSaveResult> => {
      while (pendingMarkdownRef.current !== lastAcceptedMarkdownRef.current) {
        const result = await performSaveRef.current(pendingMarkdownRef.current);
        if (result.status !== "saved") return result;
      }
      onSaveStateChange("saved");
      return { status: "saved" };
    };

    const operation = savePending();
    inFlightSaveRef.current = operation;
    void operation.finally(() => {
      if (inFlightSaveRef.current === operation) {
        inFlightSaveRef.current = null;
      }
    });
    return operation;
  }, [onSaveStateChange]);

  const scheduleSave = useCallback(
    (nextMarkdown: string) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return;
      }

      onSaveStateChange("saving");
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void flushSave();
      }, 500);
    },
    [flushSave, onSaveStateChange, saveBlocked],
  );

  useEffect(() => {
    onSaveControllerChange?.({ flushSave });
    return () => onSaveControllerChange?.(null);
  }, [flushSave, onSaveControllerChange]);

  const handleMarkdownChange = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(nextMarkdown !== lastAcceptedMarkdownRef.current);
      scheduleSave(nextMarkdown);
    },
    [onLocalContentChange, reportDirtyState, scheduleSave],
  );

  useEffect(() => {
    const forceResetChanged = forceResetKeyRef.current !== forceResetKey;
    forceResetKeyRef.current = forceResetKey;

    if (forceResetChanged) {
      recentMarkdownRef.current.delete(page.content);
      acceptMarkdown(page.content);
      return;
    }

    if (recentMarkdownRef.current.has(page.content)) {
      recentMarkdownRef.current.delete(page.content);
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = markdown;
      reportDirtyState(markdown !== page.content);
      return;
    }

    if (localDirtyRef.current && markdown !== page.content) {
      return;
    }

    if (markdown === page.content) {
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = page.content;
      reportDirtyState(false);
      return;
    }

    acceptMarkdown(page.content);
  }, [acceptMarkdown, forceResetKey, markdown, page.content, reportDirtyState]);

  useEffect(() => {
    if (!saveBlocked || !saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    onSaveStateChange(
      pendingMarkdownRef.current === lastAcceptedMarkdownRef.current
        ? "saved"
        : "unsaved",
    );
  }, [onSaveStateChange, saveBlocked]);

  useEffect(() => {
    const previousEditorViewMode = previousEditorViewModeRef.current;
    previousEditorViewModeRef.current = editorViewMode;

    if (previousEditorViewMode !== "code" || editorViewMode !== "rich-text") {
      return;
    }

    setRichTextSourceMarkdown(markdown);
    setRichTextSourceVersion((current) => current + 1);
  }, [editorViewMode, markdown]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, []);

  const hasCommentRailSpace = useMemo(
    () => editorViewMode === "code" && criticMarkdownHasReviewRail(markdown),
    [editorViewMode, markdown],
  );

  useEffect(() => {
    if (editorViewMode !== "code") return;
    onCommentRailPresenceChange?.(hasCommentRailSpace);
  }, [editorViewMode, hasCommentRailSpace, onCommentRailPresenceChange]);

  if (editorViewMode === "code") {
    return (
      <CodeEditorSurface
        markdown={markdown}
        hasCommentRailSpace={hasCommentRailSpace}
        interactionMode={interactionMode}
        layout={layout}
        onMarkdownChange={handleMarkdownChange}
      />
    );
  }

  const effectiveRichTextSourceMarkdown =
    !localDirtyRef.current &&
    !recentMarkdownRef.current.has(page.content) &&
    markdown !== page.content
      ? page.content
      : richTextSourceMarkdown;

  return (
    <RichTextEditorSurface
      key={`${page.id}:${richTextSourceVersion}:${effectiveRichTextSourceMarkdown}`}
      page={page}
      activeDocumentPath={activeDocumentPath}
      selected={selected}
      layout={layout}
      focusRequestKey={focusRequestKey}
      sourceMarkdown={effectiveRichTextSourceMarkdown}
      onMarkdownChange={handleMarkdownChange}
      beforeNavigate={async () => (await flushSave()).status === "saved"}
      interactionMode={interactionMode}
      onCommentRailPresenceChange={onCommentRailPresenceChange}
      backend={backend}
      onEditorReady={onEditorReady}
    />
  );
});

export function PageCard({
  page,
  activeDocumentPath = null,
  selected = false,
  layout = "default",
  focusRequestKey = null,
  onSave,
  onSaveStateChange,
  editorViewMode = "rich-text",
  interactionMode = "editing",
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
  saveBlocked,
  forceResetKey,
}: PageCardProps) {
  const [saveState, setSaveState] = useState<DocumentSaveState>("saved");

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [onSaveStateChange, saveState]);

  return (
    <div className="w-full">
      <PageCardEditorSurface
        page={page}
        activeDocumentPath={activeDocumentPath}
        selected={selected}
        layout={layout}
        focusRequestKey={focusRequestKey}
        onSave={onSave}
        onSaveStateChange={setSaveState}
        editorViewMode={editorViewMode}
        interactionMode={interactionMode}
        backend={backend}
        onEditorReady={onEditorReady}
        onCommentRailPresenceChange={onCommentRailPresenceChange}
        onDirtyStateChange={onDirtyStateChange}
        onLocalContentChange={onLocalContentChange}
        onSaveControllerChange={onSaveControllerChange}
        saveBlocked={saveBlocked}
        forceResetKey={forceResetKey}
      />
    </div>
  );
}
