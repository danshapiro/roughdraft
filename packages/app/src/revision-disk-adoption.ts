import { mergeReviewDrafts, type SyncDraft } from "@roughdraft/rfm";
import { EditorState } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import type { Node, Schema } from "@tiptap/pm/model";
import {
  editorStateToCriticMarkdown,
  type CriticComment,
} from "./critic-markup";
import { rejectCriticChangeTransaction } from "./editor-extensions";
import { suggestionDetail } from "./revision-bulk";
import {
  cleanRevisionDocument,
  createSourceSpellingPreserver,
} from "./revision-markdown";
import {
  projectAcceptedDocument,
  suggestionPositions,
} from "./revision-projection";
import {
  parseRemoteRevision,
  replaceRevisionContent,
} from "./revision-remote-source";
import { cleanSourceFromNode } from "./revision-clean-cache";

function annotationRanges(doc: Node) {
  const comments = new Map<string, { from: number; to: number }>();
  const suggestions = new Map<string, { from: number; to: number }>();
  const include = (
    map: typeof comments,
    id: string,
    from: number,
    to: number,
  ) => {
    const old = map.get(id);
    map.set(id, {
      from: Math.min(old?.from ?? from, from),
      to: Math.max(old?.to ?? to, to),
    });
  };
  doc.descendants((node, position) => {
    if (node.type.name === "criticChangeBlock")
      include(
        suggestions,
        node.attrs.change.changeId,
        position,
        position + node.nodeSize,
      );
    for (const mark of node.marks) {
      if (mark.type.name === "criticChange")
        include(
          suggestions,
          mark.attrs.changeId,
          position,
          position + node.nodeSize,
        );
      if (mark.type.name === "commentRef")
        for (const id of mark.attrs.commentIds as string[])
          include(comments, id, position, position + node.nodeSize);
    }
  });
  return { comments, suggestions };
}

