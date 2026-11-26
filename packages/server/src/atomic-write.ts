import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class FileChangedError extends Error {
  readonly status = 409;
  constructor() {
    super("Markdown file changed on disk");
  }
}

export interface PreparedFileIdentity {
  device: number;
  inode: number;
  inPlace: boolean;
  stagedPath: string;
}

function existingFile(filename: string) {
  try {
    const resolved = fs.realpathSync(filename);
    const stat = fs.statSync(resolved);
    if (!stat.isFile())
      throw new Error("The destination is not a regular file");
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(resolved))
      .digest("hex");
    return {
      path: resolved,
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode & 0o7777,
      version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${digest}`,
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      !fs.lstatSync(filename, { throwIfNoEntry: false })
    )
      return null;
    throw error;
  }
}

export function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

// Recovery never rewrites an observed destination. Sync the existing bytes and
// their directory entry before a durable completion record can acknowledge it.
export function syncExistingFile(filename: string): void {
  const resolved = fs.realpathSync(filename);
  const descriptor = fs.openSync(resolved, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  syncDirectory(path.dirname(resolved));
}

export function atomicWrite(
  filename: string,
  content: string | Buffer,
  options: {
    mode?: number;
    beforePublish?: () => void;
    allowBusyFallback?: boolean;
    onPrepared?: (identity: PreparedFileIdentity) => void;
  } = {},
): void {
  const requested = path.resolve(filename);
  const original = existingFile(requested);
  const destination = original?.path ?? requested;
  const mode = original?.mode ?? options.mode ?? 0o600;
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`,
  );
  const assertUnchanged = () => {
    const current = existingFile(requested);
    if (
      current?.path !== original?.path ||
      current?.version !== original?.version
    )
      throw new FileChangedError();
  };
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, "wx", mode);
    created = true;
    try {
      fs.writeFileSync(descriptor, content);
      fs.fchmodSync(descriptor, mode);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    const staged = fs.statSync(temporary);
    options.onPrepared?.({
      device: staged.dev,
      inode: staged.ino,
      inPlace: false,
      stagedPath: temporary,
    });
    options.beforePublish?.();
    assertUnchanged();
    try {
      fs.renameSync(temporary, destination);
      created = false;
    } catch (error) {
      if (
        !options.allowBusyFallback ||
        !original ||
        (error as NodeJS.ErrnoException).code !== "EBUSY"
      )
        throw error;

      // Individual-file bind mounts cannot replace their inode. Local hosts
      // may explicitly accept an in-place write; strict callers never do.
      const descriptor = fs.openSync(destination, "r+");
      try {
        options.beforePublish?.();
        assertUnchanged();
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== original.device || opened.ino !== original.inode)
          throw new FileChangedError();
        options.onPrepared?.({
          device: opened.dev,
          inode: opened.ino,
          inPlace: true,
          stagedPath: destination,
        });
        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            severity: "WARNING",
            event: "roughdraft_non_atomic_write",
            nonAtomic: true,
            reason: "EBUSY",
          }),
        );
        fs.writeFileSync(descriptor, content);
        fs.ftruncateSync(descriptor, Buffer.byteLength(content));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    syncDirectory(path.dirname(destination));
  } finally {
    if (created) fs.unlinkSync(temporary);
  }
}
