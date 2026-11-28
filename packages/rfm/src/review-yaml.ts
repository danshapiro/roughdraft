import {
  isMap,
  isScalar,
  type Node,
  parseDocument,
  stringify,
  type YAMLMap,
} from "yaml";
import { canonicalValue } from "./review-values.js";

export class UnsupportedReviewMerge extends Error {}
export interface SourcePatch {
  from: number;
  to: number;
  text: string;
}
export interface ReviewYaml {
  prefix: string;
  source: string;
  suffix: string;
  data: Record<string, unknown>;
  doc: ReturnType<typeof parseDocument>;
}
export interface ReviewSourceParts {
  frontmatter: ReviewYaml | null;
  endmatter: ReviewYaml | null;
  body: string;
}

export function applySourcePatches(
  source: string,
  patches: SourcePatch[],
): string {
  let next = source;
  let previous = source.length + 1;
  for (const patch of [...patches].sort(
    (a, b) => b.from - a.from || b.to - a.to,
  )) {
    if (patch.from < 0 || patch.to > previous || patch.from > patch.to)
      throw new UnsupportedReviewMerge(
        "Source patches overlap or exceed their input.",
      );
    next = next.slice(0, patch.from) + patch.text + next.slice(patch.to);
    previous = patch.from;
  }
  return next;
}

function yaml(prefix: string, source: string, suffix: string): ReviewYaml {
  const doc = parseDocument(source, {
    keepSourceTokens: true,
    uniqueKeys: true,
  });
  const data: unknown = doc.toJS();
  if (
    doc.errors.length ||
    (data !== null &&
      (!data || typeof data !== "object" || Array.isArray(data)))
  )
    throw new UnsupportedReviewMerge("YAML cannot safely be merged by key.");
  return {
    prefix,
    source,
    suffix,
    data: (data ?? {}) as Record<string, unknown>,
    doc,
  };
}

export function splitReviewSource(
  source: string,
  frontmatterAsText = false,
): ReviewSourceParts {
  let body = source;
  let frontmatter: ReviewYaml | null = null;
  let endmatter: ReviewYaml | null = null;
  const front = /^(---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(
    body,
  );
  if (front?.index === 0 && !frontmatterAsText) {
    frontmatter = yaml(front[1], front[2], front[3]);
    body = body.slice(front[0].length);
  }
  const separators = [...body.matchAll(/\r?\n---[ \t]*\r?\n/g)];
  const last = separators.at(-1);
  if (last?.index !== undefined) {
    const source = body.slice(last.index + last[0].length);
    try {
      const candidate = yaml(last[0], source, "");
      if ("comments" in candidate.data || "suggestions" in candidate.data) {
        endmatter = candidate;
        body = body.slice(0, last.index);
      }
    } catch (error) {
      if (/^(?:comments|suggestions):/m.test(source)) throw error;
    }
  }
  return { frontmatter, endmatter, body };
}

function pairValue(map: YAMLMap, key: string): Node | null {
  const value = map.get(key, true);
  return value && typeof value === "object" ? (value as Node) : null;
}

function pairRange(block: ReviewYaml, map: YAMLMap, key: string) {
  const pair = map.items.find(
    (item) => isScalar(item.key) && String(item.key.value) === key,
  );
  if (!pair || !isScalar(pair.key) || !pair.key.range)
    throw new UnsupportedReviewMerge("YAML key has no safe source range.");
  const start = block.source.lastIndexOf("\n", pair.key.range[0] - 1) + 1;
  const value = pairValue(map, key);
  const end =
    value?.range?.[2] ?? block.source.indexOf("\n", pair.key.range[1]) + 1;
  return { start, end: end > start ? end : block.source.length, value };
}

/** Patch changed YAML entries; never stringify an existing untouched map. */
export function patchReviewYaml(
  basis: ReviewYaml,
  target: Record<string, unknown>,
  local: ReviewYaml | null,
  incoming: ReviewYaml | null,
): string {
  if (canonicalValue(basis.data) === canonicalValue(target))
    return basis.source;
  if (!isMap(basis.doc.contents))
    throw new UnsupportedReviewMerge("YAML root has no source-preserving map.");
  const patches: SourcePatch[] = [];
  const visit = (
    map: YAMLMap,
    wanted: Record<string, unknown>,
    path: string[],
  ) => {
    if (map.flow)
      throw new UnsupportedReviewMerge(
        "A changed flow map requires browser recovery.",
      );
    const existing = new Set(
      map.items.map((pair) =>
        isScalar(pair.key) ? String(pair.key.value) : "",
      ),
    );
    for (const key of existing) {
      const range = pairRange(basis, map, key);
      if (!(key in wanted)) {
        patches.push({ from: range.start, to: range.end, text: "" });
        continue;
      }
      const current = map.get(key);
      const actual =
        current && typeof current === "object" && "toJSON" in current
          ? (current as Node).toJSON()
          : current;
      if (canonicalValue(actual) === canonicalValue(wanted[key])) continue;
      if (
        isMap(range.value) &&
        wanted[key] &&
        typeof wanted[key] === "object" &&
        !Array.isArray(wanted[key])
      ) {
        visit(range.value, wanted[key] as Record<string, unknown>, [
          ...path,
          key,
        ]);
        continue;
      }
      const from = range.value?.range?.[0];
      const to = range.value?.range?.[1];
      if (from === undefined || to === undefined)
        throw new UnsupportedReviewMerge(
          "YAML value has no safe source range.",
        );
      let replacement: string | undefined;
      for (const source of [local, incoming]) {
        const node = source?.doc.getIn([...path, key], true) as
          | Node
          | undefined;
        if (
          source &&
          node?.range &&
          canonicalValue(node.toJSON()) === canonicalValue(wanted[key])
        ) {
          replacement = source.source.slice(node.range[0], node.range[1]);
          break;
        }
      }
      replacement ??= stringify(wanted[key]).trimEnd();
      patches.push({ from, to, text: replacement });
    }
    const additions: string[] = [];
    for (const key of Object.keys(wanted).filter((key) => !existing.has(key))) {
      let copied = false;
      for (const source of [local, incoming]) {
        const sourceMap = source?.doc.getIn(path, true);
        if (
          !source ||
          !isMap(sourceMap) ||
          sourceMap.flow ||
          !sourceMap.has(key)
        )
          continue;
        const range = pairRange(source, sourceMap, key);
        const node = pairValue(sourceMap, key);
        if (
          canonicalValue(node?.toJSON() ?? null) !== canonicalValue(wanted[key])
        )
          continue;
        additions.push(source.source.slice(range.start, range.end));
        copied = true;
        break;
      }
      if (!copied)
        throw new UnsupportedReviewMerge(
          "A new YAML entry has no unambiguous source.",
        );
    }
    if (additions.length) {
      const position = map.range?.[1];
      if (position === undefined)
        throw new UnsupportedReviewMerge("YAML insertion has no source range.");
      const needsNewline = position > 0 && basis.source[position - 1] !== "\n";
      patches.push({
        from: position,
        to: position,
        text: `${needsNewline ? (basis.source.includes("\r\n") ? "\r\n" : "\n") : ""}${additions.join("")}`,
      });
    }
  };
  visit(basis.doc.contents, target, []);
  return applySourcePatches(basis.source, patches);
}
