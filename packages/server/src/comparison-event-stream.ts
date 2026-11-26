import type { Response } from "express";

/** Coalesce small version hints while a phone/proxy stops reading. */
export class ComparisonEventStream {
  private blocked = false;
  private closed = false;
  private pending = new Map<string, () => string>();

  constructor(
    private response: Response,
    private maximum = 100,
  ) {
    response.on("drain", this.drain);
  }

  send(id: string, render: () => string): void {
    if (this.closed || this.response.destroyed || this.response.writableEnded)
      return;
    if (this.blocked) {
      this.pending.set(id, render);
      if (this.pending.size > this.maximum) {
        this.close();
        this.response.end();
      }
      return;
    }
    this.blocked = !this.response.write(render());
  }

  heartbeat(render: () => string): void {
    if (
      this.closed ||
      this.blocked ||
      this.response.destroyed ||
      this.response.writableEnded
    )
      return;
    this.blocked = !this.response.write(render());
  }

  private drain = (): void => {
    this.blocked = false;
    for (const [id, render] of this.pending) {
      this.pending.delete(id);
      this.send(id, render);
      if (this.blocked || this.closed) return;
    }
  };

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.response.off("drain", this.drain);
  }
}
