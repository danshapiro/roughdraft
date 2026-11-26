import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logServerEvent } from "./diagnostics.js";

export interface WatchedDocumentSnapshot {
  path: string;
  resolvedPath: string | null;
  exists: boolean;
  text: string | null;
  version: string | null;
  hash: string | null;
  mode: number | null;
  mtimeMs?: number;
  size?: number;
  availability: "available" | "missing" | "unreadable" | "unobservable";
  error?: string;
  generation: number;
  observedAt: number;
}
export interface DocumentWatchEvent {
  path: string;
  snapshot: WatchedDocumentSnapshot;
  reason: "changed" | "missing" | "unreadable" | "unobservable";
  generation: number;
  operationId?: string;
}
type Listener = (event: DocumentWatchEvent) => void;
interface DirectoryWatch {
  paths: Set<string>;
  identity: string | null;
  retryAt: number;
  watcher?: {
    close(): void;
    on?(event: "error", listener: (error: Error) => void): unknown;
  };
}
interface Entry {
  path: string;
  snapshot: WatchedDocumentSnapshot;
  identity: string | null;
  listeners: Set<Listener>;
  directories: Set<string>;
  leaseUntil: number;
  firstEvent: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
  followUp: boolean;
  publications: Set<string>;
  operation?: { id: string; expectedVersion?: string | null };
  lastChecked: number;
  degraded: boolean;
}
interface Candidate {
  snapshot: WatchedDocumentSnapshot;
  identity: string | null;
}
export interface DocumentWatcherOptions {
  coalesceMs?: number;
  maxWaitMs?: number;
  stabilityMs?: number;
  leaseMs?: number;
  sweepMs?: number;
  consistencyMs?: number;
  degradedConsistencyMs?: number;
  unobservablePaths?: readonly string[];
  watchDirectory?: (
    directory: string,
    listener: (event: string, filename: string | null) => void,
  ) => NonNullable<DirectoryWatch["watcher"]>;
}
function log(
  event: string,
  fields: Record<string, unknown>,
  severity: "info" | "warn" | "error" = "info",
) {
  logServerEvent("server/document-watchers", event, fields, severity);
}
function sameStat(a: fs.Stats, b: fs.Stats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function equalSnapshot(a: WatchedDocumentSnapshot, b: WatchedDocumentSnapshot) {
  return (
    a.version === b.version &&
    a.resolvedPath === b.resolvedPath &&
    a.availability === b.availability &&
    a.error === b.error &&
    a.mode === b.mode
  );
}
function emptySnapshot(filename: string): WatchedDocumentSnapshot {
  return {
    path: filename,
    resolvedPath: null,
    exists: false,
    text: null,
    version: null,
    hash: null,
    mode: null,
    availability: "missing",
    generation: 0,
    observedAt: Date.now(),
  };
}
class ChangingFile extends Error {}

/** One cache and one OS watch per active parent, shared by SSE and short-request leases. */
export class DocumentWatcherRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly directories = new Map<string, DirectoryWatch>();
  private readonly unobservable: Set<string>;
  private readonly mountPoints: Set<string>;
  private readonly options: Required<
    Omit<DocumentWatcherOptions, "unobservablePaths" | "watchDirectory">
  >;
  private readonly watchDirectory: NonNullable<
    DocumentWatcherOptions["watchDirectory"]
  >;
  private sweeper: ReturnType<typeof setInterval> | null;
  private closed = false;
  private reads = 0;
  private hashes = 0;
  private generation = 0;

  constructor(options: DocumentWatcherOptions = {}) {
    this.options = {
      coalesceMs: options.coalesceMs ?? 75,
      maxWaitMs: options.maxWaitMs ?? 250,
      stabilityMs: options.stabilityMs ?? 50,
      leaseMs: options.leaseMs ?? 5000,
      sweepMs: options.sweepMs ?? 250,
      consistencyMs: options.consistencyMs ?? 5000,
      degradedConsistencyMs: options.degradedConsistencyMs ?? 1000,
    };
    this.unobservable = new Set(
      (options.unobservablePaths ?? []).map((p) => path.resolve(p)),
    );
    this.mountPoints = this.readMountPoints();
    this.watchDirectory =
      options.watchDirectory ??
      ((directory, listener) =>
        fs.watch(directory, { persistent: false }, (event, filename) =>
          listener(event, filename?.toString() ?? null),
        ));
    this.sweeper = setInterval(() => this.sweep(), this.options.sweepMs);
    this.sweeper.unref?.();
  }

  /** Cache-only after first prime. An un-subscribed read keeps a bounded five-second lease. */
  get(filename: string): WatchedDocumentSnapshot {
    const entry = this.ensure(filename);
    if (!entry.listeners.size)
      entry.leaseUntil = Date.now() + this.options.leaseMs;
    return entry.snapshot;
  }
  peek(filename: string): WatchedDocumentSnapshot | undefined {
    return this.entries.get(path.resolve(filename))?.snapshot;
  }
  lease(filenames: readonly string[], durationMs = this.options.leaseMs): void {
    const until = Date.now() + Math.min(Math.max(durationMs, 0), 30_000);
    for (const filename of new Set(filenames.map((p) => path.resolve(p))))
      this.ensure(filename).leaseUntil = Math.max(
        this.ensure(filename).leaseUntil,
        until,
      );
  }
  subscribe(filenames: readonly string[], listener: Listener): () => void {
    const subscribed: Entry[] = [];
    for (const filename of new Set(filenames.map((p) => path.resolve(p)))) {
      const entry = this.ensure(filename);
      entry.listeners.add(listener);
      subscribed.push(entry);
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      for (const entry of subscribed) {
        entry.listeners.delete(listener);
        this.releaseInactive(entry);
      }
    };
  }
  invalidate(filename: string): void {
    const entry = this.entries.get(path.resolve(filename));
    if (entry) this.schedule(entry);
  }
  beginPublication(
    filenames: readonly string[],
    operationId: string,
  ): (expectedVersions?: Record<string, string | null>) => void {
    const entries = [...new Set(filenames.map((p) => path.resolve(p)))].map(
      (p) => this.ensure(p),
    );
    for (const entry of entries) entry.publications.add(operationId);
    let released = false;
    return (expectedVersions) => {
      if (released) return;
      released = true;
      for (const entry of entries) {
        entry.publications.delete(operationId);
        entry.operation = {
          id: operationId,
          expectedVersion: expectedVersions?.[entry.path],
        };
        this.schedule(entry);
      }
    };
  }
  diagnostics() {
    return {
      paths: this.entries.size,
      directories: this.directories.size,
      watchers: [...this.directories.values()].filter((d) => d.watcher).length,
      listeners: [...this.entries.values()].reduce(
        (sum, e) => sum + e.listeners.size,
        0,
      ),
      leases: [...this.entries.values()].filter(
        (e) => e.leaseUntil > Date.now(),
      ).length,
      timers:
        (this.sweeper ? 1 : 0) +
        [...this.entries.values()].filter((e) => e.timer).length,
      degraded: [...this.entries.values()].filter((e) => e.degraded).length,
      reads: this.reads,
      hashes: this.hashes,
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const entry of [...this.entries.values()]) this.remove(entry);
    for (const directory of this.directories.values())
      directory.watcher?.close();
    this.directories.clear();
  }

  private ensure(filename: string): Entry {
    if (this.closed) throw new Error("Document watchers are closed");
    const normalized = path.resolve(filename);
    const existing = this.entries.get(normalized);
    if (existing) return existing;
    const entry: Entry = {
      path: normalized,
      snapshot: emptySnapshot(normalized),
      identity: null,
      listeners: new Set(),
      directories: new Set(),
      leaseUntil: 0,
      firstEvent: null,
      timer: null,
      reading: false,
      followUp: false,
      publications: new Set(),
      lastChecked: Date.now(),
      degraded: false,
    };
    this.entries.set(normalized, entry);
    // Install the parent watch before reading, so replacement during the initial snapshot isn't missed.
    this.addDirectory(entry, path.dirname(normalized));
    try {
      const candidate = this.readSync(normalized);
      entry.snapshot = candidate.snapshot;
      entry.identity = candidate.identity;
    } catch (error) {
      entry.snapshot = this.failure(normalized, error);
      this.schedule(entry);
    }
    this.trackResolvedParent(entry);
    return entry;
  }
  private directoryIdentity(directory: string): string | null {
    try {
      const stat = fs.statSync(directory);
      return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
    } catch {
      return null;
    }
  }
  private degradedDirectory(
    directory: string,
    shared: DirectoryWatch,
    message: string,
  ) {
    shared.watcher?.close();
    shared.watcher = undefined;
    shared.retryAt = Date.now() + this.options.degradedConsistencyMs;
    for (const filename of shared.paths) {
      const entry = this.entries.get(filename);
      if (entry) {
        entry.degraded = true;
        this.schedule(entry);
      }
    }
    log("watch.degraded", { directory, message }, "warn");
  }
  private openDirectory(directory: string, shared: DirectoryWatch) {
    const restoring = shared.retryAt > 0;
    shared.retryAt = Date.now() + this.options.degradedConsistencyMs;
    try {
      const identity = this.directoryIdentity(directory);
      if (!identity) throw new Error("The watched directory is unavailable");
      shared.identity = identity;
      shared.watcher = this.watchDirectory(directory, (event, filename) => {
        if (
          event === "rename" &&
          (filename === path.basename(directory) ||
            this.directoryIdentity(directory) !== shared.identity)
        ) {
          this.degradedDirectory(
            directory,
            shared,
            "The watched directory changed",
          );
          return;
        }
        for (const filenamePath of shared.paths) {
          const entry = this.entries.get(filenamePath);
          if (!entry) continue;
          if (
            filename === null ||
            (path.dirname(entry.path) === directory &&
              path.basename(entry.path) === filename) ||
            (entry.snapshot.resolvedPath &&
              path.dirname(entry.snapshot.resolvedPath) === directory &&
              path.basename(entry.snapshot.resolvedPath) === filename)
          )
            this.schedule(entry);
        }
      });
      shared.watcher.on?.("error", (error) =>
        this.degradedDirectory(directory, shared, error.message),
      );
      for (const filename of shared.paths) {
        const entry = this.entries.get(filename);
        if (!entry) continue;
        entry.degraded = [...entry.directories].some(
          (parent) => !this.directories.get(parent)?.watcher,
        );
        if (restoring) this.schedule(entry);
      }
    } catch (error) {
      shared.watcher = undefined;
      log("watch.degraded", { directory, message: String(error) }, "warn");
    }
  }
  private addDirectory(entry: Entry, directory: string) {
    if (entry.directories.has(directory)) return;
    entry.directories.add(directory);
    let shared = this.directories.get(directory);
    if (!shared) {
      shared = { paths: new Set(), identity: null, retryAt: 0 };
      this.directories.set(directory, shared);
      shared.paths.add(entry.path);
      this.openDirectory(directory, shared);
    } else shared.paths.add(entry.path);
    if (!shared.watcher) entry.degraded = true;
  }
  private trackResolvedParent(entry: Entry) {
    const directories = new Set([path.dirname(entry.path)]);
    if (entry.snapshot.resolvedPath)
      directories.add(path.dirname(entry.snapshot.resolvedPath));
    for (const directory of directories) this.addDirectory(entry, directory);
    for (const directory of [...entry.directories])
      if (!directories.has(directory)) this.dropDirectory(entry, directory);
  }
  private dropDirectory(entry: Entry, directory: string) {
    entry.directories.delete(directory);
    const shared = this.directories.get(directory);
    if (!shared) return;
    shared.paths.delete(entry.path);
    if (!shared.paths.size) {
      shared.watcher?.close();
      this.directories.delete(directory);
    }
  }
  private releaseInactive(entry: Entry) {
    if (
      !entry.listeners.size &&
      entry.leaseUntil <= Date.now() &&
      !entry.publications.size
    )
      this.remove(entry);
  }
  private remove(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    for (const directory of [...entry.directories])
      this.dropDirectory(entry, directory);
    entry.listeners.clear();
    this.entries.delete(entry.path);
  }
  private sweep() {
    const now = Date.now();
    for (const [directory, shared] of this.directories)
      if (!shared.watcher && now >= shared.retryAt)
        this.openDirectory(directory, shared);
    for (const entry of [...this.entries.values()]) {
      this.releaseInactive(entry);
      if (!this.entries.has(entry.path)) continue;
      const interval = entry.degraded
        ? this.options.degradedConsistencyMs
        : this.options.consistencyMs;
      if (now - entry.lastChecked >= interval) {
        entry.lastChecked = now;
        this.schedule(entry);
      }
    }
  }
  private schedule(entry: Entry) {
    if (this.closed || this.entries.get(entry.path) !== entry) return;
    if (entry.publications.size || entry.reading) {
      entry.followUp = true;
      return;
    }
    const now = Date.now();
    entry.firstEvent ??= now;
    if (entry.timer) clearTimeout(entry.timer);
    const delay = Math.min(
      this.options.coalesceMs,
      Math.max(0, this.options.maxWaitMs - (now - entry.firstEvent)),
    );
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.firstEvent = null;
      void this.refresh(entry);
    }, delay);
    entry.timer.unref?.();
  }
  private async refresh(entry: Entry) {
    if (this.closed || this.entries.get(entry.path) !== entry) return;
    if (entry.publications.size) {
      entry.followUp = true;
      return;
    }
    entry.reading = true;
    entry.followUp = false;
    entry.lastChecked = Date.now();
    try {
      let candidate = await this.read(entry.path);
      const changesInPlace =
        entry.snapshot.exists &&
        (!candidate.snapshot.exists || candidate.identity === entry.identity) &&
        !equalSnapshot(entry.snapshot, candidate.snapshot);
      if (changesInPlace) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.options.stabilityMs);
          timer.unref?.();
        });
        const stable = await this.read(entry.path);
        if (!equalSnapshot(candidate.snapshot, stable.snapshot))
          throw new ChangingFile("Document is still changing");
        candidate = stable;
      }
      if (this.closed || this.entries.get(entry.path) !== entry) return;
      // A publication can begin while an asynchronous read is in progress.
      if (entry.publications.size) {
        entry.followUp = true;
        return;
      }
      const previous = entry.snapshot;
      entry.snapshot = {
        ...candidate.snapshot,
        generation: previous.generation,
      };
      entry.identity = candidate.identity;
      this.trackResolvedParent(entry);
      if (!equalSnapshot(previous, entry.snapshot)) {
        entry.snapshot.generation = ++this.generation;
        const event: DocumentWatchEvent = {
          path: entry.path,
          snapshot: entry.snapshot,
          generation: entry.snapshot.generation,
          reason:
            entry.snapshot.availability === "available"
              ? "changed"
              : entry.snapshot.availability,
          ...(entry.operation?.expectedVersion === entry.snapshot.version
            ? { operationId: entry.operation.id }
            : {}),
        };
        entry.operation = undefined;
        log("watch.changed", {
          path: entry.path,
          availability: entry.snapshot.availability,
          generation: entry.snapshot.generation,
        });
        for (const listener of [...entry.listeners]) {
          try {
            listener(event);
          } catch (error) {
            log(
              "watch.listener-failed",
              { path: entry.path, message: String(error) },
              "error",
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof ChangingFile) {
        entry.followUp = true;
        log("watch.unstable", { path: entry.path }, "warn");
      } else
        log(
          "watch.refresh-failed",
          { path: entry.path, message: String(error) },
          "warn",
        );
    } finally {
      entry.reading = false;
      if (entry.followUp && !entry.publications.size) {
        entry.followUp = false;
        this.schedule(entry);
      }
    }
  }
  private make(
    filename: string,
    resolvedPath: string,
    stat: fs.Stats,
    bytes: Buffer,
  ): Candidate {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new Error("File must contain UTF-8 text");
    this.hashes++;
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const unobservable =
      this.unobservable.has(filename) ||
      this.unobservable.has(resolvedPath) ||
      this.mountPoints.has(filename) ||
      this.mountPoints.has(resolvedPath);
    return {
      snapshot: {
        path: filename,
        resolvedPath,
        exists: true,
        text,
        hash,
        version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${hash}`,
        mode: stat.mode & 0o7777,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        availability: unobservable ? "unobservable" : "available",
        ...(unobservable
          ? {
              error:
                "External changes cannot be observed for this mounted file",
            }
          : {}),
        generation: 0,
        observedAt: Date.now(),
      },
      identity: `${stat.dev}:${stat.ino}`,
    };
  }
  private readSync(filename: string): Candidate {
    try {
      const resolved = fs.realpathSync(filename);
      const before = fs.statSync(resolved);
      if (!before.isFile()) throw new Error("Not a regular file");
      this.reads++;
      const bytes = fs.readFileSync(resolved);
      const after = fs.statSync(resolved);
      if (!sameStat(before, after))
        throw new ChangingFile("Document changed while reading");
      return this.make(filename, resolved, after, bytes);
    } catch (error) {
      if (error instanceof ChangingFile) throw error;
      return { snapshot: this.failure(filename, error), identity: null };
    }
  }
  private async read(filename: string): Promise<Candidate> {
    try {
      const resolved = await fs.promises.realpath(filename);
      const before = await fs.promises.stat(resolved);
      if (!before.isFile()) throw new Error("Not a regular file");
      this.reads++;
      const bytes = await fs.promises.readFile(resolved);
      const after = await fs.promises.stat(resolved);
      if (!sameStat(before, after))
        throw new ChangingFile("Document changed while reading");
      return this.make(filename, resolved, after, bytes);
    } catch (error) {
      if (error instanceof ChangingFile) throw error;
      return { snapshot: this.failure(filename, error), identity: null };
    }
  }
  private failure(filename: string, error: unknown): WatchedDocumentSnapshot {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return {
      ...emptySnapshot(filename),
      availability: missing ? "missing" : "unreadable",
      ...(missing
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    };
  }
  private readMountPoints(): Set<string> {
    const result = new Set<string>();
    if (process.platform !== "linux") return result;
    try {
      const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
      for (const line of mountinfo.split("\n")) {
        const encoded = line.split(" ")[4];
        if (!encoded) continue;
        const filename = encoded.replace(
          /\\([0-7]{3})/g,
          (_match, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)),
        );
        try {
          if (fs.statSync(filename).isFile())
            result.add(path.resolve(filename));
        } catch {
          /* Mount information is optional observability evidence. */
        }
      }
    } catch {
      /* Non-Linux and restricted containers use explicit capability declarations. */
    }
    return result;
  }
}
