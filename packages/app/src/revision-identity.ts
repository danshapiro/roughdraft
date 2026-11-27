import { renumberReviewDraft } from "@roughdraft/rfm";
import type { Node } from "@tiptap/pm/model";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { explicitReviewEdit } from "./editor-extensions";
import type { RevisionSourceMetadata } from "./revision-source";

interface IdentityRule {
  oldId: string;
  newId: string;
  generation: number;
  ranges: Array<{ from: number; to: number }>;
}
interface IdentityState {
  generation: number;
  rules: IdentityRule[];
}
const identityKey = new PluginKey<IdentityState>("roughdraftReviewIdentity");
const identityRemap = "roughdraftReviewIdentityRemap";
function rangesFor(doc: Node, id: string) {
  const ranges: IdentityRule["ranges"] = [];
  doc.descendants((node, pos) => {
    if (
      node.attrs.change?.changeId === id ||
      node.attrs.changeId === id ||
      node.marks.some(
        (mark) =>
          mark.attrs.changeId === id || mark.attrs.commentIds?.includes(id),
      )
    )
      ranges.push({ from: pos, to: pos + node.nodeSize });
  });
  return ranges;
}
function remapMetadata(
  metadata: RevisionSourceMetadata,
  rules: IdentityRule[],
) {
  let result = metadata;
  for (const generation of [
    ...new Set(rules.map((rule) => rule.generation)),
  ].sort((a, b) => a - b)) {
    if ((result.identityGeneration ?? 0) >= generation) continue;
    const map = Object.fromEntries(
      rules
        .filter((rule) => rule.generation === generation)
        .map((rule) => [rule.oldId, rule.newId]),
    );
    const comments = (result.sourceComments ?? []).map((comment) => ({
      ...comment,
      changeId: comment.parentCommentId ?? "document",
    }));
    const remapped = renumberReviewDraft(
      { markdown: result.markdown, decisions: {}, reviewComments: comments },
      map,
    );
    const sourceSpelling =
      result.sourceSpelling === undefined
        ? undefined
        : renumberReviewDraft(
            {
              markdown: result.sourceSpelling,
              decisions: {},
              reviewComments: [],
            },
            map,
          ).markdown;
    result = {
      ...result,
      markdown: remapped.markdown,
      sourceSpelling,
      sourceComments: remapped.reviewComments,
      identityGeneration: generation,
    };
  }
  return result;
}
export function reviewIdentityGeneration(state: EditorState) {
  return identityKey.getState(state)?.generation ?? 0;
}
export function remapReviewIdentity(
  state: EditorState,
  ids: Record<string, string>,
) {
  const previous = identityKey.getState(state) ?? { generation: 0, rules: [] };
  const generation = previous.generation + 1;
  const rules = Object.entries(ids).map(([oldId, newId]) => ({
    oldId,
    newId,
    generation,
    ranges: rangesFor(state.doc, oldId),
  }));
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (node.attrs.change?.changeId && ids[node.attrs.change.changeId])
      tr.setNodeMarkup(
        pos,
        undefined,
        {
          ...node.attrs,
          change: {
            ...node.attrs.change,
            changeId: ids[node.attrs.change.changeId],
          },
        },
        node.marks,
      );
    if (node.attrs.changeId && ids[node.attrs.changeId])
      tr.setNodeMarkup(
        pos,
        undefined,
        { ...node.attrs, changeId: ids[node.attrs.changeId] },
        node.marks,
      );
    for (const mark of node.marks) {
      if (mark.attrs.changeId && ids[mark.attrs.changeId]) {
        tr.removeMark(pos, pos + node.nodeSize, mark);
        tr.addMark(
          pos,
          pos + node.nodeSize,
          mark.type.create({
            ...mark.attrs,
            changeId: ids[mark.attrs.changeId],
          }),
        );
      }
      if (mark.attrs.commentIds?.some((id: string) => ids[id])) {
        tr.removeMark(pos, pos + node.nodeSize, mark);
        tr.addMark(
          pos,
          pos + node.nodeSize,
          mark.type.create({
            ...mark.attrs,
            commentIds: mark.attrs.commentIds.map(
              (id: string) => ids[id] ?? id,
            ),
          }),
        );
      }
    }
  });
  const kept = state.doc.attrs.kept as string[] | undefined;
  const reviewed = state.doc.attrs.reviewed as
    | import("./comparison-types").ReviewedChange[]
    | undefined;
  if (kept || reviewed) {
    const renamed = renumberReviewDraft(
      {
        markdown: "",
        reviewComments: [],
        decisions: Object.fromEntries(
          (kept ?? []).map((id) => [id, "kept" as const]),
        ),
        reviewed,
      },
      ids,
    );
    if (kept) tr.setDocAttribute("kept", Object.keys(renamed.decisions));
    if (reviewed) tr.setDocAttribute("reviewed", renamed.reviewed ?? []);
  }
  const metadata = state.doc.attrs
    .sourceMetadata as RevisionSourceMetadata | null;
  if (metadata)
    tr.setDocAttribute("sourceMetadata", remapMetadata(metadata, rules));
  return tr
    .setMeta(identityRemap, { generation, rules })
    .setMeta(explicitReviewEdit, true)
    .setMeta("addToHistory", false);
}

