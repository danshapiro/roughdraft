import { documentMetadata, withDocumentMetadata } from "./revision-metadata";

/** A worker result cannot replace metadata typed after its input snapshot. */
export function rebaseRemoteMetadata(
  base: string,
  current: string,
  incoming: string,
): string | null {
  const before = documentMetadata(base);
  const local = documentMetadata(current);
  const remote = documentMetadata(incoming);
  const result = { ...remote };
  for (const field of ["frontmatter", "endmatter"] as const) {
    if (local[field] === before[field] || local[field] === remote[field])
      continue;
    if (remote[field] !== before[field]) return null;
    result[field] = local[field];
  }
  return withDocumentMetadata(incoming, result);
}
