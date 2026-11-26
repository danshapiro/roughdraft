import { diffArrays } from "diff";
import {
  cleanRoughdraftMarkdown,
  type RfmReviewItem,
  type RfmReviewRange,
  roughdraftAttachmentContexts,
  scanRoughdraftReview,
} from "./index.js";
import {
  renumberReviewDraft,
  reviewHistoryProposalIds,
} from "./review-identities.js";
import type {
  SyncConflict,
  SyncDraft,
  SyncHistory,
  SyncMerge,
} from "./review-sync.js";
import {
  canonicalValue,
  contentSignature,
  normalizedReviewComment,
  reviewDraftSignature,
  sameReviewDraft,
} from "./review-values.js";
import {
  patchReviewYaml,
  splitReviewSource,
  UnsupportedReviewMerge,
} from "./review-yaml.js";

export { renumberReviewDraft, reviewDraftSignature, sameReviewDraft };
export interface ReviewMergeOptions {
  server?: boolean;
  budgetMs?: number;
  resolution?: "local" | "incoming";
  projectedCleanMarkdown?: string;
}
interface Change {
  from: number;
  to: number;
  text: string;
  side: "local" | "incoming";
}
const same = (a: unknown, b: unknown) =>
  a === undefined || b === undefined
    ? a === b
    : canonicalValue(a) === canonicalValue(b);
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function historyMeaning(entry: SyncHistory | undefined) {
  if (!entry) return undefined;
  const {
    inverse: _inverse,
    guard: _guard,
    stale: _stale,
    staleReason: _staleReason,
    unmappedSince: _unmappedSince,
    originSignature: _originSignature,
    ...meaning
  } = entry;
  return meaning;
}

function inverseProposalOwners(draft: SyncDraft) {
  const owners = new Map<string, Set<string>>();
  for (const entry of draft.reviewed ?? [])
    for (const id of reviewHistoryProposalIds([entry])) {
      const events = owners.get(id) ?? new Set<string>();
      events.add(entry.id);
      owners.set(id, events);
    }
  return owners;
}

