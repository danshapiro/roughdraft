import type { JSONContent } from "@tiptap/core";
import { marked } from "marked";
import type {
  ComparisonDecision,
  ComparisonReviewData,
  ComparisonSegment,
} from "./comparison-types";
import type { ControlledReviewBlockHighlight } from "./controlled-review";
import {
  type CriticChangeAttrs,
  type CriticComment,
  criticMarkdownToEditorState,
} from "./critic-markup";
import type { CriticChangeRailItem } from "./DocumentReviewRail";
import { type MarkdownOptions, splitYamlDocumentMetadata } from "./markdown";
import { diffRenderedComparison } from "./rendered-comparison-diff";

export interface ComparisonDocumentGroup {
  id: string;
  segmentIds: string[];
  decision: ComparisonDecision | "mixed";
}

export interface ComparisonDocumentModel {
  doc: JSONContent;
  groups: ComparisonDocumentGroup[];
  suggestions: CriticChangeRailItem[];
  comments: Map<string, CriticComment>;
  blockHighlights: ControlledReviewBlockHighlight[];
}

interface Snapshot {
  boundaries: Set<number>;
  metadata: { from: number; to: number }[];
  references: string;
}

interface UnitPart {
  segment: ComparisonSegment;
  before: string;
  after: string;
}

interface Unit {
  parts: UnitPart[];
}

interface ComparisonDisplayOptions extends MarkdownOptions {
  formatted?: boolean;
}

// The prefix prevents an ordinary horizontal rule at the start of a display
// unit from being mistaken for document frontmatter. It is never displayed.
const CONTEXT_PREFIX = "\uE000comparison-context\uE001\n\n";
const UNKNOWN_TIME = "1970-01-01T00:00:00.000Z";

function normalizeWithOffsets(text: string) {
  let normalized = "";
  const offsets = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") index++;
      normalized += "\n";
    } else {
      normalized += text[index];
    }
    offsets.push(index + 1);
  }
  return { normalized, offsets };
}

