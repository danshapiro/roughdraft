import {
  extractRoughdraftReviewIndex,
  findRoughdraftDelimiter,
} from "@roughdraft/rfm";
import {
  elementFromString,
  getHTMLFromFragment,
  getSchema,
  type JSONContent,
} from "@tiptap/core";
import {
  DOMSerializer,
  DOMParser as ProseMirrorDOMParser,
} from "@tiptap/pm/model";
import {
  Marked,
  type RendererThis,
  type Token,
  type TokenizerAndRendererExtension,
  type TokenizerThis,
  type Tokens,
} from "marked";
import type TurndownService from "turndown";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type CriticChangeAttrs,
  type CriticChangeKind,
  createEditorExtensions,
  readCriticBlockChange,
} from "../editor-extensions";
import { endnoteExtension } from "../endnotes";
import {
  appendYamlEndmatter,
  createMarkedRenderer,
  createTurndownService,
  type MarkdownOptions,
  normalizeBlockSpacing,
  prependYamlFrontmatter,
  protectRichTextRoundTripMarkdown,
  splitYamlDocumentMetadata,
  splitYamlFrontmatter,
} from "../markdown";

export interface CriticComment {
  id: string;
  content: string;
  createdAt: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  parentCommentId?: string | null;
  scope?: "document";
  originalQuote?: string;
  detachedReason?: string;
}

export interface CriticCommentThread {
  comment: CriticComment;
  replies: CriticCommentThread[];
}

export interface CriticMarkdownOptions extends MarkdownOptions {
  /** Explicit compatibility mode for code reviews authored before the marker. */
  legacyCodeComments?: boolean;
  /** Global definition labels when parsing one unchanged-context source block. */
  endnoteDefinitions?: ReadonlySet<string>;
}

export type { CriticChangeAttrs, CriticChangeKind };

interface CriticCommentToken {
  type: "criticCommentAnchor";
  raw: string;
  commentIds: string[];
  tokens: Token[];
}

interface CriticStandaloneCommentToken {
  type: "criticStandaloneComment";
  raw: string;
  commentIds: string[];
}

interface CriticChangeToken {
  type: "criticChange" | "criticBlockChange";
  raw: string;
  change: CriticChangeAttrs;
  commentIds: string[];
  prefix?: string;
  suffix?: string;
  source?: string;
  oldSource?: string;
  newSource?: string;
  tokens?: Token[];
  oldTokens?: Token[];
  newTokens?: Token[];
}

const schema = getSchema(createEditorExtensions(""));
const htmlParser = ProseMirrorDOMParser.fromSchema(schema);
const domSerializer = DOMSerializer.fromSchema(schema);
const parseHtml = (html: string): JSONContent => {
  const element = elementFromString(html);
  // TipTap removes whitespace-only HTML text nodes. These marked newlines are
  // authored YAML spelling, so restore them before the schema reads the DOM.
  for (const newline of element.querySelectorAll(
    '[data-yaml-frontmatter] span[data-yaml-line-ending="crlf"]',
  ))
    if (!newline.textContent) newline.textContent = "\n";
  return htmlParser.parse(element).toJSON();
};
const renderHtml = (doc: JSONContent) =>
  getHTMLFromFragment(schema.nodeFromJSON(doc).content, schema);
const criticCommentAnchorPattern = /^\{==([\s\S]+?)==\}(?=\{>>)/;
const criticCommentBlockPattern =
  /^\{>>([\s\S]*?)<<\}(?:(\{@([\s\S]+?)@\})|(\{(?:\s*[A-Za-z][A-Za-z0-9_-]*="(?:\\[\s\S]|[^"\\])*")+\s*\})|(\{#[A-Za-z][A-Za-z0-9_-]*\}))?/;
function matchCriticWrapped(
  source: string,
  open: string,
  close: string,
): [string, string] | null {
  if (!source.startsWith(open)) return null;
  const end = findRoughdraftDelimiter(source, close, open.length);
  return end < 0
    ? null
    : [source.slice(0, end + close.length), source.slice(open.length, end)];
}

function matchCriticSubstitution(
  source: string,
): [string, string, string] | null {
  if (!source.startsWith("{~~")) return null;
  const separator = findRoughdraftDelimiter(source, "~>", 3);
  if (separator < 0) return null;
  const end = findRoughdraftDelimiter(source, "~~}", separator + 2);
  return end < 0
    ? null
    : [
        source.slice(0, end + 3),
        source.slice(3, separator),
        source.slice(separator + 2, end),
      ];
}
const attributeMetadataBlockPattern =
  /^\{(?:\s*[A-Za-z][A-Za-z0-9_-]*="(?:\\[\s\S]|[^"\\])*")+\s*\}/;
const metadataAttributePattern =
  /([A-Za-z][A-Za-z0-9_-]*)="((?:\\[\s\S]|[^"\\])*)"/g;
const metadataReferencePattern = /^\{#([A-Za-z][A-Za-z0-9_-]*)\}$/;
const unanchoredCommentSentinel = "\u2060";

interface ParsedEndmatter {
  comments: Map<string, Record<string, unknown>>;
  suggestions: Map<string, Record<string, unknown>>;
  data: Record<string, unknown> | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseLegacyMetadata(
  metadataText?: string,
): Partial<Omit<CriticComment, "content">> {
  const fields = new Map<string, string>();

  for (const part of metadataText?.split(";") ?? []) {
    const [rawKey, ...valueParts] = part.split(":");
    const key = rawKey?.trim();
    const value = valueParts.join(":").trim();

    if (!key || !value) continue;
    fields.set(key, value);
  }

  const author = fields.get("by") ?? "user";

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId: fields.get("re") ?? null,
  };
}

function unescapeMetadataAttributeValue(value: string): string {
  return value.replaceAll(/\\([\s\S])/g, "$1");
}

function escapeMetadataAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseAttributeMetadata(
  metadataText?: string,
): Partial<Omit<CriticComment, "content">> {
  if (!metadataText?.startsWith("{") || !metadataText.endsWith("}")) {
    return {};
  }

  const fields = new Map<string, string>();
  const content = metadataText.slice(1, -1);

  for (const match of content.matchAll(metadataAttributePattern)) {
    fields.set(match[1], unescapeMetadataAttributeValue(match[2]));
  }

  const author = fields.get("by") ?? "user";

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId: fields.get("re") ?? null,
  };
}

function commentPartialFromEndmatterEntry(
  id: string,
  entry?: Record<string, unknown>,
  options?: { includeParent?: boolean },
): Partial<Omit<CriticComment, "content">> {
  const author = typeof entry?.by === "string" ? entry.by : "user";
  const includeParent = options?.includeParent ?? true;

  return {
    id,
    createdAt:
      typeof entry?.at === "string" ? entry.at : new Date().toISOString(),
    authorType: author.toUpperCase() === "AI" ? "ai" : "user",
    authorId: author.toUpperCase() === "AI" ? null : author,
    parentCommentId:
      includeParent && typeof entry?.re === "string" ? entry.re : null,
  };
}

function parseMetadata(
  legacyMetadataText?: string,
  attributeMetadataText?: string,
  referenceMetadataText?: string,
  endmatter?: ParsedEndmatter,
  kind: "comment" | "suggestion" = "comment",
): Partial<Omit<CriticComment, "content">> {
  const reference = referenceMetadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const entry =
      kind === "comment"
        ? endmatter?.comments.get(id)
        : endmatter?.suggestions.get(id);
    return commentPartialFromEndmatterEntry(id, entry, {
      includeParent: false,
    });
  }

  if (attributeMetadataText) {
    return parseAttributeMetadata(attributeMetadataText);
  }

  return parseLegacyMetadata(legacyMetadataText);
}

function commentBody(
  inline: string,
  reference: string | undefined,
  endmatter: ParsedEndmatter | undefined,
): string {
  const id = reference?.match(metadataReferencePattern)?.[1];
  const body = id ? endmatter?.comments.get(id)?.body : undefined;
  return inline === "" && typeof body === "string" ? body : inline;
}

function needsCommentBody(comment: CriticComment): boolean {
  return /<<}|[\r\n]/.test(comment.content);
}

function isEncodedCodeReference(
  reference: string | undefined,
  inline: string,
  endmatter?: ParsedEndmatter,
) {
  const id = reference?.match(metadataReferencePattern)?.[1];
  const entry = id ? endmatter?.comments.get(id) : undefined;
  return (
    entry?.codeAnchorEncoding === "backslash" &&
    typeof entry.body === "string" &&
    inline === ""
  );
}

function decodeCodeAnchor(text: string) {
  return text.replace(/\\([\\{}>])/g, "$1");
}

