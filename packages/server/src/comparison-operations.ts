import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncContext, SyncOperation, SyncResult } from "@roughdraft/rfm";
import { atomicWrite, syncDirectory } from "./atomic-write.js";

function initializeJson(filename: string, value: unknown): void {
  if (fs.existsSync(filename)) return;
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    try {
      fs.linkSync(temporary, filename);
      syncDirectory(path.dirname(filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    fs.unlinkSync(temporary);
  }
}

export interface OperationRecord<Review> {
  operation: SyncOperation;
  reviewId: string;
  createdAt: number;
  phase: "running" | "prepared" | "done";
  result?: SyncResult<Review>;
  acknowledged?: boolean;
  publicationWitness?: { path: string; device: number; inode: number };
}
interface PageOutcomes {
  operations: Array<{ id: string; sequence: number; acknowledged?: boolean }>;
  pruned: Array<[number, number]>;
  lastUsedAt?: number;
}

function recordPruned(page: PageOutcomes, sequence: number): void {
  const ranges = [
    ...page.pruned,
    [sequence, sequence] as [number, number],
  ].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  page.pruned = merged;
}

class InvalidOperationIdentity extends Error {
  readonly status = 400;
}

export function readOperation(body: Record<string, unknown>): SyncOperation {
  const context = body.operationContext as SyncContext | undefined;
  if (
    typeof body.operationId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(body.operationId) ||
    typeof body.pageInstanceId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(body.pageInstanceId) ||
    !Number.isSafeInteger(body.operationSequence) ||
    (body.operationSequence as number) < 1 ||
    !context ||
    typeof context.owner !== "string" ||
    typeof context.epoch !== "string" ||
    !Number.isFinite(context.acceptUntil)
  )
    throw new InvalidOperationIdentity(
      "A complete save operation identity is required",
    );
  return {
    operationId: body.operationId,
    pageInstanceId: body.pageInstanceId,
    operationSequence: body.operationSequence as number,
    operationContext: context,
    ...(Array.isArray(body.acknowledgedOperationIds)
      ? {
          acknowledgedOperationIds: body.acknowledgedOperationIds.filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
  };
}

/** Outcomes are operational recovery data; GET never creates or resolves one. */
export class ComparisonOperations<Review> {
  readonly owner: string;
  readonly epoch = crypto.randomUUID();
  private directory: string;
  private wallStart = Date.now();
  private monotonicStart = performance.now();
  private journalLost = false;
  private journalGeneration: string;

  constructor(
    store: string,
    processStateDirectory: string,
    private beforePrune?: (record: OperationRecord<Review>) => boolean,
  ) {
    fs.mkdirSync(processStateDirectory, { recursive: true, mode: 0o700 });
    const ownerFile = path.join(processStateDirectory, "server-owner.json");
    initializeJson(ownerFile, { id: crypto.randomUUID(), host: os.hostname() });
    const identity = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as {
      id: string;
      host: string;
    };
    if (!identity.id || !identity.host)
      throw new Error("Invalid owner identity");
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    this.owner = crypto
      .createHash("sha256")
      .update(`${fs.realpathSync(store)}:${identity.id}:${identity.host}`)
      .digest("hex");
    this.directory = path.join(store, "operations");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const generation = path.join(this.directory, "generation.json");
    const expected = path.join(
      processStateDirectory,
      `operation-journal-${crypto.createHash("sha256").update(fs.realpathSync(store)).digest("hex").slice(0, 16)}.json`,
    );
    if (fs.existsSync(expected) && !fs.existsSync(generation))
      this.journalLost = true;
    initializeJson(generation, { id: crypto.randomUUID() });
    const actualGeneration = JSON.parse(
      fs.readFileSync(generation, "utf8"),
    ) as { id: string };
    this.journalGeneration = actualGeneration.id;
    initializeJson(expected, {
      directory: this.directory,
      generation: actualGeneration.id,
    });
    const expectedGeneration = JSON.parse(
      fs.readFileSync(expected, "utf8"),
    ) as { generation?: string };
    if (expectedGeneration.generation !== actualGeneration.id)
      this.journalLost = true;
  }

  now = (): number => this.wallStart + performance.now() - this.monotonicStart;

  context(): SyncContext {
    return {
      owner: this.owner,
      epoch: this.epoch,
      acceptUntil: this.now() + 120_000,
    };
  }

  private filename(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id))
      throw new Error("Invalid operation ID");
    return path.join(this.directory, `${id}.json`);
  }

  private pageFile(page: string): string {
    return path.join(
      this.directory,
      `page-${crypto.createHash("sha256").update(page).digest("hex")}.json`,
    );
  }

  private page(page: string): PageOutcomes {
    try {
      return JSON.parse(fs.readFileSync(this.pageFile(page), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { operations: [], pruned: [] };
      throw error;
    }
  }

  read(id: string): OperationRecord<Review> | null {
    try {
      return JSON.parse(fs.readFileSync(this.filename(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  lost(operation: SyncOperation): boolean {
    try {
      const generation = JSON.parse(
        fs.readFileSync(path.join(this.directory, "generation.json"), "utf8"),
      ) as { id?: string };
      if (generation.id !== this.journalGeneration) this.journalLost = true;
    } catch {
      this.journalLost = true;
    }
    const page = this.page(operation.pageInstanceId);
    return (
      this.journalLost ||
      this.retired(operation) ||
      (page.operations.some((entry) => entry.id === operation.operationId) &&
        !this.read(operation.operationId)) ||
      page.pruned.some(
        ([from, to]) =>
          operation.operationSequence >= from &&
          operation.operationSequence <= to,
      )
    );
  }

  wasPruned(pageInstanceId: string, sequence: number): boolean {
    return this.page(pageInstanceId).pruned.some(
      ([from, to]) => sequence >= from && sequence <= to,
    );
  }

  private prunePayload(id: string): void {
    const record = this.read(id);
    if (record && this.beforePrune && !this.beforePrune(record)) return;
    fs.rmSync(this.filename(id), { force: true });
  }

  private retired(operation: SyncOperation): boolean {
    try {
      const retention = JSON.parse(
        fs.readFileSync(path.join(this.directory, "retention.json"), "utf8"),
      ) as { prunedBefore: number };
      return operation.operationContext.acceptUntil <= retention.prunedBefore;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  valid(operation: SyncOperation): boolean {
    const context = operation.operationContext;
    return (
      context.owner === this.owner &&
      context.epoch === this.epoch &&
      context.acceptUntil >= this.now() &&
      context.acceptUntil <= this.now() + 120_000
    );
  }

  foreign(operation: SyncOperation): boolean {
    return operation.operationContext.owner !== this.owner;
  }

  begin(operation: SyncOperation, reviewId: string): OperationRecord<Review> {
    const record: OperationRecord<Review> = {
      operation,
      reviewId,
      createdAt: this.now(),
      phase: "running",
    };
    this.write(record);
    const page = this.page(operation.pageInstanceId);
    page.lastUsedAt = this.now();
    if (!page.operations.some((item) => item.id === operation.operationId))
      page.operations.push({
        id: operation.operationId,
        sequence: operation.operationSequence,
      });
    const touched = new Map<string, PageOutcomes>([
      [operation.pageInstanceId, page],
    ]);
    for (const id of operation.acknowledgedOperationIds ?? []) {
      let item = page.operations.find((entry) => entry.id === id);
      if (item?.acknowledged) continue;
      const previous = this.read(id);
      if (!previous || !previous.result) continue;
      if (previous.phase === "prepared") this.finish(previous);
      const pageId = previous.operation.pageInstanceId;
      let ownerPage = touched.get(pageId);
      if (!ownerPage) {
        ownerPage = this.page(pageId);
        touched.set(pageId, ownerPage);
      }
      item = ownerPage.operations.find((entry) => entry.id === id);
      if (item) {
        item.acknowledged = true;
        ownerPage.lastUsedAt = this.now();
      }
    }
    for (const [pageId, values] of touched) {
      const acknowledged = values.operations.filter(
        (item) => item.acknowledged,
      );
      const removed = acknowledged.slice(
        0,
        Math.max(0, acknowledged.length - 16),
      );
      for (const item of removed) {
        recordPruned(values, item.sequence);
        values.operations = values.operations.filter(
          (entry) => entry.id !== item.id,
        );
      }
      // Coverage is durable BEFORE payload removal. A crash cannot make an
      // old committed request appear to be a fresh never-received operation.
      atomicWrite(this.pageFile(pageId), JSON.stringify(values));
      for (const item of removed) this.prunePayload(item.id);
    }
    return record;
  }

  prepare(record: OperationRecord<Review>, result: SyncResult<Review>): void {
    record.result = { ...result, operationId: record.operation.operationId };
    record.phase = "prepared";
    this.write(record);
  }

  holdPublication(
    record: OperationRecord<Review>,
    witness: NonNullable<OperationRecord<Review>["publicationWitness"]>,
  ): void {
    record.publicationWitness = witness;
    this.write(record);
  }

  private cleanPublication(record: OperationRecord<Review>): void {
    const witness = record.publicationWitness;
    if (!witness) return;
    try {
      const stat = fs.lstatSync(witness.path);
      if (stat.dev === witness.device && stat.ino === witness.inode) {
        fs.unlinkSync(witness.path);
        syncDirectory(path.dirname(witness.path));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            component: "comparison-operations",
            event: "publication-cleanup-deferred",
            operationId: record.operation.operationId,
            message: String(error),
          }),
        );
    }
  }

  finish(record: OperationRecord<Review>): SyncResult<Review> {
    if (!record.result) throw new Error("An operation outcome is required");
    record.phase = "done";
    this.write(record);
    this.cleanPublication(record);
    return record.result;
  }

  reject(
    operation: SyncOperation,
    reviewId: string,
    result: SyncResult<Review>,
  ) {
    const record = this.begin(operation, reviewId);
    this.prepare(record, result);
    return this.finish(record);
  }

  private write(record: OperationRecord<Review>): void {
    atomicWrite(
      this.filename(record.operation.operationId),
      JSON.stringify(record),
    );
  }

  maintenance(): void {
    // Terminal orphan payloads are recoverable for seven days. Running
    // publication intents are never removed by this bounded cleanup.
    const cutoff = this.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(this.directory)) {
      if (
        name.startsWith("page-") ||
        name === "generation.json" ||
        name === "retention.json" ||
        !name.endsWith(".json")
      )
        continue;
      const id = name.slice(0, -5);
      const record = this.read(id);
      if (record?.phase === "done") this.cleanPublication(record);
      if (!record || record.phase !== "done" || record.createdAt >= cutoff)
        continue;
      const page = this.page(record.operation.pageInstanceId);
      recordPruned(page, record.operation.operationSequence);
      page.lastUsedAt = this.now();
      page.operations = page.operations.filter((entry) => entry.id !== id);
      atomicWrite(
        this.pageFile(record.operation.pageInstanceId),
        JSON.stringify(page),
      );
      this.prunePayload(id);
    }
    const retiredPages: string[] = [];
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.startsWith("page-") || !name.endsWith(".json")) continue;
      const filename = path.join(this.directory, name);
      const page = JSON.parse(
        fs.readFileSync(filename, "utf8"),
      ) as PageOutcomes;
      if (
        !page.operations.length &&
        (page.lastUsedAt ?? fs.statSync(filename).mtimeMs) < cutoff
      )
        retiredPages.push(filename);
    }
    if (retiredPages.length) {
      atomicWrite(
        path.join(this.directory, "retention.json"),
        JSON.stringify({ prunedBefore: cutoff }),
      );
      for (const filename of retiredPages) fs.rmSync(filename, { force: true });
    }
  }
}
