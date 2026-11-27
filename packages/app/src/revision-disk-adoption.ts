import {
  contentSignature,
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
  nextReviewIdentity,
  renumberReviewDraft,
  reviewDraftSignature,
  reviewHistoryProposalIds,
  roughdraftAttachmentContexts,
  type SyncDraft,
  type SyncMerge,
} from "@roughdraft/rfm";
import type { Node, Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { Mapping, type Step } from "@tiptap/pm/transform";
import {
  type CriticComment,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { rejectCriticChangeTransaction } from "./editor-extensions";
import { splitYamlDocumentMetadata } from "./markdown";
import { suggestionDetail } from "./revision-bulk";
import { cleanSourceFromNode } from "./revision-clean-cache";
import {
  cleanRevisionDocument,
  cleanRevisionSourceMarkdown,
  createSourceSpellingPreserver,
} from "./revision-markdown";
import {
  documentMetadata,
  sameMetadata,
  withDocumentMetadata,
} from "./revision-metadata";
import {
  projectAcceptedDocument,
  suggestionPositions,
} from "./revision-projection";
import {
  parseRemoteRevision,
  replaceRevisionContent,
} from "./revision-remote-source";
import {
  RevisionCanonicalSpellingProof,
  RevisionSpellingProof,
} from "./revision-spelling-proof";

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

function suggestionAttribution(doc: Node, id: string) {
  let attribution: Pick<
    NonNullable<SyncDraft["outdatedSuggestions"]>[number],
    "createdAt" | "authorType" | "authorId"
  > = {};
  doc.descendants((node) => {
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
  return attribution;
}

/** Reconcile disk's accepted text into a detached review state; never mutate the live editor. */
export interface RevisionDiskBase {
  path: string;
  /** Exact disk text acknowledged by the shared review, not its edited draft. */
  markdown: string;
  resolution?: "local" | "incoming";
}
export type RevisionDiskMerge = SyncMerge & { diskCleanMarkdown?: string };
export function adoptRevisionDisk(
  base: SyncDraft,
  markdown: string,
  schema: Schema,
  force?: boolean,
): SyncDraft | null;
export function adoptRevisionDisk(
  base: SyncDraft,
  markdown: string,
  schema: Schema,
  force: boolean | undefined,
  diskBase: RevisionDiskBase | undefined,
): SyncDraft | RevisionDiskMerge | null;
export function adoptRevisionDisk(
  base: SyncDraft,
  markdown: string,
  schema: Schema,
  force = false,
  diskBase?: RevisionDiskBase,
): SyncDraft | RevisionDiskMerge | null {
  if (diskBase) {
    try {
      const result = mergeDisk(base, markdown, schema, force, diskBase);
      return result.status !== "merged" &&
        force &&
        diskBase.resolution === "incoming"
        ? reloadRawDisk(base, markdown, schema, diskBase)
        : result;
    } catch (error) {
      console.warn(
        JSON.stringify({
          severity: "warning",
          component: "revision-editor",
          event: "disk-adoption-unavailable",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return {
        status: "client-merge-required",
        draft: base,
        conflicts: [],
        signature: reviewDraftSignature(base),
        reason: "The outside update could not be mapped safely.",
      };
    }
  }
  return adoptDisk(base, markdown, schema, force);
}

function diskDraft(markdown: string, schema: Schema): SyncDraft {
  const parsed = parseRemoteRevision(markdown, EditorState.create({ schema }));
  const undated = new Set(
    extractRoughdraftReviewIndex(markdown)
      .items.filter((item) => item.kind === "comment" && !item.createdAt)
      .map((item) => item.id),
  );
  return {
    markdown,
    cleanMarkdown: cleanRevisionSourceMarkdown(markdown),
    decisions: {},
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      ...(undated.has(comment.id)
        ? { createdAt: "1970-01-01T00:00:00.000Z" }
        : {}),
      changeId: comment.parentCommentId ?? "document",
    })),
  };
}

function readDiskSides(
  review: SyncDraft,
  markdown: string,
  schema: Schema,
  diskBase: RevisionDiskBase,
) {
  const origin = review.diskOrigin;
  const aliases =
    origin?.path === diskBase.path &&
    origin.signature === contentSignature(diskBase.markdown)
      ? { ...origin.ids }
      : {};
  const rawIds = new Set(
    [diskBase.markdown, markdown].flatMap((source) =>
      extractRoughdraftReviewIndex(source).items.map((item) => item.id),
    ),
  );
  const targets = new Set(Object.values(aliases));
  const used = new Set([
    ...rawIds,
    ...targets,
    ...Object.keys(aliases),
    ...extractRoughdraftReviewIndex(review.markdown).items.map(
      (item) => item.id,
    ),
    ...review.reviewComments.map((comment) => comment.id),
    ...Object.keys(review.decisions),
    ...reviewHistoryProposalIds(review.reviewed),
    ...(review.outdatedSuggestions ?? []).map((item) => item.id),
  ]);
  // The disk and review have separate ID spaces once an imported item was
  // renamed. Reserve fresh targets before applying aliases simultaneously.
  for (const id of rawIds)
    if (!Object.hasOwn(aliases, id) && targets.has(id)) {
      const fresh = nextReviewIdentity(id, used);
      aliases[id] = fresh;
      used.add(fresh);
      targets.add(fresh);
    }
  const before = renumberReviewDraft(
    diskDraft(diskBase.markdown, schema),
    aliases,
  );
  const disk = renumberReviewDraft(diskDraft(markdown, schema), aliases);
  return { aliases, before, disk };
}

/** Disk and browser changes share the last acknowledged annotated disk base. */
function mergeDisk(
  review: SyncDraft,
  markdown: string,
  schema: Schema,
  force: boolean,
  diskBase: RevisionDiskBase,
): RevisionDiskMerge {
  if (
    review.cleanMarkdown !== undefined &&
    !provesAcceptedSpelling(review.markdown, review.cleanMarkdown, schema)
  )
    return {
      status: "client-merge-required",
      draft: review,
      conflicts: [],
      signature: reviewDraftSignature(review),
      reason: "The saved clean text could not be verified against its review.",
    };
  const { aliases, before, disk } = readDiskSides(
    review,
    markdown,
    schema,
    diskBase,
  );
  if (
    [before, disk].some(
      (side) =>
        side.cleanMarkdown !== undefined &&
        !provesAcceptedSpelling(side.markdown, side.cleanMarkdown, schema),
    )
  )
    return {
      status: "client-merge-required",
      draft: review,
      conflicts: [],
      signature: reviewDraftSignature(review),
      reason:
        "The source file's clean text could not be verified against its complete document.",
    };
  const options = {
    server: false,
    budgetMs: 100,
    ...(diskBase.resolution
      ? {
          resolution:
            diskBase.resolution === "local"
              ? ("incoming" as const)
              : ("local" as const),
        }
      : {}),
  };
  const plain = (draft: SyncDraft): SyncDraft => {
    const text =
      draft.cleanMarkdown ?? cleanRevisionSourceMarkdown(draft.markdown);
    return {
      markdown: text,
      cleanMarkdown: text,
      decisions: {},
      reviewComments: [],
    };
  };
  // Pending feedback is not a prose edit. First merge the accepted text, then
  // map each side's feedback onto that result before comparing its decisions.
  // In particular, review-only comments/suggestions displaced by an agent edit
  // become detached/outdated feedback rather than a false writing conflict.
  const sides = [before, disk, review];
  const plainSides = sides.map(plain);
  const prose = mergeReviewDrafts(
    plainSides[0],
    plainSides[1],
    plainSides[2],
    options,
  );
  if (prose.status !== "merged")
    return {
      ...prose,
      conflicts: prose.conflicts.map((conflict) => ({
        ...conflict,
        local: conflict.incoming,
        incoming: conflict.local,
      })),
    };
  const mapped = sides.map((value, index) =>
    adoptDisk(
      value,
      prose.draft.markdown,
      schema,
      force,
      undefined,
      plainSides[index].markdown,
    ),
  );
  const [mappedBefore, mappedDisk, mappedReview] = mapped;
  if (!mappedBefore || !mappedDisk || !mappedReview)
    return {
      status: "client-merge-required",
      draft: review,
      conflicts: [],
      signature: reviewDraftSignature(review),
      reason: "The outside update could not be mapped safely.",
    };
  // Removing a passage must not remove its discussion. Deliberately removing
  // markup on unchanged prose still counts as an annotation deletion.
  const diskCommentIds = new Set(
    mappedDisk.reviewComments.map((comment) => comment.id),
  );
  mappedDisk.reviewComments.push(
    ...mappedBefore.reviewComments.filter(
      (comment) =>
        comment.detachedReason &&
        !before.reviewComments.find((old) => old.id === comment.id)
          ?.detachedReason &&
        !diskCommentIds.has(comment.id),
    ),
  );
  const previousOutdated = new Set(
    (before.outdatedSuggestions ?? []).map((item) => item.id),
  );
  const diskOutdated = new Set(
    (mappedDisk.outdatedSuggestions ?? []).map((item) => item.id),
  );
  const displaced = (mappedBefore.outdatedSuggestions ?? []).filter(
    (item) => !previousOutdated.has(item.id) && !diskOutdated.has(item.id),
  );
  if (displaced.length)
    mappedDisk.outdatedSuggestions = [
      ...(mappedDisk.outdatedSuggestions ?? []),
      ...displaced,
    ];
  const merged = mergeReviewDrafts(
    mappedBefore,
    mappedDisk,
    mappedReview,
    options,
  );
  if (merged.status !== "merged")
    return {
      ...merged,
      conflicts: merged.conflicts.map((conflict) => ({
        ...conflict,
        local: conflict.incoming,
        incoming: conflict.local,
      })),
    };
  // The second merge settles annotations, not prose. A clean source can spell
  // the accepted model differently around pending markup. Keep its proven
  // spelling only after checking that the final feedback still projects to
  // exactly the same canonical accepted document.
  const mergedMarkdown = withDocumentMetadata(
    merged.draft.markdown,
    documentMetadata(prose.draft.markdown),
  );
  const finalState = EditorState.create({ schema });
  const parsedFinal = parseRemoteRevision(mergedMarkdown, finalState);
  const finalAccepted = projectAcceptedDocument(parsedFinal.doc).doc;
  const canonical = acceptedSpelling(finalAccepted, prose.draft.markdown);
  if (
    !new RevisionCanonicalSpellingProof().matches(
      prose.draft.markdown,
      canonical,
      finalAccepted,
      finalState,
    )
  )
    return {
      status: "client-merge-required",
      draft: review,
      conflicts: [],
      signature: reviewDraftSignature(review),
      reason:
        "The outside update could not be mapped without changing its accepted text.",
    };
  const ids: Record<string, string> = { ...aliases };
  for (const item of extractRoughdraftReviewIndex(markdown).items) {
    const mapped = aliases[item.id] ?? item.id;
    if (merged.idRemap?.[mapped]) ids[item.id] = merged.idRemap[mapped];
  }
  const draft: SyncDraft = {
    ...merged.draft,
    markdown: mergedMarkdown,
    cleanMarkdown: prose.draft.markdown,
    diskOrigin: {
      path: diskBase.path,
      signature: contentSignature(markdown),
      ids,
    },
  };
  // The remapping belongs to disk's identities. Browser drafts and their UI
  // references already own their IDs and must not be renamed with this map.
  return {
    ...merged,
    draft,
    diskCleanMarkdown: disk.cleanMarkdown,
    idRemap: undefined,
    signature: reviewDraftSignature(draft),
  };
}

/** Compare feedback meaning and its attachment, independently of source spelling. */
function reloadFeedback(draft: SyncDraft) {
  const items = extractRoughdraftReviewIndex(draft.markdown).items;
  const represented = new Map(items.map((item) => [item.id, item]));
  const contexts = roughdraftAttachmentContexts(
    draft.markdown,
    items
      .filter((item) => item.endOffset > item.offset)
      .map((item) => item.offset),
  );
  const context = (id: string) => {
    const item = represented.get(id);
    return item && item.endOffset > item.offset
      ? (contexts.get(item.offset) ?? null)
      : null;
  };
  const meanings = new Map(
    items.map((item) => [
      item.id,
      JSON.stringify([
        item.kind,
        item.suggestionKind ?? null,
        item.text,
        item.originalText ?? null,
        item.replacementText ?? null,
        item.anchorText ?? null,
        item.parentId,
        context(item.id),
      ]),
    ]),
  );
  for (const comment of draft.reviewComments)
    meanings.set(
      comment.id,
      JSON.stringify([
        "comment",
        comment.content,
        comment.parentCommentId ?? null,
        represented.get(comment.id)?.anchorText ??
          comment.originalQuote ??
          null,
        context(comment.id),
        Boolean(comment.detachedReason),
      ]),
    );
  return { items, meanings };
}

/** Explicit Reload owns disk's prose; unmappable feedback remains visible. */
function reloadRawDisk(
  review: SyncDraft,
  markdown: string,
  schema: Schema,
  diskBase: RevisionDiskBase,
): RevisionDiskMerge {
  const { aliases, before, disk } = readDiskSides(
    review,
    markdown,
    schema,
    diskBase,
  );
  const localFeedback = reloadFeedback(review);
  const beforeFeedback = reloadFeedback(before);
  const diskFeedback = reloadFeedback(disk);
  const reserved = new Set([
    ...Object.keys(review.decisions),
    ...reviewHistoryProposalIds(review.reviewed),
    ...(review.outdatedSuggestions ?? []).map((item) => item.id),
  ]);
  const owned = new Set([
    ...localFeedback.meanings.keys(),
    // Deleting an item does not release its identity from browser Undo.
    ...beforeFeedback.meanings.keys(),
    ...review.reviewComments.map((comment) => comment.id),
    ...reserved,
  ]);
  const used = new Set([
    ...owned,
    ...diskFeedback.meanings.keys(),
    ...Object.keys(aliases),
    ...Object.values(aliases),
  ]);
  const remap: Record<string, string> = {};
  for (const [id, incomingMeaning] of diskFeedback.meanings) {
    const localMeaning = localFeedback.meanings.get(id);
    const beforeMeaning = beforeFeedback.meanings.get(id);
    const collision =
      owned.has(id) &&
      ((reserved.has(id) && localMeaning === undefined) ||
        beforeMeaning === undefined ||
        (localMeaning !== beforeMeaning && localMeaning !== incomingMeaning));
    if (collision) {
      remap[id] = nextReviewIdentity(id, used);
      used.add(remap[id]);
    }
  }
  const incoming = renumberReviewDraft(disk, remap);
  const incomingItems = extractRoughdraftReviewIndex(incoming.markdown).items;
  const incomingById = new Map(incomingItems.map((item) => [item.id, item]));
  const clean = cleanRevisionSourceMarkdown(markdown);
  // Only parsed identity patches may distinguish this review from raw disk.
  // Their clean spelling must remain identical; old review clean text is unused.
  if (cleanRevisionSourceMarkdown(incoming.markdown) !== clean)
    return {
      status: "client-merge-required",
      draft: review,
      conflicts: [],
      signature: reviewDraftSignature(review),
      reason:
        "The source identities could not be restored without changing its text.",
    };

  const parsed = parseRemoteRevision(
    review.markdown,
    EditorState.create({ schema }),
  );
  const ranges = annotationRanges(parsed.doc);
  const comments = new Map<string, SyncDraft["reviewComments"][number]>(
    review.reviewComments.map((comment) => [comment.id, comment]),
  );
  for (const comment of parsed.comments.values())
    if (!comments.has(comment.id))
      comments.set(comment.id, {
        ...comment,
        changeId: comment.parentCommentId ?? "document",
      });
  const incomingComments = new Set(
    incoming.reviewComments.map((comment) => comment.id),
  );
  for (const [id, comment] of comments) {
    if (incomingComments.has(id) || comment.parentCommentId) continue;
    const range = ranges.comments.get(id);
    comments.set(id, {
      ...comment,
      scope: "document",
      changeId: "document",
      originalQuote:
        comment.originalQuote ??
        (range
          ? parsed.doc.textBetween(range.from, range.to, "\n")
          : undefined),
      detachedReason:
        comment.detachedReason ??
        "The file was reloaded before this comment could be safely attached.",
    });
  }
  for (const comment of incoming.reviewComments) {
    const existing = comments.get(comment.id);
    const source = incomingById.get(comment.id);
    comments.set(comment.id, {
      ...comment,
      ...(existing && !source?.createdAt
        ? { createdAt: existing.createdAt }
        : {}),
      ...(existing && !source?.author
        ? { authorType: existing.authorType, authorId: existing.authorId }
        : {}),
    });
  }
  const outdated = [...(review.outdatedSuggestions ?? [])];
  const pending = new Set(
    incomingItems
      .filter((item) => item.kind === "suggestion")
      .map((item) => item.id),
  );
  for (const [id] of ranges.suggestions) {
    if (pending.has(id) || outdated.some((item) => item.id === id)) continue;
    const detail = suggestionDetail(parsed.doc, id);
    outdated.push({
      id,
      originalText: detail.oldText,
      proposedText: detail.newText,
      reason:
        "The file was reloaded before this proposal could be safely attached.",
      ...suggestionAttribution(parsed.doc, id),
    });
  }
  const ids = { ...aliases };
  for (const item of extractRoughdraftReviewIndex(markdown).items) {
    const previous = aliases[item.id] ?? item.id;
    if (remap[previous]) ids[item.id] = remap[previous];
  }
  const draft: SyncDraft = {
    ...review,
    markdown: incoming.markdown,
    cleanMarkdown: clean,
    reviewComments: [...comments.values()],
    outdatedSuggestions: outdated,
    reviewed: review.reviewed?.map((entry) => ({
      ...entry,
      stale: true,
      staleReason:
        entry.staleReason ?? "The file was reloaded from its source.",
    })),
    diskOrigin: {
      path: diskBase.path,
      signature: contentSignature(markdown),
      ids,
    },
  };
  console.info(
    JSON.stringify({
      severity: "info",
      component: "revision-editor",
      event: "explicit-raw-disk-reload",
      comments: comments.size,
      outdatedSuggestions: outdated.length,
      renumbered: Object.keys(remap).length,
    }),
  );
  return {
    status: "merged",
    draft,
    conflicts: [],
    signature: reviewDraftSignature(draft),
    diskCleanMarkdown: clean,
  };
}
function adoptDisk(
  base: SyncDraft,
  markdown: string,
  schema: Schema,
  force: boolean,
  projected?: ReturnType<typeof parseRemoteRevision>,
  comparisonMarkdown?: string,
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
    // The detached model may omit a trailing space that exists solely before
    // a pending proposal. Use its actual accepted spelling as the annotation
    // merge base; that normalization is not an independent browser deletion.
    const acceptedSpelling = cleanRevisionSourceMarkdown(adopted.markdown);
    const plain: SyncDraft = {
      markdown: acceptedSpelling,
      cleanMarkdown: acceptedSpelling,
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
  // Source projection may serialize adjacent whitespace differently from the
  // model left by Revert. Compare new prose with the exact source baseline used
  // by the three-way merge, then map only its actual edits into that model.
  // A projection-only spelling difference must not displace pending feedback.
  const comparison =
    comparisonMarkdown === undefined
      ? accepted.doc
      : parseRemoteRevision(comparisonMarkdown, state).doc;
  const comparisonState = EditorState.create({ schema, doc: comparison });
  const originalComments = new Map(parsedBase.comments);
  for (const comment of base.reviewComments)
    originalComments.set(comment.id, comment);
  const canonicalOriginal = editorStateToCriticMarkdown(
    state.doc.toJSON(),
    originalComments,
    { frontmatter: parsedBase.frontmatter, endmatter: parsedBase.endmatter },
  );
  const changes = replaceRevisionContent(comparisonState, parsedIncoming.doc);
  const inverse = new Mapping();
  inverse.appendMapping(
    replaceRevisionContent(comparisonState, accepted.doc).mapping,
  );
  inverse.appendMapping(accepted.mapping.invert());
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
    if (!outdated.some((item) => item.id === id))
      outdated.push({
        id,
        originalText: detail.oldText,
        proposedText: detail.newText,
        reason: "The file changed on disk across this proposal.",
        ...suggestionAttribution(state.doc, id),
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
  const toAccepted = replaceRevisionContent(
    comparisonState,
    projection.doc,
  ).mapping;
  const expected = applyMappedSteps(acceptedState, changes.steps, toAccepted);
  const toReview = new Mapping();
  toReview.appendMapping(toAccepted);
  toReview.appendMapping(projection.mapping.invert());
  const transaction = applyMappedSteps(state, changes.steps, toReview);
  if (!expected || !transaction) return null;
  if (
    !projectAcceptedDocument(transaction.doc).doc.content.eq(
      expected.doc.content,
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
      endmatter:
        comparisonMarkdown === undefined
          ? parsedIncoming.endmatter
          : splitYamlDocumentMetadata(
              withDocumentMetadata(base.markdown, documentMetadata(markdown)),
            ).endmatter,
    },
  );
  const clean = acceptedSpelling(expected.doc, markdown);
  const oldSpelling = createSourceSpellingPreserver(
    base.markdown,
    canonicalOriginal,
  )(review);
  let sourceReview = oldSpelling;
  if (comparisonMarkdown === undefined) sourceReview ??= review;
  else if (
    sourceReview === null ||
    !provesReviewSpelling(
      sourceReview,
      review,
      transaction.doc,
      state,
      markdown,
    )
  ) {
    sourceReview = createSourceSpellingPreserver(markdown, clean)(review);
    if (
      sourceReview === null ||
      !provesReviewSpelling(
        sourceReview,
        review,
        transaction.doc,
        state,
        markdown,
      )
    )
      return null;
  }
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

function acceptedSpelling(doc: Node, markdown: string) {
  return cleanRevisionDocument({
    ...doc.toJSON(),
    attrs: { ...doc.attrs, sourceMetadata: documentMetadata(markdown) },
  });
}

function provesAcceptedSpelling(review: string, clean: string, schema: Schema) {
  const state = EditorState.create({ schema });
  const parsed = parseRemoteRevision(review, state);
  const accepted = projectAcceptedDocument(parsed.doc).doc;
  return new RevisionCanonicalSpellingProof().matches(
    clean,
    acceptedSpelling(accepted, review),
    accepted,
    state,
  );
}

function provesReviewSpelling(
  candidate: string,
  canonical: string,
  doc: Node,
  state: EditorState,
  prose: string,
) {
  if (
    !sameMetadata(documentMetadata(candidate), documentMetadata(prose)) ||
    !new RevisionSpellingProof().matchesFile(candidate, canonical, doc, state)
  )
    return false;
  const comments = (markdown: string) =>
    [...parseRemoteRevision(markdown, state).comments.values()]
      .map((comment) => ({
        id: comment.id,
        content: comment.content,
        parent: comment.parentCommentId ?? null,
        authorType: comment.authorType ?? null,
        authorId: comment.authorId ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return (
    JSON.stringify(comments(candidate)) === JSON.stringify(comments(canonical))
  );
}

function applyMappedSteps(
  state: EditorState,
  steps: readonly Step[],
  initial: Mapping,
) {
  let mapping = initial;
  const transaction = state.tr;
  for (const step of steps) {
    const mapped = step.map(mapping);
    if (!mapped || transaction.maybeStep(mapped).failed) return null;
    const next = new Mapping();
    next.appendMap(step.getMap().invert());
    next.appendMapping(mapping);
    next.appendMap(mapped.getMap());
    mapping = next;
  }
  return transaction;
}
