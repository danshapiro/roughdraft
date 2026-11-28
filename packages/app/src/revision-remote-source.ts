import { Fragment, type Mark, type Node } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { diffArrays, diffChars } from "diff";
import { Marked } from "marked";
import {
  type CriticComment,
  criticMarkdownBodyToEditorState,
  criticFrontmatterToEditorState,
  criticMarkdownToEditorState,
  readReviewEndmatter,
} from "./critic-markup";
import { endnoteExtension, noteKey } from "./endnotes";
import { splitYamlDocumentMetadata } from "./markdown";
import { editableMarkdownOptions } from "./revision-markdown";
import { stableSuggestionDates } from "./revision-source";

export interface ParsedSource {
  doc: Node;
  comments: Map<string, CriticComment>;
  frontmatter: string | null;
  endmatter: string | null;
  registryIds?: Set<string>;
  sourceBlocks?: Array<{
    from: number;
    to: number;
    index: number;
    count: number;
  }>;
}
const caches = new WeakMap<object, Map<string, ParsedSource>>();
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
interface SourceLayout {
  readonly spans: ReadonlyArray<Readonly<{ from: number; to: number }>>;
  readonly definitions: string;
  readonly endnoteDefinitions: ReadonlySet<string>;
  readonly context: string;
}
const layouts = new Map<
  string,
  { layout: SourceLayout | null; bytes: number }
>();
const MAX_LAYOUTS = 8;
const MAX_LAYOUT_BYTES = 1024 * 1024;
let layoutBytes = 0;