function referenceDefinitions(links: ReturnType<typeof marked.lexer>["links"]) {
  const escapeReference = (value: string) =>
    value.replace(/[\\[\]<>"]/g, "\\$&");
  return Object.entries(links)
    .map(
      ([label, { href, title }]) =>
        `[${escapeReference(label)}]: <${escapeReference(href)}>${title ? ` "${escapeReference(title)}"` : ""}`,
    )
    .join("\n");
}

/** Only outer Markdown block boundaries can split an exact-source review. */
function snapshot(text: string): Snapshot {
  const { frontmatter, endmatter } = splitYamlDocumentMetadata(text);
  const bodyStart = frontmatter?.length ?? 0;
  const bodyEnd = text.length - (endmatter?.length ?? 0);
  const metadata = [
    ...(frontmatter ? [{ from: 0, to: bodyStart }] : []),
    ...(endmatter ? [{ from: bodyEnd, to: text.length }] : []),
  ];
  const boundaries = new Set([0, bodyStart, bodyEnd, text.length]);
  const { normalized, offsets } = normalizeWithOffsets(
    text.slice(bodyStart, bodyEnd),
  );
  const tokens = marked.lexer(normalized);
  let cursor = 0;
  for (const token of tokens) {
    // Marked omits reference definitions from its token array. Locate each
    // retained raw token in order so those omitted definitions keep their
    // original source positions instead of shifting every later boundary.
    const start = normalized.indexOf(token.raw, cursor);
    if (start < 0) continue;
    const end = start + token.raw.length;
    boundaries.add(bodyStart + offsets[start]);
    boundaries.add(bodyStart + offsets[end]);
    const trailingWhitespace = token.raw.match(/\s*$/)?.[0].length ?? 0;
    const whitespaceStart =
      token.type === "space" ? start : end - trailingWhitespace;
    if (whitespaceStart < end) {
      for (let index = whitespaceStart; index < end; index++) {
        if (normalized[index] === "\n")
          boundaries.add(bodyStart + offsets[index + 1]);
      }
    }
    cursor = end;
  }
  return {
    boundaries,
    metadata,
    references: referenceDefinitions(tokens.links),
  };
}

/** A cut must lie in equal source and be a complete block in both versions. */
function displayUnits(
  segments: ComparisonSegment[],
  before: Snapshot,
  after: Snapshot,
): Unit[] {
  const units: Unit[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let unit: Unit = { parts: [] };
  const flush = () => {
    if (unit.parts.length) units.push(unit);
    unit = { parts: [] };
  };
  for (const segment of segments) {
    if (segment.kind === "change") {
      unit.parts.push({
        segment,
        before: segment.before,
        after: segment.after,
      });
      oldOffset += segment.before.length;
      newOffset += segment.after.length;
      continue;
    }
    const cuts = [...before.boundaries]
      .filter(
        (position) =>
          position >= oldOffset &&
          position <= oldOffset + segment.before.length &&
          after.boundaries.has(newOffset + position - oldOffset),
      )
      .map((position) => position - oldOffset)
      .sort((left, right) => left - right);
    let consumed = 0;
    for (const cut of cuts) {
      if (cut > consumed) {
        const content = segment.before.slice(consumed, cut);
        unit.parts.push({ segment, before: content, after: content });
        oldOffset += content.length;
        newOffset += content.length;
      }
      consumed = cut;
      flush();
    }
    if (consumed < segment.before.length) {
      const content = segment.before.slice(consumed);
      unit.parts.push({ segment, before: content, after: content });
      oldOffset += content.length;
      newOffset += content.length;
    }
  }
  flush();
  return units;
}

function codeBlock(source: string, language: string): JSONContent {
  return {
    type: "codeBlock",
    attrs: { language },
    content: source
      ? [
          {
            type: "text",
            text: source.replace(/\r\n?/g, "\n").trimEnd() || " ",
          },
        ]
      : [],
  };
}

function parseBody(
  source: string,
  context: Snapshot,
  options: MarkdownOptions,
  comments: Map<string, CriticComment>,
  showInvisible: boolean,
): JSONContent[] {
  if (!source.trim()) return [];
  const parsed = criticMarkdownToEditorState(
    `${CONTEXT_PREFIX}${source}\n\n${context.references}\n`,
    options,
  );
  for (const [id, comment] of parsed.comments) comments.set(id, comment);
  const content = (parsed.doc.content?.slice(1) ?? []).filter(
    (node) => node.type !== "paragraph" || Boolean(node.content?.length),
  );
  // Reference definitions and whitespace are real source changes but have no
  // rendered prose. Keep their decision visible without turning ordinary
  // Markdown hunks into source-code panels.
  return content.length || !showInvisible
    ? content
    : [codeBlock(source, "text")];
}

function parseRange(
  source: string,
  from: number,
  context: Snapshot,
  options: ComparisonDisplayOptions,
  comments: Map<string, CriticComment>,
  showInvisible: boolean,
): JSONContent[] {
  // Literal Markdown uses the same read-only native review surface and marks.
  // It is a display projection; the server still applies original source bytes.
  if (options.formatted === false) {
    // A paragraph boundary already supplies one line break in this projection.
    const text = source.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    return source
      ? [
          {
            type: "paragraph",
            content: text ? [{ type: "text", text }] : [],
          },
        ]
      : [];
  }
  const result: JSONContent[] = [];
  let consumed = 0;
  for (const metadata of context.metadata) {
    const start = Math.max(from, metadata.from);
    const end = Math.min(from + source.length, metadata.to);
    if (start >= end) continue;
    result.push(
      ...parseBody(
        source.slice(consumed, start - from),
        context,
        options,
        comments,
        showInvisible,
      ),
    );
    result.push(codeBlock(source.slice(start - from, end - from), "yaml"));
    consumed = end - from;
  }
  result.push(
    ...parseBody(
      source.slice(consumed),
      context,
      options,
      comments,
      showInvisible,
    ),
  );
  return result.length || !showInvisible || !source
    ? result
    : [codeBlock(source, "text")];
}

function nodeSize(node: JSONContent): number {
  if (node.type === "text") return node.text?.length ?? 0;
  if (
    node.type === "image" ||
    node.type === "horizontalRule" ||
    node.type === "hardBreak" ||
    node.type === "rawMarkdownBlock"
  )
    return 1;
  return (
    2 +
    (node.content ?? []).reduce((total, child) => total + nodeSize(child), 0)
  );
}

function plainText(content: JSONContent[]): string {
  return content
    .map((node) => node.text ?? plainText(node.content ?? []))
    .join("");
}

function decorate(
  node: JSONContent,
  change: CriticChangeAttrs | null,
  commentIds: string[],
): JSONContent {
  const anchoredIds = [
    ...new Set([
      ...(node.marks ?? [])
        .filter((mark) => mark.type === "commentRef")
        .flatMap((mark) => mark.attrs?.commentIds ?? []),
      ...commentIds,
    ]),
  ];
  return {
    ...node,
    ...(node.type === "text"
      ? {
          marks: [
            ...(node.marks ?? []).filter(
              (mark) =>
                (!change || mark.type !== "criticChange") &&
                mark.type !== "commentRef",
            ),
            ...(change ? [{ type: "criticChange", attrs: change }] : []),
            ...(anchoredIds.length
              ? [{ type: "commentRef", attrs: { commentIds: anchoredIds } }]
              : []),
          ],
        }
      : {}),
    ...(node.content
      ? {
          content: node.content.map((child) =>
            decorate(child, change, commentIds),
          ),
        }
      : {}),
  };
}

function reviewStatus(
  decision: ComparisonDocumentGroup["decision"],
  mode: ComparisonReviewData["mode"],
) {
  if (decision === "mixed") return "Mixed choices";
  if (decision === "pending") return "Undecided";
  if (mode === "applied") return decision === "after" ? "Kept" : "Reverted";
  return decision === "after" ? "Accepted" : "Skipped";
}

function anchored(nodes: JSONContent[], unit: number): JSONContent[] {
  return nodes.map((node) => ({
    ...node,
    attrs: { ...node.attrs, comparisonAnchor: `unit-${unit}` },
  }));
}

export type ComparisonPreviewVersion = "before" | "after" | "result";

/** Frozen versions ignore choices; Result uses After for undecided changes. */
export function buildComparisonPreviewDocument(
  review: ComparisonReviewData,
  options: ComparisonDisplayOptions = {},
  version: ComparisonPreviewVersion = "result",
): JSONContent {
  const units = displayUnits(
    review.segments,
    snapshot(review.beforeText),
    snapshot(review.afterText),
  );
  const select = ({ segment, before, after }: UnitPart) =>
    version === "before" ||
    (version === "result" &&
      segment.kind === "change" &&
      segment.decision === "before")
      ? before
      : after;
  const source = units.flatMap((unit) => unit.parts.map(select)).join("");
  const context = snapshot(source);
  let offset = 0;
  const content = units.flatMap((unit, index) => {
    const selected = unit.parts.map(select).join("");
    const nodes = anchored(
      parseRange(selected, offset, context, options, new Map(), false),
      index,
    );
    offset += selected.length;
    return nodes;
  });
  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

/** The document is a display projection. Only server-side source slices apply. */
export function buildComparisonDocument(
  review: ComparisonReviewData,
  options: ComparisonDisplayOptions & { showReviewed?: boolean } = {},
): ComparisonDocumentModel {
  const before = snapshot(review.beforeText);
  const after = snapshot(review.afterText);
  const units = displayUnits(review.segments, before, after);
  const groups: ComparisonDocumentGroup[] = [];
  const unitGroups = new Map<Unit, ComparisonDocumentGroup>();
  const segmentGroups = new Map<string, string>();
  for (const unit of units) {
    const changes = unit.parts
      .filter((part) => part.segment.kind === "change")
      .map((part) => part.segment);
    if (!changes.length) continue;
    const decisions = new Set(changes.map((segment) => segment.decision));
    const group: ComparisonDocumentGroup = {
      id: changes[0].id,
      segmentIds: changes.map((segment) => segment.id),
      decision: decisions.size === 1 ? changes[0].decision : "mixed",
    };
    groups.push(group);
    unitGroups.set(unit, group);
    for (const id of group.segmentIds) segmentGroups.set(id, group.id);
  }

  const comments = new Map<string, CriticComment>();
  const detachedCommentIds: string[] = [];
  const groupCommentIds = new Map<string, string[]>();
  const remember = (comment: CriticComment, changeId: string) => {
    const groupId = segmentGroups.get(changeId);
    const rendered = {
      ...comment,
      ...(comment.parentCommentId && segmentGroups.has(comment.parentCommentId)
        ? { parentCommentId: segmentGroups.get(comment.parentCommentId) }
        : {}),
      ...(!groupId ? { scope: "document" as const } : {}),
    };
    comments.set(comment.id, rendered);
    if (groupId) {
      const ids = groupCommentIds.get(groupId) ?? [];
      ids.push(comment.id);
      groupCommentIds.set(groupId, ids);
    } else {
      detachedCommentIds.push(comment.id);
    }
  };
  for (const segment of review.segments) {
    if (!segment.comment) continue;
    remember(
      {
        id: `legacy:${segment.id}`,
        content: segment.comment,
        createdAt: UNKNOWN_TIME,
        authorType: "user",
        parentCommentId: segmentGroups.get(segment.id) ?? segment.id,
      },
      segment.id,
    );
  }
  for (const comment of review.reviewComments ?? [])
    remember(comment, comment.changeId);

  const content: JSONContent[] = [];
  const suggestions: CriticChangeRailItem[] = [];
  const blockHighlights: ControlledReviewBlockHighlight[] = [];
  let position = 0;
  let currentUnit = 0;
  const append = (
    nodes: JSONContent[],
    change: CriticChangeAttrs | null,
    commentIds: string[] = [],
  ) => {
    for (const node of anchored(nodes, currentUnit)) {
      const rendered = decorate(node, change, commentIds);
      const size = nodeSize(rendered);
      if (change)
        blockHighlights.push({
          from: position,
          to: position + size,
          changeId: change.changeId,
          kind: change.kind,
        });
      content.push(rendered);
      position += size;
    }
  };
  const projectedText = (parts: UnitPart[], pending: "before" | "after") =>
    parts
      .map(({ segment, before: previous, after: next }) =>
        segment.kind === "equal" ||
        segment.decision === "after" ||
        (segment.decision === "pending" && pending === "after")
          ? next
          : previous,
      )
      .join("");
  const selectedText = (parts: UnitPart[]) =>
    projectedText(parts, review.mode === "proposal" ? "before" : "after");
  const allParts = review.segments.map((segment) => ({
    segment,
    before: segment.before,
    after: segment.after,
  }));
  const selectedContext = snapshot(selectedText(allParts));
  // Until Show reviewed is selected, a partial linked-group review must keep
  // its settled choices on both visible sides. Only undecided source chunks
  // differ; the immutable snapshots remain available for revising all choices.
  const retainChoices = !options.showReviewed && review.mode !== "compare";
  const previousContext = retainChoices
    ? snapshot(projectedText(allParts, "before"))
    : before;
  const nextContext = retainChoices
    ? snapshot(projectedText(allParts, "after"))
    : after;
  let selectedOffset = 0;
  let previousOffset = 0;
  let nextOffset = 0;
  for (const [unitIndex, unit] of units.entries()) {
    currentUnit = unitIndex;
    const previous = retainChoices
      ? projectedText(unit.parts, "before")
      : unit.parts.map((part) => part.before).join("");
    const next = retainChoices
      ? projectedText(unit.parts, "after")
      : unit.parts.map((part) => part.after).join("");
    const previousStart = previousOffset;
    const nextStart = nextOffset;
    previousOffset += previous.length;
    nextOffset += next.length;
    const selected = selectedText(unit.parts);
    const group = unitGroups.get(unit);
    if (!group) {
      append(
        parseRange(
          selected,
          selectedOffset,
          selectedContext,
          options,
          comments,
          false,
        ),
        null,
      );
      selectedOffset += selected.length;
      continue;
    }
    const ids = groupCommentIds.get(group.id) ?? [];
    const visible =
      review.mode === "compare" ||
      options.showReviewed ||
      unit.parts.some(
        (part) =>
          part.segment.kind === "change" && part.segment.decision === "pending",
      );
    if (!visible) {
      const selectedNodes = parseRange(
        selected,
        selectedOffset,
        selectedContext,
        options,
        comments,
        false,
      );
      append(selectedNodes, null, ids);
      if (ids.length && !plainText(selectedNodes)) {
        append(
          [{ type: "paragraph", content: [{ type: "text", text: "\u2060" }] }],
          null,
          ids,
        );
      }
      selectedOffset += selected.length;
      continue;
    }
    const oldNodes = parseRange(
      previous,
      previousStart,
      previousContext,
      options,
      comments,
      true,
    );
    const newNodes = parseRange(
      next,
      nextStart,
      nextContext,
      options,
      comments,
      true,
    );
    const change: CriticChangeAttrs = {
      changeId: group.id,
      kind:
        previous && next
          ? "substitution-old"
          : previous
            ? "deletion"
            : "addition",
      authorType: "ai",
      createdAt: UNKNOWN_TIME,
    };
    const anchorTop = position;
    const difference = diffRenderedComparison(oldNodes, newNodes, change);
    for (const highlight of difference.blockHighlights) {
      blockHighlights.push({
        ...highlight,
        from: position + highlight.from,
        to: position + highlight.to,
      });
    }
    append(difference.content, null, ids);
    if (!difference.changed) {
      // Identical rendering can still conceal a real source change, such as
      // Markdown marker spelling, line endings, or the final newline. Give its
      // existing native review card a small anchor without painting prose.
      append(
        [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "\u2060",
                marks: [{ type: "criticChange", attrs: change }],
              },
            ],
          },
        ],
        null,
        ids,
      );
    }
    const oldSummary = difference.changed
      ? difference.oldText
      : "Previous Markdown source formatting";
    const newSummary = difference.changed
      ? difference.newText
      : "Updated source formatting (rendered content unchanged)";
    const suggestionKind =
      oldSummary && newSummary
        ? "substitution-old"
        : oldSummary
          ? "deletion"
          : "addition";
    suggestions.push({
      changeId: group.id,
      change: { ...change, kind: suggestionKind },
      kind: suggestionKind,
      oldText: oldSummary,
      newText: newSummary,
      commentIds: ids,
      anchorTop,
      anchorBottom: position,
      sourceChangeCount: group.segmentIds.length,
      reviewStatus: reviewStatus(group.decision, review.mode),
    });
    selectedOffset += selected.length;
  }
  if (detachedCommentIds.length) {
    append(
      [{ type: "paragraph", content: [{ type: "text", text: "\u2060" }] }],
      null,
      detachedCommentIds,
    );
  }
  return {
    doc: {
      type: "doc",
      content: content.length ? content : [{ type: "paragraph" }],
    },
    groups,
    suggestions,
    comments,
    blockHighlights,
  };
}
