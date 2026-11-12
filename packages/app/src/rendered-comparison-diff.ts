import type { JSONContent } from "@tiptap/core";
import { diffArrays } from "diff";
import type { ControlledReviewBlockHighlight } from "./controlled-review";
import type { CriticChangeAttrs, CriticChangeKind } from "./critic-markup";

export interface RenderedComparisonDifference {
  content: JSONContent[];
  blockHighlights: ControlledReviewBlockHighlight[];
  oldText: string;
  newText: string;
  changed: boolean;
}

const TEXT_BLOCKS = new Set(["paragraph", "heading", "codeBlock"]);
const POSITIONAL_CHILDREN = new Set([
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "blockquote",
]);
const ATOMS = new Set([
  "image",
  "horizontalRule",
  "hardBreak",
  "rawMarkdownBlock",
]);
const TABLE_PARTS = new Set(["table", "tableRow", "tableCell", "tableHeader"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function semanticMarks(node: JSONContent) {
  return (node.marks ?? [])
    .filter(
      (mark) => mark.type !== "criticChange" && mark.type !== "commentRef",
    )
    .map(canonical)
    .sort();
}

function tableStructure(node: JSONContent): unknown {
  return {
    type: node.type,
    attrs: node.attrs ?? {},
    // Cell contents may be diffed normally. The grid itself must stay intact.
    ...(node.type === "table" || node.type === "tableRow"
      ? { content: (node.content ?? []).map(tableStructure) }
      : {}),
  };
}

function visibleText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "image")
    return `Image${node.attrs?.alt ? `: ${node.attrs.alt}` : ""} (${node.attrs?.src ?? ""})`;
  if (node.type === "horizontalRule") return "Horizontal rule";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "rawMarkdownBlock") return "Markdown block";
  return (node.content ?? [])
    .map(visibleText)
    .join(TEXT_BLOCKS.has(node.type ?? "") ? "" : "\n");
}

function textTokens(content: JSONContent[]): JSONContent[] {
  return content.flatMap((node) =>
    node.type === "text"
      ? (
          node.text?.match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_]/gu) ??
          []
        ).map((text) => ({ ...node, text }))
      : [node],
  );
}

function nodeSize(node: JSONContent): number {
  if (node.type === "text") return node.text?.length ?? 0;
  if (ATOMS.has(node.type ?? "")) return 1;
  return (
    2 +
    (node.content ?? []).reduce((total, child) => total + nodeSize(child), 0)
  );
}

function joinText(content: JSONContent[]) {
  const result: JSONContent[] = [];
  for (const node of content) {
    const previous = result.at(-1);
    if (
      previous?.type === "text" &&
      node.type === "text" &&
      canonical(previous.marks ?? []) === canonical(node.marks ?? [])
    ) {
      previous.text = `${previous.text ?? ""}${node.text ?? ""}`;
    } else {
      // Preserve atom identity so its node decoration survives text joining.
      result.push(node.type === "text" ? { ...node } : node);
    }
  }
  return result;
}

function summary(content: JSONContent[], formatting: boolean): string {
  const text = content.map(visibleText).join("").trim();
  const descriptors = new Set<string>();
  const visit = (node: JSONContent) => {
    if (formatting && TABLE_PARTS.has(node.type ?? "")) {
      const attributes = Object.entries(node.attrs ?? {})
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => `${key}=${canonical(value)}`);
      descriptors.add(
        `${node.type}${attributes.length ? `: ${attributes.join(", ")}` : ""}`,
      );
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === "link")
        descriptors.add(
          `link: ${mark.attrs?.href ?? ""}${mark.attrs?.title ? `, title: ${mark.attrs.title}` : ""}`,
        );
      else if (
        formatting &&
        mark.type !== "criticChange" &&
        mark.type !== "commentRef"
      )
        descriptors.add(mark.type);
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of content) visit(node);
  if (formatting && !descriptors.size) descriptors.add("plain text");
  const suffix = descriptors.size ? ` (${[...descriptors].join(", ")})` : "";
  const emptyLabel = content.some((node) => node.type === "hardBreak")
    ? "Line break"
    : content.length
      ? "Whitespace"
      : "";
  return `${text || emptyLabel}${suffix}`;
}

