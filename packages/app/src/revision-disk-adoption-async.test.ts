import fs from "node:fs";
import path from "node:path";
import {
  mergeReviewDrafts,
  type SyncDraft,
  type SyncMerge,
} from "@roughdraft/rfm";
import { getSchema } from "@tiptap/core";
import { expect, test, vi } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";
import {
  adoptRevisionDisk,
  adoptRevisionDiskAsync,
} from "./revision-disk-adoption";
import { cleanRevisionMarkdown } from "./revision-markdown";
import { parseRemoteRevision } from "./revision-remote-source";
import { RevisionSource } from "./revision-source";

vi.mock("./revision-remote-source", { spy: true });
const schema = getSchema([...createEditorExtensions(""), RevisionSource]);
const original = "# Plan\n\nAlpha owner: stable.\n\nBeta owner: stable.\n";
const base: SyncDraft = {
  markdown: original,
  cleanMarkdown: original,
  decisions: {},
  reviewComments: [],
};

test("scheduled input runs between disk adoption evaluations before the result is complete", async () => {
  let done = false;
  let inputRan = false;
  let inputBeforeResult = false;
  let scheduled = false;
  const native = await vi.importActual<
    typeof import("./revision-remote-source")
  >("./revision-remote-source");
  const parser = vi.mocked(parseRemoteRevision);
  parser.mockClear();
  parser.mockImplementation((...args) => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => {
        inputRan = true;
        inputBeforeResult = !done;
      }, 0);
    }
    return native.parseRemoteRevision(...args);
  });
  try {
    const result = await adoptRevisionDiskAsync(
      base,
      original.replace("Beta owner: stable.", "Beta owner: updated."),
      schema,
      false,
      { path: "/practice.md", markdown: original },
    );
    done = true;
    expect(inputRan).toBe(true);
    expect(inputBeforeResult).toBe(true);
    expect(result && "status" in result ? result.status : result).toBe(
      "merged",
    );
  } finally {
    parser.mockImplementation(native.parseRemoteRevision);
  }
});

test("cooperative adoption has exactly the synchronous result and never repeats evaluations", async () => {
  const disk = original.replace("Beta owner: stable.", "Beta owner: updated.");
  const frozenBase = structuredClone(base);
  const savedText = { path: "/practice.md", markdown: original };
  const parser = vi.mocked(parseRemoteRevision);
  parser.mockClear();
  const expected = adoptRevisionDisk(
    frozenBase,
    disk,
    schema,
    false,
    savedText,
  );
  const syncCalls = parser.mock.calls.length;
  parser.mockClear();
  const actual = await adoptRevisionDiskAsync(
    frozenBase,
    disk,
    schema,
    false,
    savedText,
  );
  expect(actual).toEqual(expected);
  expect(parser.mock.calls.length).toBe(syncCalls);
  expect(frozenBase).toEqual(base);
  expect(savedText).toEqual({ path: "/practice.md", markdown: original });
});

test("each cooperative evaluation keeps its initial draft and file binding when input changes during a pause", async () => {
  const native = await vi.importActual<
    typeof import("./revision-remote-source")
  >("./revision-remote-source");
  const input = structuredClone(base);
  const binding = { path: "/practice.md", markdown: original };
  const disk = original.replace("Beta owner: stable.", "Beta owner: updated.");
  const expected = adoptRevisionDisk(
    structuredClone(input),
    disk,
    schema,
    false,
    { ...binding },
  );
  let scheduled = false;
  const parser = vi.mocked(parseRemoteRevision);
  parser.mockImplementation((...args) => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => {
        input.markdown = "Later unrelated typing.\n";
        input.cleanMarkdown = input.markdown;
        input.reviewComments.push({
          id: "c-new",
          changeId: "document",
          content: "Later private feedback",
          createdAt: "2026-11-27T12:00:00.000Z",
        });
        binding.path = "/new-destination.md";
        binding.markdown = "Later outside revision.\n";
      }, 0);
    }
    return native.parseRemoteRevision(...args);
  });
  try {
    const result = await adoptRevisionDiskAsync(
      input,
      disk,
      schema,
      false,
      binding,
    );
    expect(input.markdown).toBe("Later unrelated typing.\n");
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("Later private feedback");
    expect(JSON.stringify(result)).not.toContain("new-destination");
  } finally {
    parser.mockImplementation(native.parseRemoteRevision);
  }
});

test("the annotated maintained document and explicit conflict choices have identical cooperative and synchronous results", async () => {
  const original = fs.readFileSync(
    path.resolve(process.cwd(), "../../docs/spec/fixtures/editing-review.md"),
    "utf8",
  );
  const markdown = original.replace("planting schedule", "orchard schedule");
  const parsed = criticMarkdownToEditorState(markdown);
  const review: SyncDraft = {
    markdown,
    cleanMarkdown: cleanRevisionMarkdown(markdown),
    decisions: {},
    reviewed: [],
    reviewComments: [...parsed.comments.values()].map((comment) => ({
      ...comment,
      changeId: comment.parentCommentId ?? "document",
    })),
  };
  const incoming = original
    .replace("planting schedule", "garden schedule")
    .replace("lighting schedule", "lantern schedule");
  for (const resolution of [undefined, "incoming", "local"] as const) {
    const binding = {
      path: "/practice.md",
      markdown: original,
      ...(resolution ? { resolution } : {}),
    };
    const snapshot = structuredClone(review);
    const expected = adoptRevisionDisk(
      snapshot,
      incoming,
      schema,
      false,
      binding,
    );
    const actual = await adoptRevisionDiskAsync(
      snapshot,
      incoming,
      schema,
      false,
      binding,
    );
    expect(actual).toEqual(expected);
    expect(snapshot).toEqual(review);
  }
}, 15000);