function decodeCodeAnchorTokens(tokens: Token[]): Token[] {
  return tokens.map((token) => {
    if (token.type === "codespan")
      return { ...token, text: decodeCodeAnchor(token.text) };
    if ("tokens" in token && Array.isArray(token.tokens))
      return { ...token, tokens: decodeCodeAnchorTokens(token.tokens) };
    return token;
  });
}

function serializeMetadata(comment: CriticComment): string {
  const fields = [
    ["id", comment.id],
    ["by", comment.authorType === "ai" ? "AI" : comment.authorId || "user"],
    ["at", comment.createdAt || new Date().toISOString()],
  ];

  if (comment.parentCommentId) {
    fields.push(["re", comment.parentCommentId]);
  }

  return `{${fields
    .map(([key, value]) => `${key}="${escapeMetadataAttributeValue(value)}"`)
    .join(" ")}}`;
}

function serializeChangeMetadata(change: CriticChangeAttrs): string {
  return serializeMetadata({
    id: change.changeId,
    content: "",
    createdAt: change.createdAt,
    authorType: change.authorType,
    authorId: change.authorId,
  });
}

function parseReviewEndmatter(endmatter?: string | null): ParsedEndmatter {
  if (!endmatter) {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  const yamlText = endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, "");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { comments: new Map(), suggestions: new Map(), data: null };
  }

  const record = parsed as Record<string, unknown>;
  return {
    comments: parseEndmatterMap(record.comments),
    suggestions: parseEndmatterMap(record.suggestions),
    data: record,
  };
}

function parseEndmatterMap(
  value: unknown,
): Map<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Map();
  }

  return new Map(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        Boolean(entry[1]) &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]),
    ),
  );
}

function addEndmatterFeedback(
  comments: Map<string, CriticComment>,
  endmatter: ParsedEndmatter,
) {
  for (const [id, entry] of endmatter.comments) {
    if (typeof entry.body !== "string") {
      continue;
    }
    if (comments.has(id)) {
      continue;
    }

    comments.set(
      id,
      createCommentWithContext({
        ...commentPartialFromEndmatterEntry(id, entry),
        content: entry.body,
        parentCommentId: typeof entry.re === "string" ? entry.re : null,
        scope: typeof entry.re === "string" ? undefined : "document",
      }),
    );
  }
}

/** Read review registry data without rendering the document again. */
export function readReviewEndmatter(endmatter?: string | null) {
  const metadata = parseReviewEndmatter(endmatter);
  const comments = new Map<string, CriticComment>();
  addEndmatterFeedback(comments, metadata);
  return { metadata, comments };
}

function areEndmatterEntriesEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }

  return true;
}

function areEndmatterMapsEqual(
  left: Map<string, Record<string, unknown>>,
  right: Map<string, Record<string, unknown>>,
): boolean {
  if (left.size !== right.size) return false;

  for (const [id, leftEntry] of left) {
    const rightEntry = right.get(id);
    if (!rightEntry || !areEndmatterEntriesEqual(leftEntry, rightEntry)) {
      return false;
    }
  }

  return true;
}

function endmatterEntryForComment(
  comment: CriticComment,
  existing: Record<string, unknown> = {},
  encodedCode = false,
): Record<string, unknown> {
  const by = comment.authorType === "ai" ? "AI" : comment.authorId || "user";
  const next: Record<string, unknown> = {
    ...existing,
    by,
    at: comment.createdAt,
  };
  if (encodedCode) next.codeAnchorEncoding = "backslash";
  else delete next.codeAnchorEncoding;

  if (comment.scope === "document") {
    next.body = comment.content;
    delete next.re;
  } else if (comment.parentCommentId) {
    next.body = comment.content;
    next.re = comment.parentCommentId;
  } else {
    if (encodedCode || needsCommentBody(comment)) next.body = comment.content;
    else delete next.body;
    delete next.re;
  }

  return next;
}

function endmatterEntryForChange(
  change: CriticChangeAttrs,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";

  return {
    ...existing,
    by,
    at: change.createdAt,
  };
}

function serializeReviewEndmatter(
  existingEndmatter: string | null,
  comments: Map<string, CriticComment>,
  changes: Map<string, CriticChangeAttrs>,
  enabled: boolean,
  encodedCodeComments: ReadonlySet<string>,
  frontmatterComments: ReadonlySet<string> = new Set(),
  frontmatterSuggestions: ReadonlySet<string> = new Set(),
  encodedYamlChanges: ReadonlySet<string> = new Set(),
): string | null {
  if (!enabled) return null;

  const parsed = parseReviewEndmatter(existingEndmatter);
  const commentEntries = new Map<string, Record<string, unknown>>();
  const suggestionEntries = new Map<string, Record<string, unknown>>();

  for (const comment of comments.values()) {
    commentEntries.set(
      comment.id,
      endmatterEntryForComment(
        comment,
        parsed.comments.get(comment.id),
        encodedCodeComments.has(comment.id),
      ),
    );
  }

  for (const change of changes.values()) {
    suggestionEntries.set(
      change.changeId,
      endmatterEntryForChange(change, parsed.suggestions.get(change.changeId)),
    );
  }

  for (const [id, entry] of commentEntries) {
    if (frontmatterComments.has(id)) entry.frontmatterAnchor = true;
    else delete entry.frontmatterAnchor;
  }
  for (const [id, entry] of suggestionEntries) {
    if (frontmatterSuggestions.has(id)) entry.frontmatterAnchor = true;
    else delete entry.frontmatterAnchor;
    if (encodedYamlChanges.has(id)) entry.literalChangeEncoding = "backslash";
    else delete entry.literalChangeEncoding;
  }
  if (
    areEndmatterMapsEqual(parsed.comments, commentEntries) &&
    areEndmatterMapsEqual(parsed.suggestions, suggestionEntries)
  ) {
    return existingEndmatter;
  }

  const data: Record<string, unknown> = { ...(parsed.data ?? {}) };
  if (commentEntries.size > 0) {
    data.comments = Object.fromEntries(commentEntries);
  } else {
    delete data.comments;
  }
  if (suggestionEntries.size > 0) {
    data.suggestions = Object.fromEntries(suggestionEntries);
  } else {
    delete data.suggestions;
  }

  if (Object.keys(data).length === 0) return null;

  return `---\n${stringifyYaml(data)}`;
}