/** Reconcile disk's accepted text into a detached review state; never mutate the live editor. */
export function adoptRevisionDisk(
  base: SyncDraft,
  markdown: string,
  schema: Schema,
  force = false,
): SyncDraft | null {
  return adoptDisk(base, markdown, schema, force);
}
function adoptDisk(
  base: SyncDraft,
  markdown: string,
  schema: Schema,
  force: boolean,
  projected?: ReturnType<typeof parseRemoteRevision>,
): SyncDraft | null {
  let state = EditorState.create({ schema });
  const parsedBase = parseRemoteRevision(base.markdown, state);
  state = EditorState.create({
    schema,
    doc: parsedBase.doc.type.create(
      {
        ...parsedBase.doc.attrs,
        reviewed: base.reviewed ?? [],
        kept: Object.keys(base.decisions),
        sourceMetadata: {
          markdown: base.markdown,
          frontmatter: parsedBase.frontmatter,
          endmatter: parsedBase.endmatter,
        },
      },
      parsedBase.doc.content,
    ),
  });
  const parsedIncoming = projected ?? parseRemoteRevision(markdown, state);
  // First adopt disk's accepted text, then add its annotations. The saved review
  // owns existing IDs; disk-only collisions are renamed before reaching the live editor.
  if (
    suggestionPositions(parsedIncoming.doc).size ||
    parsedIncoming.comments.size
  ) {
    const sourceDoc = parsedIncoming.doc.type.create(
      {
        ...parsedIncoming.doc.attrs,
        sourceMetadata: {
          markdown,
          frontmatter: parsedIncoming.frontmatter,
          endmatter: parsedIncoming.endmatter,
        },
      },
      parsedIncoming.doc.content,
    );
    const clean = cleanSourceFromNode(
      markdown,
      sourceDoc,
      parsedIncoming.comments,
    );
    const adopted = adoptDisk(base, clean, schema, force, {
      ...parsedIncoming,
      doc: projectAcceptedDocument(parsedIncoming.doc).doc,
      comments: new Map(),
    });
    if (!adopted) return null;
    const disk: SyncDraft = {
      markdown,
      cleanMarkdown: clean,
      decisions: {},
      reviewComments: [...parsedIncoming.comments.values()].map((comment) => ({
        ...comment,
        changeId: comment.parentCommentId ?? "document",
      })),
    };
    const plain: SyncDraft = {
      markdown: clean,
      cleanMarkdown: clean,
      decisions: {},
      reviewComments: [],
    };
    const merged = mergeReviewDrafts(plain, disk, adopted, {
      server: false,
      budgetMs: 100,
    });
    return merged.status === "merged"
      ? { ...merged.draft, cleanMarkdown: clean }
      : null;
  }
  const accepted = projectAcceptedDocument(state.doc);
  const originalComments = new Map(parsedBase.comments);
  for (const comment of base.reviewComments)
    originalComments.set(comment.id, comment);
  const canonicalOriginal = editorStateToCriticMarkdown(
    state.doc.toJSON(),
    originalComments,
    { frontmatter: parsedBase.frontmatter, endmatter: parsedBase.endmatter },
  );
  const changes = replaceRevisionContent(
    EditorState.create({ schema, doc: accepted.doc }),
    parsedIncoming.doc,
  );
  const inverse = accepted.mapping.invert();
  const ranges = annotationRanges(state.doc);
  const affectedComments = new Set<string>();
  const affectedSuggestions = new Set<string>();
  const ambiguousSuggestions = new Set<string>();
  const intersects = (
    from: number,
    to: number,
    range: { from: number; to: number },
  ) =>
    from === to
      ? from > range.from && from < range.to
      : from < range.to && to > range.from;
  for (const step of changes.steps) {
    const json = step.toJSON() as { from?: number; to?: number };
    if (json.from === undefined) continue;
    const end = json.to ?? json.from;
    const ambiguous =
      !force &&
      json.from === end &&
      inverse.map(json.from, -1) !== inverse.map(json.from, 1);
    const from = inverse.map(json.from, -1);
    const to = inverse.map(end, 1);
    if (ambiguous) {
      for (const [id, range] of ranges.suggestions)
        if (intersects(from, to, range)) ambiguousSuggestions.add(id);
      continue;
    }
    for (const [id, range] of ranges.comments)
      if (force || intersects(from, to, range)) affectedComments.add(id);
    for (const [id, range] of ranges.suggestions)
      if (force || intersects(from, to, range)) affectedSuggestions.add(id);
  }
  if (
    !force &&
    [...ambiguousSuggestions].some((id) => !affectedSuggestions.has(id))
  )
    return null;
  if (force) {
    for (const id of ranges.comments.keys()) affectedComments.add(id);
    for (const id of ranges.suggestions.keys()) affectedSuggestions.add(id);
  }
  const outdated = [...(base.outdatedSuggestions ?? [])];
  for (const id of affectedSuggestions) {
    const detail = suggestionDetail(state.doc, id);
    let attribution: Pick<
      NonNullable<SyncDraft["outdatedSuggestions"]>[number],
      "createdAt" | "authorType" | "authorId"
    > = {};
    state.doc.descendants((node) => {
      const change =
        node.attrs.change ??
        node.marks.find((mark) => mark.type.name === "criticChange")?.attrs;
      if (change?.changeId === id)
        attribution = {
          createdAt: change.createdAt,
          authorType: change.authorType,
          authorId: change.authorType === "ai" ? null : change.authorId,
        };
    });
    if (!outdated.some((item) => item.id === id))
      outdated.push({
        id,
        originalText: detail.oldText,
        proposedText: detail.newText,
        reason: "The file changed on disk across this proposal.",
        ...attribution,
      });
    const rejected = rejectCriticChangeTransaction(state, id);
    if (rejected) state = state.apply(rejected);
  }
  const commentMap = new Map<string, SyncDraft["reviewComments"][number]>(
    [...parsedBase.comments.values()].map((comment) => [
      comment.id,
      { ...comment, changeId: comment.parentCommentId ?? "document" },
    ]),
  );
  for (const comment of base.reviewComments)
    commentMap.set(comment.id, comment);
  const annotationTr = state.tr;
  for (const id of affectedComments) {
    const old = commentMap.get(id);
    const range = ranges.comments.get(id);
    if (old)
      commentMap.set(id, {
        ...old,
        scope: "document",
        changeId: "document",
        originalQuote: range
          ? parsedBase.doc.textBetween(range.from, range.to, "\n")
          : old.originalQuote,
        detachedReason: "The file changed on disk across this comment.",
      });
    state.doc.descendants((node, pos) => {
      const mark = node.marks.find(
        (candidate) =>
          candidate.type.name === "commentRef" &&
          candidate.attrs.commentIds.includes(id),
      );
      if (!mark) return;
      annotationTr.removeMark(pos, pos + node.nodeSize, mark);
      const ids = (mark.attrs.commentIds as string[]).filter(
        (item) => item !== id,
      );
      if (ids.length)
        annotationTr.addMark(
          pos,
          pos + node.nodeSize,
          mark.type.create({ ...mark.attrs, commentIds: ids }),
        );
    });
  }
  if (annotationTr.docChanged) state = state.apply(annotationTr);
  const projection = projectAcceptedDocument(state.doc);
  const acceptedState = EditorState.create({ schema, doc: projection.doc });
  const acceptedUpdate = replaceRevisionContent(
    acceptedState,
    parsedIncoming.doc,
  );
  let mapping = projection.mapping.invert();
  const transaction = state.tr;
  for (const step of acceptedUpdate.steps) {
    const mapped = step.map(mapping);
    if (!mapped || transaction.maybeStep(mapped).failed) return null;
    const nextMapping = new Mapping();
    nextMapping.appendMap(step.getMap().invert());
    nextMapping.appendMapping(mapping);
    nextMapping.appendMap(mapped.getMap());
    mapping = nextMapping;
  }
  if (
    !projectAcceptedDocument(transaction.doc).doc.content.eq(
      parsedIncoming.doc.content,
    )
  )
    return null;
  const comments = new Map<string, CriticComment>(
    [...commentMap].map(([id, comment]) => [id, comment]),
  );
  const review = editorStateToCriticMarkdown(
    transaction.doc.toJSON(),
    comments,
    {
      frontmatter: parsedIncoming.frontmatter,
      endmatter: parsedIncoming.endmatter,
    },
  );
  const sourceReview =
    createSourceSpellingPreserver(base.markdown, canonicalOriginal)(review) ??
    review;
  const clean = cleanRevisionDocument(parsedIncoming.doc.toJSON());
  const preserved =
    createSourceSpellingPreserver(markdown, clean)(clean) ?? clean;
  return {
    ...base,
    markdown: sourceReview,
    cleanMarkdown: preserved,
    reviewComments: [...commentMap.values()],
    outdatedSuggestions: outdated,
    reviewed: base.reviewed,
  };
}