function historyAction(entry: SyncHistory, sharedSources: ReadonlySet<string>) {
  const detail = historyMeaning(entry);
  if (!detail) return undefined;
  const { id: _id, keptId, keptIds, ...meaning } = detail;
  const sources = [
    ...new Set(
      [keptId, ...(keptIds ?? [])].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ].sort();
  // Native IDs must identify a pending item in the common base. Newly allocated
  // IDs can collide after a proposal is immediately decided in two passages.
  // Reference IDs encode the fixed comparison passage; metadata is document-wide.
  return sources.length &&
    sources.every(
      (id) =>
        sharedSources.has(id) ||
        id.startsWith("reference-") ||
        id === "document-metadata",
    )
    ? canonicalValue([sources, meaning])
    : undefined;
}

function identityItems(
  draft: SyncDraft,
  parsed: RfmReviewItem[],
  attachmentContext = false,
) {
  const items = new Map<string, unknown>();
  const contexts = attachmentContext
    ? parsed.some((item) => item.endOffset > item.offset)
      ? roughdraftAttachmentContexts(
          draft.markdown,
          parsed
            .filter((item) => item.endOffset > item.offset)
            .map((item) => item.offset),
        )
      : new Map<number, string>()
    : null;
  for (const item of parsed) {
    if (contexts && item.endOffset > item.offset && !contexts.has(item.offset))
      throw new UnsupportedReviewMerge(
        "This review attachment needs browser mapping.",
      );
    items.set(item.id, {
      kind: item.kind,
      text: item.text,
      originalText: item.originalText,
      replacementText: item.replacementText,
      anchorText: item.anchorText,
      parentId: item.parentId,
      author: item.author,
      createdAt: item.createdAt,
      ...(attachmentContext
        ? {
            context:
              item.endOffset > item.offset ? contexts?.get(item.offset) : null,
          }
        : {}),
    });
  }
  for (const comment of draft.reviewComments) {
    const previous = items.get(comment.id);
    items.set(comment.id, {
      represented: previous,
      sidecar: normalizedReviewComment(comment),
    });
  }
  for (const history of draft.reviewed ?? []) items.set(history.id, history);
  for (const proposal of draft.outdatedSuggestions ?? [])
    items.set(proposal.id, proposal);
  return items;
}

function nextIdentity(id: string, used: Set<string>) {
  const numbered = /^(.*?)(\d+)$/.exec(id);
  const prefix = numbered?.[1] ?? `${id}-`;
  let next = numbered ? Number(numbered[2]) + 1 : 2;
  for (const value of used) {
    if (!value.startsWith(prefix)) continue;
    const suffix = value.slice(prefix.length);
    if (/^\d+$/.test(suffix)) next = Math.max(next, Number(suffix) + 1);
  }
  while (used.has(`${prefix}${next}`)) next++;
  return `${prefix}${next}`;
}

function tokenize(
  source: string,
  fragments: readonly RfmReviewRange[],
  bodyOffset: number,
): string[] {
  // Reuse the full-context scan, retaining each same-ID fragment separately.
  // Metadata-only feedback has no inline range and cannot consume body text.
  const ranges = fragments
    .filter(
      (range) =>
        range.from >= bodyOffset &&
        range.to <= bodyOffset + source.length &&
        range.to > range.from,
    )
    .map((range) => ({
      from: range.from - bodyOffset,
      to: range.to - bodyOffset,
    }));
  for (const match of source.matchAll(
    /^([ \t]*)(`{3,}|~{3,})[^\r\n]*\r?\n/gm,
  )) {
    const marker = match[2];
    const closing = new RegExp(
      `^${match[1]}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`,
      "gm",
    );
    closing.lastIndex = match.index + match[0].length;
    const end = closing.exec(source);
    if (end) ranges.push({ from: match.index, to: end.index + end[0].length });
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  const tokens: string[] = [];
  let position = 0;
  const plain = (text: string) =>
    tokens.push(...(text.match(/\r\n|\n|[ \t]+|[^\s\p{P}\p{S}]+|./gu) ?? []));
  for (const range of merged) {
    plain(source.slice(position, range.from));
    tokens.push(source.slice(range.from, range.to));
    position = range.to;
  }
  plain(source.slice(position));
  return tokens;
}

function changes(
  base: string[],
  next: string[],
  side: Change["side"],
  remaining: number,
): Change[] {
  const parts = Number.isFinite(remaining)
    ? diffArrays(base, next, { timeout: Math.max(1, remaining) })
    : diffArrays(base, next);
  if (!parts)
    throw new UnsupportedReviewMerge(
      "The bounded comparison needs the browser merge path.",
    );
  const result: Change[] = [];
  let from = 0;
  let pending: Change | null = null;
  for (const part of parts) {
    if (part.added || part.removed) {
      pending ??= { from, to: from, text: "", side };
      if (part.added) pending.text += part.value.join("");
      else {
        from += part.value.length;
        pending.to = from;
      }
    } else {
      if (pending) result.push(pending);
      pending = null;
      from += part.value.length;
    }
  }
  if (pending) result.push(pending);
  return result;
}

function overlapping(a: Change, b: Change) {
  if (a.from === a.to) return a.from >= b.from && a.from <= b.to;
  if (b.from === b.to) return b.from >= a.from && b.from <= a.to;
  return a.from < b.to && b.from < a.to;
}

function renderRange(
  base: string[],
  from: number,
  to: number,
  edits: Change[],
) {
  let text = "";
  let position = from;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    text += base.slice(position, edit.from).join("") + edit.text;
    position = edit.to;
  }
  return text + base.slice(position, to).join("");
}

/** A same-anchor discussion can gain independent threads without text conflict. */
function combinedComments(
  base: string,
  local: string,
  incoming: string,
): string | null {
  const clean = cleanRoughdraftMarkdown(base);
  if (
    cleanRoughdraftMarkdown(local) !== clean ||
    cleanRoughdraftMarkdown(incoming) !== clean
  )
    return null;
  // A shared anchored comment is one diff token. An independent pending
  // insertion immediately beside it can therefore share its replacement
  // range even though the original comment's exact bytes are unchanged.
  const existingIds = new Set(
    scanRoughdraftReview(base).items.map((item) => item.id),
  );
  const annotationExtension = (extended: string, shared: string) => {
    if (!shared) return null;
    const at = extended.indexOf(shared);
    if (at < 0 || extended.indexOf(shared, at + 1) >= 0) return null;
    const extras = extended.slice(0, at) + extended.slice(at + shared.length);
    if (!extras || cleanRoughdraftMarkdown(extras) !== "") return null;
    const additions = scanRoughdraftReview(extras).items;
    const sharedIds = new Set(
      scanRoughdraftReview(shared).items.map((item) => item.id),
    );
    return additions.length &&
      additions.every(
        (item) =>
          !existingIds.has(item.id) &&
          !sharedIds.has(item.id) &&
          item.endOffset > item.offset &&
          (item.kind !== "suggestion" || item.suggestionKind === "addition"),
      )
      ? extended
      : null;
  };
  const extension =
    annotationExtension(local, incoming) ??
    annotationExtension(incoming, local);
  if (extension !== null) return extension;
  const sources = [base, local, incoming];
  const entries = sources.map((source) => scanRoughdraftReview(source).items);
  if (
    entries.some((items) =>
      items.some(
        (item) => item.kind === "suggestion" || item.anchorText === undefined,
      ),
    )
  )
    return null;
  const chosen = new Map<string, { source: string; item: RfmReviewItem }>();
  const maps = entries.map(
    (items, index) =>
      new Map(items.map((item) => [item.id, { source: sources[index], item }])),
  );
  for (const id of new Set([
    ...maps[0].keys(),
    ...maps[1].keys(),
    ...maps[2].keys(),
  ])) {
    const [before, left, right] = maps.map((map) => map.get(id));
    const raw = (value: typeof before) =>
      value
        ? value.source.slice(value.item.offset, value.item.endOffset)
        : undefined;
    const b = raw(before),
      l = raw(left),
      r = raw(right);
    // Deleting an annotation competes with changing it, just as two changed
    // bodies do. An absent side must not silently win over the edited thread.
    if (l !== r && l !== b && r !== b) return null;
    const next = l === r || r === b ? left : l === b ? right : undefined;
    if (next) chosen.set(id, next);
  }
  const anchors = new Map<
    string,
    { from: number; to: number; raw: string; comments: string[] }
  >();
  for (const { source, item } of chosen.values()) {
    const anchor = `{==${item.anchorText}==}`;
    const start = source.lastIndexOf(anchor, item.offset);
    if (start < 0) return null;
    const from = cleanRoughdraftMarkdown(source.slice(0, start)).length;
    if (item.anchorText === undefined) return null;
    const to = from + cleanRoughdraftMarkdown(item.anchorText).length;
    const key = `${from}:${to}`;
    const group = anchors.get(key) ?? { from, to, raw: anchor, comments: [] };
    if (group.raw !== anchor) return null;
    group.comments.push(source.slice(item.offset, item.endOffset));
    anchors.set(key, group);
  }
  let result = clean;
  let position = clean.length + 1;
  for (const anchor of [...anchors.values()].sort((a, b) => b.from - a.from)) {
    if (anchor.to > position) return null;
    result =
      result.slice(0, anchor.from) +
      anchor.raw +
      anchor.comments.join("") +
      result.slice(anchor.to);
    position = anchor.from;
  }
  return result;
}

export function mergeReviewDrafts(
  base: SyncDraft,
  submitted: SyncDraft,
  incoming: SyncDraft,
  options: ReviewMergeOptions = {},
): SyncMerge {
  const begin = performance.now();
  const budget =
    options.budgetMs ?? (options.server ? 16 : Number.POSITIVE_INFINITY);
  const conflicts: SyncConflict[] = [];
  const occurrence = new Map<string, number>();
  let local = submitted;
  let idRemap: Record<string, string> | undefined;
  const remaining = () => budget - (performance.now() - begin);
  const check = () => {
    if (remaining() <= 0)
      throw new UnsupportedReviewMerge("The comparison budget was exhausted.");
  };
  const conflict = (
    kind: SyncConflict["kind"],
    label: string,
    before: unknown,
    left: unknown,
    right: unknown,
  ) => {
    const signature = contentSignature(
      canonicalValue([kind, label, before, left, right]),
    );
    const count = occurrence.get(signature) ?? 0;
    occurrence.set(signature, count + 1);
    conflicts.push({
      id: `${signature}-${count}`,
      kind,
      label,
      base: before,
      local: left,
      incoming: right,
    });
    return options.resolution === "incoming" ? right : left;
  };
  const value = (
    before: unknown,
    left: unknown,
    right: unknown,
    kind: SyncConflict["kind"],
    label: string,
  ): unknown => {
    const nullableCommentField =
      kind === "comment" &&
      /\.(?:authorType|authorId|parentCommentId|scope|originalQuote|detachedReason)$/.test(
        label,
      );
    const equal = (a: unknown, b: unknown) =>
      nullableCommentField ? same(a ?? null, b ?? null) : same(a, b);
    if (equal(left, right) || equal(right, before)) return left;
    if (equal(left, before)) return right;
    if (
      object(left) &&
      object(right) &&
      (before === undefined || before === null || object(before))
    ) {
      const previous = object(before) ? before : {};
      const result: Record<string, unknown> = {};
      for (const key of new Set([
        ...Object.keys(right),
        ...Object.keys(left),
        ...Object.keys(previous),
      ])) {
        const merged = value(
          previous[key],
          left[key],
          right[key],
          kind,
          `${label}.${key}`,
        );
        if (merged !== undefined) result[key] = merged;
      }
      return result;
    }
    return conflict(kind, label, before, left, right);
  };
  const collection = <T extends { id: string }>(
    before: T[] = [],
    left: T[] = [],
    right: T[] = [],
    kind: SyncConflict["kind"],
  ): T[] => {
    const maps = [before, left, right].map(
      (items) => new Map(items.map((item) => [item.id, item])),
    );
    const result: T[] = [];
    for (const id of new Set([
      ...right.map((item) => item.id),
      ...left.map((item) => item.id),
      ...before.map((item) => item.id),
    ])) {
      const item = value(
        maps[0].get(id),
        maps[1].get(id),
        maps[2].get(id),
        kind,
        `${kind}:${id}`,
      );
      if (item !== undefined) result.push(item as T);
    }
    return result;
  };
  try {
    check();
    if (
      options.server &&
      [base, local, incoming].some((draft) => draft.markdown.length > 50 * 1024)
    )
      throw new UnsupportedReviewMerge(
        "Large documents use the bounded browser merge path.",
      );
    const scans = [base, local, incoming].map((draft) =>
      scanRoughdraftReview(draft.markdown),
    );
    const parsed = scans.map((scan) => scan.items);
    // Older inline feedback can omit its date. Parsing it on two pages invents
    // two import times; that is one existing comment, not two new comments.
    // Preserve explicitly authored dates, and use the committed sidecar's date
    // for a comment already present in the original Markdown.
    const undated = new Set(
      parsed[0]
        .filter((item) => item.kind === "comment" && !item.createdAt)
        .map((item) => item.id),
    );
    const authored = new Set(
      parsed[1].filter((item) => item.createdAt).map((item) => item.id),
    );
    const committed = new Map(
      incoming.reviewComments.map((comment) => [comment.id, comment]),
    );
    local = {
      ...local,
      reviewComments: local.reviewComments.map((comment) => {
        const previous = committed.get(comment.id);
        return previous && undated.has(comment.id) && !authored.has(comment.id)
          ? { ...comment, createdAt: previous.createdAt }
          : comment;
      }),
    };
    const indexes = [base, local, incoming].map((draft, index) =>
      identityItems(draft, parsed[index]),
    );
    const inverseOwners = [base, local, incoming].map(inverseProposalOwners);
    const inverseIds = inverseOwners.map((owners) => new Set(owners.keys()));
    const incomingHistory = new Map(
      (incoming.reviewed ?? []).map((entry) => [entry.id, entry]),
    );
    const sharedEvents = new Set(
      (local.reviewed ?? [])
        .filter(
          (entry) =>
            // UUID and timestamp/random events have a separator after the
            // prefix. Legacy decision-1 IDs can still collide across pages.
            entry.id.startsWith("decision-") &&
            entry.id.slice("decision-".length).includes("-") &&
            same(
              historyMeaning(entry),
              historyMeaning(incomingHistory.get(entry.id)),
            ),
        )
        .map((entry) => entry.id),
    );
    const used = new Set([
      ...indexes.flatMap((items) => [...items.keys()]),
      ...inverseIds.flatMap((ids) => [...ids]),
    ]);
    const mapping: Record<string, string> = {};
    let attachments: Map<string, unknown>[] | undefined;
    for (const id of indexes[1].keys()) {
      if (
        indexes[0].has(id) ||
        inverseIds[0].has(id) ||
        !indexes[2].has(id) ||
        sharedEvents.has(id)
      )
        continue;
      // Only simultaneous new IDs need attachment comparison. Existing review
      // IDs retain their identity when nearby pending markup changes spelling.
      attachments ??= [local, incoming].map((draft, index) =>
        identityItems(draft, parsed[index + 1], true),
      );
      if (!same(attachments[0].get(id), attachments[1].get(id))) {
        if (options.server)
          throw new UnsupportedReviewMerge(
            "New review IDs collide; the browser must renumber its own items.",
          );
        const replacement = nextIdentity(id, used);
        mapping[id] = replacement;
        used.add(replacement);
      }
    }
    for (const id of new Set([...indexes[1].keys(), ...inverseIds[1]])) {
      if (
        mapping[id] ||
        indexes[0].has(id) ||
        inverseIds[0].has(id) ||
        (!inverseIds[1].has(id) && !inverseIds[2].has(id)) ||
        (!indexes[2].has(id) && !inverseIds[2].has(id))
      )
        continue;
      const localOwners = inverseOwners[1].get(id);
      const incomingOwners = inverseOwners[2].get(id);
      if (
        !indexes[1].has(id) &&
        !indexes[2].has(id) &&
        localOwners &&
        incomingOwners &&
        localOwners.size === incomingOwners.size &&
        [...localOwners].every(
          (owner) => sharedEvents.has(owner) && incomingOwners.has(owner),
        )
      )
        continue;
      // Resolving a proposal removes its inline ID, but its inverse still owns
      // that identity. Only the browser may rename its new local references.
      if (options.server)
        throw new UnsupportedReviewMerge(
          "Resolved proposal IDs collide; the browser must renumber its own items.",
        );
      const replacement = nextIdentity(id, used);
      mapping[id] = replacement;
      used.add(replacement);
    }
    if (Object.keys(mapping).length) {
      local = renumberReviewDraft(local, mapping);
      idRemap = mapping;
      scans[1] = scanRoughdraftReview(local.markdown);
    }
    check();
    const parity = [base, local, incoming].every(
      (draft) =>
        cleanRoughdraftMarkdown(draft.markdown) ===
        (draft.cleanMarkdown ?? draft.markdown),
    );
    if (options.server && !parity)
      throw new UnsupportedReviewMerge(
        "The annotated and clean browser projections require client reconciliation.",
      );
    const parts = [base, local, incoming].map((draft) =>
      splitReviewSource(draft.markdown),
    );
    check();
    const metadata = (key: "frontmatter" | "endmatter") => {
      const [b, l, r] = parts.map((part) => part[key]);
      const merged = value(b?.data, l?.data, r?.data, "metadata", key) as
        | Record<string, unknown>
        | undefined;
      if (!merged) return "";
      for (const block of [r, l, b]) {
        if (block && same(block.data, merged))
          return block.prefix + block.source + block.suffix;
      }
      const basis = r ?? l ?? b;
      if (!basis) return "";
      return basis.prefix + patchReviewYaml(basis, merged, l, r) + basis.suffix;
    };
    const frontmatter = metadata("frontmatter");
    const endmatter = metadata("endmatter");
    const [beforeBody, localBody, incomingBody] = parts.map(
      (part) => part.body,
    );
    let body: string;
    if (localBody === incomingBody || incomingBody === beforeBody)
      body = localBody;
    else if (localBody === beforeBody) body = incomingBody;
    else {
      const tokensFor = (body: string, index: number) => {
        const front = parts[index].frontmatter;
        const offset = front
          ? front.prefix.length + front.source.length + front.suffix.length
          : 0;
        return tokenize(body, scans[index].ranges, offset);
      };
      const tokens = tokensFor(beforeBody, 0);
      const patches = [
        ...changes(tokens, tokensFor(localBody, 1), "local", remaining()),
        ...changes(tokens, tokensFor(incomingBody, 2), "incoming", remaining()),
      ].sort((a, b) => a.from - b.from || a.to - b.to);
      body = "";
      let position = 0;
      for (let index = 0; index < patches.length; ) {
        check();
        const group = [patches[index++]];
        while (
          index < patches.length &&
          group.some((item) => overlapping(item, patches[index]))
        )
          group.push(patches[index++]);
        const from = Math.min(...group.map((item) => item.from));
        const to = Math.max(...group.map((item) => item.to));
        body += tokens.slice(position, from).join("");
        const left = group.filter((item) => item.side === "local");
        const right = group.filter((item) => item.side === "incoming");
        const before = tokens.slice(from, to).join("");
        const l = renderRange(tokens, from, to, left);
        const r = renderRange(tokens, from, to, right);
        body += !left.length
          ? r
          : !right.length || l === r
            ? l
            : (combinedComments(before, l, r) ??
              (conflict("text", "Document passage", before, l, r) as string));
        position = to;
      }
      body += tokens.slice(position).join("");
    }
    check();
    const markdown = frontmatter + body + endmatter;
    const historyOrigins = new Map<string, SyncDraft>();
    const sharedHistorySources = new Set(parsed[0].map((item) => item.id));
    const previousHistory = new Set(
      (base.reviewed ?? []).map((entry) => entry.id),
    );
    const newIncoming = new Map<string, SyncHistory[]>();
    for (const entry of incoming.reviewed ?? []) {
      const action = historyAction(entry, sharedHistorySources);
      if (previousHistory.has(entry.id) || action === undefined) continue;
      const entries = newIncoming.get(action) ?? [];
      entries.push(entry);
      newIncoming.set(action, entries);
    }
    const coalescedHistory = new Map<string, SyncHistory>();
    const localHistory = (local.reviewed ?? []).filter((entry) => {
      if (previousHistory.has(entry.id)) return true;
      const action = historyAction(entry, sharedHistorySources);
      const peer =
        action === undefined ? undefined : newIncoming.get(action)?.shift();
      if (!peer || peer.id === entry.id) return true;
      // Two new actions on one real source are idempotent. Never coalesce by
      // wording alone, or remove a prior event already present in the base.
      coalescedHistory.set(peer.id, entry);
      return false;
    });
    const histories = [base.reviewed, localHistory, incoming.reviewed].map(
      (entries) => new Map((entries ?? []).map((entry) => [entry.id, entry])),
    );
    const reviewed: SyncHistory[] = [];
    for (const id of new Set(histories.flatMap((items) => [...items.keys()]))) {
      const entries = histories.map((items) => items.get(id));
      const meaning = value(
        historyMeaning(entries[0]),
        historyMeaning(entries[1]),
        historyMeaning(entries[2]),
        "history",
        `history:${id}`,
      );
      if (meaning === undefined) continue;
      // Reuse one known coordinate system, preferably the common origin.
      // Its positions are mapped by the editor after the merged text arrives.
      const origins = [0, 2, 1].flatMap((index) =>
        entries[index]
          ? [{ entry: entries[index], source: [base, local, incoming][index] }]
          : [],
      );
      const matching = origins.filter((origin) =>
        same(historyMeaning(origin.entry), meaning),
      );
      const basis = matching[0] ?? origins[0];
      const entry = { ...basis.entry, ...(meaning as object) } as SyncHistory;
      const twin = coalescedHistory.get(id);
      const permanent =
        matching.find(
          (origin) =>
            origin.entry.stale && origin.entry.staleReason !== "needs-remap",
        )?.entry ??
        (twin?.stale && twin.staleReason !== "needs-remap" ? twin : undefined);
      if (permanent) {
        entry.stale = true;
        entry.staleReason = permanent.staleReason;
      } else if (!matching.length) {
        // Combined semantic edits have no inverse known to restore that meaning.
        entry.stale = true;
        entry.staleReason = "changed-decision";
      }
      reviewed.push(entry);
      historyOrigins.set(id, basis.source);
    }
    const origin = reviewDraftSignature(base);
    const mapped = reviewed.map((item): SyncHistory => {
      const from = historyOrigins.get(item.id) ?? local;
      if (from.markdown === markdown) return item;
      return {
        ...item,
        stale: true,
        staleReason:
          item.stale && item.staleReason !== "needs-remap"
            ? item.staleReason
            : "needs-remap",
        unmappedSince: item.unmappedSince ?? origin,
        originSignature: item.originSignature ?? reviewDraftSignature(from),
      };
    });
    const result: SyncDraft = {
      markdown,
      decisions: value(
        base.decisions,
        local.decisions,
        incoming.decisions,
        "decision",
        "Decision",
      ) as SyncDraft["decisions"],
      reviewComments: collection(
        base.reviewComments,
        local.reviewComments,
        incoming.reviewComments,
        "comment",
      ),
      ...(mapped.length ? { reviewed: mapped } : {}),
      ...(base.outdatedSuggestions?.length ||
      local.outdatedSuggestions?.length ||
      incoming.outdatedSuggestions?.length
        ? {
            outdatedSuggestions: collection(
              base.outdatedSuggestions,
              local.outdatedSuggestions,
              incoming.outdatedSuggestions,
              "suggestion",
            ),
          }
        : {}),
    };
    if (!options.server && options.projectedCleanMarkdown !== undefined)
      result.cleanMarkdown = options.projectedCleanMarkdown;
    else if (parity) result.cleanMarkdown = cleanRoughdraftMarkdown(markdown);
    else {
      const exact = [local, incoming, base].find(
        (draft) => draft.markdown === markdown,
      );
      if (exact) result.cleanMarkdown = exact.cleanMarkdown;
    }
    check();
    const signature = conflicts.length
      ? contentSignature(canonicalValue(conflicts))
      : reviewDraftSignature(result);
    return {
      status: conflicts.length && !options.resolution ? "conflict" : "merged",
      draft: result,
      conflicts,
      signature,
      ...(idRemap ? { idRemap } : {}),
    };
  } catch (error) {
    if (!(error instanceof UnsupportedReviewMerge)) throw error;
    return {
      status: "client-merge-required",
      draft: submitted,
      conflicts: [],
      signature: reviewDraftSignature(submitted),
      reason: error.message,
    };
  }
}
