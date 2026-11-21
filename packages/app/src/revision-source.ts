import { Extension, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  type CriticComment,
  criticMarkdownToEditorState,
} from "./critic-markup";
import { editableMarkdownOptions } from "./revision-markdown";

export interface RevisionSourceMetadata {
  markdown: string;
  frontmatter: string | null;
  endmatter: string | null;
  sourceComments?: CriticComment[];
  sourceSpelling?: string;
}

export const RevisionSource = Extension.create({
  name: "revisionSource",
  addGlobalAttributes: () => [
    {
      types: ["doc"],
      attributes: { sourceMetadata: { default: null, rendered: false } },
    },
  ],
});

export function revisionSourceMetadata(doc: ProseMirrorNode) {
  return doc.attrs.sourceMetadata as RevisionSourceMetadata | null;
}

/** TipTap's final typing paragraph is layout furniture after a non-text block. */
export function sameSourceContent(
  left: ProseMirrorNode,
  right: ProseMirrorNode,
) {
  const content = (doc: ProseMirrorNode) => {
    const last = doc.lastChild;
    return doc.childCount > 1 &&
      last?.type.name === "paragraph" &&
      last.content.size === 0 &&
      doc.child(doc.childCount - 2).type.name !== "paragraph"
      ? doc.content.cut(0, doc.content.size - last.nodeSize)
      : doc.content;
  };
  return content(left).eq(content(right));
}

/** Source edits own represented comments; detached sidecar threads stay intact. */
export function revisionSourceComments(
  markdown: string,
  previousMarkdown: string,
  parsed: ReadonlyMap<string, CriticComment>,
  existing: ReadonlyMap<string, CriticComment>,
) {
  const previous = criticMarkdownToEditorState(
    previousMarkdown,
    editableMarkdownOptions,
  ).comments;
  const comments = new Map(parsed);
  for (const [id, comment] of existing) {
    const next = comments.get(id);
    if (next && !markdown.includes(next.createdAt))
      comments.set(id, { ...next, createdAt: comment.createdAt });
    else if (!next && !previous.has(id)) comments.set(id, comment);
  }
  return comments;
}

function commentSignature(comment: CriticComment | undefined) {
  return comment
    ? JSON.stringify([
        comment.id,
        comment.content,
        comment.createdAt,
        comment.authorType ?? null,
        comment.authorId ?? null,
        comment.parentCommentId ?? null,
        comment.scope ?? null,
      ])
    : null;
}

/** Undo only feedback owned by that source edit; keep subsequent UI feedback. */
export function mergeSourceHistoryComments(
  from: CriticComment[] | undefined,
  to: CriticComment[] | undefined,
  current: ReadonlyMap<string, CriticComment>,
) {
  const result = new Map(current);
  if (!from || !to) return result;
  const previous = new Map(from.map((comment) => [comment.id, comment]));
  const target = new Map(to.map((comment) => [comment.id, comment]));
  for (const id of new Set([...previous.keys(), ...target.keys()])) {
    const sourceBefore = previous.get(id);
    const sourceAfter = target.get(id);
    if (
      commentSignature(sourceBefore) === commentSignature(sourceAfter) ||
      commentSignature(current.get(id)) !== commentSignature(sourceBefore)
    )
      continue;
    if (sourceAfter) result.set(id, sourceAfter);
    else {
      const newerReply = [...current.values()].some((comment) => {
        if (previous.has(comment.id)) return false;
        let parent = comment.parentCommentId;
        for (let count = 0; parent && count < current.size; count++) {
          if (parent === id) return true;
          parent = current.get(parent)?.parentCommentId;
        }
        return false;
      });
      if (!newerReply) result.delete(id);
    }
  }
  return result;
}

/** Keep generated dates stable while typing source that has no explicit dates. */
function stableSuggestionDates(
  doc: JSONContent,
  before: ProseMirrorNode,
  markdown: string,
) {
  const dates = new Map<string, string>();
  before.descendants((node) => {
    const change = node.attrs.change;
    if (change?.changeId) dates.set(change.changeId, change.createdAt);
    for (const mark of node.marks) {
      if (mark.type.name === "criticChange")
        dates.set(mark.attrs.changeId, mark.attrs.createdAt);
    }
  });
  const visit = (node: JSONContent) => {
    const attrs = [
      ...(node.attrs?.change ? [node.attrs.change] : []),
      ...(node.marks ?? [])
        .filter((mark) => mark.type === "criticChange")
        .map((mark) => mark.attrs),
    ];
    for (const change of attrs) {
      if (!change) continue;
      const previous = dates.get(change.changeId);
      if (previous && !markdown.includes(change.createdAt))
        change.createdAt = previous;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
}

/** Replace only the changed rendered range, retaining mappings and history. */
export function replaceRevisionSource(state: EditorState, markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  stableSuggestionDates(parsed.doc, state.doc, markdown);
  const next = state.schema.nodeFromJSON(parsed.doc);
  const transaction = state.tr;
  const start = state.doc.content.findDiffStart(next.content);
  if (start !== null) {
    const end = state.doc.content.findDiffEnd(next.content) ?? {
      a: state.doc.content.size,
      b: next.content.size,
    };
    const overlap = start - Math.min(end.a, end.b);
    if (overlap > 0) {
      end.a += overlap;
      end.b += overlap;
    }
    transaction.replace(start, end.a, next.slice(start, end.b));
  }
  transaction.setDocAttribute("sourceMetadata", {
    markdown,
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
  } satisfies RevisionSourceMetadata);
  return { ...parsed, transaction };
}
