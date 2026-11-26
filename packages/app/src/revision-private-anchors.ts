import type { Node } from "@tiptap/pm/model";

export interface PrivateCommentAnchor {
  quote: string;
  before: string;
  after: string;
  atStart: boolean;
  atEnd: boolean;
}

export function containsReviewIdentity(doc: Node, id: string) {
  let found = false;
  doc.descendants((node) => {
    if (
      node.attrs.change?.changeId === id ||
      node.attrs.changeId === id ||
      node.marks.some(
        (mark) =>
          mark.attrs.changeId === id || mark.attrs.commentIds?.includes(id),
      )
    )
      found = true;
  });
  return found;
}

export function isPrivateCommentAnchor(
  value: unknown,
): value is PrivateCommentAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as PrivateCommentAnchor;
  return (
    typeof anchor.quote === "string" &&
    Boolean(anchor.quote.trim()) &&
    typeof anchor.before === "string" &&
    anchor.before.length <= 40 &&
    typeof anchor.after === "string" &&
    anchor.after.length <= 40 &&
    typeof anchor.atStart === "boolean" &&
    typeof anchor.atEnd === "boolean"
  );
}

function textMap(doc: Node) {
  const characters: string[] = [];
  const positions: Array<{ from: number; to: number }> = [];
  const append = (text: string, from: number, to: number) => {
    characters.push(text);
    positions.push({ from, to });
  };
  const visit = (node: Node, pos: number) => {
    if (node.isText) {
      const text = node.text ?? "";
      for (let index = 0; index < text.length; index++)
        append(text[index], pos + index, pos + index + 1);
      return;
    }
    if (node.isLeaf) {
      append(
        node.type.name === "hardBreak" ? "\n" : "\uFFFC",
        pos,
        pos + node.nodeSize,
      );
      if (node.isBlock) append("\n", pos + node.nodeSize, pos + node.nodeSize);
      return;
    }
    node.forEach((child, offset) => {
      visit(child, pos + 1 + offset);
    });
    if (node.isTextblock)
      append("\n", pos + node.nodeSize - 1, pos + node.nodeSize);
  };
  visit(doc, -1);
  return { text: characters.join(""), positions };
}

/** Store the selected words and nearby wording, independent of document offsets. */
export function capturePrivateCommentAnchor(
  doc: Node,
  from: number,
  to: number,
): PrivateCommentAnchor | null {
  const { text, positions } = textMap(doc);
  const start = positions.findIndex(
    (point) => point.to > from && point.from < to,
  );
  if (start < 0) return null;
  let end = start;
  while (end < positions.length && positions[end].from < to) end++;
  const quote = text.slice(start, end);
  if (!quote.trim() || quote.includes("\uFFFC")) return null;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  return {
    quote,
    before: text.slice(Math.max(lineStart, start - 40), start),
    after: text.slice(
      end,
      Math.min(lineEnd < 0 ? text.length : lineEnd, end + 40),
    ),
    atStart: start === lineStart,
    atEnd: end === (lineEnd < 0 ? text.length : lineEnd),
  };
}

/** A changed or repeated semantic target remains in recovery rather than guessed. */
export function resolvePrivateCommentAnchor(
  doc: Node,
  anchor: PrivateCommentAnchor,
): { from: number; to: number } | null {
  if (!isPrivateCommentAnchor(anchor)) return null;
  const { text, positions } = textMap(doc);
  let found: { from: number; to: number } | null = null;
  let offset = 0;
  while (offset <= text.length) {
    const start = text.indexOf(anchor.quote, offset);
    if (start < 0) break;
    const end = start + anchor.quote.length;
    offset = start + 1;
    if (
      text.slice(Math.max(0, start - anchor.before.length), start) !==
        anchor.before ||
      text.slice(end, end + anchor.after.length) !== anchor.after ||
      (anchor.atStart && start > 0 && text[start - 1] !== "\n") ||
      (anchor.atEnd && end < text.length && text[end] !== "\n")
    )
      continue;
    const first = positions[start];
    const last = positions[end - 1];
    if (!first || !last || first.from >= last.to) continue;
    if (found) return null;
    found = { from: first.from, to: last.to };
  }
  return found;
}
