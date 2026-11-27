import type { Node } from "@tiptap/pm/model";
import {
  type CriticComment,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  appendYamlEndmatter,
  normalizeBlockSpacing,
  prependYamlFrontmatter,
  splitYamlDocumentMetadata,
} from "./markdown";
import { publicRevisionNode } from "./revision-private-comments";

interface NodeInfo {
  ids: Set<string>;
  annotated: boolean;
  edge: boolean;
}
const information = new WeakMap<Node, NodeInfo>();
const plain = new WeakMap<Node, { nodes: Node[]; body: string }>();
interface Skeleton {
  prefix: string;
  placeholders: Node[];
  nodes: Node[];
  comments: string;
  options: string;
  markdown: string;
}
const skeletons = new WeakMap<object, Skeleton>();
function info(node: Node): NodeInfo {
  const cached = information.get(node);
  if (cached) return cached;
  const result: NodeInfo = { ids: new Set(), annotated: false, edge: false };
  const visit = (child: Node) => {
    if (
      child.type.name === "criticChangeBlock" ||
      child.type.name === "criticChangeBoundary"
    ) {
      result.annotated = true;
      const id = child.attrs.change?.changeId ?? child.attrs.changeId;
      if (id) result.ids.add(id);
      result.edge ||= child.type.name === "criticChangeBoundary";
    }
    for (const mark of child.marks) {
      if (mark.type.name === "criticChange") {
        result.annotated = true;
        if (mark.attrs.changeId) result.ids.add(mark.attrs.changeId);
      }
      if (mark.type.name === "commentRef") {
        result.annotated = true;
        for (const id of mark.attrs.commentIds ?? []) result.ids.add(id);
      }
    }
  };
  visit(node);
  node.descendants(visit);
  information.set(node, result);
  return result;
}

/** Serialize the authoritative PM model without allocating another complete JSON tree. */
export function serializeRevisionNode(
  doc: Node,
  comments: Map<string, CriticComment>,
  options?: { frontmatter?: string | null; endmatter?: string | null },
  privateCommentIds?: ReadonlySet<string>,
): string {
  if (privateCommentIds?.size) {
    const hidden = new Set(
      [...privateCommentIds].filter((id) => !comments.get(id)?.content.trim()),
    );
    return serializeRevisionNode(
      publicRevisionNode(doc, hidden),
      new Map([...comments].filter(([id]) => !hidden.has(id))),
      options,
    );
  }
  const commentKey = JSON.stringify([...comments]);
  const optionKey = JSON.stringify(options ?? {});
  let cache = skeletons.get(doc.type.schema);
  if (
    !cache ||
    doc.textContent.includes(cache.prefix) ||
    commentKey.includes(cache.prefix) ||
    optionKey.includes(cache.prefix)
  ) {
    let prefix = "roughdraftplaceholder";
    while (
      doc.textContent.includes(prefix) ||
      commentKey.includes(prefix) ||
      optionKey.includes(prefix)
    )
      prefix += "x";
    cache = {
      prefix,
      placeholders: [],
      nodes: [],
      comments: "",
      options: "",
      markdown: "",
    };
    skeletons.set(doc.type.schema, cache);
  }
  const nodes = doc.children;
  const spans = new Map<string, { from: number; to: number; edge: boolean }>();
  const starts = new Map<number, number>();
  nodes.forEach((node, index) => {
    const details = info(node);
    if (details.annotated) starts.set(index, index);
    for (const id of details.ids) {
      const old = spans.get(id);
      spans.set(id, {
        from: old?.from ?? index,
        to: index,
        edge: Boolean(old?.edge || details.edge),
      });
    }
  });
  for (const span of spans.values()) {
    const from = span.edge ? Math.max(0, span.from - 1) : span.from;
    const to = span.edge ? Math.min(nodes.length - 1, span.to + 1) : span.to;
    starts.set(from, Math.max(starts.get(from) ?? from, to));
  }
  const skeleton: Node[] = [];
  const substitutions: Array<{ token: string; body: string }> = [];
  for (let index = 0; index < nodes.length; ) {
    if (starts.has(index)) {
      let end = starts.get(index) ?? index;
      for (let at = index; at <= end; at++)
        end = Math.max(end, starts.get(at) ?? at);
      skeleton.push(...nodes.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    const bodies: string[] = [];
    while (index < nodes.length && !starts.has(index)) {
      const node = nodes[index++];
      const group = [node];
      // Block images serialize as adjacent inline DOM images. Keep that
      // existing codec context instead of inventing paragraph separators.
      if (node.type.name === "image")
        while (
          index < nodes.length &&
          !starts.has(index) &&
          nodes[index].type.name === "image"
        )
          group.push(nodes[index++]);
      let fragment = plain.get(node);
      if (
        !fragment ||
        fragment.nodes.length !== group.length ||
        group.some((item, at) => item !== fragment?.nodes[at])
      ) {
        const body = editorStateToCriticMarkdown(
          doc.type.create(null, group).toJSON(),
          new Map(),
        ).trimEnd();
        fragment = { nodes: group, body };
        plain.set(node, fragment);
      }
      const body = fragment.body;
      if (body.trim()) bodies.push(body);
    }
    const ordinal = substitutions.length;
    const token = `${cache.prefix}${ordinal}z`;
    cache.placeholders[ordinal] ??= doc.type.schema.nodes.paragraph.create(
      null,
      doc.type.schema.text(token),
    );
    skeleton.push(cache.placeholders[ordinal]);
    substitutions.push({ token, body: bodies.join("\n\n") });
  }
  cache.placeholders.length = substitutions.length;
  if (
    cache.comments !== commentKey ||
    cache.options !== optionKey ||
    cache.nodes.length !== skeleton.length ||
    skeleton.some((node, index) => node !== cache.nodes[index])
  ) {
    cache.markdown = editorStateToCriticMarkdown(
      doc.type.create(null, skeleton).toJSON(),
      comments,
      options,
    );
    cache.nodes = skeleton;
    cache.comments = commentKey;
    cache.options = optionKey;
  }
  const metadata = splitYamlDocumentMetadata(cache.markdown);
  let body = metadata.body;
  const patches: Array<{ from: number; to: number; text: string }> = [];
  for (const substitution of substitutions) {
    const from = body.indexOf(substitution.token);
    if (
      from < 0 ||
      body.indexOf(substitution.token, from + substitution.token.length) >= 0
    )
      return editorStateToCriticMarkdown(doc.toJSON(), comments, options);
    patches.push({
      from,
      to: from + substitution.token.length,
      text: substitution.body,
    });
  }
  for (const patch of patches.sort((a, b) => b.from - a.from))
    body = body.slice(0, patch.from) + patch.text + body.slice(patch.to);
  return appendYamlEndmatter(
    prependYamlFrontmatter(
      normalizeBlockSpacing(`${body.trimEnd()}\n`),
      metadata.frontmatter,
    ),
    metadata.endmatter,
  );
}
