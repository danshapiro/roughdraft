import { cleanRoughdraftMarkdown } from "@roughdraft/rfm";
import { isMap, isNode, parseDocument } from "yaml";
import type { DocumentMetadata } from "./comparison-types";
import { splitYamlDocumentMetadata } from "./markdown";

const reviewKeys = ["comments", "suggestions"] as const;
const metadataCache = new Map<string, DocumentMetadata>();
const sourceCache = new Map<string, DocumentMetadata>();
const MAX_SOURCE_CACHE_BYTES = 1024 * 1024;
let sourceCacheBytes = 0;

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
  const cached = sourceCache.get(markdown);
  if (cached) return cached;
  const result = readDocumentMetadata(markdown);
  // The editor reads the same saved source for every selection/render. Cache
  // that result before the splitter reparses its review YAML, with a byte cap
  // so a succession of large documents cannot accumulate in a long-lived tab.
  const bytes = markdown.length * 2;
  if (bytes <= MAX_SOURCE_CACHE_BYTES) {
    sourceCache.set(markdown, result);
    sourceCacheBytes += bytes;
    while (sourceCache.size > 8 || sourceCacheBytes > MAX_SOURCE_CACHE_BYTES) {
      const oldest = sourceCache.keys().next().value as string;
      sourceCache.delete(oldest);
      sourceCacheBytes -= oldest.length * 2;
    }
  }
  return result;
}

function readDocumentMetadata(markdown: string): DocumentMetadata {
  const { frontmatter, endmatter } = splitYamlDocumentMetadata(markdown);
  if (!endmatter) return { frontmatter, endmatter: null };
  const key = `${frontmatter ?? ""}\0${endmatter}`;
  const cached = metadataCache.get(key);
  if (cached) return cached;
  const remember = (result: DocumentMetadata) => {
    if (key.length < 32_768) {
      metadataCache.set(key, result);
      while (metadataCache.size > 32)
        metadataCache.delete(metadataCache.keys().next().value as string);
    }
    return result;
  };
  const document = yamlDocument(endmatter);
  for (const key of reviewKeys) document.delete(key);
  if (!isMap(document.contents) || document.contents.items.length === 0)
    return remember({ frontmatter, endmatter: null });
  // The source projection owns removal of review YAML. Its last delimiter is
  // this known endmatter because it still contains document-owned fields.
  const clean = cleanRoughdraftMarkdown(`{#metadata-context}\n\n${endmatter}`);
  const delimiter = [...clean.matchAll(/\n---[ \t]*\r?\n/g)].at(-1);
  return remember({
    frontmatter,
    endmatter:
      delimiter?.index === undefined ? null : clean.slice(delimiter.index + 1),
  });
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
