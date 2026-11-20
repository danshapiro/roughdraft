import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { isMap, parseDocument } from "yaml";
import { splitYamlDocumentMetadata } from "./markdown";

/** Resolve a source-backed suggestion without reformatting unrelated Markdown. */
export function resolveSuggestionSource(
  markdown: string,
  changeId: string,
  decision: "accept" | "reject",
): string | null {
  return resolveSuggestionsSource(markdown, [changeId], decision);
}

/** Resolve source-backed suggestions together, preserving the untouched text. */
export function resolveSuggestionsSource(
  markdown: string,
  changeIds: readonly string[],
  decision: "accept" | "reject",
): string | null {
  const { endmatter } = splitYamlDocumentMetadata(markdown);
  const index = extractRoughdraftReviewIndex(markdown);
  const removedIds = new Set(changeIds);
  const matches = index.items.filter(
    (item) => item.kind === "suggestion" && removedIds.has(item.id),
  );
  // Anonymous, ambiguous, or temporary editor items use the normal serializer.
  if (
    matches.length !== removedIds.size ||
    new Set(matches.map((item) => item.id)).size !== removedIds.size ||
    matches.some(
      (item) =>
        item.text.includes("\u2060") || item.originalText?.includes("\u2060"),
    )
  ) {
    return null;
  }
  let previousSize = 0;
  while (removedIds.size !== previousSize) {
    previousSize = removedIds.size;
    for (const item of index.items) {
      if (item.parentId && removedIds.has(item.parentId))
        removedIds.add(item.id);
    }
  }
  const replies = index.items.filter(
    (item) => item.kind !== "suggestion" && removedIds.has(item.id),
  );
  // An independently highlighted reply needs the editor's anchor-removal path.
  if (replies.some((item) => item.anchorText !== undefined)) return null;
  const edits = [
    ...matches.map((suggestion) => ({
      from: suggestion.offset,
      to: suggestion.endOffset,
      text:
        decision === "accept"
          ? suggestion.suggestionKind === "deletion"
            ? ""
            : suggestion.text
          : suggestion.suggestionKind === "addition"
            ? ""
            : (suggestion.originalText ?? ""),
    })),
    ...replies
      .filter((item) => item.endOffset > item.offset)
      .map((item) => ({ from: item.offset, to: item.endOffset, text: "" })),
  ].sort((a, b) => a.from - b.from);
  const parts: string[] = [];
  let end = 0;
  for (const edit of edits) {
    if (edit.from < end) return null;
    parts.push(markdown.slice(end, edit.from), edit.text);
    end = edit.to;
  }
  parts.push(markdown.slice(end));
  const resolved = parts.join("");
  if (!endmatter) return resolved;
  const yaml = parseDocument(endmatter.replace(/^---[^\n]*\n/, ""));
  if (yaml.errors.length) return null;
  if (isMap(yaml.get("suggestions"))) {
    for (const id of changeIds) yaml.deleteIn(["suggestions", id]);
  }
  if (isMap(yaml.get("comments"))) {
    for (const id of removedIds) yaml.deleteIn(["comments", id]);
  }
  for (const key of ["suggestions", "comments"]) {
    const section = yaml.get(key);
    if (isMap(section) && section.items.length === 0) yaml.delete(key);
  }
  const remaining =
    isMap(yaml.contents) && yaml.contents.items.length > 0
      ? `---\n${yaml.toString()}`
      : "";
  return resolved.slice(0, resolved.length - endmatter.length) + remaining;
}
