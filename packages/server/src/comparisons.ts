import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { diffLines } from "diff";
import { Router, type Request, type Response } from "express";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import {
  atomicWrite,
  FileChangedError,
  syncDirectory,
  syncExistingFile,
} from "./atomic-write.js";

export type ComparisonMode = "proposal" | "applied" | "compare" | "document";
export type ComparisonDecision = "pending" | "before" | "after";
type BaseVersion = "old" | "new";
type BaseOptions = Record<BaseVersion, string | null>;
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
  baseVersion?: BaseVersion | null;
  baseOptions?: BaseOptions;
  feedback?: EditorFeedback | null;
}
interface StoredComparison extends Omit<Comparison, "targetChanged"> {
  targetVersion: string | null;
  pendingApply?: { outputHash: string; completion: ComparisonCompletion };
  destinationVersion?: string | null;
  baseInputVersions?: Record<BaseVersion, string | null>;
  pendingSave?: {
    path: string;
    draft: EditorDraft;
    reviewComments: ComparisonReviewComment[];
    baseVersion?: BaseVersion;
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
function snapshot(filename: string, root?: string): FileSnapshot {
  try {
    const realPath = fs.realpathSync(path.resolve(filename));
    enforceDocumentRoot(root, filename, realPath);
    if (root && path.extname(realPath).toLowerCase() !== ".md")
      throw new ComparisonError(400, "The destination must be a Markdown file");
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
function containsReviewMarkup(markdown: string): boolean {
  // Code snippets that show CriticMarkup syntax are ordinary Markdown. Use
  // the same scanner as the review index to distinguish them from annotations.
  return Boolean(
    /\{(?:[+\-~=]{2}|>>)|^(?:comments|suggestions):/m.test(markdown) &&
      extractRoughdraftReviewIndex(markdown).items.length,
  );
}
function assertPlainMarkdown(markdown: string): void {
  if (containsReviewMarkup(markdown))
    throw new ComparisonError(
      400,
      "The file text must exclude pending suggestions and review comments",
    );
}
function outsideRoot(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}
function enforceDocumentRoot(
  root: string | undefined,
  filename: string,
  resolved?: string,
): void {
  if (!root) return;
  const requested = path.resolve(filename);
  const actualRoot = fs.realpathSync(root);
  // Stored paths are canonical. Accept both root spellings when a hosted
  // installation configured an alias for its document directory.
  if (
    (outsideRoot(path.resolve(root), requested) &&
      outsideRoot(actualRoot, requested)) ||
    (resolved && outsideRoot(actualRoot, resolved))
  )
    throw new ComparisonError(
      403,
      "Choose a Markdown file inside the document directory",
    );
}
function createFile(
  filename: string,
  text: string,
  validate: () => void,
): void {
  // Publish a new file without replacing anything that raced the last check.
  // Stage in the same directory, fsync the data, then link it into place.
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    validate();
    try {
      fs.linkSync(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ComparisonError(
          409,
          "The destination changed on disk. Choose a different file.",
        );
      throw error;
    }
  } finally {
    fs.unlinkSync(temporary);
  }
  syncDirectory(directory);
}
function inspectDestination(
  filename: string,
  root?: string,
): {
  path: string;
  current: FileSnapshot | null;
} {
  if (
    !path.isAbsolute(filename) ||
    path.extname(filename).toLowerCase() !== ".md"
  )
    throw new ComparisonError(400, "Choose an absolute path ending in .md");
  enforceDocumentRoot(root, filename);
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
  enforceDocumentRoot(root, filename, candidate);
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: candidate, current: null };
    throw error;
  }
  const current = snapshot(candidate, root);
  if (path.extname(current.path).toLowerCase() !== ".md")
    throw new ComparisonError(400, "The destination must be a Markdown file");
  return { path: current.path, current };
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
  private lastFeedbackTime = 0;

  constructor(
    private directory: string,
    private options: {
      allowFileBindMountWrites?: boolean;
      documentRoot?: string;
    } = {},
  ) {}
  private inspectDestination(filename: string) {
    return inspectDestination(filename, this.options.documentRoot);
  }
  private sourceSnapshot(filename: string): FileSnapshot {
    if (!this.options.documentRoot) return snapshot(filename);
    const { current } = this.inspectDestination(filename);
    if (!current) throw new ComparisonError(400, "Markdown file not found");
    return current;
  }
  private filename(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new ComparisonError(404, "Comparison not found");
    return path.join(this.directory, `${id}.json`);
  }
  private watchChildren(id: string): string {
    return path.join(this.directory, `watch-${id}`);
  }
  watch(id: string): StoredComparison {
    const root = this.load(id);
    if (root.editor !== "unified") return root;
    let latest = root;
    const seen = new Set<string>();
    const pending = [id];
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const review = next === id ? root : this.loadIndexedReview(next);
      if (!review) continue;
      if (
        review.feedback &&
        review.feedback.sentAt > (latest.feedback?.sentAt ?? "")
      )
        latest = review;
      try {
        for (const child of fs.readdirSync(this.watchChildren(next)))
          pending.push(child);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return latest;
  }
  private documentIndex(filename: string, pending = false): string {
    return path.join(
      this.directory,
      `document-${hash(filename)}.${pending ? "pending" : "index"}`,
    );
  }
  private isDocumentMove(review: StoredComparison, filename: string): boolean {
    return review.mode === "document" && review.destinationPath !== filename;
  }
  private indexOwner(index: string): string | null {
    try {
      return fs.readFileSync(index, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private loadIndexedReview(owner: string | null): StoredComparison | null {
    if (!owner) return null;
    try {
      return this.load(owner);
    } catch (error) {
      if (error instanceof ComparisonError && error.status === 404) return null;
      throw error;
    }
  }
  private clearDocumentMove(filename: string, owner: string): void {
    const pending = this.documentIndex(filename, true);
    if (this.indexOwner(pending) === owner) fs.rmSync(pending, { force: true });
  }
  private recoverDocumentMove(filename: string): void {
    const pending = this.documentIndex(filename, true);
    const owner = this.indexOwner(pending);
    if (!owner) return;
    // The provisional pointer allows recovery by filename before the active
    // index has moved. Recovery never republishes any Markdown bytes.
    this.loadIndexedReview(owner);
    this.clearDocumentMove(filename, owner);
  }
  private save(review: StoredComparison): void {
    const firstCreated = fs.mkdirSync(this.directory, {
      recursive: true,
      mode: 0o700,
    });
    if (firstCreated) {
      const existingParent = path.dirname(path.resolve(firstCreated));
      for (
        let directory = path.resolve(this.directory);
        ;
        directory = path.dirname(directory)
      ) {
        syncDirectory(directory);
        if (directory === existingParent) break;
      }
    }
    atomicWrite(this.filename(review.id), `${JSON.stringify(review)}\n`);
  }
  private readReview(id: string): StoredComparison {
    const filename = this.filename(id);
    if (!fs.existsSync(filename))
      throw new ComparisonError(404, "Comparison not found");
    const review = JSON.parse(
      fs.readFileSync(filename, "utf8"),
    ) as StoredComparison;
    review.reviewComments ??= [];
    return review;
  }
  load(id: string): StoredComparison {
    const review = this.readReview(id);
    // An intent makes a retry safe if the process stopped after rename but before
    // recording completion. Never replay a write during recovery.
    if (review.pendingApply && review.targetPath) {
      let wroteExpectedOutput = false;
      try {
        wroteExpectedOutput =
          hash(this.sourceSnapshot(review.targetPath).text) ===
          review.pendingApply.outputHash;
      } catch {
        /* Missing/changed destinations stay open and conflicted. */
      }
      if (wroteExpectedOutput) {
        syncExistingFile(review.targetPath);
        review.status = "applied";
        review.completion = review.pendingApply.completion;
        review.revision++;
      }
      delete review.pendingApply;
      this.save(review);
      if (wroteExpectedOutput) {
        log("recovered", {
          id: review.id,
          fileWritten: review.completion?.fileWritten,
        });
      }
    }
    if (review.pendingSave) {
      const intent = review.pendingSave;
      let current: FileSnapshot | null = null;
      try {
        current = this.sourceSnapshot(intent.path);
      } catch {
        /* Recovery never writes to an unavailable or changed destination. */
      }
      const moving = this.isDocumentMove(review, intent.path);
      if (
        current?.path === intent.path &&
        current.text === cleanDraft(intent.draft) &&
        (!moving ||
          this.indexOwner(this.documentIndex(intent.path, true)) === review.id)
      ) {
        syncExistingFile(current.path);
        this.finishSave(
          review,
          intent.draft,
          intent.reviewComments,
          current,
          intent.baseVersion,
        );
        log("draft-save-recovered", {
          id: review.id,
          destinationPath: current.path,
        });
      } else {
        // A crash before the write (or an external edit afterward) must not
        // lose the draft from the Save request. Never mark it saved blindly.
        // A failed comparison copy may contain a different reference seed.
        // An untitled document can always recover its annotations in place.
        if (!intent.baseVersion || review.mode === "document")
          review.draft = intent.draft;
        review.reviewComments = intent.reviewComments;
        review.revision++;
        delete review.pendingSave;
        this.save(review);
        if (moving) this.clearDocumentMove(intent.path, review.id);
      }
    }
    return review;
  }
  view(review: StoredComparison): Comparison {
    const {
      targetVersion,
      destinationVersion,
      baseInputVersions: _baseInputVersions,
      pendingApply: _pendingApply,
      pendingSave: _pendingSave,
      ...result
    } = review;
    let targetChanged = false;
    const filename =
      review.editor === "unified" ? review.destinationPath : review.targetPath;
    if (filename && (review.editor === "unified" || review.status === "open")) {
      try {
        const current = this.sourceSnapshot(filename);
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
    const { path: filename, current: disk } =
      this.inspectDestination(targetPath);
    this.recoverDocumentMove(filename);
    const index = this.documentIndex(filename);
    const current = this.loadIndexedReview(this.indexOwner(index));
    if (current?.mode === "document" && current.destinationPath === filename) {
      const draft = current.draft;
      const hasWork =
        current.feedback ||
        current.reviewComments.length ||
        (draft &&
          (cleanDraft(draft) !== current.savedText ||
            containsReviewMarkup(draft.markdown)));
      // Opening the source again should show external changes if there is
      // no unfinished draft or feedback to protect. Existing links stay valid.
      if (!disk || disk.version === current.destinationVersion || hasWork)
        return current;
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
        ? this.inspectDestination(targetInput).current
        : this.sourceSnapshot(targetInput)
      : null;
    if (targetInput && !target)
      throw new ComparisonError(404, "Markdown file not found");
    const beforePath = stringField(body, "beforePath");
    const afterPath = stringField(body, "afterPath");
    const explicitBefore = stringField(body, "beforeText");
    const explicitAfter = stringField(body, "afterText");
    const beforeFile =
      beforePath && (explicitBefore === undefined || editor === "unified")
        ? this.sourceSnapshot(beforePath)
        : null;
    const afterFile =
      afterPath && (explicitAfter === undefined || editor === "unified")
        ? this.sourceSnapshot(afterPath)
        : null;
    const beforeText =
      mode === "document"
        ? ""
        : (explicitBefore ??
          beforeFile?.text ??
          (mode === "proposal" ? target?.text : undefined));
    const afterText =
      mode === "document"
        ? (target?.text ?? "")
        : (explicitAfter ??
          afterFile?.text ??
          (mode === "applied" ? target?.text : undefined));
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
    const selectable = (file: FileSnapshot | null, text: string) =>
      file?.text === text && path.extname(file.path).toLowerCase() === ".md"
        ? file
        : null;
    const old = selectable(
      mode === "proposal"
        ? target
        : mode === "compare" ||
            (mode === "applied" && beforeFile?.path !== target?.path)
          ? beforeFile
          : null,
      beforeText,
    );
    const newer = selectable(
      mode === "applied" ? target : afterFile,
      afterText,
    );
    // A candidate that aliases the original path cannot be a second writable
    // input. Which version would be overwritten would otherwise be ambiguous.
    const newInput = newer?.path === old?.path ? null : newer;
    const initial = mode === "document" ? target : null;
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
            destinationPath: initial?.path ?? null,
            destinationVersion: initial?.version ?? null,
            savedPath: initial?.path ?? null,
            savedText: initial?.text ?? null,
            baseVersion: null,
            baseOptions: {
              old: old?.path ?? null,
              new: newInput?.path ?? null,
            },
            baseInputVersions: {
              old: old?.version ?? null,
              new: newInput?.version ?? null,
            },
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
  private requireEditorRevision(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): void {
    this.requireEditor(review);
    if (body.revision !== review.revision)
      throw new ComparisonError(
        409,
        "This draft changed in another browser. Reload the saved draft before continuing.",
      );
  }
  private editorUpdate(
    review: StoredComparison,
    body: Record<string, unknown>,
  ) {
    this.requireEditorRevision(review, body);
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
    const { path: inspected, current } = this.inspectDestination(requested);
    return {
      path: inspected,
      version: current?.version ?? null,
      markdown: current?.text ?? null,
    };
  }
  chooseBase(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    this.requireEditorRevision(review, body);
    const choice = body.choice;
    if (choice !== "old" && choice !== "new" && choice !== "copy")
      throw new ComparisonError(
        400,
        "Choose the old file, new file, or a copy",
      );
    if (review.destinationPath)
      throw new ComparisonError(
        409,
        "This review already has a base file. Use Save As to change it.",
      );
    if (
      choice === "copy" &&
      body.seed !== undefined &&
      body.seed !== "old" &&
      body.seed !== "new"
    )
      throw new ComparisonError(
        400,
        "A copy must start from the old or new version",
      );
    const baseVersion =
      choice === "copy" ? (body.seed === "new" ? "new" : "old") : choice;
    const seed = baseVersion === "old" ? review.beforeText : review.afterText;
    const draft =
      body.markdown === undefined
        ? { markdown: seed, decisions: {} }
        : draftField(body);
    const reviewComments =
      reviewCommentsField(body.reviewComments, review, true) ??
      review.reviewComments;
    const text = cleanDraft(draft);
    if (text !== seed) {
      if (!containsReviewMarkup(seed))
        throw new ComparisonError(
          400,
          "The draft must match the selected version before editing it",
        );
      assertPlainMarkdown(text);
    }
    if (choice === "copy") {
      const filename = stringField(body, "path");
      if (!filename)
        throw new ComparisonError(400, "Choose a path for the copy");
      const selected = this.inspectDestination(filename);
      if (selected.current)
        throw new ComparisonError(
          409,
          "A file already exists at that path. Choose a different file.",
        );
      assertPlainMarkdown(text);
      return this.publishDraft(
        review,
        draft,
        reviewComments,
        filename,
        selected.path,
        null,
        baseVersion,
      );
    }
    const filename = review.baseOptions?.[choice];
    const version = review.baseInputVersions?.[choice];
    if (!filename || !version)
      throw new ComparisonError(
        400,
        "This version is a snapshot. Choose a copy to edit it.",
      );
    let current: FileSnapshot | null;
    try {
      current = this.inspectDestination(filename).current;
    } catch {
      current = null;
    }
    if (
      current?.path !== filename ||
      current.version !== version ||
      current.text !== seed
    )
      throw new ComparisonError(
        409,
        "The selected file changed on disk. Choose a copy or open a new review.",
      );
    review.baseVersion = baseVersion;
    this.recordSave(review, draft, reviewComments, current);
    this.save(review);
    return review;
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
    review.savedText = current.text;
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
    const { path: resolved, current } = this.inspectDestination(filename);
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

    if (
      current?.text === cleanDraft(draft) &&
      !this.isDocumentMove(review, resolved)
    ) {
      this.recordSave(review, draft, reviewComments, current);
      this.save(review);
      return review;
    }
    assertPlainMarkdown(cleanDraft(draft));
    return this.publishDraft(
      review,
      draft,
      reviewComments,
      filename,
      resolved,
      current,
    );
  }
  forkDraft(id: string, body: Record<string, unknown>): StoredComparison {
    // Read only: a stale tab's copy must never update the shared review, even
    // if an earlier request on that review is still awaiting recovery.
    const review = this.readReview(id);
    this.requireEditor(review);
    const filename = stringField(body, "path");
    if (!filename) throw new ComparisonError(400, "Choose a path for the copy");
    const expectedVersion = body.expectedVersion;
    if (expectedVersion !== null && typeof expectedVersion !== "string")
      throw new ComparisonError(
        400,
        "Inspect the destination before saving to it",
      );
    const selectedSide = body.baseVersion;
    if (
      selectedSide !== undefined &&
      selectedSide !== null &&
      selectedSide !== "old" &&
      selectedSide !== "new"
    )
      throw new ComparisonError(400, "baseVersion must be old, new, or null");
    const { path: resolved, current } = this.inspectDestination(filename);
    if (
      [review.destinationPath, review.pendingSave?.path].some(
        (active) => active === resolved || active === path.resolve(filename),
      )
    )
      throw new ComparisonError(409, "Choose a different file for the copy");
    if (expectedVersion !== (current?.version ?? null))
      throw new ComparisonError(
        409,
        "The destination changed on disk. Inspect it or choose another file.",
      );
    const draft = draftField(body);
    assertPlainMarkdown(cleanDraft(draft));
    const comments =
      reviewCommentsField(body.reviewComments, review, true) ?? [];
    const fork: StoredComparison = {
      id: crypto.randomUUID(),
      revision: 1,
      mode: review.mode,
      title: review.title,
      beforeLabel: review.beforeLabel,
      afterLabel: review.afterLabel,
      beforeText: review.beforeText,
      afterText: review.afterText,
      targetPath: review.targetPath,
      targetVersion: review.targetVersion,
      segments: review.segments,
      editor: "unified",
      baseVersion:
        selectedSide === undefined
          ? (review.baseVersion ?? null)
          : selectedSide,
      baseOptions: review.baseOptions,
      baseInputVersions: review.baseInputVersions,
      destinationPath: null,
      destinationVersion: null,
      savedPath: null,
      savedText: null,
      feedback: null,
      comment: "",
      reviewComments: comments,
      draft,
      status: "open",
      completion: null,
    };
    // Register the copy before publishing it so a restart cannot strand a
    // watch. Failed or incomplete copies have no readable review to report.
    const children = this.watchChildren(review.id);
    if (fs.mkdirSync(children, { recursive: true, mode: 0o700 }))
      syncDirectory(this.directory);
    atomicWrite(path.join(children, fork.id), "");
    return this.publishDraft(
      fork,
      draft,
      comments,
      filename,
      resolved,
      current,
    );
  }
  private publishDraft(
    review: StoredComparison,
    draft: EditorDraft,
    reviewComments: ComparisonReviewComment[],
    filename: string,
    resolved: string,
    current: FileSnapshot | null,
    baseVersion?: BaseVersion,
  ): StoredComparison {
    const errorMessage =
      "The destination changed on disk. Inspect it or use Save As to save somewhere else.";
    const verify = () => {
      const latest = this.inspectDestination(filename);
      if (
        latest.path !== resolved ||
        (latest.current?.version ?? null) !== (current?.version ?? null)
      )
        throw new ComparisonError(409, errorMessage);
    };
    const text = cleanDraft(draft);
    const moving = this.isDocumentMove(review, resolved);
    if (moving) this.recoverDocumentMove(resolved);
    review.pendingSave = { path: resolved, draft, reviewComments, baseVersion };
    this.save(review);
    if (moving) atomicWrite(this.documentIndex(resolved, true), review.id);
    try {
      if (current?.text === text) verify();
      else if (current)
        atomicWrite(resolved, text, {
          mode: current.mode,
          beforePublish: verify,
          allowBusyFallback: this.options.allowFileBindMountWrites,
        });
      else createFile(resolved, text, verify);
    } catch (error) {
      if (
        error instanceof FileChangedError ||
        (error instanceof ComparisonError && error.status === 409)
      ) {
        delete review.pendingSave;
        this.save(review);
        if (moving) this.clearDocumentMove(resolved, review.id);
        throw new ComparisonError(409, errorMessage);
      }
      // An I/O failure can occur either before or after publication. Leave the
      // durable intent so the next read can recover without rewriting a file.
      throw error;
    }
    const saved = this.sourceSnapshot(resolved);
    if (saved.path !== resolved || saved.text !== text)
      throw new ComparisonError(409, errorMessage);
    this.finishSave(review, draft, reviewComments, saved, baseVersion);
    log("draft-saved", { id: review.id, destinationPath: resolved });
    return review;
  }
  private finishSave(
    review: StoredComparison,
    draft: EditorDraft,
    reviewComments: ComparisonReviewComment[],
    saved: FileSnapshot,
    baseVersion?: BaseVersion,
  ): void {
    const moving = this.isDocumentMove(review, saved.path);
    // Keep the intent until the new filename can find the review. The old
    // filename's pointer no longer matches and will get a fresh review on open.
    if (moving) atomicWrite(this.documentIndex(saved.path), review.id);
    if (baseVersion) review.baseVersion = baseVersion;
    this.recordSave(review, draft, reviewComments, saved);
    delete review.pendingSave;
    this.save(review);
    if (moving) this.clearDocumentMove(saved.path, review.id);
  }
  sendFeedback(
    review: StoredComparison,
    body: Record<string, unknown>,
  ): StoredComparison {
    const { draft, reviewComments } = this.editorUpdate(review, body);
    const comment = stringField(body, "comment") ?? review.comment;
    // Two sends in the same millisecond must still be distinguishable to a watcher.
    const previousTime = Date.parse(review.feedback?.sentAt ?? "") || 0;
    this.lastFeedbackTime = Math.max(
      Date.now(),
      previousTime + 1,
      this.lastFeedbackTime + 1,
    );
    const sentAt = new Date(this.lastFeedbackTime).toISOString();
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
          : review.baseVersion === "old"
            ? { label: review.afterLabel, markdown: review.afterText }
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
      current = this.sourceSnapshot(review.targetPath);
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
      // The intent is durable before publication. Preserve it on failure:
      // recovery inspects the destination and never replays an uncertain write.
      atomicWrite(current.path, output, {
        mode: current.mode,
        allowBusyFallback: this.options.allowFileBindMountWrites,
        beforePublish: () => {
          this.destination(review);
        },
      });
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
    const current = this.sourceSnapshot(review.targetPath);
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

export function comparisonRouter(
  directory: string,
  options: { allowFileBindMountWrites?: boolean; documentRoot?: string } = {},
): Router {
  const router = Router();
  const store = new ComparisonStore(directory, options);
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
    "/:id/watch",
    handle((req, res) => {
      res.json(store.view(store.watch(String(req.params.id))));
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
    "/:id/base",
    handle((req, res) => {
      res.json(store.view(store.chooseBase(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/save",
    handle((req, res) => {
      res.json(store.view(store.saveDraft(load(req), objectBody(req.body))));
    }),
  );
  router.post(
    "/:id/fork",
    handle((req, res) => {
      res
        .status(201)
        .json(
          store.view(
            store.forkDraft(String(req.params.id), objectBody(req.body)),
          ),
        );
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
