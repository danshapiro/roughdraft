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
        ["AGENTS.md", "--after", candidate, "--watch", "--no-open", "--json"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    const [url, init] = f.fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://localhost:7373/api/comparisons");
    expect(JSON.parse(String(init?.body))).toEqual({
      editor: "unified",
      mode: "proposal",
      targetPath: target,
      afterPath: candidate,
      autosave: "none",
      handoff: "button",
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
      editor: "unified",
      mode: "applied",
      targetPath: target,
      beforePath: before,
      autosave: "none",
      handoff: "chat",
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
      editor: "unified",
      mode: "compare",
      beforePath: before,
      afterPath: target,
      autosave: "none",
      handoff: "chat",
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
        [target, "--after", candidate, "--watch", "--timeout", "0", "--json"],
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
        ["durable", "--watch", "--json"],
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
        ["already-finished", "--watch", "--json"],
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

  it("opens a chat review with friendly metadata and an absolute autosave destination without waiting", async () => {
    const f = fixture();
    const before = file("before.md", "Before");
    const after = file("after.md", "After");
    f.fetchImpl.mockResolvedValueOnce(
      Response.json({
        id: "chat",
        editor: "unified",
        status: "open",
        completion: null,
      }),
    );
    expect(
      await runComparisonCommand(
        "compare",
        [
          before,
          after,
          "--title",
          "Review the customer welcome guide",
          "--before-label",
          "Previous guide",
          "--after-label",
          "Updated guide",
          "--autosave",
          "reviewed.md",
          "--autosave-base",
          "old",
          "--timeout",
          "0",
          "--json",
        ],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0][1]?.body))).toEqual({
      editor: "unified",
      mode: "compare",
      beforePath: before,
      afterPath: after,
      title: "Review the customer welcome guide",
      beforeLabel: "Previous guide",
      afterLabel: "Updated guide",
      autosave: path.join(directory, "reviewed.md"),
      autosaveBase: "old",
      handoff: "chat",
    });
    expect(JSON.parse(f.logs[0])).toMatchObject({
      event: "comparison.opened",
      comparisonId: "chat",
    });
    expect(f.openUrl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(directory, "reviewed.md"))).toBe(false);
  });

  it.each([
    undefined,
    "none",
  ])("uses the edit file as autosave unless explicitly disabled (%s)", async (autosave) => {
    const f = fixture();
    const target = file("notes.md", "Notes");
    f.fetchImpl.mockResolvedValueOnce(
      Response.json({
        id: "edit",
        editor: "unified",
        status: "open",
        completion: null,
      }),
    );
    expect(
      await runComparisonCommand(
        "edit",
        [
          target,
          "--timeout",
          "0",
          ...(autosave ? ["--autosave", autosave] : []),
        ],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0][1]?.body))).toEqual({
      targetPath: target,
      autosave: autosave ?? target,
      handoff: "chat",
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the latest saved draft and comments without opening a browser or registering a watch", async () => {
    const f = fixture();
    const latest = {
      id: "read-me",
      status: "open",
      editor: "unified",
      completion: null,
      title: "Review the customer guide",
      draft: {
        markdown: "Current {++suggestion++}",
        decisions: { first: "kept" },
      },
      reviewComments: [{ id: "c1", content: "Latest comment" }],
      feedback: {
        draft: { markdown: "Stale snapshot" },
        sentAt: "earlier",
        saved: false,
      },
    };
    f.fetchImpl.mockResolvedValueOnce(Response.json(latest));
    expect(
      await runComparisonCommand(
        "comparison",
        [latest.id, "--read", "--json"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(f.fetchImpl.mock.calls[0][0])).toBe(
      "http://localhost:7373/api/comparisons/read-me",
    );
    expect(f.fetchImpl.mock.calls[0][1]?.method).toBeUndefined();
    expect(f.openUrl).not.toHaveBeenCalled();
    expect(f.logs.map((line) => JSON.parse(line))).toEqual([
      { event: "comparison.read", comparisonId: latest.id, comparison: latest },
    ]);
  });

  it("prints saved review content and comments in plain read output", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(
      Response.json({
        id: "read-me",
        status: "open",
        completion: null,
        title: "Review the customer guide",
        draft: {
          markdown: "Current {++suggestion++}",
          decisions: { first: "kept" },
        },
        reviewComments: [{ id: "c1", content: "Latest comment" }],
      }),
    );
    expect(
      await runComparisonCommand(
        "comparison",
        ["read-me", "--read"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(f.logs.join("\n")).toContain("Review the customer guide");
    expect(f.logs.join("\n")).toContain("Current {++suggestion++}");
    expect(f.logs.join("\n")).toContain("Latest comment");
    expect(f.logs.join("\n")).toContain("kept");
    expect(f.openUrl).not.toHaveBeenCalled();
  });

  it("reopens a review without waiting unless --watch is explicit", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(
      Response.json({
        id: "resume",
        editor: "unified",
        status: "open",
        completion: null,
      }),
    );
    expect(
      await runComparisonCommand(
        "comparison",
        ["resume", "--json", "--timeout", "0"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.logs[0]).event).toBe("comparison.opened");
  });

  it("enables the feedback button before explicitly waiting on an existing chat review", async () => {
    const f = fixture();
    const chat = {
      id: "chat-review",
      editor: "unified",
      handoff: "chat",
      revision: 3,
      status: "open",
      completion: null,
      feedback: null,
    };
    const button = { ...chat, handoff: "button", revision: 4 };
    f.fetchImpl.mockResolvedValueOnce(Response.json(chat));
    f.fetchImpl.mockImplementationOnce(async (url, init) => {
      expect(String(url)).toBe(
        "http://localhost:7373/api/comparisons/chat-review/handoff",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        revision: 3,
        handoff: "button",
      });
      expect(f.openUrl).not.toHaveBeenCalled();
      return Response.json(button);
    });
    f.fetchImpl.mockResolvedValueOnce(Response.json(button));
    f.fetchImpl.mockResolvedValueOnce(
      Response.json({ ...button, feedback: { sentAt: "now", saved: false } }),
    );
    expect(
      await runComparisonCommand(
        "comparison",
        [chat.id, "--watch", "--json"],
        f.deps,
        false,
        f.connect,
      ),
    ).toBe(0);
    expect(f.fetchImpl).toHaveBeenCalledTimes(4);
    expect(JSON.parse(f.logs[0]).comparison.handoff).toBe("button");
    expect(JSON.parse(f.logs.at(-1) ?? "{}").event).toBe(
      "comparison.completed",
    );
  });

  it.each([
    ["comparison", ["id", "--read", "--watch"]],
    ["edit", ["--read"]],
    ["edit", ["--autosave-base", "current"]],
  ] as const)("rejects invalid review options for %s before connecting", async (command, args) => {
    const f = fixture();
    expect(
      await runComparisonCommand(command, [...args], f.deps, false, f.connect),
    ).toBe(2);
    expect(f.connect).not.toHaveBeenCalled();
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
