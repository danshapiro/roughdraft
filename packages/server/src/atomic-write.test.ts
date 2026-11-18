import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite, FileChangedError } from "./atomic-write";

describe("atomicWrite", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-atomic-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("publishes complete replacement bytes without changing an existing reader", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Original complete document", { mode: 0o640 });
    const originalReader = fs.openSync(target, "r");

    try {
      atomicWrite(target, "Updated complete document");

      expect(fs.readFileSync(target, "utf8")).toBe("Updated complete document");
      expect(fs.readFileSync(originalReader, "utf8")).toBe(
        "Original complete document",
      );
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
      expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
    } finally {
      fs.closeSync(originalReader);
    }
  });

  it("writes through a symlink while preserving its target permissions and link", () => {
    const target = path.join(directory, "draft.md");
    const alias = path.join(directory, "alias.md");
    fs.writeFileSync(target, "Before", { mode: 0o640 });
    fs.symlinkSync("draft.md", alias);

    atomicWrite(alias, Buffer.from("After"));

    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(alias)).toBe("draft.md");
    expect(fs.readFileSync(target, "utf8")).toBe("After");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("does not overwrite an edit made before publication", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Before");

    expect(() =>
      atomicWrite(target, "Obsolete replacement", {
        beforePublish: () => fs.writeFileSync(target, "Newer external edit"),
      }),
    ).toThrow(FileChangedError);

    expect(fs.readFileSync(target, "utf8")).toBe("Newer external edit");
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
  });

  it("does not write either destination when a symlink is retargeted during a save", () => {
    const target = path.join(directory, "draft.md");
    const other = path.join(directory, "other.md");
    const alias = path.join(directory, "alias.md");
    fs.writeFileSync(target, "Original draft");
    fs.writeFileSync(other, "Other document");
    fs.symlinkSync(target, alias);

    expect(() =>
      atomicWrite(alias, "Obsolete replacement", {
        beforePublish: () => {
          fs.unlinkSync(alias);
          fs.symlinkSync(other, alias);
        },
      }),
    ).toThrow(FileChangedError);

    expect(fs.readFileSync(target, "utf8")).toBe("Original draft");
    expect(fs.readFileSync(other, "utf8")).toBe("Other document");
    expect(fs.readlinkSync(alias)).toBe(other);
    expect(fs.readdirSync(directory).sort()).toEqual([
      "alias.md",
      "draft.md",
      "other.md",
    ]);
  });

  it("does not replace a newly created destination during its first save", () => {
    const target = path.join(directory, "draft.md");

    expect(() =>
      atomicWrite(target, "Obsolete first save", {
        beforePublish: () => fs.writeFileSync(target, "External creation"),
      }),
    ).toThrow(FileChangedError);

    expect(fs.readFileSync(target, "utf8")).toBe("External creation");
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
  });

  it("removes a prepared replacement when the publication guard rejects it", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Before");

    expect(() =>
      atomicWrite(target, "After", {
        beforePublish: () => {
          throw new Error("Document version changed");
        },
      }),
    ).toThrow("Document version changed");

    expect(fs.readFileSync(target, "utf8")).toBe("Before");
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
  });

  it("creates new documents with the requested private permissions", () => {
    const target = path.join(directory, "draft.md");
    atomicWrite(target, "New document", { mode: 0o640 });

    expect(fs.readFileSync(target, "utf8")).toBe("New document");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);

    const privateTarget = path.join(directory, "private.md");
    atomicWrite(privateTarget, "Private document");
    expect(fs.statSync(privateTarget).mode & 0o777).toBe(0o600);
  });

  it("refuses a busy rename by default without changing the document", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Original document");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("Busy mount"), { code: "EBUSY" });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => atomicWrite(target, "Replacement")).toThrow("Busy mount");

    expect(fs.readFileSync(target, "utf8")).toBe("Original document");
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
    expect(warning).not.toHaveBeenCalled();
  });

  it("uses an explicit busy-mount fallback without replacing the inode or leaving old tail bytes", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Original longer document", { mode: 0o640 });
    const originalInode = fs.statSync(target).ino;
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("Busy mount"), { code: "EBUSY" });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    atomicWrite(target, "New", { allowBusyFallback: true });

    expect(fs.readFileSync(target, "utf8")).toBe("New");
    expect(fs.statSync(target).ino).toBe(originalInode);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
    expect(warning).toHaveBeenCalledOnce();
    const record = JSON.parse(String(warning.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      severity: "WARNING",
      nonAtomic: true,
      reason: "EBUSY",
    });
    expect(JSON.stringify(record)).not.toContain(target);
    expect(JSON.stringify(record)).not.toContain("Original longer document");
  });

  it("keeps non-busy rename failures strict even when fallback is enabled", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Original document");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("Denied rename"), { code: "EACCES" });
    });

    expect(() =>
      atomicWrite(target, "Replacement", { allowBusyFallback: true }),
    ).toThrow("Denied rename");

    expect(fs.readFileSync(target, "utf8")).toBe("Original document");
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
  });

  it("rechecks document bytes after a busy rename before writing in place", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Original document");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      fs.writeFileSync(target, "Newer external edit");
      throw Object.assign(new Error("Busy mount"), { code: "EBUSY" });
    });

    expect(() =>
      atomicWrite(target, "Obsolete replacement", { allowBusyFallback: true }),
    ).toThrow(FileChangedError);

    expect(fs.readFileSync(target, "utf8")).toBe("Newer external edit");
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
  });

  it("rechecks the caller publication guard before using the busy fallback", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Original document");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("Busy mount"), { code: "EBUSY" });
    });
    let checks = 0;

    expect(() =>
      atomicWrite(target, "Obsolete replacement", {
        allowBusyFallback: true,
        beforePublish: () => {
          checks += 1;
          if (checks === 2) {
            fs.writeFileSync(target, "Newer guarded edit");
            throw new FileChangedError();
          }
        },
      }),
    ).toThrow(FileChangedError);

    expect(fs.readFileSync(target, "utf8")).toBe("Newer guarded edit");
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
  });

  it("does not follow a symlink retargeted while the rename reports busy", () => {
    const target = path.join(directory, "draft.md");
    const other = path.join(directory, "other.md");
    const alias = path.join(directory, "alias.md");
    fs.writeFileSync(target, "Original document");
    fs.writeFileSync(other, "Other document");
    fs.symlinkSync(target, alias);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      fs.unlinkSync(alias);
      fs.symlinkSync(other, alias);
      throw Object.assign(new Error("Busy mount"), { code: "EBUSY" });
    });

    expect(() =>
      atomicWrite(alias, "Obsolete replacement", { allowBusyFallback: true }),
    ).toThrow(FileChangedError);

    expect(fs.readFileSync(target, "utf8")).toBe("Original document");
    expect(fs.readFileSync(other, "utf8")).toBe("Other document");
    expect(fs.readdirSync(directory).sort()).toEqual([
      "alias.md",
      "draft.md",
      "other.md",
    ]);
  });

  it("preserves original bytes when the operating system rejects a real partial write", () => {
    const target = path.join(directory, "draft.md");
    fs.writeFileSync(target, "Original complete document", { mode: 0o640 });
    const moduleUrl = new URL("./atomic-write.ts", import.meta.url).href;
    const loader = createRequire(import.meta.url).resolve("tsx");
    const script = `
      import { atomicWrite } from ${JSON.stringify(moduleUrl)};
      process.on("SIGXFSZ", () => {});
      try {
        atomicWrite(process.argv[1], "x".repeat(2048));
        process.exitCode = 1;
      } catch (error) {
        if (error.code !== "EFBIG") throw error;
      }
    `;
    const limited = spawnSync(
      "python3",
      [
        "-c",
        "import os,resource,sys;resource.setrlimit(resource.RLIMIT_FSIZE,(1024,1024));os.execv(sys.argv[1],sys.argv[1:])",
        process.execPath,
        "--import",
        loader,
        "--input-type=module",
        "-e",
        script,
        target,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(limited.error).toBeUndefined();
    expect(limited.status, limited.stderr).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("Original complete document");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(directory)).toEqual(["draft.md"]);
  });
});
