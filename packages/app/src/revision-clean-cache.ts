import { cleanRoughdraftMarkdown } from "@roughdraft/rfm";
import type { Node } from "@tiptap/pm/model";
import { editorStateToCriticMarkdown } from "./critic-markup";
import { normalizeBlockSpacing } from "./markdown";
import {
  needsSourceProjection,
  createSourceSpellingPreserver as preserveSourceSpelling,
} from "./revision-markdown";
import { projectAcceptedDocument } from "./revision-projection";
import { serializeRevisionNode } from "./revision-review-cache";

const identities = new WeakMap<Node, ReadonlySet<string>>();
const boundaries = new WeakMap<Node, ReadonlySet<string>>();
interface ProjectedFragment {
  nodes: readonly Node[];
  doc: Node;
  clean: string;
}
const fragments = new WeakMap<Node, ProjectedFragment>();
function pendingIds(node: Node) {
  const cached = identities.get(node);
  if (cached) return cached;
  const ids = new Set<string>();
  const edges = new Set<string>();
  const read = (child: Node) => {
    if (child.type.name === "criticChangeBlock")
      ids.add(child.attrs.change.changeId);
    if (child.type.name === "criticChangeBoundary") {
      ids.add(child.attrs.changeId);
      edges.add(child.attrs.changeId);
    }
    for (const mark of child.marks)
      if (mark.type.name === "criticChange") ids.add(mark.attrs.changeId);
  };
  read(node);
  node.descendants(read);
  identities.set(node, ids);
  boundaries.set(node, edges);
  return ids;
}

/** Project only changed immutable blocks; multi-block proposals remain one unit. */
function projectedFragments(doc: Node): ProjectedFragment[] {
  const nodes = doc.children;
  const spans = new Map<string, { from: number; to: number; edge: boolean }>();
  nodes.forEach((node, index) => {
    for (const id of pendingIds(node)) {
      const old = spans.get(id);
      spans.set(id, {
        from: old?.from ?? index,
        to: index,
        edge: Boolean(old?.edge || boundaries.get(node)?.has(id)),
      });
    }
  });
  const starts = new Map<number, number>();
  for (const span of spans.values()) {
    const from = span.edge ? Math.max(0, span.from - 1) : span.from;
    const to = span.edge ? Math.min(nodes.length - 1, span.to + 1) : span.to;
    starts.set(from, Math.max(starts.get(from) ?? from, to));
  }
  const output: ProjectedFragment[] = [];
  for (let index = 0; index < nodes.length; ) {
    let end = starts.get(index) ?? index;
    for (let cursor = index; cursor <= end; cursor++)
      end = Math.max(end, starts.get(cursor) ?? cursor);
    const group = nodes.slice(index, end + 1);
    const cached = fragments.get(group[0]);
    if (
      cached &&
      group.length === cached.nodes.length &&
      group.every((node, at) => node === cached.nodes[at])
    )
      output.push(cached);
    else {
      const fragment = doc.type.create(null, group);
      const projected = projectAcceptedDocument(fragment).doc;
      const clean = editorStateToCriticMarkdown(projected.toJSON(), new Map());
      const result = { nodes: group, doc: projected, clean };
      fragments.set(group[0], result);
      output.push(result);
    }
    index = end + 1;
  }
  return output;
}

export function cleanRevisionNode(doc: Node): string {
  const body = projectedFragments(doc)
    .map((fragment) => fragment.clean)
    .filter((value) => value.trim())
    .map((value) => value.trimEnd())
    .join("\n\n");
  const metadata = doc.attrs.sourceMetadata;
  const tail = metadata?.endmatter
    ? editorStateToCriticMarkdown({ type: "doc", content: [] }, new Map(), {
        endmatter: metadata.endmatter,
      }).replace(/^\n/, "")
    : "";
  const projected = normalizeBlockSpacing(body ? `${body}\n` : "\n");
  const endmatter = tail.replace(/^\n+/, "");
  return `${metadata?.frontmatter ?? ""}${projected}${endmatter ? `${projected.endsWith("\n\n") ? "" : "\n"}${endmatter}` : ""}`;
}

/** Use the already-parsed model when projecting a source edit; do not parse it again. */
export function cleanSourceFromNode(
  markdown: string,
  doc: Node,
  comments: Map<string, import("./critic-markup").CriticComment>,
  privateCommentIds?: ReadonlySet<string>,
): string {
  // Ordinary inline review syntax has an exact source projection. Diffing the
  // annotated serializer against accepted text can consume neighboring syntax
  // and spelling at a pending proposal's whitespace boundary.
  if (!needsSourceProjection(doc.toJSON()))
    return cleanRoughdraftMarkdown(markdown);
  const metadata = doc.attrs.sourceMetadata;
  const canonical = serializeRevisionNode(
    doc,
    comments,
    {
      frontmatter: metadata?.frontmatter,
      endmatter: metadata?.endmatter,
    },
    privateCommentIds,
  );
  return (
    preserveSourceSpelling(markdown, canonical)(cleanRevisionNode(doc)) ??
    cleanRevisionNode(doc)
  );
}

export function projectCleanRevisionNode(doc: Node): Node {
  return doc.type.create(
    doc.attrs,
    projectedFragments(doc).flatMap((fragment) => fragment.doc.children),
    doc.marks,
  );
}
