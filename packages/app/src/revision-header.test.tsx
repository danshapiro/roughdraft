import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import { RevisionEditor } from "./RevisionEditor";

const liveSession = vi.hoisted(() => ({
  overrides: {} as Record<string, unknown>,
}));

vi.mock("./comparison-reading-position", () => ({
  useComparisonReadingPosition: () => () => {},
}));
vi.mock("./revision-session", () => ({
  useRevisionSession: (session: ComparisonReviewData, draft: unknown) => ({
    session,
    draft,
    updateDraft: vi.fn(),
    readDraft: () => draft,
    run: vi.fn(),
    inspect: vi.fn(),
    recoveryPending: false,
    fileWritePending: false,
    writePaused: false,
    reviewChanged: false,
    flush: vi.fn(),
    registerAdapter: vi.fn(),
    resolveConflict: vi.fn(),
    retrySync: vi.fn(),
    inspectCopy: vi.fn(),
    saveCopy: vi.fn(),
    setCopyLocked: vi.fn(),
    checkCopyStatus: vi.fn(),
    copyLocked: false,
    conflict: null,
    orphans: [],
    restoreOrphan: vi.fn(),
    ...liveSession.overrides,
  }),
}));
vi.mock("./PageCard", () => ({
  RichTextEditorSurface: ({ interactionMode }: { interactionMode: string }) => (
    <div data-testid="header-test-editor-mode">{interactionMode}</div>
  ),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  liveSession.overrides = {};
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

function review(overrides: Record<string, unknown> = {}): ComparisonReviewData {
  return {
    id: "review-header",
    revision: 1,
    mode: "compare",
    title: "Improve the laser product page",
    beforeLabel: "Original",
    afterLabel: "Revised",
    beforePath: "/project/test-results/SKILL-before.md",
    afterPath: "/project/skills/laser/SKILL.md",
    autosave: "/project/skills/laser/SKILL.md",
    handoff: "chat",
    targetPath: null,
    beforeText: "Original text\n",
    afterText: "Revised text\n",
    destinationPath: "/project/skills/laser/SKILL.md",
    savedPath: "/project/skills/laser/SKILL.md",
    savedText: "Revised text\n",
    segments: [],
    comment: "",
    status: "open",
    targetChanged: false,
    completion: null,
    ...overrides,
  } as ComparisonReviewData;
}

function byId(id: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function render(overrides: Record<string, unknown> = {}) {
  await act(async () =>
    root.render(<RevisionEditor initial={review(overrides)} />),
  );
}

test("the compact identity shows the agent's title and friendly versions", async () => {
  await render();
  expect(byId("revision-path")?.textContent).toBe(
    "Improve the laser product page",
  );
  expect(byId("revision-identity")?.textContent).toContain("Original");
  expect(byId("revision-identity")?.textContent).toContain("Revised");
  expect(byId("revision-identity")?.textContent).not.toContain("/project/");
  expect(byId("revision-before-label")?.title).toBe(
    "/project/test-results/SKILL-before.md",
  );
  expect(byId("revision-after-label")?.title).toBe(
    "/project/skills/laser/SKILL.md",
  );
});

test("review details expose the exact source paths and preset save destination", async () => {
  await render();
  expect(byId("revision-details")).not.toBeNull();
  await act(async () => byId("revision-details")?.click());
  expect(byId("revision-details-before")?.textContent).toBe(
    "/project/test-results/SKILL-before.md",
  );
  expect(byId("revision-details-after")?.textContent).toBe(
    "/project/skills/laser/SKILL.md",
  );
  expect(byId("revision-details-autosave")?.textContent).toBe(
    "/project/skills/laser/SKILL.md",
  );
});

test("opening Recovery copies closes Review details before its dialog takes input", async () => {
  await render({
    recoveryCheckpoints: [
      {
        id: "saved-feedback",
        reason: "Unfinished feedback saved with separate copy",
        updatedAt: "2026-11-26T12:00:00.000Z",
      },
    ],
  });
  await act(async () => byId("revision-details")?.click());
  expect(byId("revision-details")?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => byId("revision-recovery-copies")?.click());
  expect(byId("revision-recovery-dialog")).not.toBeNull();
  expect(byId("revision-recovery-copy-saved-feedback")).not.toBeNull();
  expect(byId("revision-details")?.getAttribute("aria-expanded")).toBe("false");
});

test("chat reviews have no send-feedback or file-picker actions", async () => {
  await render();
  expect(byId("revision-send")).toBeNull();
  expect(byId("revision-save-as")).toBeNull();
  expect(byId("revision-base-dialog")).toBeNull();
});

test("button integrations retain their explicit feedback action", async () => {
  await render({ handoff: "button" });
  expect(byId("revision-send")?.textContent).toBe("Send feedback");
});

test("saved files use an accessible icon without another status line", async () => {
  await render();
  expect(byId("revision-file-status")?.getAttribute("aria-label")).toBe(
    "Saved to file",
  );
  expect(byId("revision-file-status")?.textContent).toBe("");
});

test("an untouched no-file review with inline comments is already saved", async () => {
  await render({
    autosave: "none",
    destinationPath: null,
    savedPath: null,
    savedText: null,
    draft: null,
    reviewComments: [],
    afterText: "Read {==this==}{>>Check wording<<}{#c1}\n",
  });
  expect(byId("revision-file-status")?.getAttribute("aria-label")).toBe(
    "Review saved",
  );
});

test("explicit no-file reviews stay editable and switch modes through a dropdown", async () => {
  await render({
    autosave: "none",
    destinationPath: null,
    savedPath: null,
    savedText: null,
  });
  expect(byId("header-test-editor-mode")?.textContent).toBe("editing");
  expect(byId("revision-mode")).not.toBeNull();
  await act(async () => byId("revision-mode")?.click());
  expect(byId("revision-mode-suggest")).not.toBeNull();
  await act(async () => byId("revision-mode-suggest")?.focus());
  await act(async () => byId("revision-mode-suggest")?.click());
  expect(byId("header-test-editor-mode")?.textContent).toBe("suggesting");
  expect(byId("revision-base-dialog")).toBeNull();
});

test("the Markdown icon exposes its action and active state", async () => {
  await render();
  expect(byId("revision-format")?.getAttribute("aria-label")).toBe(
    "Show Markdown",
  );
  expect(byId("revision-format")?.textContent).toBe("");
  expect(byId("revision-format")?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => byId("revision-format")?.click());
  expect(byId("revision-format")?.getAttribute("aria-pressed")).toBe("true");
  expect(byId("revision-format")?.getAttribute("aria-label")).toBe(
    "Show formatted document",
  );
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(byId("revision-markdown")?.querySelector(".cm-editor")).toBeTruthy();
  });
  const host =
    byId("revision-markdown")?.querySelector<HTMLElement>(".cm-editor");
  expect(host).toBeTruthy();
  if (!host) throw new Error("Markdown editor was not mounted");
  const source = EditorView.findFromDOM(host);
  expect(source?.state.doc.toString()).toBe("Revised text\n");
  expect(source?.state.readOnly).toBe(false);
});

test("the sticky header opens reachable conflict actions and identifies a review update without guessing a file changed", async () => {
  liveSession.overrides = {
    writePaused: true,
    recoveryPending: true,
    conflict: {
      kind: "conflict",
      message:
        "A newer saved review is available. Some unsaved changes overlap.",
      state: null,
      conflicts: [
        {
          id: "body",
          kind: "text",
          base: "Old",
          local: "Mine",
          incoming: "Theirs",
          label: "Document",
        },
      ],
      signature: "overlap",
      checkpointSaved: true,
    },
  };
  await render();
  expect(byId("revision-file-status")?.getAttribute("aria-label")).toBe(
    "Review update",
  );
  const attention = byId("revision-update-attention");
  expect(attention?.closest("header")).not.toBeNull();
  await act(async () => attention?.click());
  const dialog = byId("revision-update-dialog");
  expect(dialog).not.toBeNull();
  for (const action of [
    "revision-discard",
    "revision-overwrite",
    "revision-save-separately",
  ])
    expect(dialog?.querySelector(`[data-testid="${action}"]`)).not.toBeNull();
});

test("an observation limitation stays visible while a writable file remains saved", async () => {
  const warning =
    "Outside changes to this mounted file cannot be observed automatically.";
  await render({ fileObservationWarning: warning });
  expect(byId("revision-file-observation-warning")?.textContent).toBe(warning);
  expect(byId("revision-file-status")?.getAttribute("aria-label")).toBe(
    "Saved to file",
  );
  expect(byId("revision-update-attention")).toBeNull();
});

test.each([
  false,
  true,
])("publication recovery is offered only when the server marks it recoverable: %s", async (recoverable) => {
  const recover = vi.fn(async () => true);
  liveSession.overrides = {
    recoverPublication: recover,
    writePaused: true,
    recoveryPending: true,
    conflict: {
      kind: "waiting",
      signature: "publication",
      conflicts: [],
      message: "Publication did not finish.",
      state: {
        publishing: { recoverable },
        review: { title: "Release plan" },
        draft: { markdown: "Saved body." },
      },
    },
  };
  await render();
  const button = byId("revision-publication-recover");
  expect(Boolean(button)).toBe(recoverable);
  expect(recover).not.toHaveBeenCalled();
  if (recoverable) {
    await act(async () => button?.click());
    expect(recover).toHaveBeenCalledOnce();
  }
});

test("Compare latest shows the waiting disk text while retaining the complete local annotated review", async () => {
  const local =
    "My {==annotated passage==}{>>Keep this saved feedback.<<}{#c1} and {++pending proposal++}{#s1}.\n";
  const disk = "The actual waiting document written on disk.\n";
  const changeDraft = vi.fn();
  const run = vi.fn();
  liveSession.overrides = {
    writePaused: true,
    recoveryPending: true,
    updateDraft: changeDraft,
    run,
    conflict: {
      kind: "waiting",
      signature: "disk-v2",
      conflicts: [],
      message:
        "The file changed on disk. This update is waiting for safe mapping.",
      state: {
        draft: { markdown: "The older saved review text.\n" },
        disk: {
          path: "/practice/release.md",
          availability: "available",
          text: disk,
        },
        review: {
          title: "Release plan",
          destinationPath: "/practice/release.md",
        },
      },
    },
  };
  await render({ afterText: local });
  await act(async () => byId("revision-compare-changes")?.click());
  const comparison = byId("revision-compare-dialog");
  expect(comparison).not.toBeNull();
  const versions = [
    ...(comparison?.querySelectorAll(
      '[data-testid="revision-compare-source"]',
    ) ?? []),
  ].map((node) => node.textContent);
  expect(versions).toEqual([local, disk]);
  expect(changeDraft).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

test("recreating a missing autosave file requires confirmation of its exact bound path", async () => {
  const recreate = vi.fn(async () => true);
  liveSession.overrides = {
    recreateFile: recreate,
    writePaused: true,
    recoveryPending: true,
    conflict: {
      kind: "file",
      message: "The autosave file is missing.",
      conflicts: [],
      signature: "missing-v1",
      state: {
        canRecreateFile: true,
        disk: { availability: "missing", path: "/practice/release.md" },
        review: {
          title: "Release plan",
          destinationPath: "/practice/release.md",
        },
        draft: { markdown: "My working draft." },
      },
    },
  };
  await render();
  const action = byId("revision-recreate-file");
  expect(action).not.toBeNull();
  await act(async () => action?.click());
  const confirmation = byId("revision-recreate-dialog");
  expect(confirmation?.textContent).toContain("/practice/release.md");
  expect(confirmation?.textContent).toContain("If the file appears first");
  expect(recreate).not.toHaveBeenCalled();
  await act(async () => byId("revision-recreate-confirm")?.click());
  expect(recreate).toHaveBeenCalledExactlyOnceWith("/practice/release.md");
});

test("an arriving file disables an already-open recreation confirmation", async () => {
  const recreate = vi.fn(async () => true);
  const missing = {
    kind: "file",
    message: "The autosave file is missing.",
    conflicts: [],
    signature: "missing-v1",
    state: {
      canRecreateFile: true,
      disk: { availability: "missing", path: "/practice/release.md" },
      review: {
        title: "Release plan",
        destinationPath: "/practice/release.md",
      },
      draft: { markdown: "My draft." },
    },
  };
  liveSession.overrides = {
    recreateFile: recreate,
    writePaused: true,
    recoveryPending: true,
    conflict: missing,
  };
  await render();
  await act(async () => byId("revision-recreate-file")?.click());
  liveSession.overrides.conflict = {
    ...missing,
    signature: "arrived-v2",
    state: {
      ...missing.state,
      canRecreateFile: false,
      disk: { ...missing.state.disk, availability: "available" },
    },
  };
  await render();
  expect(byId("revision-recreate-dialog")?.textContent).toContain("changed");
  expect(
    (byId("revision-recreate-confirm") as HTMLButtonElement | null)?.disabled,
  ).toBe(true);
  await act(async () => byId("revision-recreate-confirm")?.click());
  expect(recreate).not.toHaveBeenCalled();
});

test.each([
  "review-only",
  "missing source",
  "unsupported",
  "appeared",
] as const)("Recreate file is unavailable for %s", async (scenario) => {
  const bound = scenario !== "review-only" && scenario !== "missing source";
  liveSession.overrides = {
    recreateFile: vi.fn(),
    writePaused: true,
    recoveryPending: true,
    conflict: {
      kind: "file",
      message: "File unavailable.",
      conflicts: [],
      signature: "missing-v1",
      state: {
        canRecreateFile: scenario !== "unsupported",
        disk:
          scenario === "review-only"
            ? null
            : {
                availability: scenario === "appeared" ? "available" : "missing",
                path: "/practice/source.md",
              },
        review: {
          title: "Review",
          destinationPath: bound ? "/practice/source.md" : null,
          autosave: bound ? "/practice/source.md" : "none",
          liveSourcePath:
            scenario === "missing source" ? "/practice/source.md" : null,
        },
        draft: { markdown: "Working draft." },
      },
    },
  };
  await render();
  expect(byId("revision-recreate-file")).toBeNull();
});