/** Reuse only literal prose whose Markdown meaning needs no parser or context. */
export function unchangedPlainParagraph(
  raw: string,
  live: Node | null,
  template: Node | undefined,
) {
  if (
    !live ||
    !template ||
    !live.sameMarkup(template) ||
    !live.children.every((child) => child.isText && !child.marks.length)
  )
    return false;
  const text = raw.replace(/[\r\n]+$/, "");
  return (
    /^[\p{L}][\p{L}\p{N} .,!?;()'’"%-]*$/u.test(text) &&
    !/ {2}| $/.test(text) &&
    !/\bwww\./i.test(text) &&
    live.textContent === text
  );
}

/** Keep a review range spanning blank lines together before parsing blocks. */
function reviewRanges(body: string) {
  const ranges: Array<{ from: number; to: number }> = [];
  const stack: Array<{ from: number; close: string }> = [];
  const closes: Record<string, string> = {
    "{~~": "~~}",
    "{++": "++}",
    "{--": "--}",
    "{==": "==}",
    "{>>": "<<}",
  };
  let fence: { char: string; size: number } | null = null;
  let inline = 0;
  for (let at = 0; at < body.length; at++) {
    if (at === 0 || body[at - 1] === "\n") {
      const line = body.slice(
        at,
        body.indexOf("\n", at) < 0 ? undefined : body.indexOf("\n", at),
      );
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match) {
        if (!fence) fence = { char: match[1][0], size: match[1].length };
        else if (
          match[1][0] === fence.char &&
          match[1].length >= fence.size &&
          !match[2].trim()
        )
          fence = null;
        at += line.length;
        continue;
      }
    }
    if (fence) continue;
    if (body[at] === "\\") {
      at++;
      continue;
    }
    if (body[at] === "`") {
      let end = at + 1;
      while (body[end] === "`") end++;
      const count = end - at;
      if (!inline) inline = count;
      else if (inline === count) inline = 0;
      at = end - 1;
      continue;
    }
    if (inline) continue;
    const marker = body.slice(at, at + 3);
    if (stack.length && marker === stack.at(-1)?.close) {
      const open = stack.pop();
      if (open && !stack.length && body.slice(open.from, at).includes("\n")) {
        const id = /^\{#[A-Za-z][A-Za-z0-9_-]*\}/.exec(body.slice(at + 3));
        ranges.push({ from: open.from, to: at + 3 + (id?.[0].length ?? 0) });
      }
      at += 2;
    } else if (closes[marker]) {
      stack.push({ from: at, close: closes[marker] });
      at += 2;
    }
  }
  // An unfinished annotation must never be split into independently parsed blocks.
  if (stack.length) ranges.push({ from: stack[0].from, to: body.length });
  return ranges;
}

/** Reuse source-only offsets/context, never a parsed model or live attributes. */
function sourceBlocks(body: string): SourceLayout | null {
  const cached = layouts.get(body);
  if (cached) {
    layouts.delete(body);
    layouts.set(body, cached);
    return cached.layout;
  }
  const layout = lexSourceBlocks(body);
  const bytes =
    body.length * 2 +
    (layout
      ? (layout.definitions.length +
          layout.context.length +
          [...layout.endnoteDefinitions].join("").length) *
          2 +
        layout.spans.length * 16
      : 0);
  if (bytes <= MAX_LAYOUT_BYTES) {
    layouts.set(body, { layout, bytes });
    layoutBytes += bytes;
    while (layouts.size > MAX_LAYOUTS || layoutBytes > MAX_LAYOUT_BYTES) {
      const oldest = layouts.entries().next().value;
      if (!oldest) break;
      layoutBytes -= oldest[1].bytes;
      layouts.delete(oldest[0]);
    }
  }
  return layout;
}

function lexSourceBlocks(body: string): SourceLayout | null {
  const normalized = body.replace(/\r\n?/g, "\n");
  const offsets = [0];
  for (let at = 0; at < body.length; at++) {
    if (body[at] === "\r" && body[at + 1] === "\n") at++;
    offsets.push(at + 1);
  }
  const lexer = new Marked();
  lexer.use(endnoteExtension());
  const tokens = lexer.lexer(normalized);
  const protectedRanges = reviewRanges(body);
  const spans: Array<{ from: number; to: number }> = [];
  let offset = 0;
  for (const token of tokens) {
    const start = normalized.indexOf(token.raw, offset);
    if (start < 0) return null;
    offset = start + token.raw.length;
    if (token.type === "space") continue;
    let from = offsets[start];
    let to = offsets[offset];
    for (const range of protectedRanges)
      if (from < range.to && to > range.from) {
        from = Math.min(from, range.from);
        to = Math.max(to, range.to);
      }
    const previous = spans.at(-1);
    if (previous && from < previous.to) previous.to = Math.max(previous.to, to);
    else spans.push({ from, to });
  }
  const definitions = Object.entries(tokens.links)
    .map(
      ([id, value]) =>
        `[${id}]: ${value.href}${value.title ? ` ${JSON.stringify(value.title)}` : ""}`,
    )
    .join("\n");
  // Footnote definitions and supported raw blocks depend on surrounding source.
  // Parse those documents as complete context when the context itself changes.
  const footnoteTokens = tokens.filter(
    (token) => token.type === "endnoteDefinition",
  );
  const footnotes = footnoteTokens
    .map(
      (token) =>
        (token as unknown as { definitionSource?: string }).definitionSource ??
        token.raw,
    )
    .join("\n");
  const endnoteDefinitions = new Set(
    footnoteTokens.map((token) =>
      noteKey(String((token as unknown as { label: string }).label)),
    ),
  );
  return {
    spans,
    definitions,
    endnoteDefinitions,
    context: `${JSON.stringify(tokens.links)}\0${footnotes}`,
  };
}

/** Parse changed blocks only; document-wide metadata/reference changes invalidate keys. */
export function parseRemoteRevision(
  markdown: string,
  state: EditorState,
): ParsedSource {
  const { body, frontmatter, endmatter } = splitYamlDocumentMetadata(markdown);
  const blocks = sourceBlocks(body);
  const cache = caches.get(state.schema) ?? new Map<string, ParsedSource>();
  caches.set(state.schema, cache);
  const registry = readReviewEndmatter(endmatter);
  const context = blocks?.context ?? "";
  if (!blocks?.spans.length) {
    const parsed = criticMarkdownToEditorState(
      markdown,
      editableMarkdownOptions,
    );
    stableSuggestionDates(parsed.doc, state.doc, markdown);
    return { ...parsed, doc: state.schema.nodeFromJSON(parsed.doc) };
  }
  const nodes: Node[] = [];
  const sourceRanges: NonNullable<ParsedSource["sourceBlocks"]> = [];
  const comments = new Map<string, CriticComment>();
  const used = new Set<string>();
  if (frontmatter) {
    const yaml = criticFrontmatterToEditorState(frontmatter, endmatter);
    nodes.push(state.schema.nodeFromJSON(yaml.node));
    sourceRanges.push({ from: 0, to: frontmatter.length, index: 0, count: 1 });
    for (const [id, comment] of yaml.comments) comments.set(id, comment);
  }
  const plainParagraph = state.schema.nodes.paragraph?.create();
  for (const span of blocks.spans) {
    const raw = body.slice(span.from, span.to);
    const live = state.doc.maybeChild(nodes.length);
    if (unchangedPlainParagraph(raw, live, plainParagraph) && live) {
      sourceRanges.push({
        from: (frontmatter?.length ?? 0) + span.from,
        to: (frontmatter?.length ?? 0) + span.to,
        index: nodes.length,
        count: 1,
      });
      nodes.push(live);
      continue;
    }
    const ids = new Set(
      [
        ...raw.matchAll(
          /\{#([A-Za-z][A-Za-z0-9_-]*)\}|\bid="([A-Za-z][A-Za-z0-9_-]*)"/g,
        ),
      ].map((match) => match[1] ?? match[2]),
    );
    const registryKey = JSON.stringify(
      [...ids].map((id) => [
        id,
        registry.metadata.comments.get(id) ??
          registry.metadata.suggestions.get(id) ??
          null,
      ]),
    );
    const key = `${context}\0${registryKey}\0${raw}`;
    used.add(key);
    let parsed = cache.get(key);
    if (!parsed) {
      const source = `${frontmatter ? `${frontmatter}\n` : ""}${raw}\n${blocks.definitions ? `\n${blocks.definitions}\n` : ""}${endmatter ? `\n${endmatter}` : ""}`;
      // Terminal newlines are part of preserved code/endnote source attributes.
      // Add a separator only when appending the document's link definitions.
      const framedBody = `${raw}${blocks.definitions ? `\n\n${blocks.definitions}\n` : ""}`;
      const result = criticMarkdownBodyToEditorState(
        endmatter ? framedBody.replace(/\s*$/, "\n") : framedBody,
        { frontmatter, endmatter, review: registry.metadata },
        {
          ...editableMarkdownOptions,
          endnoteDefinitions: blocks.endnoteDefinitions,
        },
      );
      stableSuggestionDates(result.doc, state.doc, source);
      parsed = {
        ...result,
        doc: state.schema.nodeFromJSON(result.doc),
        registryIds: new Set(registry.metadata.comments.keys()),
      };
      cache.set(key, parsed);
    }
    sourceRanges.push({
      from: (frontmatter?.length ?? 0) + span.from,
      to: (frontmatter?.length ?? 0) + span.to,
      index: nodes.length,
      count: parsed.doc.childCount,
    });
    parsed.doc.forEach((node) => {
      nodes.push(node);
    });
    for (const [id, comment] of parsed.comments)
      if (ids.has(id) || !parsed.registryIds?.has(id))
        comments.set(id, comment);
  }
  for (const [id, comment] of registry.comments)
    if (!comments.has(id)) comments.set(id, comment);
  let bytes = 0;
  for (const key of cache.keys()) bytes += key.length * 2;
  if (bytes > MAX_CACHE_BYTES)
    for (const key of cache.keys()) if (!used.has(key)) cache.delete(key);
  const numbers = new Map<string, number>();
  const occurrences = new Map<string, number>();
  const numberFor = (label: string) => {
    const key = noteKey(label);
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    return String(numbers.get(key));
  };
  const renumberNotes = (node: Node): Node => {
    let attrs = node.attrs;
    if (node.type.name === "endnoteReference") {
      const key = noteKey(String(node.attrs.label));
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      attrs = {
        ...attrs,
        number: numberFor(String(attrs.label)),
        occurrence: String(occurrence),
      };
    } else if (node.type.name === "endnoteDefinition")
      attrs = { ...attrs, number: numberFor(String(attrs.label)) };
    if (node.isLeaf)
      return attrs === node.attrs
        ? node
        : node.type.create(attrs, node.content, node.marks);
    const children = node.children.map(renumberNotes);
    return attrs === node.attrs &&
      children.every((child, index) => child === node.child(index))
      ? node
      : node.type.create(attrs, children, node.marks);
  };
  const normalized = nodes.map((node, index) => {
    const next = renumberNotes(node);
    const live = state.doc.maybeChild(index);
    // Keep the live immutable block's warmed projection/serialization caches
    // when parsing produces exactly the same content, marks and attributes.
    return live?.eq(next) ? live : next;
  });
  return {
    doc: state.schema.topNodeType.create(
      { frontmatterInContent: true },
      normalized,
    ),
    comments,
    frontmatter,
    endmatter,
    sourceBlocks: sourceRanges,
  };
}

/** Separate text edits from mark changes when formatting splits text nodes. */
function patchTextFragments(
  tr: Transaction,
  before: Node[],
  after: Node[],
  offset: number,
) {
  const text = (nodes: Node[]) => nodes.map((node) => node.text ?? "").join("");
  const oldText = text(before),
    newText = text(after);
  const parts = diffChars(oldText, newText, {
    timeout: 8,
    maxEditLength: 4096,
  });
  if (!parts) return false;
  const spans = (nodes: Node[]) => {
    let at = 0;
    return nodes.map((node) => {
      const from = at;
      at += node.nodeSize;
      return { from, to: at, node };
    });
  };
  const oldSpans = spans(before),
    newSpans = spans(after);
  const edits: Array<{
    from: number;
    to: number;
    content?: Node[];
    remove?: Mark;
    add?: Mark;
  }> = [];
  let oldAt = 0,
    newAt = 0,
    oldIndex = 0,
    newIndex = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      let remaining = part.value.length;
      while (remaining) {
        while (oldSpans[oldIndex].to <= oldAt) oldIndex++;
        while (newSpans[newIndex].to <= newAt) newIndex++;
        const old = oldSpans[oldIndex],
          next = newSpans[newIndex];
        const length = Math.min(remaining, old.to - oldAt, next.to - newAt);
        const from = offset + oldAt,
          to = from + length;
        for (const mark of old.node.marks)
          if (!next.node.marks.some((other) => other.eq(mark)))
            edits.push({ from, to, remove: mark });
        for (const mark of next.node.marks)
          if (!old.node.marks.some((other) => other.eq(mark)))
            edits.push({ from, to, add: mark });
        oldAt += length;
        newAt += length;
        remaining -= length;
      }
      continue;
    }
    const from = oldAt,
      newFrom = newAt;
    while (
      index < parts.length &&
      (parts[index].added || parts[index].removed)
    ) {
      const change = parts[index++];
      if (change.removed) oldAt += change.value.length;
      else newAt += change.value.length;
    }
    index--;
    const content =
      newAt === newFrom
        ? []
        : newSpans.flatMap((span) =>
            span.from < newAt && span.to > newFrom
              ? [
                  span.node.cut(
                    Math.max(0, newFrom - span.from),
                    Math.min(span.node.nodeSize, newAt - span.from),
                  ),
                ]
              : [],
          );
    edits.push({ from: offset + from, to: offset + oldAt, content });
  }
  for (const edit of edits.reverse()) {
    if (edit.content) tr.replaceWith(edit.from, edit.to, edit.content);
    else if (edit.remove) tr.removeMark(edit.from, edit.to, edit.remove);
    else if (edit.add) tr.addMark(edit.from, edit.to, edit.add);
  }
  return true;
}

