import type { JSONContent } from "@tiptap/core";
import type {
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ControlledDocumentReview } from "./controlled-review";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CommentEditorList } from "./CommentEditorList";
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
  SUGGESTED_PARAGRAPH_SENTINEL,
} from "./editor-extensions";
import { cn } from "./lib/utils";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { buildLocationForLinkedMarkdownDocument } from "./app-navigation";
import { toHtml } from "./markdown";
import type { Page, StorageBackend } from "./storage";
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
  onMarkdownChange: (markdown: string) => void;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  controlledReview?: ControlledDocumentReview;
}

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

function areCommentIdListsEqual(
  current: string[] | null | undefined,
  next: string[] | null | undefined,
) {
  if (!current || !next) return current === next;
  if (current.length !== next.length) return false;
  return current.every((commentId, index) => commentId === next[index]);
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

function getAnchorCommentIds(
  editor: Editor | null,
  commentId: string,
): string[] {
  const anchorElement = findCommentAnchorElement(editor, commentId);
  if (!anchorElement) return [];
  return parseCommentIds(anchorElement.dataset.commentIds);
}

function addCommentIdsToAnchor(
  editor: Editor | null,
  anchorCommentId: string,
  commentIdsToAdd: string[],
): string[] | null {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  const anchorCommentIds = getAnchorCommentIds(editor, anchorCommentId);
  const nextCommentIds = [
    ...new Set([...anchorCommentIds, ...commentIdsToAdd]),
  ];
  if (!commentMarkType || anchorCommentIds.length === 0) return null;

  let found = false;
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

  editor.view.dispatch(tr);
  return nextCommentIds;
}

function getDocumentCriticChanges(
  editor: Editor,
): Array<Pick<CriticChangeAttrs, "changeId">> {
  const changes = new Map<string, Pick<CriticChangeAttrs, "changeId">>();

  editor.state.doc.descendants((node) => {
    if (!node.isText) return;

    for (const mark of node.marks) {
      if (mark.type.name !== "criticChange") continue;
      if (typeof mark.attrs.changeId !== "string") continue;

      changes.set(mark.attrs.changeId, { changeId: mark.attrs.changeId });
    }
  });

  return [...changes.values()];
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
    ".critic-change[data-critic-change-id]",
  );
  const editorRect = editorElement.getBoundingClientRect();

  for (const element of changeElements) {
    const changeId = element.dataset.criticChangeId;
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
    if (suppliedSuggestions || !node.isText || !node.text) return;

    const changeMark = node.marks.find(
      (mark) =>
        mark.type.name === "criticChange" &&
        typeof mark.attrs.changeId === "string",
    );
    if (!changeMark) return;

    const change = changeMark.attrs as CriticChangeAttrs;
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
      existing.newText += node.text;
    } else {
      existing.oldText += node.text;
    }

    for (const mark of node.marks) {
      if (mark.type.name !== "commentRef") continue;
      if (!Array.isArray(mark.attrs.commentIds)) continue;

      existing.commentIds = [
        ...new Set([...existing.commentIds, ...mark.attrs.commentIds]),
      ];
    }

    changes.set(changeId, existing);
  });

  for (const change of changes.values()) {
    Object.assign(change, anchors.get(change.changeId));
    const rootCommentIds = [...comments.values()]
      .filter((comment) => comment.parentCommentId === change.changeId)
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

  editor.view.dispatch(tr);
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
}: RichTextEditorSurfaceProps) {
  const editorRef = useRef<Editor | null>(null);
  const controlledReviewRef = useRef(controlledReview);
  const lastControlledDocumentRef = useRef<{
    editor: Editor;
    doc: ProseMirrorNode;
  } | null>(null);
  controlledReviewRef.current = controlledReview;
  const isControlled = Boolean(controlledReview);
  const hoveredChangeIdRef = useRef<string | null>(null);
  const hoveredCommentIdRef = useRef<string | null>(null);
  const [isWideReview, setIsWideReview] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1100px)").matches
      : true,
  );
  useEffect(() => {
    if (!isControlled || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1100px)");
    const update = () => setIsWideReview(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [isControlled]);
  const criticChangeFrameRef = useRef<number | null>(null);
  const interactionModeRef = useRef<DocumentInteractionMode>(interactionMode);
  const commentsRef = useRef<Map<string, CriticComment>>(new Map());
  const suppressNextMarkdownUpdateRef = useRef(false);
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
      }),
    [activeDocumentPath, backend],
  );

  const parsedContent = useMemo(
    () =>
      criticMarkdownToEditorState(sourceMarkdown, {
        resolveFileUrl,
        resolveLinkUrl,
      }),
    [resolveFileUrl, resolveLinkUrl, sourceMarkdown],
  );
  const [localComments, setComments] = useState<Map<string, CriticComment>>(
    () => controlledReview?.comments ?? parsedContent.comments,
  );
  // The controlled map and a newly selected reply arrive in the same render.
  // Reading a delayed local copy would clear that reply as "missing" and
  // collapse its native feedback thread before the editor can receive focus.
  const comments = controlledReview?.comments ?? localComments;
  const suppliedSuggestions = controlledReview?.suggestions;
  const reviewSuggestions = useMemo(() => {
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
  }, [suppliedSuggestions, criticChanges]);
  const frontmatterRef = useRef<string | null>(parsedContent.frontmatter);
  const endmatterRef = useRef<string | null>(parsedContent.endmatter);

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

  const emitMarkdownChange = useCallback(
    (doc?: JSONContent, nextComments?: Map<string, CriticComment>) => {
      if (controlledReviewRef.current) return;
      const currentEditor = editorRef.current;
      const currentDoc = doc ?? currentEditor?.getJSON();
      if (!currentDoc) return;

      onMarkdownChange(
        editorStateToCriticMarkdown(
          currentDoc,
          nextComments ?? commentsRef.current,
          {
            frontmatter: frontmatterRef.current,
            endmatter: endmatterRef.current,
          },
        ),
      );
    },
    [onMarkdownChange],
  );

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
          toHtml(markdown, {
            resolveFileUrl,
            resolveLinkUrl,
          }),
        )
        .run();
    },
    [backend, resolveFileUrl, resolveLinkUrl],
  );

  const refreshCriticChanges = useCallback(() => {
    if (criticChangeFrameRef.current != null) {
      cancelAnimationFrame(criticChangeFrameRef.current);
    }

    criticChangeFrameRef.current = requestAnimationFrame(() => {
      criticChangeFrameRef.current = null;
      setCriticChanges(
        getDocumentCriticChangeRailItems(
          editorRef.current,
          commentsRef.current,
          controlledReviewRef.current?.suggestions,
        ),
      );
    });
  }, []);

  useEffect(() => {
    return () => {
      if (criticChangeFrameRef.current != null) {
        cancelAnimationFrame(criticChangeFrameRef.current);
      }
    };
  }, []);

  const editor = useEditor(
    {
      extensions: createEditorExtensions("Start writing..."),
      content: controlledReview?.doc ?? parsedContent.doc,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: "tiptap min-h-[70vh]",
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(files);
          return true;
        },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void insertFiles(files);
            return true;
          }

          if (interactionModeRef.current !== "suggesting") return false;

          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;

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
              tr.insert(insertPos, view.state.schema.text(text, [newMark]));
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
              tr.insert(insertPos, view.state.schema.text(text, [mark]));
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
            tr.insert(from, view.state.schema.text(text, [mark]));
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          }

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleTextInput: (view, from, to, text) => {
          if (interactionModeRef.current !== "suggesting") return false;
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

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
              tr.insert(insertPos, view.state.schema.text(text, [newMark]));
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
              tr.insert(insertPos, view.state.schema.text(text, [mark]));
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
            tr.insert(from, view.state.schema.text(text, [mark]));
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          }

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleKeyDown: (view, event) => {
          if (interactionModeRef.current !== "suggesting") return false;

          if (event.key === "Enter") {
            event.preventDefault();

            const currentEditor = editorRef.current;
            if (!currentEditor) return true;

            const { selection } = view.state;
            if (!selection.empty) return true;

            const $from = selection.$from;
            if (!$from.parent.isTextblock) return true;
            if ($from.parentOffset !== $from.parent.content.size) return true;

            const change = createCriticChange("addition", undefined, {
              existingChanges: getDocumentCriticChanges(currentEditor),
            });
            const mark = view.state.schema.marks.criticChange.create(change);
            const tr = view.state.tr.split(selection.from);
            const insertPos = tr.selection.from;

            tr.insert(
              insertPos,
              view.state.schema.text(SUGGESTED_PARAGRAPH_SENTINEL, [mark]),
            );
            tr.setSelection(
              TextSelection.create(
                tr.doc,
                insertPos + SUGGESTED_PARAGRAPH_SENTINEL.length,
              ),
            );
            tr.scrollIntoView();
            view.dispatch(tr);
            return true;
          }

          // Handle Cut (Ctrl+X / Cmd+X)
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "x"
          ) {
            const { selection } = view.state;
            if (selection.empty) return false;

            const currentEditor = editorRef.current;
            if (!currentEditor) return false;

            event.preventDefault();
            const from = selection.from;
            const to = selection.to;
            const selectedText = view.state.doc.textBetween(from, to);
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
                from = Math.max(blockStart, selection.from - 1);
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
                to = Math.min(blockEnd, selection.to + 1);
              }
            }
          }

          if (from === to) {
            event.preventDefault();
            return true;
          }

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
      onUpdate: ({ editor: currentEditor }) => {
        if (controlledReviewRef.current) return;
        if (suppressNextMarkdownUpdateRef.current) {
          suppressNextMarkdownUpdateRef.current = false;
          return;
        }

        emitMarkdownChange(currentEditor.getJSON());
        refreshCriticChanges();
      },
    },
    [page.id],
  );

  editorRef.current = editor;
  selectedCommentIdRef.current = selectedCommentId;
  selectedChangeIdRef.current = selectedChangeId;
  hoveredChangeIdRef.current = hoveredChangeId;
  hoveredCommentIdRef.current = hoveredCommentId;

  useEffect(() => {
    editor?.setEditable(!isControlled && interactionMode !== "viewing", false);
  }, [editor, interactionMode, isControlled]);

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
      editor.state.tr.setMeta(controlledReviewHighlightKey, {
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
    if (!isControlled) return commentGroups;
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
  }, [isControlled, commentGroups, comments, reviewSuggestions, contentHeight]);

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
    if (!editor || isControlled) return;

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
  }, [editor, isControlled, parsedContent, refreshCriticChanges]);

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
      editor.state.tr.setMeta(commentHighlightPluginKey, {
        selectedCommentId,
        hoveredCommentId: effectiveHoveredCommentId,
      }),
    );
  }, [editor, hoveredCommentId, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredChangeId = selectedChangeId ? hoveredChangeId : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(criticChangeHighlightPluginKey, {
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

    const existingIds = getSelectionCommentIds(currentEditor);
    const comment = createCriticComment(undefined, {
      existingComments: commentsRef.current.values(),
    });
    const nextComments = new Map(commentsRef.current);
    nextComments.set(comment.id, comment);
    commentsRef.current = nextComments;
    setComments(nextComments);
    setNewCommentDraftIds((current) =>
      current.includes(comment.id) ? current : [...current, comment.id],
    );

    suppressNextMarkdownUpdateRef.current = true;
    currentEditor
      .chain()
      .focus()
      .setCommentRef({ commentIds: [...existingIds, comment.id] })
      .run();
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
      );
      if (suppressNextMarkdownUpdateRef.current) {
        suppressNextMarkdownUpdateRef.current = false;
      }
      if (!nextAnchorCommentIds) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [createControlledReply, measureLayout],
  );

  const removeSuggestionComments = useCallback(
    (changeId: string, currentEditor: Editor) => {
      const directCommentIds = [...commentsRef.current.values()]
        .filter((comment) => comment.parentCommentId === changeId)
        .map((comment) => comment.id);
      const commentIdsToDelete = [
        ...directCommentIds,
        ...directCommentIds.flatMap((commentId) =>
          getCommentDescendantIds(commentId, commentsRef.current),
        ),
      ];

      if (commentIdsToDelete.length === 0) return commentsRef.current;

      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();

      commentsRef.current = nextComments;
      setComments(nextComments);
      return nextComments;
    },
    [],
  );

  const acceptSuggestion = useCallback(
    (changeId: string) => {
      const controlled = controlledReviewRef.current;
      if (controlled) {
        if (controlled.canDecide && !controlled.disabled)
          controlled.onAccept(changeId);
        return;
      }
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().acceptCriticChange(changeId).run();
      const nextComments = removeSuggestionComments(changeId, currentEditor);
      setSelectedChangeId((current) => (current === changeId ? null : current));
      setHoveredChangeId((current) => (current === changeId ? null : current));
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges, removeSuggestionComments],
  );

  const rejectSuggestion = useCallback(
    (changeId: string) => {
      const controlled = controlledReviewRef.current;
      if (controlled) {
        if (controlled.canDecide && !controlled.disabled)
          controlled.onReject(changeId);
        return;
      }
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().rejectCriticChange(changeId).run();
      const nextComments = removeSuggestionComments(changeId, currentEditor);
      setSelectedChangeId((current) => (current === changeId ? null : current));
      setHoveredChangeId((current) => (current === changeId ? null : current));
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges, removeSuggestionComments],
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
      );
      if (suppressNextMarkdownUpdateRef.current) {
        suppressNextMarkdownUpdateRef.current = false;
      }
      if (!didAddCommentId) {
        return;
      }

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedChangeId(changeId);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
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

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();
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
  const hasReviewColumn = isControlled || hasReviewRail;
  const documentShellRef =
    useReviewLayoutShiftAnimation<HTMLDivElement>(hasReviewColumn);
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
    isControlled || layout === "embedded-demo"
      ? "hidden"
      : "min-[1100px]:hidden",
  );
  const reviewRailClass = cn(
    "document-comment-rail",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : isControlled
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
          {activeComments.length > 0 ? (
            <CommentEditorList
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
              className={cn(contentCardClass, "px-10 py-10 sm:px-14 sm:py-14")}
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
                  <EditorContent editor={editor} />
                </div>
              </EditorContextMenu>
            </div>
          </div>
        </div>
        <DocumentReviewRail
          className={reviewRailClass}
          layout={
            layout === "embedded-demo" || (isControlled && !isWideReview)
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
              : undefined
          }
          testId="document-review-rail"
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
        console.error("Failed to save page:", error);
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
        inFlightSaveRef.current = performSave(nextMarkdown).finally(() => {
          inFlightSaveRef.current = null;
        });
        void inFlightSaveRef.current;
      }, 500);
    },
    [onSaveStateChange, performSave, saveBlocked],
  );

  const flushSave = useCallback(async (): Promise<ManualSaveResult> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const currentMarkdown = pendingMarkdownRef.current;

    if (
      currentMarkdown === lastAcceptedMarkdownRef.current &&
      !inFlightSaveRef.current
    ) {
      onSaveStateChange("saved");
      return { status: "saved" };
    }

    if (inFlightSaveRef.current) {
      await inFlightSaveRef.current;
      if (pendingMarkdownRef.current === lastAcceptedMarkdownRef.current) {
        onSaveStateChange("saved");
        return { status: "saved" };
      }
    }

    return await performSave(pendingMarkdownRef.current);
  }, [onSaveStateChange, performSave]);

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
    () => criticMarkdownHasReviewRail(markdown),
    [markdown],
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
