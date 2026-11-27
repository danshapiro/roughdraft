import fs from "node:fs";
import path from "node:path";
import {
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
} from "@roughdraft/rfm";
import type { Editor } from "@tiptap/core";
import { act, useEffect, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import editingReview from "../../../docs/spec/fixtures/editing-review.md?raw";
import { ComparisonStore } from "../../server/src/comparisons";
import type { ComparisonReviewData } from "./comparison-types";
import { TooltipProvider } from "./components/ui/tooltip";
import { RevisionEditor } from "./RevisionEditor";
import { adoptRevisionDiskAsync } from "./revision-disk-adoption";
import { reopenReviewedChange } from "./revision-history";
import type {
  RevisionDraft,
  RevisionSessionController,
} from "./revision-session";

vi.mock("./revision-disk-adoption", { spy: true });
const mounted = vi.hoisted(() => ({
  editor: null as Editor | null,
  controller: null as RevisionSessionController | null,
  request: null as
    | null
    | (<T>(route: string, body?: object) => Promise<T | null>),
}));
vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));
vi.mock("./comparison-reading-position", () => ({
  useComparisonReadingPosition: () => () => {},
}));
vi.mock("./PageCard", async (load) => {
  const actual = await load<typeof import("./PageCard")>();
  return {
    ...actual,
    RichTextEditorSurface: (
      props: React.ComponentProps<typeof actual.RichTextEditorSurface>,
    ) => (
      <actual.RichTextEditorSurface
        {...props}
        onEditorReady={(editor) => {
          mounted.editor = editor;
          props.onEditorReady?.(editor);
        }}
      />
    ),
  };
});
vi.mock("./revision-session", async (load) => {
  const actual = await load<typeof import("./revision-session")>();
  return {
    ...actual,
    useRevisionSession: (
      initial: ComparisonReviewData,
      seed: RevisionDraft,
    ) => {
      const controller = useMemo(
        () =>
          new actual.RevisionSessionController(initial, seed, {
            request: async <T,>(route: string, body?: object) =>
              mounted.request?.<T>(route, body) ?? null,
            storage: new MemoryStorage(),
            tabStorage: new MemoryStorage(),
            merge: async (base, local, incoming, options) =>
              mergeReviewDrafts(base, local, incoming, {
                ...options,
                server: false,
                budgetMs: 1000,
              }),
          }),
        [initial, seed],
      );
      mounted.controller = controller;
      const snapshot = useSyncExternalStore(
        controller.subscribe,
        controller.getSnapshot,
        controller.getSnapshot,
      );
      useEffect(() => {
        controller.start();
        return () => controller.stop();
      }, [controller]);
      return {
        ...snapshot,
        updateDraft: controller.updateDraft,
        readDraft: controller.readDraft,
        run: controller.run,
        flush: controller.flush,
        registerAdapter: controller.setAdapter,
        generation: controller.getGeneration,
        inspect: controller.inspect,
        retrySync: controller.retry,
      };
    },
  };
});
class MemoryStorage {
  records = new Map<string, string>();
  get length() {
    return this.records.size;
  }
  getItem(key: string) {
    return this.records.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.records.set(key, value);
  }
  removeItem(key: string) {
    this.records.delete(key);
  }
  key(index: number) {
    return [...this.records.keys()][index] ?? null;
  }
}
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let directory: string;
let store: ComparisonStore;
let releaseAck = () => {};
let pendingOperations: Promise<unknown>[];
beforeEach(() => {
  mounted.editor = null;
  mounted.controller = null;
  mounted.request = null;
  vi.mocked(adoptRevisionDiskAsync).mockClear();
  releaseAck = () => {};
  pendingOperations = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  const parent = path.resolve(
    process.cwd(),
    "../../.test-tmp/history-disk-progress",
  );
  fs.mkdirSync(parent, { recursive: true });
  directory = fs.mkdtempSync(path.join(parent, "run-"));
  const fixtures = path.resolve(process.cwd(), "../../docs/spec/fixtures");
  fs.cpSync(
    path.join(fixtures, "editing-review-assets"),
    path.join(directory, "editing-review-assets"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(fixtures, "editing-review-linked.md"),
    path.join(directory, "editing-review-linked.md"),
  );
  store = new ComparisonStore(path.join(directory, "comparisons"), {
    homeDir: directory,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  releaseAck();
  mounted.controller?.stop();
  await act(async () => {
    await Promise.allSettled(pendingOperations);
    root.unmount();
  });
  store.watchers.close();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  container.remove();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

for (const scenario of ["settled", "held", "no outside"] as const) {
  const heldAck = scenario === "held";
  const outsideUpdate = scenario !== "no outside";
  test(`the real editor adopts a file insertion after Keep s10/Revert s11 (${scenario})`, async () => {
    const target = path.join(directory, "practice.md");
    fs.writeFileSync(target, editingReview);
    const opened = store.openDocument({ targetPath: target, autosave: target });
    const sent: Array<{
      reason: unknown;
      writeFile: unknown;
      reviewed: number;
      result: string;
    }> = [];
    const ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    mounted.request = async <T,>(route: string, body?: object) => {
      if (!body) return structuredClone(store.state(opened.id)) as T;
      if (route.endsWith("/checkpoint"))
        return store.checkpoint(
          opened.id,
          body as Record<string, unknown>,
        ) as T;
      if (!route.endsWith("/reconcile")) throw new Error(`Unexpected ${route}`);
      const value = body as Record<string, unknown>;
      const result = store.reconcile(opened.id, value);
      const reviewed = (value.draft as RevisionDraft).reviewed?.length ?? 0;
      sent.push({
        reason: value.reason,
        writeFile: value.writeFile,
        reviewed,
        result: result.status,
      });
      if (heldAck && reviewed === 2 && result.status === "committed") await ack;
      return structuredClone(result) as T;
    };
    await act(async () =>
      root.render(
        <TooltipProvider>
          <RevisionEditor
            initial={
              store.state(opened.id).review as unknown as ComparisonReviewData
            }
          />
        </TooltipProvider>,
      ),
    );
    const controller = mounted.controller;
    if (!controller || !mounted.editor)
      throw new Error("Expected the actual editor and session");
    await act(async () => {
      await controller.flush();
    });
    const choose = async (id: string, decision: string) => {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-testid="comment-rail-${id}-action-${decision}"]`,
      );
      expect(button).not.toBeNull();
      await act(async () => {
        button?.click();
      });
    };
    await choose("s10", "accept");
    await act(async () => {
      await controller.flush();
    });
    await choose("s11", "reject");
    let lastSave: Promise<unknown> | undefined;
    await act(async () => {
      lastSave = controller.flush();
      pendingOperations.push(lastSave);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store.state(opened.id).draft.reviewed).toHaveLength(2);
    if (!heldAck)
      await act(async () => {
        await lastSave;
      });
    const before = fs.readFileSync(target, "utf8");
    const sentBeforeOutside = sent.length;
    const incoming = outsideUpdate
      ? before.replace(
          "# Try Roughdraft",
          "An outside writer added this paragraph above both History examples.\n\n# Try Roughdraft",
        )
      : before;
    if (outsideUpdate) {
      expect(incoming).not.toBe(before);
      fs.writeFileSync(target, incoming);
      store.watchers.invalidate(target);
      await vi.waitFor(() =>
        expect(store.state(opened.id).disk?.text).toBe(incoming),
      );
    }
    let refreshing: Promise<void> | undefined;
    await act(async () => {
      refreshing = controller.refresh(true);
      pendingOperations.push(refreshing);
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseAck();
      await lastSave;
      await refreshing;
      // Let the mounted editor's deferred serialization run before proving
      // that adopting a file never normalizes or writes it back.
      await new Promise((resolve) => setTimeout(resolve, 450));
      await controller.flush();
    });
    try {
      await act(async () => {
        await vi.waitFor(
          () => {
            expect(mounted.editor?.state.doc.textContent).toContain(
              outsideUpdate
                ? "An outside writer added this paragraph"
                : "Try Roughdraft",
            );
            expect(controller.getSnapshot().conflict).toBeNull();
          },
          { timeout: 2500 },
        );
      });
    } finally {
      const outcomes = vi
        .mocked(adoptRevisionDiskAsync)
        .mock.settledResults.map((result) => ({
          type: result.type,
          status:
            result.type === "fulfilled" &&
            result.value &&
            "status" in result.value
              ? result.value.status
              : null,
          reason:
            result.type === "fulfilled" &&
            result.value &&
            "reason" in result.value
              ? result.value.reason
              : null,
        }));
      const conflict = controller.getSnapshot().conflict;
      if (
        conflict ||
        !mounted.editor?.state.doc.textContent.includes(
          outsideUpdate
            ? "An outside writer added this paragraph"
            : "Try Roughdraft",
        )
      ) {
        process.stdout.write(
          `${JSON.stringify({ severity: "info", event: "history-disk-controller-progress", heldAck, sent, conflict: conflict ? { kind: conflict.kind, message: conflict.message } : null, adoptions: outcomes })}\n`,
        );
        const results = path.resolve(
          process.cwd(),
          "../../test-results/live-updates-implementation",
        );
        fs.mkdirSync(results, { recursive: true });
        fs.writeFileSync(
          path.join(
            results,
            `history-controller-${scenario.replaceAll(" ", "-")}.json`,
          ),
          JSON.stringify(
            {
              draft: controller.readDraft(),
              state: store.state(opened.id),
              model: mounted.editor?.state.doc.toJSON(),
              adoptions: outcomes,
            },
            null,
            2,
          ),
        );
      }
    }
    expect(controller.readDraft().reviewed).toHaveLength(2);
    expect(controller.readDraft().reviewComments).toHaveLength(14);
    expect(fs.readFileSync(target, "utf8")).toBe(incoming);
    expect(
      sent.slice(sentBeforeOutside).some((request) => request.writeFile),
    ).toBe(false);
    const editor = mounted.editor;
    if (!editor) throw new Error("The actual editor must remain mounted");
    for (const entry of controller.readDraft().reviewed ?? [])
      expect(reopenReviewedChange(editor.state, entry.id)).not.toBeNull();
    const proposals = (markdown: string) =>
      extractRoughdraftReviewIndex(markdown)
        .items.filter((item) => item.kind === "suggestion")
        .map((item) => item.id)
        .sort();
    expect(proposals(controller.readDraft().markdown)).toEqual(
      proposals(editingReview).filter((id) => id !== "s10" && id !== "s11"),
    );
  }, 20_000);
}
