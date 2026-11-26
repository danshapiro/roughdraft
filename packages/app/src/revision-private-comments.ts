import type { Node } from "@tiptap/pm/model";

const cache = new WeakMap<Node, { signature: string; node: Node }>();

/** Remove only explicitly private identities from a detached serialization model. */
export function publicRevisionNode(
  doc: Node,
  privateIds?: ReadonlySet<string>,
): Node {
  if (!privateIds?.size) return doc;
  const signature = [...privateIds].sort().join("\0");
  const ids = (values: unknown[]) =>
    values.filter((id) => !privateIds.has(String(id)));
  const historyValue = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(historyValue).filter((item) => item !== undefined);
    if (!value || typeof value !== "object") return value;
    const entry = value as Record<string, unknown>;
    if (
      entry.type === "commentRef" &&
      entry.attrs &&
      typeof entry.attrs === "object"
    ) {
      const attrs = entry.attrs as Record<string, unknown>;
      if (Array.isArray(attrs.commentIds)) {
        const remaining = ids(attrs.commentIds);
        return remaining.length
          ? { ...entry, attrs: { ...attrs, commentIds: remaining } }
          : undefined;
      }
    }
    const next = Object.fromEntries(
      Object.entries(entry).map(([key, child]) => [key, historyValue(child)]),
    );
    return (entry.stepType === "addMark" || entry.stepType === "removeMark") &&
      entry.mark &&
      next.mark === undefined
      ? undefined
      : next;
  };
  const strip = (node: Node): Node => {
    const old = cache.get(node);
    if (old?.signature === signature) return old.node;
    let attrs = node.attrs;
    if (
      Array.isArray(attrs.commentIds) &&
      attrs.commentIds.some((id: string) => privateIds.has(id))
    )
      attrs = { ...attrs, commentIds: ids(attrs.commentIds) };
    if (
      node.type.name === "doc" &&
      Array.isArray(attrs.reviewed) &&
      attrs.reviewed.length
    )
      attrs = { ...attrs, reviewed: historyValue(attrs.reviewed) };
    const marks = node.marks.flatMap((mark) => {
      if (
        !Array.isArray(mark.attrs.commentIds) ||
        !mark.attrs.commentIds.some((id: string) => privateIds.has(id))
      )
        return [mark];
      const remaining = ids(mark.attrs.commentIds);
      return mark.type.name === "commentRef" && !remaining.length
        ? []
        : [mark.type.create({ ...mark.attrs, commentIds: remaining })];
    });
    const children = node.children.map(strip);
    const changed =
      attrs !== node.attrs ||
      marks.length !== node.marks.length ||
      marks.some((mark, index) => mark !== node.marks[index]) ||
      children.some((child, index) => child !== node.child(index));
    const result = !changed
      ? node
      : node.isText
        ? node.mark(marks)
        : node.type.create(attrs, children, marks);
    cache.set(node, { signature, node: result });
    return result;
  };
  return strip(doc);
}
