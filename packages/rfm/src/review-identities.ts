import { isMap, isScalar, parseDocument } from "yaml";
import { extractRoughdraftReviewIndex } from "./index.js";
import type { SyncDraft } from "./review-sync.js";
import {
  applySourcePatches,
  type SourcePatch,
  splitReviewSource,
} from "./review-yaml.js";

function scalarSpelling(source: string, next: string) {
  if (source.startsWith('"')) return JSON.stringify(next);
  if (source.startsWith("'")) return `'${next.replaceAll("'", "''")}'`;
  return next;
}

function registryPatches(
  doc: ReturnType<typeof parseDocument>,
  source: string,
  offset: number,
  ids: Record<string, string>,
) {
  const patches: SourcePatch[] = [];
  for (const group of ["comments", "suggestions"]) {
    const map = doc.get(group, true);
    if (!isMap(map)) continue;
    for (const pair of map.items) {
      const key = pair.key;
      if (isScalar(key) && key.range && ids[String(key.value)]) {
        patches.push({
          from: offset + key.range[0],
          to: offset + key.range[1],
          text: scalarSpelling(
            source.slice(key.range[0], key.range[1]),
            ids[String(key.value)],
          ),
        });
      }
      if (!isMap(pair.value)) continue;
      const parent = pair.value.get("re", true);
      if (isScalar(parent) && parent.range && ids[String(parent.value)]) {
        patches.push({
          from: offset + parent.range[0],
          to: offset + parent.range[1],
          text: scalarSpelling(
            source.slice(parent.range[0], parent.range[1]),
            ids[String(parent.value)],
          ),
        });
      }
    }
  }
  return patches;
}

function renumberRegistry(source: string, ids: Record<string, string>) {
  const prefix = /^(?:\r?\n)?---[ \t]*\r?\n/.exec(source)?.[0] ?? "";
  const body = source.slice(prefix.length);
  const doc = parseDocument(body, { keepSourceTokens: true });
  if (doc.errors.length || !isMap(doc.contents)) return source;
  return applySourcePatches(
    source,
    registryPatches(doc, body, prefix.length, ids),
  );
}

function renumberMarkdown(markdown: string, ids: Record<string, string>) {
  const patches: SourcePatch[] = [];
  const seen = new Set<number>();
  for (const item of extractRoughdraftReviewIndex(markdown).items) {
    if (item.endOffset <= item.offset) continue;
    const raw = markdown.slice(item.offset, item.endOffset);
    const reference = /\{#([\w-]+)\}$/.exec(raw);
    if (reference && ids[reference[1]]) {
      const from = item.endOffset - reference[0].length + 2;
      if (!seen.has(from)) {
        patches.push({
          from,
          to: from + reference[1].length,
          text: ids[reference[1]],
        });
        seen.add(from);
      }
    } else {
      // This range was recognized by the RFM parser as an item's metadata.
      const begin = raw.lastIndexOf("{");
      const metadata = raw.slice(begin);
      for (const match of metadata.matchAll(
        /\b(?:id|re)="([^"\\]*(?:\\.[^"\\]*)*)"/g,
      )) {
        const value = JSON.parse(`"${match[1]}"`) as string;
        if (!ids[value]) continue;
        const from =
          item.offset + begin + match.index + match[0].indexOf('"') + 1;
        if (!seen.has(from)) {
          patches.push({
            from,
            to: from + match[1].length,
            text: JSON.stringify(ids[value]).slice(1, -1),
          });
          seen.add(from);
        }
      }
      for (const match of metadata.matchAll(
        /\b(?:id|re):\s*([^;@}]+?)(?=\s*(?:;|@\}))/g,
      )) {
        const value = match[1].trim();
        if (!ids[value]) continue;
        const from =
          item.offset + begin + match.index + match[0].indexOf(value);
        if (!seen.has(from)) {
          patches.push({ from, to: from + value.length, text: ids[value] });
          seen.add(from);
        }
      }
    }
  }
  const parts = splitReviewSource(markdown);
  if (parts.endmatter) {
    const block = parts.endmatter;
    patches.push(
      ...registryPatches(
        block.doc,
        block.source,
        markdown.length - block.source.length,
        ids,
      ),
    );
  }
  return applySourcePatches(markdown, patches);
}

/** Rewrite only parsed review identities, never literal Markdown examples. */
export function renumberReviewDraft(
  draft: SyncDraft,
  ids: Record<string, string>,
): SyncDraft {
  if (!Object.keys(ids).length) return draft;
  const referenceKeys = new Set([
    "changeId",
    "commentId",
    "parentCommentId",
    "parentId",
    "keptId",
    "keptIds",
    "commentIds",
  ]);
  const references = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value))
      return value.map((entry) => references(entry, key));
    if (value && typeof value === "object") {
      const result = Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          references(entry, name),
        ]),
      );
      if (key === "sourceComments" && typeof result.id === "string")
        result.id = ids[result.id] ?? result.id;
      return result;
    }
    if (typeof value === "string" && key === "endmatter")
      return renumberRegistry(value, ids);
    if (
      typeof value === "string" &&
      ["markdown", "sourceSpelling", "oldText", "newText"].includes(key) &&
      value.includes("{")
    )
      return renumberMarkdown(value, ids);
    return typeof value === "string" && referenceKeys.has(key)
      ? (ids[value] ?? value)
      : value;
  };
  return {
    ...draft,
    markdown: renumberMarkdown(draft.markdown, ids),
    decisions: Object.fromEntries(
      Object.entries(draft.decisions).map(([id, value]) => [
        ids[id] ?? id,
        value,
      ]),
    ),
    reviewComments: draft.reviewComments.map((entry) => ({
      ...(references(entry) as typeof entry),
      id: ids[entry.id] ?? entry.id,
    })),
    reviewed: draft.reviewed?.map((entry) => ({
      ...(references(entry) as typeof entry),
      id: ids[entry.id] ?? entry.id,
    })),
    outdatedSuggestions: draft.outdatedSuggestions?.map((entry) => ({
      ...(references(entry) as typeof entry),
      id: ids[entry.id] ?? entry.id,
    })),
  };
}
