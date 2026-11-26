import type { SyncConflict } from "@roughdraft/rfm";

const fields: Record<string, string> = {
  content: "Text",
  body: "Text",
  authorType: "Author",
  authorId: "Author name",
  by: "Author",
  at: "Created",
  createdAt: "Created",
  parentCommentId: "Reply to",
  oldText: "Original text",
  originalText: "Original text",
  originalQuote: "Original passage",
  newText: "Final text",
  proposedText: "Proposed text",
  decision: "Decision",
  scope: "Applies to",
  reason: "Reason",
  detachedReason: "Context",
  frontmatter: "Document details",
  endmatter: "Review details",
};
function fieldName(key: string) {
  if (fields[key]) return fields[key];
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}
export function conflictHeading(item: SyncConflict) {
  if (item.kind === "text") return item.label;
  const [root, ...path] = item.label.split(".");
  if (item.kind === "metadata") {
    if (root === "endmatter" && ["comments", "suggestions"].includes(path[0])) {
      const category = path[0] === "comments" ? "Comment" : "Suggestion";
      return [category, ...path.slice(2).map(fieldName)].join(" · ");
    }
    return [fieldName(root), ...path.map(fieldName)].join(" · ");
  }
  const category = {
    comment: "Comment",
    suggestion: "Suggestion",
    decision: "Review decision",
    history: "History",
  }[item.kind];
  return item.kind !== "decision" && path.length
    ? `${category} · ${fieldName(path.at(-1) ?? "")}`
    : category;
}
const internal = new Set([
  "id",
  "changeId",
  "keptId",
  "keptIds",
  "guard",
  "inverse",
  "originSignature",
  "unmappedSince",
  "stale",
  "staleReason",
]);

/** Presentation only: literal prose remains exact; stored conflict values stay untouched. */
export function conflictValueText(
  value: unknown,
  item: SyncConflict,
  field = item.label.split(".").at(-1) ?? "",
): string {
  if (value === undefined) return "Removed";
  if (value === null) return "Not set";
  if (typeof value === "string") {
    if (
      item.kind === "decision" ||
      (item.kind === "history" && field === "decision")
    ) {
      if (value === "accept" || value === "kept") return "Kept";
      if (value === "reject") return "Reverted";
    }
    if (
      item.kind !== "metadata" &&
      (field === "authorType" || field === "by")
    ) {
      if (value === "user") return "You";
      if (value === "ai") return "AI";
    }
    return value || "Empty text";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value))
    return (
      value
        .map((entry) => `- ${conflictValueText(entry, item, field)}`)
        .join("\n") || "None"
    );
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([key, entry]) =>
        item.kind === "metadata" || (!internal.has(key) && entry != null),
    );
    return (
      entries
        .map(([key, entry]) => {
          const text = conflictValueText(entry, item, key);
          return text.includes("\n")
            ? `${fieldName(key)}:\n${text
                .split("\n")
                .map((line) => `  ${line}`)
                .join("\n")}`
            : `${fieldName(key)}: ${text}`;
        })
        .join("\n") || "No details"
    );
  }
  return String(value);
}
