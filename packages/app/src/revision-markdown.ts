import { getSchema, type JSONContent } from "@tiptap/core";
import { diffChars } from "diff";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import { type MarkdownOptions, splitYamlDocumentMetadata } from "./markdown";
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
  return editorStateToCriticMarkdown(acceptedDocument(doc), new Map());
}

/** Reuse the original byte spelling when an edit can be mapped there safely. */
export function createSourceSpellingPreserver(
  original: string,
  before: string,
): (after: string) => string | null {
  if (before === original) return (after) => after;
  const alignment = diffChars(before, original, { maxEditLength: 4096 });
  if (!alignment) return (after) => (before === after ? original : null);
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
    const changes = diffChars(before, after, { maxEditLength: 4096 });
    if (!changes) return null;
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
      const start = removed
        ? (sourceIndices[at] ?? -1)
        : at === 0
          ? (sourceIndices[0] ?? 0)
          : (sourceIndices[at - 1] ?? -2) + 1;
      if (
        start < sourceOffset ||
        (removed && original.slice(start, start + removed.length) !== removed)
      )
        return null;
      result +=
        original.slice(sourceOffset, start) +
        (crlf ? added.replaceAll("\n", "\r\n") : added);
      sourceOffset = start + removed.length;
    }
    return result + original.slice(sourceOffset);
  };
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
