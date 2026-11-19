import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { isMap, parseDocument } from "yaml";
import { splitYamlDocumentMetadata } from "./markdown";

/** Resolve a source-backed suggestion without reformatting unrelated Markdown. */
export function resolveSuggestionSource(
  markdown: string,
  changeId: string,
  decision: "accept" | "reject",
): string | null {
  const { endmatter } = splitYamlDocumentMetadata(markdown);
  const index = extractRoughdraftReviewIndex(markdown);
  const matches = index.items.filter(
    (item) => item.kind === "suggestion" && item.id === changeId,
  );
  // Anonymous or ambiguous editor items use the normal document serializer.
  if (matches.length !== 1) return null;
  const suggestion = matches[0];
  // The editor uses this invisible character only while suggesting a paragraph.
  if (
    suggestion.text.includes("\u2060") ||
    suggestion.originalText?.includes("\u2060")
  )
    return null;
  const removedIds = new Set([changeId]);
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
  const chosen =
    decision === "accept"
      ? suggestion.suggestionKind === "deletion"
        ? ""
        : suggestion.text
      : suggestion.suggestionKind === "addition"
        ? ""
        : (suggestion.originalText ?? "");
  const edits = [
    { from: suggestion.offset, to: suggestion.endOffset, text: chosen },
    ...replies
      .filter((item) => item.endOffset > item.offset)
      .map((item) => ({
        from: item.offset,
        to: item.endOffset,
        text: "",
      })),
  ].sort((a, b) => b.from - a.from);
  let resolved = markdown;
  for (const edit of edits) {
    resolved =
      resolved.slice(0, edit.from) + edit.text + resolved.slice(edit.to);
  }
  if (!endmatter) return resolved;
  const yaml = parseDocument(endmatter.replace(/^---[^\n]*\n/, ""));
  if (yaml.errors.length) return null;
  if (isMap(yaml.get("suggestions"))) yaml.deleteIn(["suggestions", changeId]);
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
