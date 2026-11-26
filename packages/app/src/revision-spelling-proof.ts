import type { Node } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { measureRevision } from "./revision-performance";
import {
  type ParsedSource,
  parseRemoteRevision,
} from "./revision-remote-source";
import { sameSourceContent } from "./revision-source";

interface Proof {
  markdown: string;
  nodes: readonly Node[];
  blocks: NonNullable<ParsedSource["sourceBlocks"]>;
  valid: boolean;
  mismatches: readonly number[];
}
function sourceNodes(doc: Node) {
  const nodes = doc.children;
  const last = nodes.at(-1);
  return nodes.length > 1 &&
    last?.type.name === "paragraph" &&
    !last.content.size &&
    nodes.at(-2)?.type.name !== "paragraph"
    ? nodes.slice(0, -1)
    : nodes;
}
function plainParagraph(node: Node) {
  return (
    node.type.name === "paragraph" &&
    node.children.every((child) => child.isText && !child.marks.length) &&
    // This intentionally excludes Markdown syntax, links, line breaks, list
    // prefixes and syntax that depends on surrounding blocks or definitions.
    /^[\p{L}][\p{L}\p{N} .,:!?;()'’"%-]*$/u.test(node.textContent) &&
    !/ {2}| $/.test(node.textContent) &&
    !/(?:^|\s)www\./i.test(node.textContent)
  );
}

/** Validate rich-text spelling without reparsing unaffected document blocks. */
export class RevisionSpellingProof {
  private previous: Proof | null = null;

  private plainEdit(markdown: string, doc: Node): Proof | null {
    const previous = this.previous;
    if (!previous) return null;
    const nodes = sourceNodes(doc);
    if (nodes.length !== previous.nodes.length) return null;
    let changed = -1;
    for (let index = 0; index < nodes.length; index++) {
      if (previous.nodes[index].eq(nodes[index])) continue;
      if (changed !== -1) return null;
      changed = index;
    }
    if (changed < 0)
      return markdown === previous.markdown ? { ...previous, nodes } : null;
    // An unchanged discrepancy elsewhere still disproves this spelling. Do
    // not repeatedly parse it while the user types in an unrelated paragraph.
    if (
      !previous.valid &&
      !previous.mismatches.some((index) => index !== changed)
    )
      return null;
    const before = previous.nodes[changed];
    const after = nodes[changed];
    if (
      !before.sameMarkup(after) ||
      !plainParagraph(before) ||
      !plainParagraph(after)
    )
      return null;
    const range = previous.blocks.find(
      (block) => block.index === changed && block.count === 1,
    );
    if (!range) return null;
    const raw = previous.markdown.slice(range.from, range.to);
    if (
      !raw.startsWith(before.textContent) ||
      !/^[\r\n]*$/.test(raw.slice(before.textContent.length))
    )
      return null;
    const expected =
      previous.markdown.slice(0, range.from) +
      after.textContent +
      previous.markdown.slice(range.from + before.textContent.length);
    if (markdown !== expected) return null;
    const delta = after.textContent.length - before.textContent.length;
    return {
      markdown,
      nodes,
      valid: previous.valid,
      mismatches: previous.mismatches,
      blocks: previous.blocks.map((block) => ({
        ...block,
        from: block.from > range.from ? block.from + delta : block.from,
        to: block.to >= range.to ? block.to + delta : block.to,
      })),
    };
  }

  matches(markdown: string, doc: Node, state: EditorState) {
    const fast = this.plainEdit(markdown, doc);
    if (fast) {
      this.previous = fast;
      measureRevision(
        fast.valid ? "spelling-proof-fast" : "spelling-proof-fast-invalid",
        () => {},
      );
      return fast.valid;
    }
    const parsed = measureRevision("spelling-proof-full", () =>
      parseRemoteRevision(markdown, state),
    );
    const valid = sameSourceContent(parsed.doc, doc);
    const nodes = sourceNodes(doc);
    const parsedNodes = sourceNodes(parsed.doc);
    if (!valid) {
      measureRevision("spelling-proof-invalid", () => {});
    }
    this.previous =
      nodes.length === parsedNodes.length
        ? {
            markdown,
            nodes,
            blocks: parsed.sourceBlocks ?? [],
            valid,
            mismatches: nodes.flatMap((node, index) =>
              node.eq(parsedNodes[index]) ? [] : [index],
            ),
          }
        : null;
    return valid;
  }
}