function patchFragment(
  tr: Transaction,
  before: Fragment,
  after: Fragment,
  offset: number,
) {
  const changes = diffArrays([...before.content], [...after.content], {
    comparator: (a, b) => a.eq(b),
  });
  const patches: Array<{ from: number; old: Node[]; next: Node[] }> = [];
  let at = offset;
  let pending: (typeof patches)[number] | undefined;
  const flush = () => {
    if (pending) patches.push(pending);
    pending = undefined;
  };
  for (const change of changes) {
    if (!change.added && !change.removed) {
      flush();
      at += change.value.reduce((size, node) => size + node.nodeSize, 0);
    } else {
      pending ??= { from: at, old: [], next: [] };
      if (change.removed) {
        pending.old.push(...change.value);
        at += change.value.reduce((size, node) => size + node.nodeSize, 0);
      } else pending.next.push(...change.value);
    }
  }
  flush();
  for (const patch of patches.reverse()) {
    if (
      patch.old.every((node) => node.isText) &&
      patch.next.every((node) => node.isText) &&
      patchTextFragments(tr, patch.old, patch.next, patch.from)
    )
      continue;
    // Adjacent changed paragraphs are separate editor blocks even when no
    // unchanged block remains between them. Preserve those boundaries so an
    // active composition in one block need not hold back the others.
    if (
      patch.old.length > 1 &&
      patch.old.length === patch.next.length &&
      patch.old.every(
        (node, index) =>
          node.type === patch.next[index].type &&
          !node.isLeaf &&
          node.sameMarkup(patch.next[index]),
      )
    ) {
      let position =
        patch.from + patch.old.reduce((size, node) => size + node.nodeSize, 0);
      for (let index = patch.old.length - 1; index >= 0; index--) {
        position -= patch.old[index].nodeSize;
        patchFragment(
          tr,
          patch.old[index].content,
          patch.next[index].content,
          position + 1,
        );
      }
      continue;
    }
    const old = patch.old[0];
    const next = patch.next[0];
    if (
      patch.old.length === 1 &&
      patch.next.length === 1 &&
      old.type === next.type
    ) {
      if (old.isText && next.isText && old.text === next.text) {
        for (const mark of old.marks)
          if (!next.marks.some((candidate) => candidate.eq(mark)))
            tr.removeMark(patch.from, patch.from + old.nodeSize, mark);
        for (const mark of next.marks)
          if (!old.marks.some((candidate) => candidate.eq(mark)))
            tr.addMark(patch.from, patch.from + old.nodeSize, mark);
        continue;
      }
      if (old.sameMarkup(next)) {
        if (old.isText && next.isText) {
          const parts = diffChars(old.text ?? "", next.text ?? "", {
            timeout: 8,
            maxEditLength: 4096,
          });
          if (parts) {
            let position = patch.from;
            const edits: Array<{ from: number; to: number; text: string }> = [];
            for (let index = 0; index < parts.length; index++) {
              const part = parts[index];
              if (!part.added && !part.removed) position += part.value.length;
              else if (part.removed) {
                const addition = parts[index + 1]?.added
                  ? parts[++index].value
                  : "";
                edits.push({
                  from: position,
                  to: position + part.value.length,
                  text: addition,
                });
                position += part.value.length;
              } else
                edits.push({ from: position, to: position, text: part.value });
            }
            for (const edit of edits.reverse())
              tr.replaceWith(
                edit.from,
                edit.to,
                edit.text
                  ? tr.doc.type.schema.text(edit.text, next.marks)
                  : Fragment.empty,
              );
            continue;
          }
        } else if (!old.isLeaf) {
          patchFragment(tr, old.content, next.content, patch.from + 1);
          continue;
        }
      }
    }
    const length = patch.old.reduce((size, node) => size + node.nodeSize, 0);
    tr.replaceWith(patch.from, patch.from + length, patch.next);
  }
}

/** Separate replacements retain mappings across every unchanged intermediate node. */
export function replaceRevisionContent(state: EditorState, next: Node) {
  const transaction = state.tr;
  patchFragment(transaction, state.doc.content, next.content, 0);
  return transaction;
}
