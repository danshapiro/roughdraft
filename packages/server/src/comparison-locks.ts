import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export class ComparisonLockBusy extends Error {
  constructor() {
    super("Another save is finishing. Your changes remain queued.");
  }
}

/** A lock belongs to the parent's open file description, not the short helper. */
export class ComparisonLocks {
  private enabled: boolean | undefined;
  private held = new Map<string, number>();

  constructor(private directory: string) {}

  get available(): boolean {
    if (this.enabled === undefined) {
      this.enabled =
        process.platform === "linux" &&
        spawnSync("flock", ["--version"], { timeout: 3000 }).status === 0;
    }
    return this.enabled;
  }

  run<T>(keys: string[], action: () => T): T {
    const acquired: Array<{ key: string; fd: number }> = [];
    try {
      if (this.available) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        // Fixed stripes bound inode use even when every autosave has a new
        // operation ID. The same logical resource always selects one stripe.
        const stripes = [
          ...new Set(
            keys.map((key) =>
              crypto.createHash("sha256").update(key).digest("hex").slice(0, 2),
            ),
          ),
        ].sort();
        for (const key of stripes) {
          if (this.held.has(key)) continue;
          const name = key;
          const fd = fs.openSync(path.join(this.directory, name), "a", 0o600);
          const result = spawnSync("flock", ["-xn", "3"], {
            stdio: ["ignore", "pipe", "pipe", fd],
            timeout: 3000,
          });
          if (result.status !== 0) {
            fs.closeSync(fd);
            if (result.status === 1) throw new ComparisonLockBusy();
            throw new Error("Could not acquire the review's publication lock");
          }
          this.held.set(key, fd);
          acquired.push({ key, fd });
        }
      }
      return action();
    } finally {
      for (const { key, fd } of acquired.reverse()) {
        this.held.delete(key);
        fs.closeSync(fd);
      }
    }
  }
}
