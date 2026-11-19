import type { JSONContent } from "@tiptap/core";
import { diffChars } from "diff";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import { SUGGESTED_PARAGRAPH_SENTINEL } from "./editor-extensions";

/** Project the editable review document onto the text that currently belongs in the file. */
export function acceptedDocument(doc: JSONContent): JSONContent {
  function project(node: JSONContent): JSONContent | null {
    const marks = node.marks ?? [];
    if (
      marks.some(
        (mark) =>
          mark.type === "criticChange" &&
          ["addition", "substitution-new"].includes(mark.attrs?.kind),
      )
    ) {
      return null;
    }
    if (
      node.text === SUGGESTED_PARAGRAPH_SENTINEL &&
      marks.some((mark) => mark.type === "commentRef")
    )
      return null;
    const keptMarks = marks.filter(
      (mark) => mark.type !== "criticChange" && mark.type !== "commentRef",
    );
    const { marks: _marks, content, ...rest } = node;
    const children = content?.flatMap((child) => {
      const result = project(child);
      return result ? [result] : [];
    });
    if (
      node.type === "paragraph" &&
      !children?.length &&
      content?.some((child) =>
        child.text?.includes(SUGGESTED_PARAGRAPH_SENTINEL),
      )
    ) {
      return null;
    }
    // Annotation marks split adjacent text nodes. Merge them after removing
    // review metadata so a proposed edit compares equal to the untouched text.
    const merged: JSONContent[] = [];
    for (const child of children ?? []) {
      const last = merged.at(-1);
      if (
        child.type === "text" &&
        last?.type === "text" &&
        JSON.stringify(child.marks) === JSON.stringify(last.marks)
      ) {
        last.text = (last.text ?? "") + (child.text ?? "");
      } else merged.push(child);
    }
    return {
      ...rest,
      ...(keptMarks.length ? { marks: keptMarks } : {}),
      ...(merged.length ? { content: merged } : {}),
    };
  }
  const result = project(doc) ?? { type: "doc" };
  return result.content?.length
    ? result
    : { ...result, content: [{ type: "paragraph" }] };
}

export function cleanRevisionMarkdown(markdown: string): string {
  const { doc, comments } = criticMarkdownToEditorState(markdown);
  const hasChanges = (node: JSONContent): boolean =>
    Boolean(
      node.marks?.some((mark) => mark.type === "criticChange") ||
        node.content?.some(hasChanges),
    );
  if (!comments.size && !hasChanges(doc)) return markdown;
  return editorStateToCriticMarkdown(acceptedDocument(doc), new Map());
}

/** Reuse the original byte spelling when an edit can be mapped there safely. */
export function preserveSourceSpelling(
  original: string,
  before: string,
  after: string,
): string | null {
  if (before === after) return original;
  if (before === original) return after;
  const alignment = diffChars(before, original, { maxEditLength: 4096 });
  const changes = diffChars(before, after, { maxEditLength: 4096 });
  if (!alignment || !changes) return null;
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
  let result = "";
  canonicalOffset = 0;
  sourceOffset = 0;
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
