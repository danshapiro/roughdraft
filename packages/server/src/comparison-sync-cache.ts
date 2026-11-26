import crypto from "node:crypto";
import {
  reviewDraftSignature,
  type SyncDraft,
  type SyncReservation,
} from "@roughdraft/rfm";

export class ReviewBaseCache {
  private entries = new Map<
    string,
    { draft: SyncDraft; bytes: number; signature: string }
  >();
  private bytes = 0;

  remember(
    id: string,
    revision: number | string,
    draft: SyncDraft,
    signature = reviewDraftSignature(draft),
  ): void {
    const key = `${id}:${revision}`;
    const serialized = JSON.stringify(draft);
    const bytes = Buffer.byteLength(serialized);
    const old = this.entries.get(key);
    if (old) this.bytes -= old.bytes;
    this.entries.delete(key);
    this.entries.set(key, { draft: JSON.parse(serialized), bytes, signature });
    this.bytes += bytes;
    const own = [...this.entries.keys()].filter((entry) =>
      entry.startsWith(`${id}:`),
    );
    while (own.length > 64) {
      const oldest = own.shift();
      if (oldest) this.remove(oldest);
    }
    while (this.bytes > 8 * 1024 * 1024 && this.entries.size) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.remove(oldest);
    }
  }

  origins(id: string, signatures: Set<string>): Record<string, SyncDraft> {
    const result: Record<string, SyncDraft> = {};
    if (!signatures.size) return result;
    for (const [key, value] of this.entries)
      if (key.startsWith(`${id}:`) && signatures.has(value.signature))
        result[value.signature] = structuredClone(value.draft);
    return result;
  }

  get(id: string, revision: number): SyncDraft | undefined {
    const key = `${id}:${revision}`;
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return structuredClone(value.draft);
  }

  private remove(key: string): void {
    const value = this.entries.get(key);
    if (value) this.bytes -= value.bytes;
    this.entries.delete(key);
  }
}

interface Turn {
  owner: string;
  reservation: SyncReservation;
}
export class ReviewReservations {
  private turns = new Map<string, Turn>();
  private waiting = new Map<string, Map<string, number>>();

  constructor(private now: () => number) {}

  private clean(id: string): void {
    const turn = this.turns.get(id);
    if (turn && turn.reservation.expiresAt <= this.now()) this.turns.delete(id);
    const queue = this.waiting.get(id);
    if (queue)
      for (const [page, since] of queue)
        if (since < this.now() - 3000) queue.delete(page);
    if (!queue?.size) this.waiting.delete(id);
  }

  blocked(id: string, page: string, token?: string): boolean {
    this.clean(id);
    const turn = this.turns.get(id);
    if (!turn) return false;
    if (turn.owner === page && turn.reservation.token === token) return false;
    if (turn.owner !== page) this.enqueue(id, page);
    return true;
  }

  valid(id: string, page: string, token: string | undefined, revision: number) {
    this.clean(id);
    const turn = this.turns.get(id);
    return Boolean(
      token &&
        turn?.owner === page &&
        turn.reservation.token === token &&
        turn.reservation.revision === revision,
    );
  }

  request(id: string, page: string, revision: number): SyncReservation | null {
    this.clean(id);
    const active = this.turns.get(id);
    if (active) return active.owner === page ? active.reservation : null;
    this.enqueue(id, page);
    const first = this.waiting.get(id)?.keys().next().value;
    if (first !== page) return null;
    this.waiting.get(id)?.delete(page);
    const reservation = {
      token: crypto.randomUUID(),
      revision,
      expiresAt: this.now() + 750,
    };
    this.turns.set(id, { owner: page, reservation });
    return reservation;
  }

  release(id: string, page: string): void {
    if (this.turns.get(id)?.owner === page) this.turns.delete(id);
    this.waiting.get(id)?.delete(page);
    this.clean(id);
  }

  private enqueue(id: string, page: string): void {
    let queue = this.waiting.get(id);
    if (!queue) {
      queue = new Map();
      this.waiting.set(id, queue);
    }
    if (!queue.has(page) && queue.size < 128) queue.set(page, this.now());
  }
}
