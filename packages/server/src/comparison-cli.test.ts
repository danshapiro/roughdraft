import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliDependencies } from "./cli.js";
import { runComparisonCommand } from "./comparison-cli.js";

describe("comparison CLI", () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "comparison-cli-"));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function fixture() {
    const logs: string[] = [];
    const errors: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>();
    const openUrl = vi.fn(() => "disabled" as const);
    const deps = createCliDependencies({
      cwd: directory,
      env: { ROUGHDRAFT_PUBLIC_URL: "http://192.168.3.150:8811/" },
      fetchImpl,
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      sleepImpl: async () => {},
      openUrl,
    });
    const connect = vi.fn(async () => ({
      apiUrl: "http://localhost:7373/",
      frontendUrl: "http://localhost:7373/",
    }));
    return { deps, connect, logs, errors, fetchImpl, openUrl };
  }
  function file(name: string, content: string) {
    const filename = path.join(directory, name);
    fs.writeFileSync(filename, content);
    return filename;
  }

  it("copies a snapshot byte for byte without starting a server or overwriting one", async () => {
    const f = fixture();
    const source = file("AGENTS.md", "\ufeff# Heading\r\n\r\nOriginal");
    const output = path.join(directory, "AGENTS.before.md");
    expect(
      await runComparisonCommand(
        "snapshot",
        [source, "--out", output, "--json"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(fs.readFileSync(output)).toEqual(fs.readFileSync(source));
    expect(f.connect).not.toHaveBeenCalled();
    fs.writeFileSync(source, "New version");
    expect(
      await runComparisonCommand(
        "snapshot",
        [source, "--out", output],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(1);
    expect(fs.readFileSync(output, "utf8")).toBe(
      "\ufeff# Heading\r\n\r\nOriginal",
    );
  });

  it("creates a proposal with canonical paths and prints the public URL before waiting", async () => {
    const f = fixture();
    const target = file("AGENTS.md", "Original\n");
    const candidate = file("AGENTS.proposed.md", "Proposed\n");
    const comparison = {
      id: "review-1",
      status: "open",
      mode: "proposal",
      completion: null,
    };
    f.fetchImpl.mockResolvedValueOnce(Response.json(comparison));
    f.fetchImpl.mockImplementationOnce(async () => {
      expect(f.logs[0]).toContain(
        "http://192.168.3.150:8811/?comparison=review-1",
      );
      expect(fs.readFileSync(target, "utf8")).toBe("Original\n");
      return Response.json({
        ...comparison,
        status: "applied",
        completion: {
          fileWritten: true,
          targetPath: target,
          accepted: 1,
          reverted: 0,
          completedAt: "now",
        },
      });
    });
    expect(
      await runComparisonCommand(
        "propose",
        ["AGENTS.md", "--after", candidate, "--no-open", "--json"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    const [url, init] = f.fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://localhost:7373/api/comparisons");
    expect(JSON.parse(String(init?.body))).toEqual({
      mode: "proposal",
      targetPath: target,
      afterPath: candidate,
    });
    expect(JSON.parse(f.logs.at(-1) ?? "{}")).toMatchObject({
      event: "comparison.completed",
      completion: { fileWritten: true, targetPath: target },
    });
    expect(f.openUrl).not.toHaveBeenCalled();
  });

  it("keeps already-applied review and read-only comparison payloads distinct", async () => {
    const f = fixture();
    const before = file("before.md", "Before");
    const target = file("current.md", "After");
    f.fetchImpl.mockImplementation(async () =>
      Response.json({ id: "r2", status: "open", completion: null }),
    );
    expect(
      await runComparisonCommand(
        "review",
        [target, "--before", before, "--no-watch"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0][1]?.body))).toEqual({
      mode: "applied",
      targetPath: target,
      beforePath: before,
    });
    expect(
      await runComparisonCommand(
        "compare",
        [before, target, "--no-watch"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(JSON.parse(String(f.fetchImpl.mock.calls[1][1]?.body))).toEqual({
      mode: "compare",
      beforePath: before,
      afterPath: target,
    });
  });

  it("returns failure on timeout without approving or modifying a file", async () => {
    const f = fixture();
    const target = file("target.md", "Keep me");
    const candidate = file("new.md", "Other");
    f.fetchImpl.mockResolvedValue(
      Response.json({ id: "pending", status: "open", completion: null }),
    );
    expect(
      await runComparisonCommand(
        "propose",
        [target, "--after", candidate, "--timeout", "0", "--json"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(1);
    expect(JSON.parse(f.logs.at(-1) ?? "{}")).toMatchObject({
      timedOut: true,
      completion: null,
      comparisonId: "pending",
    });
    expect(fs.readFileSync(target, "utf8")).toBe("Keep me");
  });

  it("keeps waiting through a temporary server restart and consumes durable completion", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(
      Response.json({ id: "durable", status: "open", completion: null }),
    );
    f.fetchImpl.mockRejectedValueOnce(
      new TypeError("fetch failed: ECONNREFUSED"),
    );
    f.fetchImpl.mockResolvedValueOnce(
      Response.json({
        id: "durable",
        status: "completed",
        completion: {
          fileWritten: false,
          targetPath: null,
          accepted: 0,
          reverted: 0,
          completedAt: "now",
        },
      }),
    );
    expect(
      await runComparisonCommand(
        "comparison",
        ["durable", "--json"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(f.logs.at(-1) ?? "{}")).toMatchObject({
      event: "comparison.completed",
      completion: { fileWritten: false },
    });
  });

  it("resumes a durable completed review without creating or applying one", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValue(
      Response.json({
        id: "already-finished",
        status: "completed",
        completion: {
          fileWritten: false,
          targetPath: null,
          accepted: 0,
          reverted: 0,
          completedAt: "now",
        },
      }),
    );
    expect(
      await runComparisonCommand(
        "comparison",
        ["already-finished", "--json"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.fetchImpl.mock.calls[0][1]?.method).toBeUndefined();
    expect(JSON.parse(f.logs.at(-1) ?? "{}")).toMatchObject({
      completion: { fileWritten: false },
    });
  });

  it.each([
    "NaN",
    "Infinity",
    "1seconds",
    "-1",
  ])("rejects invalid timeout %s before starting any server", async (timeout) => {
    const f = fixture();
    expect(
      await runComparisonCommand(
        "comparison",
        ["id", "--timeout", timeout],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(2);
    expect(f.connect).not.toHaveBeenCalled();
  });
});
