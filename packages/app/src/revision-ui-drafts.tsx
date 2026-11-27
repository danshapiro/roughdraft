import { createContext, useContext, useSyncExternalStore } from "react";
import type { CriticComment } from "./critic-markup";
import {
  isPrivateCommentAnchor,
  type PrivateCommentAnchor,
} from "./revision-private-anchors";

export interface CommentDraftState {
  value: string;
  original: string;
  editing: boolean;
  /** A new reply is private until Save, so its blank target is not submitted. */
  target?: CriticComment;
  anchor?: PrivateCommentAnchor;
}

export function createPrivateCommentId() {
  return `c-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

export function privateReplyTarget(id: string, value: unknown) {
  if (!value || typeof value !== "object") return null;
  const target = (value as CommentDraftState).target;
  return target &&
    target.id === id &&
    target.content === "" &&
    typeof target.createdAt === "string" &&
    typeof target.parentCommentId === "string" &&
    target.parentCommentId.length > 0 &&
    target.parentCommentId !== id
    ? { ...target, parentCommentId: target.parentCommentId }
    : null;
}

export function privateRootTarget(id: string, value: unknown) {
  if (!value || typeof value !== "object") return null;
  const draft = value as CommentDraftState;
  const target = draft.target;
  return target &&
    target.id === id &&
    target.content === "" &&
    typeof target.createdAt === "string" &&
    !target.parentCommentId &&
    isPrivateCommentAnchor(draft.anchor)
    ? { ...target }
    : null;
}

export function commentDraftMatchesTarget(
  draft: CommentDraftState | undefined,
  comment: CriticComment,
) {
  if (!draft?.target) return true;
  const target =
    privateReplyTarget(comment.id, draft) ??
    privateRootTarget(comment.id, draft);
  return Boolean(
    target &&
      comment.content === "" &&
      target.createdAt === comment.createdAt &&
      (target.parentCommentId ?? null) === (comment.parentCommentId ?? null) &&
      (target.authorId ?? null) === (comment.authorId ?? null) &&
      (target.authorType ?? null) === (comment.authorType ?? null),
  );
}
interface UiDraftSnapshot {
  version: number;
  comments: Record<string, CommentDraftState>;
  suggestion?: unknown;
}
export class RevisionUiDraftStore {
  private snapshot: UiDraftSnapshot = { version: 0, comments: {} };
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  privateCommentIds = (comments?: ReadonlyMap<string, CriticComment>) =>
    new Set(
      Object.entries(this.snapshot.comments).flatMap(([id, draft]) => {
        const target =
          privateReplyTarget(id, draft) ?? privateRootTarget(id, draft);
        const current = comments?.get(id);
        return target && (!current || commentDraftMatchesTarget(draft, current))
          ? [id]
          : [];
      }),
    );
  private publish(update: Omit<UiDraftSnapshot, "version">) {
    this.snapshot = { ...update, version: this.snapshot.version + 1 };
    for (const listener of this.listeners) listener();
  }
  setComment(id: string, draft: CommentDraftState | null) {
    const previous = this.snapshot.comments[id];
    if (JSON.stringify(previous) === JSON.stringify(draft ?? undefined)) return;
    const comments = { ...this.snapshot.comments };
    if (draft) comments[id] = draft;
    else delete comments[id];
    this.publish({ ...this.snapshot, comments });
  }
  setSuggestion(suggestion: unknown) {
    this.publish({ ...this.snapshot, suggestion });
  }
  remap(ids: Record<string, string>) {
    if (!Object.keys(ids).length) return;
    const comments = Object.fromEntries(
      Object.entries(this.snapshot.comments).map(([id, draft]) => [
        ids[id] ?? id,
        draft.target
          ? {
              ...draft,
              target: {
                ...draft.target,
                id: ids[draft.target.id] ?? draft.target.id,
                parentCommentId: draft.target.parentCommentId
                  ? (ids[draft.target.parentCommentId] ??
                    draft.target.parentCommentId)
                  : draft.target.parentCommentId,
              },
            }
          : draft,
      ]),
    );
    this.publish({ ...this.snapshot, comments });
  }
  read = (): Record<string, unknown> => ({
    comments: this.snapshot.comments,
    suggestion: this.snapshot.suggestion,
  });
  restore = (data: Record<string, unknown>) => {
    const comments: Record<string, CommentDraftState> = {};
    if (data.comments && typeof data.comments === "object")
      for (const [id, value] of Object.entries(data.comments)) {
        if (!value || typeof value !== "object") continue;
        const draft = value as CommentDraftState;
        const target =
          privateReplyTarget(id, draft) ?? privateRootTarget(id, draft);
        if (
          typeof draft.value === "string" &&
          typeof draft.original === "string"
        )
          comments[id] = {
            value: draft.value,
            original: draft.original,
            editing: Boolean(draft.editing),
            ...(target ? { target } : {}),
            ...(target && isPrivateCommentAnchor(draft.anchor)
              ? { anchor: draft.anchor }
              : {}),
          };
      }
    this.publish({ comments, suggestion: data.suggestion });
  };
}
export const RevisionUiDraftContext =
  createContext<RevisionUiDraftStore | null>(null);
const empty: UiDraftSnapshot = { version: 0, comments: {} };
const noSubscribe = () => () => {};
export function useRevisionUiDrafts() {
  const store = useContext(RevisionUiDraftContext);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getSnapshot ?? (() => empty),
    () => empty,
  );
  return { store, snapshot };
}