export function createNextCommentId(
  existingComments: Iterable<Pick<CriticComment, "id">>,
): string {
  let maxId = 0;

  for (const comment of existingComments) {
    const match = comment.id.match(/^c(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `c${maxId + 1}`;
}

export function createNextChangeId(
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>,
): string {
  let maxId = 0;

  for (const change of existingChanges) {
    const match = change.changeId.match(/^s(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `s${maxId + 1}`;
}

function createCommentWithContext(
  partial?: Partial<CriticComment>,
  existingComments: Iterable<Pick<CriticComment, "id">> = [],
): CriticComment {
  const authorType = partial?.authorType ?? "user";

  return {
    id: partial?.id ?? createNextCommentId(existingComments),
    content: partial?.content ?? "",
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
    parentCommentId: partial?.parentCommentId ?? null,
    scope: partial?.scope,
  };
}

function createChangeWithContext(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">> = [],
): CriticChangeAttrs {
  const authorType = partial?.authorType ?? "user";

  return {
    kind,
    changeId: partial?.changeId ?? createNextChangeId(existingChanges),
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
  };
}

function parseChangeMetadata(
  metadataText?: string,
  endmatter?: ParsedEndmatter,
): Partial<CriticChangeAttrs> {
  const reference = metadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const entry = endmatter?.suggestions.get(id);
    const parsed = commentPartialFromEndmatterEntry(id, entry);
    return {
      changeId: parsed.id,
      createdAt: parsed.createdAt,
      authorType: parsed.authorType,
      authorId: parsed.authorId,
    };
  }

  const parsed = parseAttributeMetadata(metadataText);

  return {
    changeId: parsed.id,
    createdAt: parsed.createdAt,
    authorType: parsed.authorType,
    authorId: parsed.authorId,
  };
}

function buildCommentThreadsFromOrderedComments(
  orderedComments: CriticComment[],
): CriticCommentThread[] {
  const validCommentIds = new Set(orderedComments.map((comment) => comment.id));
  const repliesByParentId = new Map<string, CriticComment[]>();
  const rootComments: CriticComment[] = [];

  for (const comment of orderedComments) {
    const parentCommentId = comment.parentCommentId;

    if (
      !parentCommentId ||
      parentCommentId === comment.id ||
      !validCommentIds.has(parentCommentId)
    ) {
      rootComments.push(comment);
      continue;
    }

    const replies = repliesByParentId.get(parentCommentId) ?? [];
    replies.push(comment);
    repliesByParentId.set(parentCommentId, replies);
  }

  const buildNode = (comment: CriticComment): CriticCommentThread => ({
    comment,
    replies: (repliesByParentId.get(comment.id) ?? []).map(buildNode),
  });

  return rootComments.map(buildNode);
}

export function buildCommentThreads(
  comments: Iterable<CriticComment>,
): CriticCommentThread[] {
  return buildCommentThreadsFromOrderedComments([...comments]);
}

export function flattenCommentThreads(
  threads: Iterable<CriticCommentThread>,
): CriticComment[] {
  const orderedComments: CriticComment[] = [];

  const visit = (thread: CriticCommentThread) => {
    orderedComments.push(thread.comment);
    for (const reply of thread.replies) {
      visit(reply);
    }
  };

  for (const thread of threads) {
    visit(thread);
  }

  return orderedComments;
}

function getOrderedAnchorComments(
  commentIds: string[],
  comments: ReadonlyMap<string, CriticComment>,
): CriticComment[] {
  const visibleComments = commentIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is CriticComment => Boolean(comment));

  return flattenCommentThreads(buildCommentThreads(visibleComments));
}

function serializeCommentBlocks(
  commentIds: string[],
  comments: ReadonlyMap<string, CriticComment>,
  useEndmatter = false,
  encodedCodeComments?: ReadonlySet<string>,
): string {
  const orderedComments = useEndmatter
    ? commentIds
        .map((commentId) => comments.get(commentId))
        .filter(
          (comment): comment is CriticComment =>
            comment !== undefined && !comment.parentCommentId,
        )
    : getOrderedAnchorComments(commentIds, comments);
  let result = "";

  for (const comment of orderedComments) {
    const body =
      useEndmatter &&
      (needsCommentBody(comment) || encodedCodeComments?.has(comment.id))
        ? ""
        : comment.content;
    result += `{>>${body}<<}${
      useEndmatter ? `{#${comment.id}}` : serializeMetadata(comment)
    }`;
  }

  return result;
}

export function getCommentDescendantIds(
  commentId: string,
  comments: ReadonlyMap<string, CriticComment>,
): string[] {
  const childrenByParentId = new Map<string, string[]>();

  for (const comment of comments.values()) {
    if (!comment.parentCommentId || comment.parentCommentId === comment.id) {
      continue;
    }

    const childIds = childrenByParentId.get(comment.parentCommentId) ?? [];
    childIds.push(comment.id);
    childrenByParentId.set(comment.parentCommentId, childIds);
  }

  const descendantIds: string[] = [];
  const stack = [...(childrenByParentId.get(commentId) ?? [])].reverse();

  while (stack.length > 0) {
    const nextCommentId = stack.pop();
    if (!nextCommentId) continue;

    descendantIds.push(nextCommentId);

    const childIds = childrenByParentId.get(nextCommentId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) {
        stack.push(childId);
      }
    }
  }

  return descendantIds;
}

function tokenizeCriticCommentAnchor(
  lexer: TokenizerThis["lexer"],
  src: string,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
):
  | {
      token: CriticCommentToken;
      comments: CriticComment[];
    }
  | undefined {
  const anchorMatch = src.match(criticCommentAnchorPattern);

  if (!anchorMatch) return undefined;

  const [, anchor] = anchorMatch;
  let raw = anchorMatch[0];
  let offset = raw.length;
  const parsedComments: CriticComment[] = [];
  let encodedCode = false;

  while (offset < src.length) {
    const nextMatch = src.slice(offset).match(criticCommentBlockPattern);
    if (!nextMatch) break;

    const [
      ,
      commentText,
      ,
      legacyMetadataText,
      attributeMetadataText,
      referenceMetadataText,
    ] = nextMatch;
    encodedCode ||= isEncodedCodeReference(
      referenceMetadataText,
      commentText,
      endmatter,
    );
    const comment = createCommentWithContext(
      {
        ...parseMetadata(
          legacyMetadataText,
          attributeMetadataText,
          referenceMetadataText,
          endmatter,
          "comment",
        ),
        content: commentBody(commentText, referenceMetadataText, endmatter),
      },
      [...existingComments, ...parsedComments],
    );
    parsedComments.push(comment);
    raw += nextMatch[0];
    offset += nextMatch[0].length;
  }

  if (parsedComments.length === 0) return undefined;

  const commentIds = parsedComments.map((comment) => comment.id);
  const tokens = lexer.inlineTokens(anchor);

  return {
    token: {
      type: "criticCommentAnchor",
      raw,
      commentIds,
      tokens: encodedCode ? decodeCodeAnchorTokens(tokens) : tokens,
    },
    comments: parsedComments,
  };
}

function getTrailingAttributeMetadata(src: string, offset: number) {
  const reference = src.slice(offset).match(/^\{#[A-Za-z][A-Za-z0-9_-]*\}/);
  if (reference) {
    return {
      metadataText: reference[0],
      raw: reference[0],
    };
  }

  const match = src.slice(offset).match(attributeMetadataBlockPattern);

  if (!match) {
    return {
      metadataText: undefined,
      raw: "",
    };
  }

  return {
    metadataText: match[0],
    raw: match[0],
  };
}

function tokenizeCriticCommentBlocks(
  src: string,
  offset: number,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
) {
  let raw = "";
  let nextOffset = offset;
  const parsedComments: CriticComment[] = [];

  while (nextOffset < src.length) {
    const nextMatch = src.slice(nextOffset).match(criticCommentBlockPattern);
    if (!nextMatch) break;

    const [
      ,
      commentText,
      ,
      legacyMetadataText,
      attributeMetadataText,
      referenceMetadataText,
    ] = nextMatch;
    const comment = createCommentWithContext(
      {
        ...parseMetadata(
          legacyMetadataText,
          attributeMetadataText,
          referenceMetadataText,
          endmatter,
          "comment",
        ),
        content: commentBody(commentText, referenceMetadataText, endmatter),
      },
      [...existingComments, ...parsedComments],
    );
    parsedComments.push(comment);
    raw += nextMatch[0];
    nextOffset += nextMatch[0].length;
  }

  return {
    raw,
    comments: parsedComments,
  };
}

function tokenizeCriticStandaloneComment(
  src: string,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
):
  | {
      token: CriticStandaloneCommentToken;
      comments: CriticComment[];
    }
  | undefined {
  const result = tokenizeCriticCommentBlocks(
    src,
    0,
    existingComments,
    endmatter,
  );

  if (result.comments.length === 0) return undefined;

  return {
    token: {
      type: "criticStandaloneComment",
      raw: result.raw,
      commentIds: result.comments.map((comment) => comment.id),
    },
    comments: result.comments,
  };
}

function tokenizeCriticChange(
  lexer: TokenizerThis["lexer"],
  src: string,
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>,
  existingComments: Iterable<Pick<CriticComment, "id">>,
  endmatter?: ParsedEndmatter,
  block = false,
):
  | {
      token: CriticChangeToken;
      comments: CriticComment[];
    }
  | undefined {
  const additionMatch = matchCriticWrapped(src, "{++", "++}");

  if (additionMatch) {
    const [, text] = additionMatch;
    const metadata = getTrailingAttributeMetadata(src, additionMatch[0].length);
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      additionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "addition",
      parseChangeMetadata(metadata.metadataText, endmatter),
      existingChanges,
    );

    return {
      token: {
        type: "criticChange",
        raw: additionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        source: block ? text : undefined,
        tokens: block ? lexer.blockTokens(text) : lexer.inlineTokens(text),
      },
      comments: trailingComments.comments,
    };
  }

  const deletionMatch = matchCriticWrapped(src, "{--", "--}");

  if (deletionMatch) {
    const [, text] = deletionMatch;
    const metadata = getTrailingAttributeMetadata(src, deletionMatch[0].length);
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      deletionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "deletion",
      parseChangeMetadata(metadata.metadataText, endmatter),
      existingChanges,
    );

    return {
      token: {
        type: "criticChange",
        raw: deletionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        source: block ? text : undefined,
        tokens: block ? lexer.blockTokens(text) : lexer.inlineTokens(text),
      },
      comments: trailingComments.comments,
    };
  }

  const substitutionMatch = matchCriticSubstitution(src);

  if (substitutionMatch) {
    const [, oldText, newText] = substitutionMatch;
    const metadata = getTrailingAttributeMetadata(
      src,
      substitutionMatch[0].length,
    );
    const trailingComments = tokenizeCriticCommentBlocks(
      src,
      substitutionMatch[0].length + metadata.raw.length,
      existingComments,
      endmatter,
    );
    const change = createChangeWithContext(
      "substitution-old",
      parseChangeMetadata(metadata.metadataText, endmatter),
      existingChanges,
    );

    return {
      token: {
        type: "criticChange",
        raw: substitutionMatch[0] + metadata.raw + trailingComments.raw,
        change,
        commentIds: trailingComments.comments.map((comment) => comment.id),
        oldSource: block ? oldText : undefined,
        newSource: block ? newText : undefined,
        oldTokens: block
          ? lexer.blockTokens(oldText)
          : lexer.inlineTokens(oldText),
        newTokens: block
          ? lexer.blockTokens(newText)
          : lexer.inlineTokens(newText),
      },
      comments: trailingComments.comments,
    };
  }

  return undefined;
}

function renderCriticChangeSpan(
  change: CriticChangeAttrs,
  content: string,
  kind: CriticChangeKind = change.kind,
  commentIds: string[] = [],
) {
  const by = change.authorType === "ai" ? "AI" : change.authorId || "user";
  const changeSpan = `<span data-critic-change-kind="${escapeHtml(kind)}" data-critic-change-id="${escapeHtml(
    change.changeId,
  )}" data-critic-change-by="${escapeHtml(by)}" data-critic-change-at="${escapeHtml(
    change.createdAt,
  )}">${content}</span>`;

  if (commentIds.length === 0) {
    return changeSpan;
  }

  return `<span data-comment-ids="${escapeHtml(
    JSON.stringify(commentIds),
  )}">${changeSpan}</span>`;
}

function renderCriticCodeText(
  text: string,
  comments: Map<string, CriticComment>,
  endmatter?: ParsedEndmatter,
  legacyCodeComments = false,
) {
  let result = "";
  let offset = 0;

  while (offset < text.length) {
    const anchorMatch = text.slice(offset).match(criticCommentAnchorPattern);

    if (!anchorMatch || anchorMatch.index !== 0) {
      result += escapeHtml(text[offset] ?? "");
      offset += 1;
      continue;
    }

    const [, anchor] = anchorMatch;
    let nextOffset = offset + anchorMatch[0].length;
    const parsedComments: CriticComment[] = [];
    let encodedCode = false;

    while (nextOffset < text.length) {
      const commentMatch = text
        .slice(nextOffset)
        .match(criticCommentBlockPattern);
      if (!commentMatch) break;

      const [
        ,
        commentText,
        ,
        legacyMetadataText,
        attributeMetadataText,
        referenceMetadataText,
      ] = commentMatch;
      encodedCode ||= isEncodedCodeReference(
        referenceMetadataText,
        commentText,
        endmatter,
      );
      const comment = createCommentWithContext(
        {
          ...parseMetadata(
            legacyMetadataText,
            attributeMetadataText,
            referenceMetadataText,
            endmatter,
            "comment",
          ),
          content: commentBody(commentText, referenceMetadataText, endmatter),
        },
        [...comments.values(), ...parsedComments],
      );
      parsedComments.push(comment);
      nextOffset += commentMatch[0].length;
    }

    if (parsedComments.length === 0) {
      result += escapeHtml(anchorMatch[0]);
      offset += anchorMatch[0].length;
      continue;
    }

    const commentIds = parsedComments.map((comment) => comment.id);
    if (!encodedCode && !legacyCodeComments) {
      // Code examples are literal unless external review metadata opts in.
      result += escapeHtml(text.slice(offset, nextOffset));
      offset = nextOffset;
      continue;
    }
    for (const comment of parsedComments) {
      comments.set(comment.id, comment);
    }
    const code = encodedCode ? decodeCodeAnchor(anchor) : anchor;
    result += `<span data-comment-ids="${escapeHtml(
      JSON.stringify(commentIds),
    )}">${escapeHtml(code)}</span>`;
    offset = nextOffset;
  }

  return result;
}

function renderCriticCodeBlock(
  token: Tokens.Code,
  comments: Map<string, CriticComment>,
  endmatter?: ParsedEndmatter,
  legacyCodeComments = false,
) {
  const language = (token.lang || "").match(/\S+/)?.[0];
  const classAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
  const content = token.escaped
    ? token.text
    : renderCriticCodeText(token.text, comments, endmatter, legacyCodeComments);

  return `<pre><code${classAttr}>${content}</code></pre>\n`;
}

function commentBelongsToChange(
  id: string,
  changeId: string,
  comments: Map<string, CriticComment>,
) {
  const visited = new Set<string>();
  let parent: string | null | undefined = id;
  while (parent && !visited.has(parent)) {
    if (parent === changeId) return true;
    visited.add(parent);
    parent = comments.get(parent)?.parentCommentId;
  }
  return false;
}

function addCriticCommentRule(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter = false,
  encodedCodeComments?: ReadonlySet<string>,
) {
  const preserveAnchorWhitespace = (node: HTMLElement) => {
    // Run during rule selection, before Turndown trims content or copies its
    // flanking spaces outside the replacement. Those spaces are annotated too.
    const whitespace = (
      node as HTMLElement & {
        flankingWhitespace?: { leading: string; trailing: string };
      }
    ).flankingWhitespace;
    if (!whitespace) return;
    whitespace.leading = "";
    whitespace.trailing = "";
  };
  const isCommentSpan = (node: HTMLElement) =>
    node.nodeName === "SPAN" && node.hasAttribute("data-comment-ids");
  const commentRule: TurndownService.Rule = {
    filter: (node) => {
      if (!isCommentSpan(node)) return false;
      preserveAnchorWhitespace(node);
      return true;
    },
    replacement(content, node) {
      const commentIdsText = (node as HTMLElement).getAttribute(
        "data-comment-ids",
      );

      if (!commentIdsText) return content;

      let commentIds: string[] = [];

      try {
        commentIds = JSON.parse(commentIdsText) as string[];
      } catch {
        return content;
      }

      const block = (node as HTMLElement).closest<HTMLElement>(
        "[data-critic-block]",
      );
      const owner = block ? readCriticBlockChange(block) : null;
      if (owner && block) {
        // Suggestion replies belong to the owning block, not each marked text
        // fragment. Independent comments inside that block retain their anchor.
        const attached = getElementCommentIds(block);
        commentIds = commentIds.filter(
          (id) =>
            !attached.includes(id) &&
            !commentBelongsToChange(id, owner.changeId, comments),
        );
        if (commentIds.length === 0) return content;
        return `{==${content}==}${serializeCommentBlocks(commentIds, comments, useEndmatter, encodedCodeComments)}`;
      }

      const criticChangeElement = (node as HTMLElement).querySelector(
        "span[data-critic-change-kind]",
      );
      const change =
        criticChangeElement instanceof HTMLElement
          ? getElementChangeAttrs(criticChangeElement)
          : null;
      const children = [...node.childNodes];
      const entireChange =
        children[0] === criticChangeElement &&
        (children.length === 1 ||
          (children.length === 2 &&
            change?.kind === "substitution-old" &&
            isPairedSubstitutionElement(
              children[1] instanceof Element ? children[1] : null,
              "substitution-new",
              change.changeId,
            )));
      if (criticChangeElement instanceof HTMLElement && entireChange) {
        return serializeCriticChangeElement(
          service,
          criticChangeElement,
          service.turndown(criticChangeElement.innerHTML).trim(),
          comments,
          commentIds,
          useEndmatter,
          encodedCodeComments,
        );
      }

      const commentBlocks = serializeCommentBlocks(
        commentIds,
        comments,
        useEndmatter,
        encodedCodeComments,
      );
      if (!commentBlocks) return content;
      if (content === unanchoredCommentSentinel) return commentBlocks;

      return `{==${content}==}${commentBlocks}`;
    },
  };
  service.addRule("criticComment", commentRule);
  const selectRule = service.rules.forNode.bind(service.rules);
  service.rules.forNode = (node) => {
    // Turndown's blank rule bypasses custom filters. A separator shared by
    // overlapping comments still needs to retain both anchors.
    if (isCommentSpan(node) && !node.textContent?.trim()) {
      preserveAnchorWhitespace(node);
      return commentRule;
    }
    return selectRule(node);
  };
}

function literalReviewSerializer(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter: boolean,
  encodedCodeComments: ReadonlySet<string>,
) {
  const serializeCode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    const content = [...node.childNodes].map(serializeCode).join("");
    if (node.getAttribute("data-yaml-line-ending") === "crlf")
      return content.replace(/\r?\n/g, "\r\n");
    if (node.hasAttribute("data-comment-ids")) {
      let ids = getElementCommentIds(node);
      const block = node.closest<HTMLElement>("[data-critic-block]");
      const owner = block ? readCriticBlockChange(block) : null;
      if (owner && block) {
        const attached = getElementCommentIds(block);
        ids = ids.filter(
          (id) =>
            !attached.includes(id) &&
            !commentBelongsToChange(id, owner.changeId, comments),
        );
      }
      const feedback = serializeCommentBlocks(
        ids,
        comments,
        useEndmatter,
        encodedCodeComments,
      );
      return feedback ? `{==${content}==}${feedback}` : content;
    }
    if (node.hasAttribute("data-critic-change-kind")) {
      const block = node.closest<HTMLElement>("[data-critic-block]");
      if (
        block &&
        readCriticBlockChange(block)?.changeId ===
          getElementChangeAttrs(node)?.changeId
      )
        return content;
      return serializeCriticChangeElement(
        service,
        node,
        content,
        comments,
        [],
        useEndmatter,
        encodedCodeComments,
        (element) => [...element.childNodes].map(serializeCode).join(""),
      );
    }
    return content;
  };
  return serializeCode;
}

function serializeYamlElement(
  element: HTMLElement,
  literal: (node: Node) => string,
): string {
  const code = element.firstElementChild;
  const content = [...(code?.childNodes ?? [])].map(literal).join("");
  const text =
    element.dataset.yamlLineEnding === "crlf"
      ? content.replace(/\r?\n/g, "\r\n")
      : content;
  return (
    decodeURIComponent(element.dataset.yamlBefore ?? "---%0A") +
    text +
    decodeURIComponent(element.dataset.yamlAfter ?? "%0A---%0A%0A")
  );
}

function blockYaml(element: HTMLElement): HTMLElement | null {
  const child = element.firstElementChild;
  return element.children.length === 1 &&
    child instanceof HTMLElement &&
    child.hasAttribute("data-yaml-frontmatter")
    ? child
    : null;
}

function addCriticCodeBlockRule(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter: boolean,
  encodedCodeComments: ReadonlySet<string>,
) {
  const serializeCode = literalReviewSerializer(
    service,
    comments,
    useEndmatter,
    encodedCodeComments,
  );
  service.addRule("criticCodeBlock", {
    filter: (node) => {
      if (node.nodeName !== "PRE") return false;
      const codeElement = (node as HTMLElement).firstElementChild;
      return codeElement?.nodeName === "CODE";
    },
    replacement(_content, node) {
      const codeElement = (node as HTMLElement)
        .firstElementChild as HTMLElement | null;

      if (!codeElement) return "";

      if ((node as HTMLElement).hasAttribute("data-yaml-frontmatter"))
        return `\n\n${serializeYamlElement(node as HTMLElement, serializeCode)}\n\n`;
      const language =
        [...codeElement.classList]
          .find((className) => className.startsWith("language-"))
          ?.slice("language-".length) ?? "";
      // Prose conversion normalizes code whitespace even without text escaping.
      // Keep literal text bytes and serialize only their annotation nodes.
      const content = [...codeElement.childNodes].map(serializeCode).join("");
      const longest = (content.match(/`+/g) ?? []).reduce(
        (max, run) => Math.max(max, run.length),
        0,
      );
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `\n\n${fence}${language}\n${content}\n${fence}\n\n`;
    },
  });
}

function getElementChangeAttrs(element: HTMLElement): CriticChangeAttrs | null {
  const blockChange = readCriticBlockChange(element);
  if (blockChange) return blockChange;
  const kind = element.getAttribute("data-critic-change-kind");
  const changeId = element.getAttribute("data-critic-change-id");
  const createdAt = element.getAttribute("data-critic-change-at");

  if (
    kind !== "addition" &&
    kind !== "deletion" &&
    kind !== "substitution-old" &&
    kind !== "substitution-new"
  ) {
    return null;
  }

  if (!changeId || !createdAt) return null;

  const rawBy = element.getAttribute("data-critic-change-by") || "user";
  const authorType = rawBy.toUpperCase() === "AI" ? "ai" : "user";

  return {
    kind,
    changeId,
    createdAt,
    authorType,
    authorId: authorType === "ai" ? null : rawBy,
  };
}

function isPairedSubstitutionElement(
  element: Element | null,
  kind: CriticChangeKind,
  changeId: string,
) {
  if (!(element instanceof HTMLElement)) return false;
  const change = getElementChangeAttrs(element);
  return change?.kind === kind && change.changeId === changeId;
}

function getElementCommentIds(element: HTMLElement): string[] {
  const commentIdsText = element.getAttribute("data-comment-ids");
  if (!commentIdsText) return [];

  try {
    const parsed = JSON.parse(commentIdsText) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function getChangeCommentBlocks(
  element: HTMLElement,
  comments: Map<string, CriticComment>,
  extraCommentIds: string[] = [],
  useEndmatter = false,
  encodedCodeComments?: ReadonlySet<string>,
) {
  return serializeCommentBlocks(
    [...new Set([...getElementCommentIds(element), ...extraCommentIds])],
    comments,
    useEndmatter,
    encodedCodeComments,
  );
}

function serializeCriticChangeElement(
  service: TurndownService,
  element: HTMLElement,
  content: string,
  comments: Map<string, CriticComment>,
  extraCommentIds: string[] = [],
  useEndmatter = false,
  encodedCodeComments?: ReadonlySet<string>,
  literalReplacement?: (element: HTMLElement) => string,
  protectLiteralBlock?: (value: string) => string,
) {
  const change = getElementChangeAttrs(element);

  if (!change) return content;
  // A block proposal remains a block even when either side is a single line.
  // The parser uses this explicit newline boundary to select block tokenization.
  const block = Boolean(readCriticBlockChange(element));
  const payload = (value: string) =>
    block
      ? `\n${blockYaml(element) ? (protectLiteralBlock?.(value) ?? value) : value.trim()}\n`
      : value;
  const body = payload(content);

  const commentBlocks = getChangeCommentBlocks(
    element,
    comments,
    extraCommentIds,
    useEndmatter,
    encodedCodeComments,
  );
  const metadata = useEndmatter
    ? `{#${change.changeId}}`
    : serializeChangeMetadata(change);

  if (change.kind === "addition") {
    return `{++${body}++}${metadata}${commentBlocks}`;
  }

  if (change.kind === "deletion") {
    return `{--${body}--}${metadata}${commentBlocks}`;
  }

  if (change.kind === "substitution-new") {
    return isPairedSubstitutionElement(
      element.previousElementSibling,
      "substitution-old",
      change.changeId,
    )
      ? ""
      : `{++${body}++}${
          useEndmatter
            ? `{#${change.changeId}}`
            : serializeChangeMetadata({
                ...change,
                kind: "addition",
              })
        }${commentBlocks}`;
  }

  const nextElement = element.nextElementSibling;

  if (
    nextElement instanceof HTMLElement &&
    isPairedSubstitutionElement(
      nextElement,
      "substitution-new",
      change.changeId,
    )
  ) {
    const replacement = literalReplacement
      ? literalReplacement(nextElement)
      : service.turndown(nextElement).trim();
    return `{~~${body}~>${payload(replacement)}~~}${metadata}${commentBlocks}`;
  }

  return `{--${body}--}${
    useEndmatter
      ? `{#${change.changeId}}`
      : serializeChangeMetadata({
          ...change,
          kind: "deletion",
        })
  }${commentBlocks}`;
}

function addCriticChangeRule(
  service: TurndownService,
  comments: Map<string, CriticComment>,
  useEndmatter = false,
  encodedCodeComments?: ReadonlySet<string>,
  literalBlocks?: Map<string, string>,
  literalBlockPrefix = "roughdraftyamlpayload",
) {
  service.addRule("criticChange", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-critic-change-kind"),
    replacement(content, node) {
      const element = node as HTMLElement;
      const block = element.closest<HTMLElement>("[data-critic-block]");
      if (
        block &&
        readCriticBlockChange(block)?.changeId ===
          getElementChangeAttrs(element)?.changeId
      ) {
        return content;
      }
      return serializeCriticChangeElement(
        service,
        element,
        content,
        comments,
        [],
        useEndmatter,
        encodedCodeComments,
      );
    },
  });
  service.addRule("criticBlockChange", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as HTMLElement).hasAttribute("data-critic-block"),
    replacement(content, node) {
      const element = node as HTMLElement;
      const owner = getElementChangeAttrs(element);
      const replyIds = [
        ...element.querySelectorAll<HTMLElement>("[data-comment-ids]"),
      ]
        .flatMap(getElementCommentIds)
        .filter(
          (id) => owner && commentBelongsToChange(id, owner.changeId, comments),
        );
      const yaml = blockYaml(element);
      const literal = literalReviewSerializer(
        service,
        comments,
        useEndmatter,
        encodedCodeComments ?? new Set(),
      );
      const serialized = serializeCriticChangeElement(
        service,
        element,
        yaml ? serializeYamlElement(yaml, literal) : content.trim(),
        comments,
        replyIds,
        useEndmatter,
        encodedCodeComments,
        yaml
          ? (element) => {
              const other = blockYaml(element);
              return other
                ? serializeYamlElement(other, literal)
                : service.turndown(element).trim();
            }
          : undefined,
        literalBlocks
          ? (value) => {
              let token = `${literalBlockPrefix}${literalBlocks.size}z`;
              while (value.includes(token)) token += "x";
              literalBlocks.set(token, value);
              return token;
            }
          : undefined,
      );
      if (!serialized) return "";
      const next = isPairedSubstitutionElement(
        element.nextElementSibling,
        "substitution-new",
        getElementChangeAttrs(element)?.changeId ?? "",
      )
        ? element.nextElementSibling?.nextElementSibling
        : element.nextElementSibling;
      const prefix = element.previousElementSibling?.hasAttribute(
        "data-critic-boundary",
      )
        ? ""
        : "\n\n";
      const suffix = next?.hasAttribute("data-critic-boundary") ? "" : "\n\n";
      return prefix + serialized + suffix;
    },
  });
  service.addRule("criticChangeBoundary", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as HTMLElement).hasAttribute("data-critic-boundary"),
    replacement(content, node) {
      const { source, side } = JSON.parse(
        (node as HTMLElement).getAttribute("data-critic-boundary") ?? "{}",
      );
      const boundaryContent = content.trim();
      const leading = source?.match(/^\s*/)?.[0] ?? "";
      const trailing = source?.match(/\s*$/)?.[0] ?? "";
      return (
        (side === "prefix" ? "\n\n" : "") +
        leading +
        boundaryContent +
        trailing +
        (side === "suffix" ? "\n\n" : "")
      );
    },
  });
}

function isMultilineChange(src: string): boolean {
  const match =
    matchCriticWrapped(src, "{++", "++}") ??
    matchCriticWrapped(src, "{--", "--}") ??
    matchCriticSubstitution(src);
  return Boolean(match?.slice(1).some((text) => text?.includes("\n")));
}

function markBlockChangeContent(
  node: JSONContent,
  inherited?: CriticChangeAttrs,
  parentType?: string,
): JSONContent {
  const change =
    node.type === "criticChangeBlock"
      ? (node.attrs?.change as CriticChangeAttrs)
      : inherited;
  return {
    ...node,
    ...(node.type === "text" && change && parentType !== "codeBlock"
      ? {
          marks: [
            ...(node.marks ?? []).filter(
              (mark) => mark.type !== "criticChange",
            ),
            { type: "criticChange", attrs: change },
          ],
        }
      : {}),
    ...(node.content
      ? {
          content: node.content.map((child) =>
            markBlockChangeContent(child, change, node.type),
          ),
        }
      : {}),
  };
}

function createCriticMarked(
  markdownOptions?: CriticMarkdownOptions,
  endmatter?: ParsedEndmatter,
) {
  const comments = new Map<string, CriticComment>();
  const changes = new Map<string, CriticChangeAttrs>();
  const renderer = createMarkedRenderer(markdownOptions);
  renderer.code = (token) =>
    renderCriticCodeBlock(
      token,
      comments,
      endmatter,
      markdownOptions?.legacyCodeComments,
    );
  const parser = new Marked({
    gfm: true,
    async: false,
    renderer,
  });
  parser.use(endnoteExtension(undefined, markdownOptions?.endnoteDefinitions));

  parser.use({
    extensions: [
      {
        name: "criticBlockChange",
        level: "block",
        tokenizer(this: TokenizerThis, src: string) {
          let offset = 0;
          if (!isMultilineChange(src)) {
            // Only the current paragraph can introduce a partial selection.
            // The shared scanner skips code examples and escaped markers.
            const firstParagraphEnd = src.search(/\n[ \t]*\n/);
            const paragraph =
              firstParagraphEnd < 0 ? src : src.slice(0, firstParagraphEnd);
            if (!/\{(?:\+\+|--|~~)/.test(paragraph)) return undefined;
            const first = extractRoughdraftReviewIndex(src).items.find(
              (item) =>
                item.kind === "suggestion" &&
                isMultilineChange(src.slice(item.offset)),
            );
            if (
              !first ||
              (firstParagraphEnd >= 0 && first.offset > firstParagraphEnd)
            )
              return undefined;
            offset = first.offset;
          }
          const result = tokenizeCriticChange(
            this.lexer,
            src.slice(offset),
            changes.values(),
            comments.values(),
            endmatter,
            true,
          );
          if (!result) return undefined;
          for (const comment of result.comments)
            comments.set(comment.id, comment);
          changes.set(result.token.change.changeId, result.token.change);
          const after = src.slice(offset + result.token.raw.length);
          const suffix = after.match(/^[^\r\n]+/)?.[0] ?? "";
          return {
            ...result.token,
            type: "criticBlockChange",
            raw: src.slice(0, offset) + result.token.raw + suffix,
            prefix: src.slice(0, offset),
            suffix,
          };
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const change = token as CriticChangeToken;
          const renderBlock = (
            kind: CriticChangeKind,
            tokens: Token[],
            source?: string,
          ) => {
            const raw = (source ?? tokens.map((token) => token.raw).join(""))
              .replace(/^\n/, "")
              .replace(/\n$/, "");
            const split = splitYamlFrontmatter(raw);
            let html: string;
            if (split.frontmatter) {
              const yaml = criticFrontmatterToEditorState(
                split.frontmatter,
                null,
                endmatter,
                endmatter?.suggestions.get(change.change.changeId)
                  ?.literalChangeEncoding === "backslash",
              );
              for (const [id, comment] of yaml.comments)
                comments.set(id, comment);
              html =
                renderHtml({ type: "doc", content: [yaml.node] }) +
                (split.body ? (parser.parse(split.body) as string) : "");
            } else html = this.parser.parse(tokens);
            return `<div data-critic-block="${escapeHtml(JSON.stringify({ ...change.change, kind }))}" data-comment-ids="${escapeHtml(JSON.stringify(change.commentIds))}">${html}</div>\n`;
          };
          const renderBoundary = (side: "prefix" | "suffix", source: string) =>
            source
              ? `<div data-critic-boundary="${escapeHtml(JSON.stringify({ changeId: change.change.changeId, side, source }))}">${parser.parse(source)}</div>\n`
              : "";
          return (
            renderBoundary("prefix", change.prefix ?? "") +
            (change.change.kind === "substitution-old"
              ? renderBlock(
                  "substitution-old",
                  change.oldTokens ?? [],
                  change.oldSource,
                ) +
                renderBlock(
                  "substitution-new",
                  change.newTokens ?? [],
                  change.newSource,
                )
              : renderBlock(
                  change.change.kind,
                  change.tokens ?? [],
                  change.source,
                )) +
            renderBoundary("suffix", change.suffix ?? "")
          );
        },
        childTokens: ["tokens", "oldTokens", "newTokens"],
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticCommentAnchor",
        level: "inline",
        start(src: string) {
          return src.indexOf("{==");
        },
        tokenizer(this: TokenizerThis, src: string) {
          const result = tokenizeCriticCommentAnchor(
            this.lexer,
            src,
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          return result.token;
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticCommentToken;
          return `<span data-comment-ids="${escapeHtml(
            JSON.stringify(criticToken.commentIds),
          )}">${this.parser.parseInline(criticToken.tokens)}</span>`;
        },
        childTokens: ["tokens"],
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticStandaloneComment",
        level: "inline",
        start(src: string) {
          return src.indexOf("{>>");
        },
        tokenizer(src: string) {
          const result = tokenizeCriticStandaloneComment(
            src,
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          return result.token;
        },
        renderer(token: Tokens.Generic) {
          const criticToken = token as CriticStandaloneCommentToken;
          return `<span data-comment-ids="${escapeHtml(
            JSON.stringify(criticToken.commentIds),
          )}" data-comment-anchorless="true">${unanchoredCommentSentinel}</span>`;
        },
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticChange",
        level: "inline",
        start(src: string) {
          const starts = ["{++", "{--", "{~~"]
            .map((marker) => src.indexOf(marker))
            .filter((index) => index >= 0);

          return starts.length > 0 ? Math.min(...starts) : undefined;
        },
        tokenizer(this: TokenizerThis, src: string) {
          const result = tokenizeCriticChange(
            this.lexer,
            src,
            changes.values(),
            comments.values(),
            endmatter,
          );
          if (!result) return undefined;

          for (const comment of result.comments) {
            comments.set(comment.id, comment);
          }
          changes.set(result.token.change.changeId, result.token.change);
          return result.token;
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticChangeToken;

          if (criticToken.change.kind === "substitution-old") {
            const oldContent = this.parser.parseInline(
              criticToken.oldTokens ?? [],
            );
            const newContent = this.parser.parseInline(
              criticToken.newTokens ?? [],
            );
            const substitutionHtml = `${renderCriticChangeSpan(
              criticToken.change,
              oldContent,
              "substitution-old",
            )}${renderCriticChangeSpan(
              criticToken.change,
              newContent,
              "substitution-new",
            )}`;

            if (criticToken.commentIds.length === 0) {
              return substitutionHtml;
            }

            return `<span data-comment-ids="${escapeHtml(
              JSON.stringify(criticToken.commentIds),
            )}">${substitutionHtml}</span>`;
          }

          return renderCriticChangeSpan(
            criticToken.change,
            this.parser.parseInline(criticToken.tokens ?? []),
            criticToken.change.kind,
            criticToken.commentIds,
          );
        },
        childTokens: ["tokens", "oldTokens", "newTokens"],
      } satisfies TokenizerAndRendererExtension,
    ],
  });

  return { parser, comments, changes };
}

export function criticMarkdownHasReviewRail(
  markdown: string,
  options?: CriticMarkdownOptions,
): boolean {
  const { body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments, changes } = createCriticMarked(
    options,
    parsedEndmatter,
  );
  parser.parse(protectRichTextRoundTripMarkdown(body));
  addEndmatterFeedback(comments, parsedEndmatter);
  return comments.size > 0 || changes.size > 0;
}

export function criticMarkdownToRenderedHtml(
  markdown: string,
  options?: CriticMarkdownOptions,
): {
  html: string;
  comments: Map<string, CriticComment>;
  changes: Map<string, CriticChangeAttrs>;
  frontmatter: string | null;
  endmatter: string | null;
} {
  const { frontmatter, body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsedEndmatter = parseReviewEndmatter(endmatter);
  const { parser, comments, changes } = createCriticMarked(
    options,
    parsedEndmatter,
  );
  let html = parser.parse(protectRichTextRoundTripMarkdown(body)) as string;
  if (html.includes("data-critic-block=")) {
    html = renderHtml(markBlockChangeContent(parseHtml(html)));
  }
  addEndmatterFeedback(comments, parsedEndmatter);

  return { html, comments, changes, frontmatter, endmatter };
}

function renderFrontmatterReviewText(
  text: string,
  comments: Map<string, CriticComment>,
  changes: Map<string, CriticChangeAttrs>,
  review: ParsedEndmatter,
  decodeEscapes = false,
): string {
  if (
    ![...review.comments.values(), ...review.suggestions.values()].some(
      (entry) => entry.frontmatterAnchor === true,
    )
  )
    return escapeHtml(decodeEscapes ? decodeCodeAnchor(text) : text);
  const lexer = {
    inlineTokens: (value: string) => [
      { type: "text", raw: value, text: value },
    ],
  } as unknown as TokenizerThis["lexer"];
  const tokensText = (tokens: Token[] = []) =>
    tokens.map((token) => ("text" in token ? token.text : token.raw)).join("");
  const render = (value: string, decode = false) =>
    renderFrontmatterReviewText(value, comments, changes, review, decode);
  let html = "";
  for (let offset = 0; offset < text.length; ) {
    const source = text.slice(offset);
    if (source.startsWith("\\")) {
      html += escapeHtml(
        decodeEscapes && /[\\{}>]/.test(source[1] ?? "")
          ? source[1]
          : source.slice(0, 2),
      );
      offset += Math.min(2, source.length);
      continue;
    }
    if (source.startsWith("{==")) {
      const result = tokenizeCriticCommentAnchor(
        lexer,
        source,
        comments.values(),
        review,
      );
      if (
        result?.comments.every(
          (comment) =>
            review.comments.get(comment.id)?.frontmatterAnchor === true,
        )
      ) {
        for (const comment of result.comments)
          comments.set(comment.id, comment);
        const encoded = result.comments.some(
          (comment) =>
            review.comments.get(comment.id)?.codeAnchorEncoding === "backslash",
        );
        const anchor = tokensText(result.token.tokens);
        html += `<span data-comment-ids="${escapeHtml(JSON.stringify(result.token.commentIds))}">${render(anchor, encoded)}</span>`;
        offset += result.token.raw.length;
        continue;
      }
    }
    if (/^\{(?:\+\+|--|~~)/.test(source)) {
      const result = tokenizeCriticChange(
        lexer,
        source,
        changes.values(),
        comments.values(),
        review,
      );
      if (
        result &&
        review.suggestions.get(result.token.change.changeId)
          ?.frontmatterAnchor === true
      ) {
        const token = result.token;
        changes.set(token.change.changeId, token.change);
        for (const comment of result.comments)
          comments.set(comment.id, comment);
        const encoded =
          review.suggestions.get(token.change.changeId)
            ?.literalChangeEncoding === "backslash";
        const content =
          token.change.kind === "substitution-old"
            ? renderCriticChangeSpan(
                token.change,
                render(tokensText(token.oldTokens), encoded),
                "substitution-old",
              ) +
              renderCriticChangeSpan(
                token.change,
                render(tokensText(token.newTokens), encoded),
                "substitution-new",
              )
            : renderCriticChangeSpan(
                token.change,
                render(tokensText(token.tokens), encoded),
              );
        html += token.commentIds.length
          ? `<span data-comment-ids="${escapeHtml(JSON.stringify(token.commentIds))}">${content}</span>`
          : content;
        offset += token.raw.length;
        continue;
      }
    }
    html += escapeHtml(text[offset++]);
  }
  return html;
}

/** YAML text shares selection/review/history without being parsed as Markdown. */
export function criticFrontmatterToEditorState(
  frontmatter: string,
  endmatter: string | null,
  registry?: ParsedEndmatter,
  decodeEscapes = false,
): {
  node: JSONContent;
  comments: Map<string, CriticComment>;
} {
  const comments = new Map<string, CriticComment>();
  const changes = new Map<string, CriticChangeAttrs>();
  const opening = frontmatter.match(/^---[ \t]*\r?\n/)?.[0] ?? "---\n";
  const closingMatch = /(?:^|\n)(?:---|\.\.\.)[ \t]*(?:\r?\n[\s\S]*)?$/.exec(
    frontmatter.slice(opening.length),
  );
  const closingAt =
    opening.length +
    (closingMatch?.index ?? frontmatter.length - opening.length);
  let text = frontmatter.slice(opening.length, closingAt);
  let closing = frontmatter.slice(closingAt);
  if (text.endsWith("\r") && closing.startsWith("\n")) {
    text = text.slice(0, -1);
    closing = `\r${closing}`;
  }
  const lineEnding =
    frontmatter.includes("\r\n") &&
    !frontmatter.replaceAll("\r\n", "").includes("\n")
      ? "crlf"
      : "lf";
  const rendered = renderFrontmatterReviewText(
    text,
    comments,
    changes,
    registry ?? parseReviewEndmatter(endmatter),
    decodeEscapes,
  );
  const mixed =
    text.includes("\r\n") && text.replaceAll("\r\n", "").includes("\n");
  const content = mixed
    ? rendered.replaceAll(
        "\r\n",
        '<span data-yaml-line-ending="crlf">\n</span>',
      )
    : rendered.replaceAll("\r\n", "\n");
  const html = `<pre data-yaml-frontmatter="true" data-yaml-before="${escapeHtml(encodeURIComponent(opening))}" data-yaml-after="${escapeHtml(encodeURIComponent(closing))}" data-yaml-line-ending="${lineEnding}"><code>${content}</code></pre>`;
  return {
    node: parseHtml(html).content?.[0] ?? { type: "yamlFrontmatter" },
    comments,
  };
}

export function criticMarkdownToEditorState(
  markdown: string,
  options?: CriticMarkdownOptions,
): {
  doc: JSONContent;
  comments: Map<string, CriticComment>;
  frontmatter: string | null;
  endmatter: string | null;
} {
  const { frontmatter, body, endmatter } = splitYamlDocumentMetadata(markdown);
  const parsed = criticMarkdownBodyToEditorState(
    body,
    {
      frontmatter,
      endmatter,
      review: parseReviewEndmatter(endmatter),
    },
    options,
  );
  parsed.doc.attrs = { ...parsed.doc.attrs, frontmatterInContent: true };
  if (frontmatter) {
    const yaml = criticFrontmatterToEditorState(frontmatter, endmatter);
    parsed.doc.content = [yaml.node, ...(parsed.doc.content ?? [])];
    for (const [id, comment] of yaml.comments) parsed.comments.set(id, comment);
  }
  return parsed;
}

/** Parse a body block using its containing document's already-read metadata. */
export function criticMarkdownBodyToEditorState(
  body: string,
  context: {
    frontmatter: string | null;
    endmatter: string | null;
    review: ParsedEndmatter;
  },
  options?: CriticMarkdownOptions,
): ReturnType<typeof criticMarkdownToEditorState> {
  const { frontmatter, endmatter, review } = context;
  const { parser, comments } = createCriticMarked(options, review);
  const html = parser.parse(protectRichTextRoundTripMarkdown(body)) as string;
  const doc = markBlockChangeContent(parseHtml(html)) as JSONContent & {
    yamlFrontmatter?: string;
    yamlEndmatter?: string;
  };
  addEndmatterFeedback(comments, review);
  if (frontmatter) {
    doc.yamlFrontmatter = frontmatter;
  }
  if (endmatter) {
    doc.yamlEndmatter = endmatter;
  }

  return { doc, comments, frontmatter, endmatter };
}

function collectCriticChangesFromDoc(
  doc: JSONContent,
): Map<string, CriticChangeAttrs> {
  const changes = new Map<string, CriticChangeAttrs>();
  const visit = (node: JSONContent) => {
    if (node.type === "criticChangeBlock" && node.attrs?.change) {
      const change = node.attrs.change as CriticChangeAttrs;
      changes.set(change.changeId, change);
    }
    for (const mark of node.marks ?? []) {
      if (mark.type !== "criticChange") continue;

      const attrs = mark.attrs as Partial<CriticChangeAttrs> | undefined;
      if (
        attrs?.changeId &&
        attrs.kind &&
        attrs.createdAt &&
        attrs.authorType
      ) {
        changes.set(attrs.changeId, {
          kind: attrs.kind,
          changeId: attrs.changeId,
          createdAt: attrs.createdAt,
          authorType: attrs.authorType,
          authorId: attrs.authorId ?? null,
        });
      }
    }

    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(doc);
  return changes;
}

function encodeCommentedCode(
  fragment: DocumentFragment | HTMLElement,
): Set<string> {
  const texts: { node: Text; ids: string[] }[] = [];
  const encoded = new Set<string>();
  for (const code of fragment.querySelectorAll("code")) {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      const anchor = node.parentElement?.closest<HTMLElement>(
        "span[data-comment-ids]",
      );
      const ids = anchor ? getElementCommentIds(anchor) : [];
      if (ids.length) {
        texts.push({ node, ids });
        for (const id of ids) encoded.add(id);
      }
      node = walker.nextNode() as Text | null;
    }
  }
  // Explicit metadata distinguishes generated escapes from authored code.
  // Encode every code fragment of a flagged thread, including safe paths.
  for (const { node, ids } of texts)
    if (ids.some((id) => encoded.has(id)))
      node.data = node.data.replace(/[\\{}]/g, "\\$&");
  return encoded;
}

function encodeYamlProposalText(
  fragment: DocumentFragment | HTMLElement,
): Set<string> {
  const ids = new Set<string>();
  for (const yaml of fragment.querySelectorAll(
    "[data-yaml-frontmatter] code",
  )) {
    const walker = document.createTreeWalker(yaml, NodeFilter.SHOW_TEXT);
    for (let value = walker.nextNode(); value; value = walker.nextNode()) {
      const change = value.parentElement?.closest<HTMLElement>(
        "[data-critic-change-id]",
      );
      const id = change?.getAttribute("data-critic-change-id");
      if (!id) continue;
      ids.add(id);
      if (!value.parentElement?.closest("span[data-comment-ids]"))
        value.textContent = (value.textContent ?? "")
          .replace(/[\\{}]/g, "\\$&")
          .replaceAll("~>", "~\\>");
    }
  }
  return ids;
}

export function editorStateToCriticMarkdown(
  doc: JSONContent,
  comments: Map<string, CriticComment>,
  options?: { frontmatter?: string | null; endmatter?: string | null },
): string {
  const model = schema.nodeFromJSON(doc);
  const fragment = domSerializer.serializeFragment(model.content);
  const yamlElement = fragment.firstElementChild?.hasAttribute(
    "data-yaml-frontmatter",
  )
    ? (fragment.firstElementChild as HTMLElement)
    : null;
  const frontmatterComments = new Set<string>();
  const frontmatterSuggestions = new Set<string>();
  for (const yaml of fragment.querySelectorAll<HTMLElement>(
    "[data-yaml-frontmatter]",
  )) {
    for (const element of yaml.querySelectorAll<HTMLElement>(
      "[data-comment-ids]",
    ))
      for (const id of getElementCommentIds(element))
        frontmatterComments.add(id);
    for (const element of yaml.querySelectorAll<HTMLElement>(
      "[data-critic-change-id]",
    )) {
      const id = element.getAttribute("data-critic-change-id");
      if (id) frontmatterSuggestions.add(id);
    }
  }
  const encodedCodeComments = encodeCommentedCode(fragment);
  const encodedYamlChanges = encodeYamlProposalText(fragment);
  const service = createTurndownService();
  const escapeMarkdownText = service.escape.bind(service);
  // Review wrappers are introduced by the annotation rules after text escapes.
  // A user typing the same punctuation in the document is writing literal text.
  service.escape = (text) =>
    escapeMarkdownText(text)
      .replace(/\{(?=(?:==|>>|\+\+|--|~~))/g, "\\{")
      .replace(/(==|\+\+|--|<<)\}/g, "$1\\}")
      .replace(/~>/g, "~\\>")
      .replaceAll("~", "\\~")
      .replace(/[<&]/g, "\\$&");
  let frontmatter =
    options?.frontmatter ??
    (doc as JSONContent & { yamlFrontmatter?: string }).yamlFrontmatter ??
    null;
  const sourceEndmatter =
    options?.endmatter ??
    (doc as JSONContent & { yamlEndmatter?: string }).yamlEndmatter ??
    null;
  const changes = collectCriticChangesFromDoc(doc);
  const referenced = new Set<string>();
  let splitComments = false;
  for (const anchor of fragment.querySelectorAll<HTMLElement>(
    "span[data-comment-ids]",
  )) {
    for (const id of getElementCommentIds(anchor)) {
      if (referenced.has(id)) splitComments = true;
      referenced.add(id);
    }
  }
  const useEndmatter =
    Boolean(sourceEndmatter) ||
    frontmatterComments.size > 0 ||
    frontmatterSuggestions.size > 0 ||
    encodedCodeComments.size > 0 ||
    splitComments ||
    [...comments.values()].some(needsCommentBody);
  addCriticCommentRule(service, comments, useEndmatter, encodedCodeComments);
  const literalBlocks = new Map<string, string>();
  let literalBlockPrefix = "roughdraftyamlpayload";
  if (fragment.querySelector("[data-critic-block] [data-yaml-frontmatter]")) {
    const source = JSON.stringify([doc, [...comments], options]);
    while (source.includes(literalBlockPrefix)) literalBlockPrefix += "x";
  }
  addCriticChangeRule(
    service,
    comments,
    useEndmatter,
    encodedCodeComments,
    literalBlocks,
    literalBlockPrefix,
  );
  addCriticCodeBlockRule(service, comments, useEndmatter, encodedCodeComments);
  if (yamlElement) {
    frontmatter = serializeYamlElement(
      yamlElement,
      literalReviewSerializer(
        service,
        comments,
        useEndmatter,
        encodedCodeComments,
      ),
    );
    yamlElement.remove();
  } else if (doc.attrs?.frontmatterInContent) {
    frontmatter = null;
  }
  const endmatter = serializeReviewEndmatter(
    sourceEndmatter,
    comments,
    changes,
    useEndmatter,
    encodedCodeComments,
    frontmatterComments,
    frontmatterSuggestions,
    encodedYamlChanges,
  );
  const body = service.turndown(fragment).trimEnd();
  let normalized = body
    ? normalizeBlockSpacing(`${body}\n`)
    : frontmatter
      ? ""
      : "\n";
  for (const [token, value] of literalBlocks)
    normalized = normalized.replace(token, () => value);
  return appendYamlEndmatter(
    prependYamlFrontmatter(normalized, frontmatter),
    endmatter,
  );
}

export function createCriticComment(
  partial?: Partial<CriticComment>,
  options?: {
    existingComments?: Iterable<Pick<CriticComment, "id">>;
  },
): CriticComment {
  return createCommentWithContext(partial, options?.existingComments);
}

export function createCriticChange(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  options?: {
    existingChanges?: Iterable<Pick<CriticChangeAttrs, "changeId">>;
  },
): CriticChangeAttrs {
  return createChangeWithContext(kind, partial, options?.existingChanges);
}
