import { cleanRoughdraftMarkdown } from "@roughdraft/rfm";
import { getSchema, type JSONContent } from "@tiptap/core";
import { type Change, diffChars, diffWordsWithSpace } from "diff";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { type MarkdownOptions, splitYamlDocumentMetadata } from "./markdown";
import { documentMetadata } from "./revision-metadata";
import { projectAcceptedDocument } from "./revision-projection";

const schema = getSchema(createEditorExtensions(""));

// Keep the editable model independent of the current browser and file path.
// The view resolves assets; the save path retains the original source spelling.
export const editableMarkdownOptions: MarkdownOptions = {
  normalizeRelativeDestinations: true,
};

export function acceptedDocument(doc: JSONContent): JSONContent {
  return {
    ...doc,
    ...projectAcceptedDocument(schema.nodeFromJSON(doc)).doc.toJSON(),
  };
}

/** The live model is authoritative; review Markdown can split formatting spans. */
export function cleanRevisionDocument(
  doc: JSONContent,
  previous?: { markdown: string; cleanMarkdown?: string },
): string {
  const metadata = doc.attrs?.sourceMetadata;
  const projected = editorStateToCriticMarkdown(
    acceptedDocument(doc),
    new Map(),
    metadata
      ? { frontmatter: metadata.frontmatter, endmatter: metadata.endmatter }
      : undefined,
  );
  // Hydration can split equivalent formatting spans. If the accepted content
  // still matches the previous review, keep its already-preserved clean source.
  // Actual accepted edits/decisions/metadata differ and use the live projection.
  if (
    previous?.cleanMarkdown !== undefined &&
    projected === cleanRevisionMarkdown(previous.markdown)
  )
    return previous.cleanMarkdown;
  return projected;
}