/** Repair only restored local identity ranges; an incoming same-number item stays untouched. */
export function createReviewIdentityPlugin(onBlocked?: () => void) {
  return new Plugin<IdentityState>({
    key: identityKey,
    state: {
      init: () => ({ generation: 0, rules: [] }),
      apply(tr, previous) {
        const mapped = previous.rules.map((rule) => ({
          ...rule,
          ranges: rule.ranges.map((range) => ({
            from: tr.mapping.map(range.from, -1),
            to: tr.mapping.map(range.to, 1),
          })),
        }));
        const added = tr.getMeta(identityRemap) as IdentityState | undefined;
        return {
          generation: added?.generation ?? previous.generation,
          rules: [...mapped, ...(added?.rules ?? [])],
        };
      },
    },
    filterTransaction(tr, state) {
      if (!isHistoryTransaction(tr)) return true;
      const rules = identityKey.getState(state)?.rules ?? [];
      for (const rule of rules) {
        const owned = rule.ranges.map((range) => ({
          from: tr.mapping.map(range.from, -1),
          to: tr.mapping.map(range.to, 1),
        }));
        const other = rangesFor(state.doc, rule.oldId).map((range) => ({
          from: tr.mapping.map(range.from, -1),
          to: tr.mapping.map(range.to, 1),
        }));
        if (
          owned.some((range) =>
            other.some(
              (candidate) =>
                range.from < candidate.to && range.to > candidate.from,
            ),
          )
        ) {
          onBlocked?.();
          return false;
        }
      }
      return true;
    },
    appendTransaction(transactions, previous, current) {
      if (
        !transactions.some(isHistoryTransaction) ||
        transactions.some((tr) => tr.getMeta(identityRemap))
      )
        return null;
      const rules = identityKey.getState(current)?.rules ?? [];
      if (!rules.length) return null;
      const tr = current.tr;
      const remap = (id: string, from: number, to: number) => {
        let result = id;
        for (const rule of rules)
          if (
            rule.oldId === result &&
            rule.ranges.some((range) => from < range.to && to > range.from)
          )
            result = rule.newId;
        return result;
      };
      current.doc.descendants((node, pos) => {
        if (node.attrs.change?.changeId) {
          const id = remap(
            node.attrs.change.changeId,
            pos,
            pos + node.nodeSize,
          );
          if (id !== node.attrs.change.changeId)
            tr.setNodeMarkup(
              pos,
              undefined,
              { ...node.attrs, change: { ...node.attrs.change, changeId: id } },
              node.marks,
            );
        }
        for (const mark of node.marks) {
          if (mark.attrs.changeId) {
            const id = remap(mark.attrs.changeId, pos, pos + node.nodeSize);
            if (id !== mark.attrs.changeId) {
              tr.removeMark(pos, pos + node.nodeSize, mark);
              tr.addMark(
                pos,
                pos + node.nodeSize,
                mark.type.create({ ...mark.attrs, changeId: id }),
              );
            }
          }
          if (mark.attrs.commentIds) {
            const ids = mark.attrs.commentIds.map((id: string) =>
              remap(id, pos, pos + node.nodeSize),
            );
            if (
              ids.some(
                (id: string, index: number) =>
                  id !== mark.attrs.commentIds[index],
              )
            ) {
              tr.removeMark(pos, pos + node.nodeSize, mark);
              tr.addMark(
                pos,
                pos + node.nodeSize,
                mark.type.create({ ...mark.attrs, commentIds: ids }),
              );
            }
          }
        }
      });
      const metadata = current.doc.attrs
        .sourceMetadata as RevisionSourceMetadata | null;
      if (metadata && previous.doc.attrs.sourceMetadata !== metadata) {
        const next = remapMetadata(metadata, rules);
        if (next !== metadata) tr.setDocAttribute("sourceMetadata", next);
      }
      return tr.docChanged
        ? tr
            .setMeta(identityRemap, true)
            .setMeta(explicitReviewEdit, true)
            .setMeta("addToHistory", false)
        : null;
    },
  });
}
