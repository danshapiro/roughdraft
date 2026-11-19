import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { diffLines } from "diff";
import { Router, type Request, type Response } from "express";

export type ComparisonMode = "proposal" | "applied" | "compare" | "document";
export type ComparisonDecision = "pending" | "before" | "after";
export interface ComparisonSegment {
  id: string;
  kind: "equal" | "change";
  before: string;
  after: string;
  oldStart: number;
  newStart: number;
  decision: ComparisonDecision;
  comment: string;
}
export interface ComparisonCompletion {
  fileWritten: boolean;
  targetPath: string | null;
  accepted: number;
  reverted: number;
  completedAt: string;
}
export interface ComparisonReviewComment {
  id: string;
  changeId: string;
  content: string;
  createdAt: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  parentCommentId?: string | null;
  scope?: "document";
}
export interface EditorDraft {
  markdown: string;
  cleanMarkdown?: string;
  decisions: Record<string, "kept">;
}
export interface EditorFeedback {
  draft: EditorDraft;
  reference: { label: string; markdown: string } | null;
  destinationPath: string | null;
  saved: boolean;
  comment: string;
  reviewComments: ComparisonReviewComment[];
  sentAt: string;
}
export interface Comparison {
  id: string;
  revision: number;
  mode: ComparisonMode;
  title: string;
  beforeLabel: string;
  afterLabel: string;
  targetPath: string | null;
  beforeText: string;
  afterText: string;
  segments: ComparisonSegment[];
  comment: string;
  reviewComments: ComparisonReviewComment[];
  status: "open" | "completed" | "applied";
  completion: ComparisonCompletion | null;
  targetChanged: boolean;
  editor?: "unified";
  draft?: EditorDraft | null;
  destinationPath?: string | null;
  savedPath?: string | null;
  savedText?: string | null;
  feedback?: EditorFeedback | null;
}
interface StoredComparison extends Omit<Comparison, "targetChanged"> {
  targetVersion: string | null;
  pendingApply?: { outputHash: string; completion: ComparisonCompletion };
  destinationVersion?: string | null;
  pendingSave?: {
    path: string;
    draft: EditorDraft;
    reviewComments: ComparisonReviewComment[];
  };
}
interface FileSnapshot {
  path: string;
  text: string;
  version: string;
  mode: number;
}
class ComparisonError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.info(
    JSON.stringify({
      severity:
        event === "error" ? "error" : event === "conflict" ? "warn" : "info",
      component: "comparisons",
      event,
      ...fields,
    }),
  );
}
function stringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ComparisonError(400, `${key} must be a string`);
  return value;
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ComparisonError(400, "A JSON object is required");
  return value as Record<string, unknown>;
}
function reviewCommentsField(
  value: unknown,
  review: StoredComparison,
  allowDraftAnchors = false,
): ComparisonReviewComment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new ComparisonError(400, "reviewComments must be an array");
  const anchors = new Set([
    ...review.segments
      .filter((segment) => segment.kind === "change")
      .map((segment) => segment.id),
    ...review.reviewComments.map((comment) => comment.changeId),
  ]);
  const ids = new Set<string>();
  return value.map((raw) => {
    const input = objectBody(raw);
    const id = stringField(input, "id");
    const changeId = stringField(input, "changeId");
    const content = stringField(input, "content");
    const createdAt = stringField(input, "createdAt");
    if (
      !id ||
      ids.has(id) ||
      !changeId ||
      (!allowDraftAnchors && !anchors.has(changeId)) ||
      content === undefined ||
      !createdAt ||
      !Number.isFinite(Date.parse(createdAt))
    )
      throw new ComparisonError(
        400,
        "Review comments need unique IDs, an existing change, content and a valid timestamp",
      );
    ids.add(id);
    const { authorType, authorId, parentCommentId, scope } = input;
    if (
      authorType !== undefined &&
      authorType !== "user" &&
      authorType !== "ai"
    )
      throw new ComparisonError(400, "Comment authorType must be user or ai");
    for (const key of ["authorId", "parentCommentId"])
      if (
        input[key] !== undefined &&
        input[key] !== null &&
        typeof input[key] !== "string"
      )
        throw new ComparisonError(
          400,
          `Comment ${key} must be a string or null`,
        );
    if (scope !== undefined && scope !== "document")
      throw new ComparisonError(400, "Comment scope must be document");
    return {
      id,
      changeId,
      content,
      createdAt,
      ...(authorType !== undefined ? { authorType } : {}),
      ...(authorId !== undefined
        ? { authorId: authorId as string | null }
        : {}),
      ...(parentCommentId !== undefined
        ? { parentCommentId: parentCommentId as string | null }
        : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
  });
}
function snapshot(filename: string): FileSnapshot {
  try {
    const realPath = fs.realpathSync(path.resolve(filename));
    const stat = fs.statSync(realPath);
    if (!stat.isFile())
      throw new ComparisonError(400, `Not a regular file: ${filename}`);
    const bytes = fs.readFileSync(realPath);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new ComparisonError(
        400,
        `File must contain UTF-8 text: ${filename}`,
      );
    return {
      path: realPath,
      text,
      mode: stat.mode & 0o7777,
      version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${hash(text)}`,
    };
  } catch (error) {
    if (error instanceof ComparisonError) throw error;
    throw new ComparisonError(
      400,
      `Cannot read file ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function draftField(body: Record<string, unknown>): EditorDraft {
  const markdown = stringField(body, "markdown");
  if (markdown === undefined)
    throw new ComparisonError(400, "markdown is required");
  const cleanMarkdown = stringField(body, "cleanMarkdown");
  const entries = Object.entries(objectBody(body.decisions));
  if (entries.some(([key, value]) => !key || value !== "kept"))
    throw new ComparisonError(400, "decisions must map change IDs to kept");
  return {
    markdown,
    ...(cleanMarkdown !== undefined ? { cleanMarkdown } : {}),
    decisions: Object.fromEntries(entries.map(([id]) => [id, "kept"] as const)),
  };
}
function cleanDraft(draft: EditorDraft): string {
  return draft.cleanMarkdown ?? draft.markdown;
}
function inspectDestination(filename: string): {
  path: string;
  current: FileSnapshot | null;
} {
  if (
    !path.isAbsolute(filename) ||
    path.extname(filename).toLowerCase() !== ".md"
  )
    throw new ComparisonError(400, "Choose an absolute path ending in .md");
  let candidate: string;
  try {
    candidate = path.join(
      fs.realpathSync(path.dirname(filename)),
      path.basename(filename),
    );
    if (!fs.statSync(path.dirname(candidate)).isDirectory())
      throw new Error("The parent is not a directory");
  } catch (error) {
    throw new ComparisonError(
      400,
      `Choose a Markdown file in an existing directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: candidate, current: null };
    throw error;
  }
  const current = snapshot(candidate);
  if (path.extname(current.path).toLowerCase() !== ".md")
    throw new ComparisonError(400, "The destination must be a Markdown file");
  return { path: current.path, current };
}
function atomicWrite(
  filename: string,
  text: string,
  mode = 0o600,
  beforeRename?: () => void,
  allowBusyFallback = false,
  mustCreate = false,
): void {
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode, flag: "wx" });
    fs.chmodSync(temporary, mode);
    beforeRename?.();
    if (mustCreate) {
      try {
        fs.linkSync(temporary, filename);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new ComparisonError(
            409,
            "The destination was created before saving. Review it before replacing it.",
          );
        throw error;
      }
    }
    try {
      fs.renameSync(temporary, filename);
    } catch (error) {
      // Linux cannot rename over an individual file bind mount. Recheck the
      // destination before the only supported non-atomic write path.
      if (
        !allowBusyFallback ||
        (error as NodeJS.ErrnoException).code !== "EBUSY"
      )
        throw error;
      beforeRename?.();
      const descriptor = fs.openSync(filename, "r+");
      try {
        fs.writeFileSync(descriptor, text, "utf8");
        // r+ retains the mounted inode; truncate old tails on that same inode.
        fs.ftruncateSync(descriptor, Buffer.byteLength(text, "utf8"));
      } finally {
        fs.closeSync(descriptor);
      }
      log("bind-mount-write", { targetPath: filename, nonAtomic: true });
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function comparisonSegments(
  before: string,
  after: string,
): ComparisonSegment[] {
  const parts = diffLines(before, after);
  const segments: ComparisonSegment[] = [];
  const occurrences = new Map<string, number>();
  let oldStart = 1;
  let newStart = 1;
  const add = (
    kind: ComparisonSegment["kind"],
    previous: string,
    next: string,
  ) => {
    const signature = hash(JSON.stringify([kind, previous, next]));
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    segments.push({
      id: `${signature.slice(0, 24)}-${occurrence}`,
      kind,
      before: previous,
      after: next,
      oldStart,
      newStart,
      decision: kind === "equal" ? "after" : "pending",
      comment: "",
    });
    oldStart += (previous.match(/\n/g) ?? []).length;
    newStart += (next.match(/\n/g) ?? []).length;
  };
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      add("equal", part.value, part.value);
      continue;
    }
    let previous = "";
    let next = "";
    while (
      index < parts.length &&
      (parts[index].added || parts[index].removed)
    ) {
      if (parts[index].removed) previous += parts[index].value;
      else next += parts[index].value;
      index++;
    }
    index--;
    add("change", previous, next);
  }
  return segments;
}

class ComparisonStore {
  constructor(private directory: string) {}
  private filename(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new ComparisonError(404, "Comparison not found");
    return path.join(this.directory, `${id}.json`);
  }
  private save(review: StoredComparison): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    atomicWrite(this.filename(review.id), `${JSON.stringify(review)}\n`);
  }
  load(id: string): StoredComparison {
    const filename = this.filename(id);
    if (!fs.existsSync(filename))
      throw new ComparisonError(404, "Comparison not found");
    const review = JSON.parse(
      fs.readFileSync(filename, "utf8"),
    ) as StoredComparison;
    review.reviewComments ??= [];
    // An intent makes a retry safe if the process stopped after rename but before
    // recording completion. Never replay a write during recovery.
    if (review.pendingApply && review.targetPath) {
      let wroteExpectedOutput = false;
      try {
        wroteExpectedOutput =
          hash(snapshot(review.targetPath).text) ===
          review.pendingApply.outputHash;
      } catch {
        /* Missing/changed destinations stay open and conflicted. */
      }
      if (wroteExpectedOutput) {
        review.status = "applied";
        review.completion = review.pendingApply.completion;
        review.revision++;
        log("recovered", {
          id: review.id,
          fileWritten: review.completion.fileWritten,
        });
      }
      delete review.pendingApply;
      this.save(review);
    }
    if (review.pendingSave) {
      const intent = review.pendingSave;
      let current: FileSnapshot | null = null;
      try {
        current = snapshot(intent.path);
      } catch {
        /* Recovery never writes to an unavailable or changed destination. */
      }
      if (
        current?.path === intent.path &&
        current.text === cleanDraft(intent.draft)
      ) {
        this.recordSave(review, intent.draft, intent.reviewComments, current);
        log("draft-save-recovered", {
          id: review.id,
          destinationPath: current.path,
        });
      } else {
        // A crash before the write (or an external edit afterward) must not
        // lose the draft from the Save request. Never mark it saved blindly.
        review.draft = intent.draft;
        review.reviewComments = intent.reviewComments;
        review.revision++;
      }
      delete review.pendingSave;
      this.save(review);
    }
    return review;
  }
  view(review: StoredComparison): Comparison {
    const {
      targetVersion,
      destinationVersion,
      pendingApply: _pendingApply,
      pendingSave: _pendingSave,
      ...result
    } = review;
    let targetChanged = false;
    const filename =
      review.editor === "unified" ? review.destinationPath : review.targetPath;
    if (filename && (review.editor === "unified" || review.status === "open")) {
      try {
        const current = snapshot(filename);
        targetChanged =
          current.path !== filename ||
          current.version !==
            (review.editor === "unified" ? destinationVersion : targetVersion);
      } catch {
        targetChanged = true;
      }
    }
    return { ...result, targetChanged };
  }
  openDocument(body: Record<string, unknown>): StoredComparison {
    const targetPath = stringField(body, "targetPath");
    const input = { mode: "document", editor: "unified", targetPath };
    if (targetPath === undefined) return this.create(input);
    const { path: filename, current: disk } = inspectDestination(targetPath);
    const index = path.join(this.directory, `document-${hash(filename)}.index`);
    try {
      const current = this.load(fs.readFileSync(index, "utf8"));
      if (current.mode === "document" && current.destinationPath === filename) {
        const draft = current.draft;
        const hasWork =
          current.feedback ||
          current.reviewComments.length ||
          (draft &&
            (draft.markdown !== current.savedText ||
              cleanDraft(draft) !== current.savedText));
        // Opening the source again should show external changes if there is
        // no unfinished draft or feedback to protect. Existing links stay valid.
        if (!disk || disk.version === current.destinationVersion || hasWork)
          return current;
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof ComparisonError && error.status === 404)
      )
        throw error;
    }
    const review = this.create(input);
    atomicWrite(index, review.id);
    return review;
  }
  create(body: Record<string, unknown>): StoredComparison {
    const mode = body.mode;
    const editor = body.editor;
    if (editor !== undefined && editor !== "unified")
      throw new ComparisonError(400, "editor must be unified");
    if (
      mode !== "proposal" &&
      mode !== "applied" &&
      mode !== "compare" &&
      mode !== "document"
    )
      throw new ComparisonError(
        400,
        "mode must be proposal, applied, compare, or document",
      );
    const targetInput = stringField(body, "targetPath");
    if (mode === "compare" && targetInput !== undefined)
      throw new ComparisonError(
        400,
        "A comparison has no destination; convert it to a proposal to choose a destination",
      );
    if (mode !== "compare" && mode !== "document" && !targetInput)
      throw new ComparisonError(400, "targetPath is required");
    if (mode === "document" && editor !== "unified")
      throw new ComparisonError(
        400,
        "Document sessions require the unified editor",
      );
    const target = targetInput
      ? mode === "document"
        ? inspectDestination(targetInput).current
        : snapshot(targetInput)
      : null;
    if (targetInput && !target)
      throw new ComparisonError(404, "Markdown file not found");
    const beforePath = stringField(body, "beforePath");
    const afterPath = stringField(body, "afterPath");
    const beforeText =
      mode === "document"
        ? ""
        : (stringField(body, "beforeText") ??
          (beforePath
            ? snapshot(beforePath).text
            : mode === "proposal"
              ? target?.text
              : undefined));
    const afterText =
      mode === "document"
        ? (target?.text ?? "")
        : (stringField(body, "afterText") ??
          (afterPath
            ? snapshot(afterPath).text
            : mode === "applied"
              ? target?.text
              : undefined));
    if (beforeText === undefined || afterText === undefined)
      throw new ComparisonError(
        400,
        "Both versions are required (beforePath/beforeText and afterPath/afterText)",
      );
    if (
      target &&
      mode !== "document" &&
      target.text !== (mode === "proposal" ? beforeText : afterText)
    )
      throw new ComparisonError(
        409,
        "The destination does not match the expected version. Create a comparison against its current contents.",
      );
    const review: StoredComparison = {
      id: crypto.randomUUID(),
      revision: 1,
      mode,
      title:
        stringField(body, "title") ??
        (target
          ? path.basename(target.path)
          : mode === "document"
            ? "Untitled"
            : "Compare versions"),
      beforeLabel:
        stringField(body, "beforeLabel") ??
        beforePath ??
        (mode === "proposal" ? target?.path : undefined) ??
        "Before",
      afterLabel:
        stringField(body, "afterLabel") ??
        afterPath ??
        (mode === "applied" ? target?.path : undefined) ??
        "After",
      targetPath: target?.path ?? null,
      targetVersion: target?.version ?? null,
      beforeText,
      afterText,
      segments:
        mode === "document" ? [] : comparisonSegments(beforeText, afterText),
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      ...(editor === "unified"
        ? {
            editor,
            draft: null,
            destinationPath: target?.path ?? null,
            destinationVersion: target?.version ?? null,
            savedPath: target?.path ?? null,
            savedText: target?.text ?? null,
            feedback: null,
          }
        : {}),
    };
    this.save(review);
    log("created", {
      id: review.id,
      mode,
      targetPath: review.targetPath,
      changes: review.segments.filter((segment) => segment.kind === "change")
        .length,
    });
    return review;
  }
  private requireRevision(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): void {
    if (body.revision !== review.revision)
      throw new ComparisonError(
        409,
        "Review choices changed in another browser. Reload the saved review before continuing.",
      );
    if (review.status !== "open")
      throw new ComparisonError(409, "This review is already finished");
    if (review.editor === "unified")
      throw new ComparisonError(
        400,
        "Use the editor draft, save, and feedback operations for this review",
      );
  }
  decisions(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    this.requireRevision(review, body);
    const updates = body.decisions ?? [];
    if (!Array.isArray(updates))
      throw new ComparisonError(400, "decisions must be an array");
    const proposed = new Map<
      string,
      { decision?: ComparisonDecision; comment?: string }
    >();
    for (const raw of updates) {
      const update = objectBody(raw);
      const id = stringField(update, "id");
      const segment = review.segments.find(
        (item) => item.id === id && item.kind === "change",
      );
      if (!id || !segment)
        throw new ComparisonError(400, "Unknown change in decision update");
      const decision = update.decision;
      if (
        decision !== undefined &&
        decision !== "pending" &&
        decision !== "before" &&
        decision !== "after"
      )
        throw new ComparisonError(
          400,
          "decision must be pending, before, or after",
        );
      if (review.mode === "compare" && decision !== undefined)
        throw new ComparisonError(
          400,
          "Comparisons have no accept/revert choices; convert to a proposal first",
        );
      proposed.set(id, { decision, comment: stringField(update, "comment") });
    }
    const comment = stringField(body, "comment");
    const reviewComments = reviewCommentsField(body.reviewComments, review);
    review.segments = review.segments.map((segment) => {
      const update = proposed.get(segment.id);
      return update
        ? {
            ...segment,
            decision: update.decision ?? segment.decision,
            comment: update.comment ?? segment.comment,
          }
        : segment;
    });
    review.comment = comment ?? review.comment;
    review.reviewComments = reviewComments ?? review.reviewComments;
    review.revision++;
    this.save(review);
    return review;
  }
  private requireEditor(review: StoredComparison): void {
    if (review.editor !== "unified")
      throw new ComparisonError(
        400,
        "This review uses the original comparison editor",
      );
  }
  private editorUpdate(
    review: StoredComparison,
    body: Record<string, unknown>,
  ) {
    this.requireEditor(review);
    if (body.revision !== review.revision)
      throw new ComparisonError(
        409,
        "This draft changed in another browser. Reload the saved draft before continuing.",
      );
    return {
      draft: draftField(body),
      reviewComments:
        reviewCommentsField(body.reviewComments, review, true) ??
        review.reviewComments,
    };
  }
  recoverDraft(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    const { draft, reviewComments } = this.editorUpdate(review, body);
    review.draft = draft;
    review.reviewComments = reviewComments;
    review.revision++;
    this.save(review);
    return review;
  }
  inspect(review: StoredComparison, filename: string | undefined) {
    this.requireEditor(review);
    const requested = filename ?? review.destinationPath;
    if (!requested)
      throw new ComparisonError(400, "Choose a destination first");
    const { path: inspected, current } = inspectDestination(requested);
    return {
      path: inspected,
      version: current?.version ?? null,
      markdown: current?.text ?? null,
    };
  }
  private recordSave(
    review: StoredComparison,
    draft: EditorDraft,
    reviewComments: ComparisonReviewComment[],
    current: FileSnapshot,
  ): void {
    review.draft = draft;
    review.reviewComments = reviewComments;
    review.destinationPath = current.path;
    review.destinationVersion = current.version;
    review.savedPath = current.path;
    review.savedText = cleanDraft(draft);
    review.revision++;
  }
  saveDraft(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    const { draft, reviewComments } = this.editorUpdate(review, body);
    const requested = stringField(body, "path");
    const filename = requested ?? review.destinationPath;
    if (!filename) throw new ComparisonError(400, "Choose a destination first");
    if (
      requested !== undefined &&
      body.expectedVersion !== null &&
      typeof body.expectedVersion !== "string"
    )
      throw new ComparisonError(
        400,
        "Inspect the destination before saving to it",
      );
    const { path: resolved, current } = inspectDestination(filename);
    const version = current?.version ?? null;
    const sameDestination =
      requested === undefined ||
      resolved === review.destinationPath ||
      path.resolve(filename) === review.destinationPath;
    const errorMessage =
      "The destination changed on disk. Inspect it or use Save As to save somewhere else.";
    if (
      (requested !== undefined && body.expectedVersion !== version) ||
      (sameDestination &&
        (resolved !== review.destinationPath ||
          version !== review.destinationVersion))
    )
      throw new ComparisonError(409, errorMessage);

    if (current?.text === cleanDraft(draft)) {
      this.recordSave(review, draft, reviewComments, current);
      this.save(review);
      return review;
    }
    review.pendingSave = { path: resolved, draft, reviewComments };
    this.save(review);
    try {
      atomicWrite(
        resolved,
        cleanDraft(draft),
        current?.mode,
        () => {
          const latest = inspectDestination(filename);
          if (
            latest.path !== resolved ||
            (latest.current?.version ?? null) !== version
          )
            throw new ComparisonError(409, errorMessage);
        },
        current !== null,
        current === null,
      );
    } catch (error) {
      delete review.pendingSave;
      this.save(review);
      throw error;
    }
    const saved = snapshot(resolved);
    if (saved.path !== resolved || saved.text !== cleanDraft(draft))
      throw new ComparisonError(409, errorMessage);
    this.recordSave(review, draft, reviewComments, saved);
    delete review.pendingSave;
    this.save(review);
    log("draft-saved", { id: review.id, destinationPath: resolved });
    return review;
  }
  sendFeedback(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    const { draft, reviewComments } = this.editorUpdate(review, body);
    const comment = stringField(body, "comment") ?? review.comment;
    const sentAt = new Date().toISOString();
    const destinationPath = review.destinationPath ?? null;
    const saved =
      destinationPath !== null &&
      review.savedPath === destinationPath &&
      review.savedText === cleanDraft(draft) &&
      !this.view(review).targetChanged;
    review.draft = draft;
    review.reviewComments = reviewComments;
    review.comment = comment;
    review.feedback = {
      draft,
      reference:
        review.mode === "document"
          ? null
          : { label: review.beforeLabel, markdown: review.beforeText },
      destinationPath,
      saved,
      comment,
      reviewComments,
      sentAt,
    };
    review.status = "completed";
    review.completion = {
      fileWritten: false,
      targetPath: destinationPath,
      accepted: Object.keys(draft.decisions).length,
      reverted: 0,
      completedAt: sentAt,
    };
    review.revision++;
    this.save(review);
    log("feedback-sent", { id: review.id, destinationPath, saved });
    return review;
  }
  private destination(review: StoredComparison): FileSnapshot {
    if (!review.targetPath)
      throw new ComparisonError(400, "This comparison has no destination");
    let current: FileSnapshot;
    try {
      current = snapshot(review.targetPath);
    } catch {
      throw new ComparisonError(
        409,
        "The destination is unavailable. Restore it before refreshing this comparison.",
      );
    }
    if (
      current.path !== review.targetPath ||
      current.version !== review.targetVersion
    )
      throw new ComparisonError(
        409,
        "The destination changed during review. Your choices are saved. Refresh the comparison before applying.",
      );
    return current;
  }
  apply(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    if (review.status === "applied") return review;
    this.requireRevision(review, body);
    if (review.mode === "compare")
      throw new ComparisonError(
        400,
        "Comparisons cannot write files; convert to a proposal first",
      );
    const changes = review.segments.filter(
      (segment) => segment.kind === "change",
    );
    if (changes.some((segment) => segment.decision === "pending"))
      throw new ComparisonError(
        409,
        "Choose what to do with every change before applying, or finish without applying",
      );
    const current = this.destination(review);
    const output = review.segments
      .map((segment) =>
        segment.decision === "before" ? segment.before : segment.after,
      )
      .join("");
    const completion: ComparisonCompletion = {
      fileWritten: output !== current.text,
      targetPath: review.targetPath,
      accepted: changes.filter((segment) => segment.decision === "after")
        .length,
      reverted:
        review.mode === "applied"
          ? changes.filter((segment) => segment.decision === "before").length
          : 0,
      completedAt: new Date().toISOString(),
    };
    if (completion.fileWritten) {
      review.pendingApply = { outputHash: hash(output), completion };
      this.save(review);
      try {
        atomicWrite(
          current.path,
          output,
          current.mode,
          () => {
            this.destination(review);
          },
          true,
        );
      } catch (error) {
        delete review.pendingApply;
        this.save(review);
        throw error;
      }
    }
    delete review.pendingApply;
    review.status = "applied";
    review.completion = completion;
    review.revision++;
    this.save(review);
    log("applied", { id: review.id, ...completion });
    return review;
  }
  complete(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    if (review.status === "completed") return review;
    this.requireRevision(review, body);
    review.status = "completed";
    review.completion = {
      fileWritten: false,
      targetPath: review.targetPath,
      accepted: 0,
      reverted: 0,
      completedAt: new Date().toISOString(),
    };
    review.revision++;
    this.save(review);
    log("completed", {
      id: review.id,
      targetPath: review.targetPath,
      fileWritten: false,
    });
    return review;
  }
  refresh(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    this.requireRevision(review, body);
    if (!review.targetPath)
      throw new ComparisonError(
        400,
        "Comparisons have frozen snapshots and no destination to refresh",
      );
    const current = snapshot(review.targetPath);
    if (current.path !== review.targetPath)
      throw new ComparisonError(
        409,
        "The destination now points to a different file. Create a new comparison with the intended destination.",
      );
    const beforeText =
      review.mode === "proposal" ? current.text : review.beforeText;
    const afterText =
      review.mode === "applied" ? current.text : review.afterText;
    const oldSegments = new Map(
      review.segments.map((segment) => [segment.id, segment]),
    );
    review.segments = comparisonSegments(beforeText, afterText).map(
      (segment) => {
        const old = oldSegments.get(segment.id);
        return old &&
          old.before === segment.before &&
          old.after === segment.after
          ? { ...segment, decision: old.decision, comment: old.comment }
          : segment;
      },
    );
    // Keep feedback even if a changed source block no longer has an anchor.
    // The rendered view presents these threads as document feedback.
    const surviving = new Set(review.segments.map((segment) => segment.id));
    for (const segment of oldSegments.values()) {
      const id = `legacy:${segment.id}`;
      if (
        segment.comment &&
        !surviving.has(segment.id) &&
        !review.reviewComments.some((comment) => comment.id === id)
      )
        review.reviewComments.push({
          id,
          changeId: segment.id,
          content: segment.comment,
          createdAt: new Date().toISOString(),
          scope: "document",
        });
    }
    review.beforeText = beforeText;
    review.afterText = afterText;
    review.targetVersion = current.version;
    review.revision++;
    this.save(review);
    log("refreshed", {
      id: review.id,
      pending: review.segments.filter(
        (segment) =>
          segment.kind === "change" && segment.decision === "pending",
      ).length,
    });
    return review;
  }
  convert(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    this.requireRevision(review, body);
    if (review.mode !== "compare")
      throw new ComparisonError(
        400,
        "Only comparisons can be converted to proposals",
      );
    return this.create({
      mode: "proposal",
      targetPath: stringField(body, "targetPath"),
      beforeText: review.beforeText,
      afterText: review.afterText,
      beforeLabel: review.beforeLabel,
      afterLabel: review.afterLabel,
      title: review.title,
    });
  }
}

export function comparisonRouter(directory: string): Router {
  const router = Router();
  const store = new ComparisonStore(directory);
  const handle =
    (action: (request: Request, response: Response) => void) =>
    (req: Request, res: Response) => {
      try {
        action(req, res);
      } catch (error) {
        const status = error instanceof ComparisonError ? error.status : 500;
        const message =
          error instanceof Error
            ? error.message
            : "Comparison operation failed";
        log(status === 409 ? "conflict" : "error", {
          status,
          message,
          comparisonId: req.params.id,
        });
        res.status(status).json({ error: message });
      }
    };
  const load = (req: Request) => store.load(String(req.params.id));
  router.post(
    "/",
    handle((req, res) => {
      res.status(201).json(store.view(store.create(objectBody(req.body))));
    }),
  );
  router.post(
    "/document",
    handle((req, res) => {
      res
        .status(201)
        .json(store.view(store.openDocument(objectBody(req.body))));
    }),
  );
  router.get(
    "/:id/destination",
    handle((req, res) => {
      const filename = req.query.path;
      if (filename !== undefined && typeof filename !== "string")
        throw new ComparisonError(400, "path must be a string");
      res.json(store.inspect(load(req), filename));
    }),
  );
  router.post(
    "/:id/draft",
    handle((req, res) => {
      res.json(store.view(store.recoverDraft(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/save",
    handle((req, res) => {
      res.json(store.view(store.saveDraft(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/send",
    handle((req, res) => {
      res.json(store.view(store.sendFeedback(load(req), objectBody(req.body))));
    }),
  );
  router.get(
    "/:id",
    handle((req, res) => {
      res.json(store.view(load(req)));
    }),
  );
  router.post(
    "/:id/decisions",
    handle((req, res) => {
      res.json(store.view(store.decisions(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/apply",
    handle((req, res) => {
      res.json(store.view(store.apply(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/complete",
    handle((req, res) => {
      res.json(store.view(store.complete(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/refresh",
    handle((req, res) => {
      res.json(store.view(store.refresh(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/convert",
    handle((req, res) => {
      res
        .status(201)
        .json(store.view(store.convert(load(req), objectBody(req.body))));
    }),
  );
  return router;
}