/** Generated dates may differ when anonymous review syntax is parsed again. */
export function sameRevisionMarkup(left: string, right: string): boolean {
  const signature = (markdown: string) => {
    const parsed = criticMarkdownToEditorState(
      markdown,
      editableMarkdownOptions,
    );
    const comments = [...parsed.comments.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((comment) => [
        comment.id,
        comment.content,
        comment.authorType ?? null,
        comment.authorId ?? null,
        comment.parentCommentId ?? null,
        comment.scope ?? null,
      ]);
    return JSON.stringify(
      { doc: parsed.doc, comments, metadata: documentMetadata(markdown) },
      (key, value) => (key === "createdAt" ? undefined : value),
    );
  };
  return signature(left) === signature(right);
}

export function cleanRevisionMarkdown(markdown: string): string {
  if (
    !/\{(?:\+\+|--|~~|>>)/.test(markdown) &&
    !splitYamlDocumentMetadata(markdown).endmatter
  )
    return markdown;
  const { doc, comments } = criticMarkdownToEditorState(markdown);
  const hasChanges = (node: JSONContent): boolean =>
    node.type === "criticChangeBlock" ||
    Boolean(
      node.marks?.some((mark) => mark.type === "criticChange") ||
        node.content?.some(hasChanges),
    );
  if (!comments.size && !hasChanges(doc)) return markdown;
  return cleanRevisionDocument(doc);
}

function needsSourceProjection(node: JSONContent, inCode = false): boolean {
  const code =
    inCode ||
    node.type === "codeBlock" ||
    Boolean(node.marks?.some((mark) => mark.type === "code"));
  return Boolean(
    node.type === "criticChangeBlock" ||
      (code && node.marks?.some((mark) => mark.type === "commentRef")) ||
      node.content?.some((child) => needsSourceProjection(child, code)),
  );
}

/** Project code anchors and framed block proposals without changing source spelling. */
export function cleanRevisionSourceMarkdown(markdown: string): string {
  const sourceClean = cleanRoughdraftMarkdown(markdown);
  if (!/\{(?:==|\+\+|--|~~)/.test(markdown)) return sourceClean;
  const parsed = criticMarkdownToEditorState(markdown, editableMarkdownOptions);
  // Ordinary fenced syntax examples stay literal. Only the editor's recognized
  // code anchors/block proposals need the model's decoder and projection. Their
  // framing newlines describe structure rather than extra document whitespace.
  if (!needsSourceProjection(parsed.doc)) return sourceClean;
  const canonicalReview = editorStateToCriticMarkdown(
    parsed.doc,
    parsed.comments,
  );
  const clean = editorStateToCriticMarkdown(
    acceptedDocument(parsed.doc),
    new Map(),
  );
  return (
    createSourceSpellingPreserver(markdown, canonicalReview)(clean) ?? clean
  );
}

/** Reuse the original byte spelling when an edit can be mapped there safely. */
export function createSourceSpellingPreserver(
  original: string,
  before: string,
): (after: string) => string | null {
  if (before === original) return (after) => after;
  // An edit-distance cap alone can still spend seconds on a short rewrite.
  // The original alignment also serves Undo. Retain it rather than discarding
  // deleted blocks' spelling when later edits are processed.
  const alignment = diffChars(before, original, { maxEditLength: 4096 });
  if (!alignment) return (after) => (before === after ? original : null);
  const budget = { maxEditLength: 4096, timeout: 8 };
  const sourceIndices = new Int32Array(before.length).fill(-1);
  let canonicalOffset = 0;
  let sourceOffset = 0;
  for (const part of alignment) {
    if (!part.added && !part.removed) {
      for (let i = 0; i < part.value.length; i++)
        sourceIndices[canonicalOffset + i] = sourceOffset + i;
    }
    if (!part.added) canonicalOffset += part.value.length;
    if (!part.removed) sourceOffset += part.value.length;
  }
  const crlf =
    original.includes("\r\n") &&
    !original.replaceAll("\r\n", "").includes("\n");
  return (after) => {
    if (before === after) return original;
    let changes = diffChars(before, after, budget);
    if (!changes) {
      // Broad prose rewrites are cheap to align as words even when comparing
      // every character is expensive. Keep distant edits separate so an
      // untouched spelling difference between them remains in the source.
      // The final linear fallback is also checked against the original below.
      changes =
        diffWordsWithSpace(before, after, budget) ??
        anchoredSourceChanges(before, after);
      console.info(
        JSON.stringify({
          severity: "info",
          component: "source-spelling",
          event: "bounded-replacement",
          beforeLength: before.length,
          afterLength: after.length,
        }),
      );
    }
    let result = "";
    let canonicalOffset = 0;
    let sourceOffset = 0;
    for (let i = 0; i < changes.length; i++) {
      const part = changes[i];
      if (!part.added && !part.removed) {
        canonicalOffset += part.value.length;
        continue;
      }
      const at = canonicalOffset;
      let removed = "";
      let added = "";
      while (i < changes.length && (changes[i].added || changes[i].removed)) {
        const change = changes[i++];
        if (change.removed) removed += change.value;
        else added += change.value;
      }
      i--;
      canonicalOffset += removed.length;
      let start = removed
        ? (sourceIndices[at] ?? -1)
        : at === 0
          ? (sourceIndices[0] ?? 0)
          : (sourceIndices[at - 1] ?? -2) + 1;
      if (
        crlf &&
        removed.startsWith("\n") &&
        original[start] === "\n" &&
        original[start - 1] === "\r"
      )
        start--;
      let end = removed
        ? (sourceIndices[at + removed.length - 1] ?? -1) + 1
        : start;
      if (!removed && /[ \t]$/.test(added)) {
        const next = sourceIndices[at];
        if (next > start && /^[ \t]+$/.test(original.slice(start, next)))
          end = next;
      }
      const sourceText = original.slice(start, end);
      if (
        start < sourceOffset ||
        end < start ||
        (removed &&
          (crlf ? sourceText.replaceAll("\r\n", "\n") : sourceText) !== removed)
      )
        return null;
      result +=
        original.slice(sourceOffset, start) +
        (crlf ? added.replaceAll("\n", "\r\n") : added);
      sourceOffset = end;
    }
    return result + original.slice(sourceOffset);
  };
}

/** Linear anchors keep untouched spelling between distant replacements. */
function anchoredSourceChanges(before: string, after: string): Change[] {
  const uniqueWords = (text: string) => {
    const words = new Map<string, { from: number; to: number } | null>();
    for (const match of text.matchAll(/\S+/g))
      words.set(
        match[0],
        words.has(match[0])
          ? null
          : { from: match.index, to: match.index + match[0].length },
      );
    return words;
  };
  const oldWords = uniqueWords(before);
  const newWords = uniqueWords(after);
  const changes: Change[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  for (const [word, next] of newWords) {
    const previous = oldWords.get(word);
    if (!next || !previous || previous.from < oldOffset) continue;
    changes.push(
      ...changedSourceRange(
        before.slice(oldOffset, previous.from),
        after.slice(newOffset, next.from),
      ),
      { value: word, count: word.length, added: false, removed: false },
    );
    oldOffset = previous.to;
    newOffset = next.to;
  }
  changes.push(
    ...changedSourceRange(before.slice(oldOffset), after.slice(newOffset)),
  );
  return changes;
}

/** Linear fallback: only replace the range between identical source edges. */
function changedSourceRange(before: string, after: string): Change[] {
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < shorter - start &&
    before[before.length - end - 1] === after[after.length - end - 1]
  )
    end++;
  return [
    { value: before.slice(0, start), added: false, removed: false },
    {
      value: before.slice(start, before.length - end),
      added: false,
      removed: true,
    },
    {
      value: after.slice(start, after.length - end),
      added: true,
      removed: false,
    },
    { value: after.slice(after.length - end), added: false, removed: false },
  ]
    .filter((part) => part.value.length)
    .map((part) => ({ ...part, count: part.value.length }));
}

export async function copyRevisionMarkdown(markdown: string) {
  // Clipboard API is unavailable on the existing HTTP LAN install.
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(markdown);
    return;
  }
  const field = document.createElement("textarea");
  field.value = markdown;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = Array.from(
    { length: selection?.rangeCount ?? 0 },
    (_, index) => selection?.getRangeAt(index).cloneRange(),
  );
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy"))
      throw new Error("Could not copy Markdown.");
  } finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) if (range) selection?.addRange(range);
  }
}

export function downloadRevisionMarkdown(markdown: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
