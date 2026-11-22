import { cleanRoughdraftMarkdown } from "@roughdraft/rfm";
import { isMap, isNode, parseDocument } from "yaml";
import type { DocumentMetadata } from "./comparison-types";
import { splitYamlDocumentMetadata } from "./markdown";

const reviewKeys = ["comments", "suggestions"] as const;

function yamlDocument(endmatter: string | null) {
  const yaml = parseDocument(
    endmatter?.replace(/^---[ \t]*\r?\n/, "") ?? "{}\n",
  );
  if (yaml.errors.length || !isMap(yaml.contents))
    throw new Error("Document endmatter must be a YAML mapping.");
  return yaml;
}

/** Read document metadata without treating review feedback as a file change. */
export function documentMetadata(markdown: string): DocumentMetadata {
  const { frontmatter, endmatter } = splitYamlDocumentMetadata(markdown);
  if (!endmatter) return { frontmatter, endmatter: null };
  const document = yamlDocument(endmatter);
  for (const key of reviewKeys) document.delete(key);
  if (!isMap(document.contents) || document.contents.items.length === 0)
    return { frontmatter, endmatter: null };
  // The source projection owns removal of review YAML. Its last delimiter is
  // this known endmatter because it still contains document-owned fields.
  const clean = cleanRoughdraftMarkdown(markdown);
  const delimiter = [...clean.matchAll(/\n---[ \t]*\r?\n/g)].at(-1);
  return {
    frontmatter,
    endmatter:
      delimiter?.index === undefined ? null : clean.slice(delimiter.index + 1),
  };
}

export function sameMetadata(
  a: DocumentMetadata,
  b: DocumentMetadata,
): boolean {
  return a.frontmatter === b.frontmatter && a.endmatter === b.endmatter;
}

/** Patch the metadata envelopes while retaining the exact body and feedback. */
export function withDocumentMetadata(
  markdown: string,
  metadata: DocumentMetadata,
): string {
  const current = documentMetadata(markdown);
  if (sameMetadata(current, metadata)) return markdown;
  const split = splitYamlDocumentMetadata(markdown);
  const bodyStart = split.frontmatter?.length ?? 0;
  const beforeEndmatter = markdown.slice(bodyStart);
  const frontmatter = metadata.frontmatter ?? "";
  // A frontmatter-only change must not reformat any review YAML.
  if (current.endmatter === metadata.endmatter)
    return frontmatter + beforeEndmatter;

  const document = yamlDocument(metadata.endmatter);
  for (const key of reviewKeys) document.delete(key);
  if (split.endmatter) {
    const existing = yamlDocument(split.endmatter);
    for (const key of reviewKeys) {
      const feedback = existing.get(key, true);
      if (isNode(feedback)) document.set(key, feedback.clone());
    }
  }
  const body = split.endmatter
    ? markdown.slice(bodyStart, markdown.length - split.endmatter.length)
    : beforeEndmatter;
  if (!isMap(document.contents) || document.contents.items.length === 0)
    return frontmatter + body;
  const newline = (metadata.endmatter ?? split.endmatter ?? markdown).includes(
    "\r\n",
  )
    ? "\r\n"
    : "\n";
  const separator = split.endmatter
    ? ""
    : body.endsWith(`${newline}${newline}`)
      ? ""
      : body.endsWith(newline)
        ? newline
        : `${newline}${newline}`;
  const endmatter = `---${newline}${document.toString().replaceAll("\n", newline)}`;
  return frontmatter + body + separator + endmatter;
}