test("a hidden review completes without waiting on background-throttled scheduling", async () => {
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const throttled = vi.fn(() => {
    throw new Error("Background task has not been scheduled");
  });
  vi.stubGlobal("scheduler", { yield: throttled });
  try {
    const result = await adoptRevisionDiskAsync(
      base,
      original.replace("Beta owner: stable.", "Beta owner: updated."),
      schema,
      false,
      { path: "/practice.md", markdown: original },
    );
    expect(result && "status" in result ? result.status : result).toBe(
      "merged",
    );
    expect(throttled).not.toHaveBeenCalled();
  } finally {
    visibility.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("both pure disk comparisons await the supplied comparison service with unchanged inputs and options", async () => {
  const input = structuredClone(base);
  const binding = {
    path: "/practice.md",
    markdown: original,
    resolution: "incoming" as const,
  };
  const disk = original.replace("Beta owner: stable.", "Beta owner: updated.");
  const expected = adoptRevisionDisk(
    structuredClone(input),
    disk,
    schema,
    false,
    { ...binding },
  );
  const jobs: Array<{
    args: Parameters<typeof mergeReviewDrafts>;
    finish(): void;
  }> = [];
  const compare = vi.fn(
    (...args: Parameters<typeof mergeReviewDrafts>) =>
      new Promise<SyncMerge>((resolve) => {
        jobs.push({ args, finish: () => resolve(mergeReviewDrafts(...args)) });
      }),
  );
  let done = false;
  const pending = adoptRevisionDiskAsync(
    input,
    disk,
    schema,
    false,
    binding,
    undefined,
    compare,
  ).finally(() => {
    done = true;
  });
  await vi.waitFor(() => expect(jobs).toHaveLength(1));
  expect(done).toBe(false);
  let inputRan = false;
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      inputRan = true;
      resolve();
    }, 0),
  );
  expect(inputRan).toBe(true);
  input.markdown = "Newer native typing.\n";
  binding.markdown = "A later disk revision.\n";
  jobs[0].finish();
  await vi.waitFor(() => expect(jobs).toHaveLength(2));
  expect(done).toBe(false);
  jobs[1].finish();
  expect(await pending).toEqual(expected);
  expect(compare).toHaveBeenCalledTimes(2);
  for (const { args } of jobs) {
    expect(args[3]).toEqual({
      server: false,
      budgetMs: 100,
      resolution: "local",
    });
    expect(JSON.stringify(args)).not.toContain("Newer native typing");
    expect(JSON.stringify(args)).not.toContain("A later disk revision");
  }
  expect(input.markdown).toBe("Newer native typing.\n");
  expect(binding.markdown).toBe("A later disk revision.\n");
});

test("a rejected background disk comparison becomes a safe waiting result without mutating its source", async () => {
  const input = structuredClone(base);
  const before = structuredClone(input);
  const disk = original.replace("Beta owner: stable.", "Beta owner: updated.");
  const compare = vi.fn(async () => {
    throw new Error("Comparison was superseded");
  });
  const result = await adoptRevisionDiskAsync(
    input,
    disk,
    schema,
    false,
    { path: "/practice.md", markdown: original },
    undefined,
    compare,
  );
  expect(compare).toHaveBeenCalledOnce();
  expect(result).toMatchObject({
    status: "client-merge-required",
    draft: before,
    reason: "The outside update could not be mapped safely.",
  });
  expect(input).toEqual(before);
});

test("an unavailable comparison service returns its waiting result without mapping or retrying", async () => {
  const input = structuredClone(base);
  const compare = vi.fn(async (_before, local: SyncDraft) => ({
    status: "client-merge-required" as const,
    draft: local,
    conflicts: [],
    signature: "unavailable",
    reason: "This browser cannot run the background comparison.",
  }));
  const result = await adoptRevisionDiskAsync(
    input,
    original.replace("Beta owner: stable.", "Beta owner: updated."),
    schema,
    false,
    { path: "/practice.md", markdown: original },
    undefined,
    compare,
  );
  expect(compare).toHaveBeenCalledOnce();
  expect(result).toMatchObject({
    status: "client-merge-required",
    reason: "This browser cannot run the background comparison.",
  });
  expect(input).toEqual(base);
});

test("comparison timing includes deferred work while local mapping timing excludes that wait", async () => {
  let clock = 0;
  const monotonic = vi
    .spyOn(performance, "now")
    .mockImplementation(() => clock);
  const profile = {
    entries: [] as Array<{
      stage: string;
      duration: number;
      durationKind?: string;
    }>,
  };
  vi.stubGlobal("roughdraftProfile", profile);
  const compare = vi.fn(
    async (...args: Parameters<typeof mergeReviewDrafts>) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      clock += 100;
      return mergeReviewDrafts(...args);
    },
  );
  try {
    const result = await adoptRevisionDiskAsync(
      base,
      original.replace("Beta owner: stable.", "Beta owner: updated."),
      schema,
      false,
      { path: "/practice.md", markdown: original },
      undefined,
      compare,
    );
    expect(result).toMatchObject({ status: "merged" });
    expect(
      profile.entries.filter((entry) =>
        ["disk-adoption-prose-merge", "disk-adoption-feedback-merge"].includes(
          entry.stage,
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        stage: "disk-adoption-prose-merge",
        duration: 100,
        durationKind: "elapsed",
      }),
      expect.objectContaining({
        stage: "disk-adoption-feedback-merge",
        duration: 100,
        durationKind: "elapsed",
      }),
    ]);
    expect(
      profile.entries
        .filter((entry) => entry.durationKind === "cpu")
        .every((entry) => entry.duration === 0),
    ).toBe(true);
  } finally {
    monotonic.mockRestore();
    vi.unstubAllGlobals();
  }
});