/** Align native rendered structure, then diff words without changing source. */
export function diffRenderedComparison(
  before: JSONContent[],
  after: JSONContent[],
  change: CriticChangeAttrs,
): RenderedComparisonDifference {
  const oldSummary: string[] = [];
  const newSummary: string[] = [];
  const nodeHighlights = new WeakMap<JSONContent, CriticChangeKind>();
  const semanticCache = new WeakMap<JSONContent, string>();
  let changed = false;
  const semanticKey = (node: JSONContent): string => {
    let key = semanticCache.get(node);
    if (key === undefined) {
      key = canonical({
        type: node.type,
        attrs: node.attrs ?? {},
        text: node.text,
        marks: semanticMarks(node),
        content: (node.content ?? []).map(semanticKey),
      });
      semanticCache.set(node, key);
    }
    return key;
  };
  const equal = (left: JSONContent, right: JSONContent) =>
    semanticKey(left) === semanticKey(right);
  const annotate = (
    node: JSONContent,
    kind: CriticChangeKind,
  ): JSONContent => ({
    ...node,
    ...(node.type === "text"
      ? {
          marks: [
            ...(node.marks ?? []).filter(
              (mark) => mark.type !== "criticChange",
            ),
            { type: "criticChange", attrs: { ...change, kind } },
          ],
        }
      : {}),
    ...(node.content
      ? { content: node.content.map((child) => annotate(child, kind)) }
      : {}),
  });
  const rememberSummary = (previous: JSONContent[], next: JSONContent[]) => {
    const formatting =
      previous.length > 0 &&
      next.length > 0 &&
      previous.map(visibleText).join("") === next.map(visibleText).join("");
    if (previous.length) oldSummary.push(summary(previous, formatting));
    if (next.length) newSummary.push(summary(next, formatting));
  };
  const replace = (
    previous: JSONContent[],
    next: JSONContent[],
    structural: boolean,
  ): JSONContent[] => {
    changed = true;
    rememberSummary(previous, next);
    const oldKind = next.length ? "substitution-old" : "deletion";
    const newKind = previous.length ? "substitution-new" : "addition";
    return [
      ...previous.map((node) => {
        const rendered = annotate(node, oldKind);
        if (structural || node.type !== "text")
          nodeHighlights.set(rendered, oldKind);
        return rendered;
      }),
      ...next.map((node) => {
        const rendered = annotate(node, newKind);
        if (structural || node.type !== "text")
          nodeHighlights.set(rendered, newKind);
        return rendered;
      }),
    ];
  };
  const wordOverlap = (left: JSONContent, right: JSONContent) => {
    const previous = visibleText(left).match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
    const next = visibleText(right).match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
    const counts = new Map<string, number>();
    for (const word of previous) counts.set(word, (counts.get(word) ?? 0) + 1);
    let common = 0;
    for (const word of next) {
      if ((counts.get(word) ?? 0) > 0) {
        counts.set(word, (counts.get(word) ?? 0) - 1);
        common++;
      }
    }
    return common / Math.max(1, Math.min(previous.length, next.length));
  };
  const canMerge = (
    left: JSONContent,
    right: JSONContent,
    positional: boolean,
  ) => {
    if (
      left.type !== right.type ||
      ATOMS.has(left.type ?? "") ||
      left.type === "text"
    )
      return false;
    if (
      left.type === "heading" &&
      canonical(left.attrs) !== canonical(right.attrs)
    )
      return false;
    if (
      left.type === "table" &&
      canonical(tableStructure(left)) !== canonical(tableStructure(right))
    )
      return false;
    return (
      positional ||
      visibleText(left) === visibleText(right) ||
      wordOverlap(left, right) >= 0.4 ||
      (left.content ?? []).some((oldChild) =>
        (right.content ?? []).some((newChild) => equal(oldChild, newChild)),
      )
    );
  };
  const alignChangedNodes = (
    previous: JSONContent[],
    next: JSONContent[],
    positional: boolean,
  ): Array<[number, number]> => {
    if (!previous.length || !next.length) return [];
    // Exact unchanged nodes are already anchors. Among the remaining nodes,
    // retain the strongest ordered matches even when a sibling was inserted.
    const width = next.length + 1;
    const scores = new Float64Array((previous.length + 1) * width);
    const matchScores = previous.map((left) =>
      next.map((right) =>
        canMerge(left, right, positional)
          ? Math.max(0.1, wordOverlap(left, right))
          : 0,
      ),
    );
    for (let oldIndex = 1; oldIndex <= previous.length; oldIndex++) {
      for (let newIndex = 1; newIndex <= next.length; newIndex++) {
        const score = matchScores[oldIndex - 1][newIndex - 1];
        scores[oldIndex * width + newIndex] = Math.max(
          scores[(oldIndex - 1) * width + newIndex],
          scores[oldIndex * width + newIndex - 1],
          score ? scores[(oldIndex - 1) * width + newIndex - 1] + score : 0,
        );
      }
    }
    const matches: Array<[number, number]> = [];
    let oldIndex = previous.length;
    let newIndex = next.length;
    while (oldIndex && newIndex) {
      const score = matchScores[oldIndex - 1][newIndex - 1];
      if (
        score &&
        scores[oldIndex * width + newIndex] ===
          scores[(oldIndex - 1) * width + newIndex - 1] + score
      ) {
        matches.push([--oldIndex, --newIndex]);
      } else if (
        scores[(oldIndex - 1) * width + newIndex] >=
        scores[oldIndex * width + newIndex - 1]
      ) {
        oldIndex--;
      } else {
        newIndex--;
      }
    }
    return matches.reverse();
  };
  const mergeInline = (previous: JSONContent[], next: JSONContent[]) => {
    const parts = diffArrays(textTokens(previous), textTokens(next), {
      comparator: equal,
    });
    const result: JSONContent[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part.added && !part.removed) {
        result.push(...part.value);
        continue;
      }
      const oldNodes: JSONContent[] = [];
      const newNodes: JSONContent[] = [];
      while (
        index < parts.length &&
        (parts[index].added || parts[index].removed)
      ) {
        (parts[index].removed ? oldNodes : newNodes).push(
          ...parts[index].value,
        );
        index++;
      }
      index--;
      result.push(...replace(oldNodes, newNodes, false));
    }
    return joinText(result);
  };
  const mergeNode = (previous: JSONContent, next: JSONContent): JSONContent => {
    const rendered = {
      ...next,
      content: TEXT_BLOCKS.has(next.type ?? "")
        ? mergeInline(previous.content ?? [], next.content ?? [])
        : mergeChildren(
            previous.content ?? [],
            next.content ?? [],
            next.type ?? "",
          ),
    };
    if (canonical(previous.attrs ?? {}) !== canonical(next.attrs ?? {})) {
      changed = true;
      const keys = [
        ...new Set([
          ...Object.keys(previous.attrs ?? {}),
          ...Object.keys(next.attrs ?? {}),
        ]),
      ].filter(
        (key) =>
          canonical(previous.attrs?.[key]) !== canonical(next.attrs?.[key]),
      );
      const describe = (node: JSONContent) =>
        `${node.type} attributes: ${keys.map((key) => `${key}=${canonical(node.attrs?.[key])}`).join(", ")}`;
      oldSummary.push(describe(previous));
      newSummary.push(describe(next));
      nodeHighlights.set(rendered, "substitution-new");
    }
    return rendered;
  };
  const mergeChildren = (
    previous: JSONContent[],
    next: JSONContent[],
    parent: string,
  ): JSONContent[] => {
    const parts = diffArrays(previous, next, { comparator: equal });
    const result: JSONContent[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part.added && !part.removed) {
        result.push(...part.value);
        continue;
      }
      const oldNodes: JSONContent[] = [];
      const newNodes: JSONContent[] = [];
      while (
        index < parts.length &&
        (parts[index].added || parts[index].removed)
      ) {
        (parts[index].removed ? oldNodes : newNodes).push(
          ...parts[index].value,
        );
        index++;
      }
      index--;
      const positional = POSITIONAL_CHILDREN.has(parent);
      if (
        oldNodes.length === newNodes.length &&
        oldNodes.every((node, offset) =>
          canMerge(node, newNodes[offset], positional),
        )
      ) {
        result.push(
          ...oldNodes.map((node, offset) => mergeNode(node, newNodes[offset])),
        );
      } else {
        let oldStart = 0;
        let newStart = 0;
        for (const [oldIndex, newIndex] of alignChangedNodes(
          oldNodes,
          newNodes,
          positional,
        )) {
          if (oldIndex > oldStart || newIndex > newStart)
            result.push(
              ...replace(
                oldNodes.slice(oldStart, oldIndex),
                newNodes.slice(newStart, newIndex),
                true,
              ),
            );
          result.push(mergeNode(oldNodes[oldIndex], newNodes[newIndex]));
          oldStart = oldIndex + 1;
          newStart = newIndex + 1;
        }
        if (oldStart < oldNodes.length || newStart < newNodes.length)
          result.push(
            ...replace(
              oldNodes.slice(oldStart),
              newNodes.slice(newStart),
              true,
            ),
          );
      }
    }
    return result;
  };
  const content = mergeChildren(before, after, "doc");
  const blockHighlights: ControlledReviewBlockHighlight[] = [];
  const measure = (nodes: JSONContent[], offset: number) => {
    let position = offset;
    for (const node of nodes) {
      const size = nodeSize(node);
      const kind = nodeHighlights.get(node);
      if (kind)
        blockHighlights.push({
          from: position,
          to: position + size,
          kind,
          changeId: change.changeId,
        });
      if (node.content) measure(node.content, position + 1);
      position += size;
    }
  };
  measure(content, 0);
  return {
    content,
    blockHighlights,
    oldText: oldSummary.filter(Boolean).join(" … "),
    newText: newSummary.filter(Boolean).join(" … "),
    changed,
  };
}
