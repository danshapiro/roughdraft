import type { JSONContent } from "@tiptap/core";
import { diffArrays } from "diff";
import type { ControlledReviewBlockHighlight } from "./controlled-review";
import type { CriticChangeAttrs, CriticChangeKind } from "./critic-markup";
import { noteKey } from "./endnotes";
import { stableMarkdownDestination } from "./markdown";

export interface RenderedComparisonDifference {
  content: JSONContent[];
  blockHighlights: ControlledReviewBlockHighlight[];
  oldText: string;
  newText: string;
  changed: boolean;
}

export interface RenderedSourceDifference {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
  structural: boolean;
  oldText: string;
  newText: string;
}

type DifferenceObserver = (
  difference: RenderedSourceDifference,
  localDifference?: RenderedSourceDifference,
) => void;

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
  "endnoteDefinition",
]);
const ATOMS = new Set([
  "image",
  "horizontalRule",
  "hardBreak",
  "rawMarkdownBlock",
  "endnoteReference",
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

function semanticAttributes(
  type: string | undefined,
  attrs: NonNullable<JSONContent["attrs"]> = {},
) {
  if (type === "endnoteDefinition") {
    const { source: _source, original: _original, ...attributes } = attrs;
    return attributes;
  }
  if (type === "endnoteReference") {
    const { occurrence: _occurrence, ...attributes } = attrs;
    return attributes;
  }
  const source = attrs.dataMarkdownSrc;
  if (!source) return attrs;
  // A relative asset is resolved differently in each frozen input's folder.
  // Assess the Markdown destination, not its generated preview URL.
  const destination = stableMarkdownDestination(String(source));
  if (type === "link")
    return { ...attrs, href: destination, dataMarkdownSrc: destination };
  if (type === "image")
    return { ...attrs, src: destination, dataMarkdownSrc: destination };
  return attrs;
}

function semanticMarks(node: JSONContent) {
  return (node.marks ?? [])
    .filter(
      (mark) => mark.type !== "criticChange" && mark.type !== "commentRef",
    )
    .map((mark) =>
      canonical({ ...mark, attrs: semanticAttributes(mark.type, mark.attrs) }),
    )
    .sort();
}

function createSemanticKey() {
  const semanticCache = new WeakMap<JSONContent, string>();
  const semanticKey = (node: JSONContent): string => {
    let key = semanticCache.get(node);
    if (key === undefined) {
      key = canonical({
        type: node.type,
        attrs: semanticAttributes(node.type, node.attrs),
        text: node.text,
        marks: semanticMarks(node),
        content: (node.content ?? []).map(semanticKey),
      });
      semanticCache.set(node, key);
    }
    return key;
  };
  return semanticKey;
}

/** Compare only author-visible Markdown attributes, rather than resolved URLs. */
export function renderedContentIdentity(content: JSONContent[] | null) {
  return canonical((content ?? []).map(createSemanticKey()));
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
    return `Image${node.attrs?.alt ? `: ${node.attrs.alt}` : ""} (${node.attrs?.dataMarkdownSrc ?? node.attrs?.src ?? ""})`;
  if (node.type === "horizontalRule") return "Horizontal rule";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "rawMarkdownBlock") return "Markdown block";
  if (node.type === "endnoteReference")
    return `Endnote ${node.attrs?.number ?? node.attrs?.label ?? ""}`;
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
          `link: ${mark.attrs?.dataMarkdownSrc ?? mark.attrs?.href ?? ""}${mark.attrs?.title ? `, title: ${mark.attrs.title}` : ""}`,
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

function createMatcher(reusable: boolean) {
  const semanticKey = createSemanticKey();
  const equal = (left: JSONContent, right: JSONContent) =>
    semanticKey(left) === semanticKey(right);
  const textByNode = new WeakMap<JSONContent, string>();
  const wordsByNode = new WeakMap<
    JSONContent,
    { counts: Map<string, number>; total: number }
  >();
  const text = (node: JSONContent) => {
    const cached = textByNode.get(node);
    if (cached !== undefined) return cached;
    const value = visibleText(node);
    textByNode.set(node, value);
    return value;
  };
  const words = (node: JSONContent) => {
    const cached = wordsByNode.get(node);
    if (cached) return cached;
    const tokens = text(node).match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
    const counts = new Map<string, number>();
    for (const word of tokens) counts.set(word, (counts.get(word) ?? 0) + 1);
    const histogram = { counts, total: tokens.length };
    wordsByNode.set(node, histogram);
    return histogram;
  };
  const wordOverlap = (left: JSONContent, right: JSONContent) => {
    const a = words(left);
    const b = words(right);
    const [smaller, larger] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
    let common = 0;
    for (const [word, count] of smaller.counts)
      common += Math.min(count, larger.counts.get(word) ?? 0);
    return common / Math.max(1, Math.min(a.total, b.total));
  };
  const score = (
    left: JSONContent,
    right: JSONContent,
    positional: boolean,
  ) => {
    if (
      left.type !== right.type ||
      ATOMS.has(left.type ?? "") ||
      left.type === "text"
    )
      return 0;
    if (
      (left.type === "heading" &&
        canonical(left.attrs) !== canonical(right.attrs)) ||
      (left.type === "table" &&
        canonical(tableStructure(left)) !== canonical(tableStructure(right)))
    )
      return 0;
    if (left.type === "endnoteDefinition")
      return noteKey(left.attrs?.label ?? "") ===
        noteKey(right.attrs?.label ?? "")
        ? Math.max(0.1, wordOverlap(left, right))
        : 0;
    const overlap = wordOverlap(left, right);
    return positional ||
      overlap >= 0.4 ||
      text(left) === text(right) ||
      (left.content ?? []).some((oldChild) =>
        (right.content ?? []).some((newChild) => equal(oldChild, newChild)),
      )
      ? Math.max(0.1, overlap)
      : 0;
  };
  const scores = [
    new WeakMap<JSONContent, WeakMap<JSONContent, number>>(),
    new WeakMap<JSONContent, WeakMap<JSONContent, number>>(),
  ];
  const mergeScore: typeof score = (left, right, positional) => {
    if (!reusable || left.type !== right.type)
      return score(left, right, positional);
    const index = scores[positional ? 1 : 0];
    let row = index.get(left);
    if (!row) {
      row = new WeakMap();
      index.set(left, row);
    }
    const cached = row.get(right);
    if (cached !== undefined) return cached;
    const value = score(left, right, positional);
    row.set(right, value);
    return value;
  };
  return { equal, mergeScore, semanticKey };
}

/** Align native rendered structure, then diff words without changing source. */
export function diffRenderedComparison(
  before: JSONContent[],
  after: JSONContent[],
  change: CriticChangeAttrs,
  onDifference?: DifferenceObserver,
): RenderedComparisonDifference {
  return compareRendered(
    before,
    after,
    change,
    onDifference,
    createMatcher(false),
  );
}

/** Keep reusable comparisons local to one reference editor. */
export function createRenderedComparisonObserver() {
  const matcher = createMatcher(true);
  const subtrees: SubtreeCache = new WeakMap();
  const runs: RunCache = new WeakMap();
  type Alignment = ReturnType<typeof alignment>;
  type AlignmentCache = {
    reference: JSONContent[];
    onLeft: boolean;
    referenceKeys: Set<string>;
    editable: JSONContent[];
    parts: Alignment;
  };
  let cache: AlignmentCache | undefined;
  const key = matcher.semanticKey;
  const topLevelAlignment = (
    before: JSONContent[],
    after: JSONContent[],
    onLeft: boolean,
  ) => {
    if (cache?.onLeft === onLeft) {
      const editable = cache.onLeft ? after : before;
      const reference = cache.onLeft ? before : after;
      const { referenceKeys, editable: previous } = cache;
      // Replacing one unmatched block with another cannot change the exact
      // Myers alignment: neither block can match anything on the fixed side.
      if (
        reference === cache.reference &&
        previous.length === editable.length &&
        editable.every((node, index) => {
          const old = previous[index];
          if (node === old) return true;
          const a = key(old);
          const b = key(node);
          return a === b || (!referenceKeys.has(a) && !referenceKeys.has(b));
        })
      ) {
        cache.editable = editable;
        return cache.parts;
      }
    }
    const parts = alignment(before, after, key);
    const reference = onLeft ? before : after;
    cache = {
      reference,
      onLeft,
      referenceKeys: new Set(reference.map(key)),
      editable: onLeft ? after : before,
      parts,
    };
    return parts;
  };
  return (
    before: JSONContent[],
    after: JSONContent[],
    observe: DifferenceObserver,
    referenceOnLeft: boolean,
  ) => {
    compareRendered(
      before,
      after,
      null,
      observe,
      matcher,
      subtrees,
      runs,
      (left, right) => topLevelAlignment(left, right, referenceOnLeft),
    );
  };
}

function alignment(
  before: JSONContent[],
  after: JSONContent[],
  key: (node: JSONContent) => string,
) {
  const tokens = new Map<string, number>();
  const tokenId = (node: JSONContent) => {
    const value = key(node);
    let id = tokens.get(value);
    if (id === undefined) {
      id = tokens.size;
      tokens.set(value, id);
    }
    return id;
  };
  return diffArrays(before.map(tokenId), after.map(tokenId));
}

type SubtreeCache = WeakMap<
  JSONContent,
  WeakMap<JSONContent, RenderedSourceDifference[]>
>;

type AlignmentPart = ReturnType<typeof alignment>[number];
interface CachedRun {
  oldNodes: JSONContent[];
  newNodes: JSONContent[];
  differences: Array<[RenderedSourceDifference, RenderedSourceDifference?]>;
}
type RunCache = WeakMap<AlignmentPart, CachedRun>;

function sameNodes(first: JSONContent[], second: JSONContent[]) {
  return (
    first.length === second.length &&
    first.every((node, index) => node === second[index])
  );
}

function shiftDifference(
  difference: RenderedSourceDifference,
  oldOffset: number,
  newOffset: number,
) {
  return {
    ...difference,
    oldFrom: difference.oldFrom + oldOffset,
    oldTo: difference.oldTo + oldOffset,
    newFrom: difference.newFrom + newOffset,
    newTo: difference.newTo + newOffset,
  };
}

function compareRendered(
  before: JSONContent[],
  after: JSONContent[],
  change: CriticChangeAttrs | null,
  onDifference: DifferenceObserver | undefined,
  { mergeScore, semanticKey }: ReturnType<typeof createMatcher>,
  subtrees?: SubtreeCache,
  runs?: RunCache,
  alignRoot?: (
    before: JSONContent[],
    after: JSONContent[],
  ) => ReturnType<typeof alignment>,
): RenderedComparisonDifference {
  const oldSummary: string[] = [];
  const newSummary: string[] = [];
  const nodeHighlights = new WeakMap<JSONContent, CriticChangeKind>();
  let changed = false;
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
    if (!change) return [];
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
      next.map((right) => mergeScore(left, right, positional)),
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
  const offsets = (nodes: JSONContent[], start: number) => {
    const positions = [start];
    for (const node of nodes)
      positions.push(positions[positions.length - 1] + nodeSize(node));
    return positions;
  };
  const report = (
    previous: JSONContent[],
    next: JSONContent[],
    oldFrom: number,
    newFrom: number,
    structural: boolean,
    observe?: DifferenceObserver,
  ) => {
    if (!observe) return;
    const formatting =
      previous.length > 0 &&
      next.length > 0 &&
      previous.map(visibleText).join("") === next.map(visibleText).join("");
    observe({
      oldFrom,
      oldTo: offsets(previous, oldFrom)[previous.length],
      newFrom,
      newTo: offsets(next, newFrom)[next.length],
      structural,
      oldText: previous.length ? summary(previous, formatting) : "",
      newText: next.length ? summary(next, formatting) : "",
    });
  };
  const mergeNode = (
    previous: JSONContent,
    next: JSONContent,
    oldFrom: number,
    newFrom: number,
    observe?: DifferenceObserver,
  ): JSONContent => {
    const previousAttributes = semanticAttributes(
      previous.type,
      previous.attrs,
    );
    const nextAttributes = semanticAttributes(next.type, next.attrs);
    const changedAttributes =
      canonical(previousAttributes) !== canonical(nextAttributes);
    const inline = TEXT_BLOCKS.has(next.type ?? "");
    const oldChildren = previous.content ?? [];
    const newChildren = next.content ?? [];
    const rendered = {
      ...next,
      content: mergeChildren(
        inline ? textTokens(oldChildren) : oldChildren,
        inline ? textTokens(newChildren) : newChildren,
        next.type ?? "",
        oldFrom + 1,
        newFrom + 1,
        changedAttributes ? undefined : observe,
      ),
    };
    if (changedAttributes) {
      changed = true;
      const keys = [
        ...new Set([
          ...Object.keys(previousAttributes),
          ...Object.keys(nextAttributes),
        ]),
      ].filter(
        (key) =>
          canonical(previousAttributes[key]) !== canonical(nextAttributes[key]),
      );
      const describe = (node: JSONContent) =>
        `${node.type} attributes: ${keys.map((key) => `${key}=${canonical(node.attrs?.[key])}`).join(", ")}`;
      if (change) {
        oldSummary.push(describe(previous));
        newSummary.push(describe(next));
        nodeHighlights.set(rendered, "substitution-new");
      }
      observe?.({
        oldFrom,
        oldTo: oldFrom + nodeSize(previous),
        newFrom,
        newTo: newFrom + nodeSize(next),
        structural: true,
        oldText: describe(previous),
        newText: describe(next),
      });
    }
    return rendered;
  };
  const mergeChildren = (
    previous: JSONContent[],
    next: JSONContent[],
    parent: string,
    oldFrom: number,
    newFrom: number,
    observe?: DifferenceObserver,
  ): JSONContent[] => {
    const parts =
      parent === "doc" && alignRoot
        ? alignRoot(previous, next)
        : alignment(previous, next, semanticKey);
    let oldIndex = 0;
    let newIndex = 0;
    const result: JSONContent[] = [];
    const inline = TEXT_BLOCKS.has(parent);
    let oldPosition = oldFrom;
    let newPosition = newFrom;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part.added && !part.removed) {
        const equalNodes = next.slice(newIndex, newIndex + part.count);
        newIndex += part.count;
        oldIndex += part.count;
        if (change) result.push(...equalNodes);
        const width = offsets(equalNodes, 0)[equalNodes.length];
        oldPosition += width;
        newPosition += width;
        continue;
      }
      const oldNodes: JSONContent[] = [];
      const newNodes: JSONContent[] = [];
      while (
        index < parts.length &&
        (parts[index].added || parts[index].removed)
      ) {
        const chunk = parts[index];
        if (chunk.removed) {
          oldNodes.push(...previous.slice(oldIndex, oldIndex + chunk.count));
          oldIndex += chunk.count;
        } else {
          newNodes.push(...next.slice(newIndex, newIndex + chunk.count));
          newIndex += chunk.count;
        }
        index++;
      }
      index--;
      const runOldStart = oldPosition;
      const runNewStart = newPosition;
      const oldOffsets = offsets(oldNodes, runOldStart);
      const newOffsets = offsets(newNodes, runNewStart);
      oldPosition = oldOffsets[oldNodes.length];
      newPosition = newOffsets[newNodes.length];
      const run = parent === "doc" && observe ? runs?.get(part) : undefined;
      if (
        run &&
        observe &&
        sameNodes(run.oldNodes, oldNodes) &&
        sameNodes(run.newNodes, newNodes)
      ) {
        for (const [local, nested] of run.differences)
          observe(
            shiftDifference(local, runOldStart, runNewStart),
            nested ?? local,
          );
        continue;
      }
      let reportRun = observe;
      if (runs && parent === "doc" && observe) {
        const differences: CachedRun["differences"] = [];
        runs.set(part, { oldNodes, newNodes, differences });
        reportRun = (event, nested) => {
          const local = shiftDifference(event, -runOldStart, -runNewStart);
          differences.push([local, nested]);
          observe(event, nested ?? local);
        };
      }
      const replaceRange = (
        oldStart: number,
        oldEnd: number,
        newStart: number,
        newEnd: number,
      ) => {
        const oldSlice = oldNodes.slice(oldStart, oldEnd);
        const newSlice = newNodes.slice(newStart, newEnd);
        report(
          oldSlice,
          newSlice,
          oldOffsets[oldStart],
          newOffsets[newStart],
          !inline,
          reportRun,
        );
        result.push(...replace(oldSlice, newSlice, !inline));
      };
      const mergeAt = (oldIndex: number, newIndex: number) => {
        const oldNode = oldNodes[oldIndex];
        const newNode = newNodes[newIndex];
        const oldFrom = oldOffsets[oldIndex];
        const newFrom = newOffsets[newIndex];
        if (!subtrees || !reportRun)
          return mergeNode(oldNode, newNode, oldFrom, newFrom, reportRun);
        let row = subtrees.get(oldNode);
        if (!row) {
          row = new WeakMap();
          subtrees.set(oldNode, row);
        }
        let local = row.get(newNode);
        if (!local) {
          local = [];
          const differences = local;
          mergeNode(oldNode, newNode, 0, 0, (event) => differences.push(event));
          row.set(newNode, local);
        }
        for (const event of local)
          reportRun(shiftDifference(event, oldFrom, newFrom), event);
        return newNode;
      };
      const positional = POSITIONAL_CHILDREN.has(parent);
      if (inline) {
        replaceRange(0, oldNodes.length, 0, newNodes.length);
      } else if (
        oldNodes.length === newNodes.length &&
        oldNodes.every(
          (node, offset) => mergeScore(node, newNodes[offset], positional) > 0,
        )
      ) {
        result.push(...oldNodes.map((_, offset) => mergeAt(offset, offset)));
      } else {
        let oldStart = 0;
        let newStart = 0;
        for (const [oldIndex, newIndex] of alignChangedNodes(
          oldNodes,
          newNodes,
          positional,
        )) {
          if (oldIndex > oldStart || newIndex > newStart)
            replaceRange(oldStart, oldIndex, newStart, newIndex);
          result.push(mergeAt(oldIndex, newIndex));
          oldStart = oldIndex + 1;
          newStart = newIndex + 1;
        }
        if (oldStart < oldNodes.length || newStart < newNodes.length)
          replaceRange(oldStart, oldNodes.length, newStart, newNodes.length);
      }
    }
    return inline ? joinText(result) : result;
  };
  const content = mergeChildren(before, after, "doc", 0, 0, onDifference);
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
          changeId: change?.changeId ?? "",
        });
      if (node.content) measure(node.content, position + 1);
      position += size;
    }
  };
  if (change) measure(content, 0);
  return {
    content,
    blockHighlights,
    oldText: oldSummary.filter(Boolean).join(" … "),
    newText: newSummary.filter(Boolean).join(" … "),
    changed,
  };
}
