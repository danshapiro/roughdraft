import {
  extractRoughdraftReviewIndex,
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncState,
} from "@roughdraft/rfm";
import type { Editor } from "@tiptap/core";
import { closeHistory, undo } from "@tiptap/pm/history";
import { act, useEffect, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import { TooltipProvider } from "./components/ui/tooltip";
import { RevisionEditor } from "./RevisionEditor";
import {
  cleanRevisionMarkdown,
  cleanRevisionSourceMarkdown,
} from "./revision-markdown";
import type {
  RevisionDraft,
  RevisionSessionController,
} from "./revision-session";

const mounted = vi.hoisted(() => ({
  editor: null as Editor | null,
  controller: null as RevisionSessionController | null,
  request: null as
    | null
    | (<T>(path: string, body?: object) => Promise<T | null>),
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
            request: async <T,>(path: string, body?: object) =>
              mounted.request?.<T>(path, body) ?? null,
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
beforeEach(() => {
  mounted.editor = null;
  mounted.controller = null;
  mounted.request = null;
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  mounted.controller?.stop();
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  container.remove();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

test("keeping a suggestion and rewriting a long paragraph preserves exact list spelling and CRLF through native typing and Undo", async () => {
  const opening = "a".repeat(1900);
  const rewritten = "b".repeat(1900);
  const suffix = " typing remains immediate";
  const source = [
    "# Continued review",
    "",
    "* Keep this exact list marker.",
    "* Keep this neighboring item.",
    "",
    "A {==stable passage==}{>>Keep this comment attached.<<}{#c1}.",
    "",
    "Review {~~old~>new~~}{#s1} wording.",
    "",
    "Leave {++pending wording++}{#s2} undecided.",
    "",
    opening,
    "",
    "Footer stays unchanged.",
    "",
  ].join("\r\n");
  const initial = {
    id: "spelling-rewrite",
    revision: 1,
    mode: "document",
    title: "Review exact source spelling after continued edits",
    editor: "unified",
    beforeLabel: "Original",
    afterLabel: "Working",
    targetPath: "/practice.md",
    beforeText: source,
    afterText: source,
    segments: [],
    comment: "",
    reviewComments: [],
    status: "open",
    completion: null,
    targetChanged: false,
    draft: null,
    autosave: "/practice.md",
    destinationPath: "/practice.md",
    savedPath: "/practice.md",
    savedText: source,
    handoff: "chat",
  } as ComparisonReviewData;
  let current: SyncState<ComparisonReviewData> = {
    review: initial,
    draft: {
      markdown: source,
      cleanMarkdown: cleanRevisionMarkdown(source),
      decisions: {},
      reviewComments: [],
    },
    revision: 1,
    signature: "initial",
    registryGeneration: "1",
    disk: {
      path: "/practice.md",
      version: "1",
      hash: "1",
      text: source,
      availability: "available",
    },
    operationContext: {
      owner: "test",
      epoch: "epoch",
      acceptUntil: Date.now() + 120000,
    },
  };
  mounted.request = async <T,>(
    path: string,
    body?: object,
  ): Promise<T | null> => {
    if (!body) return structuredClone(current) as T;
    if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
    const sent = body as ReconcileRequest;
    const draft = sent.draft;
    if (!current.disk) throw new Error("The fixture requires its bound file");
    current = {
      ...current,
      draft,
      signature: reviewDraftSignature(draft),
      revision: current.revision + 1,
      registryGeneration: String(current.revision + 1),
      review: {
        ...current.review,
        draft,
        reviewComments: draft.reviewComments,
        savedText: draft.cleanMarkdown ?? draft.markdown,
        revision: current.revision + 1,
        lastOperation: {
          id: sent.operationId,
          pageInstanceId: sent.pageInstanceId,
          reason: sent.reason,
        },
      },
      disk: {
        ...current.disk,
        text: draft.cleanMarkdown ?? draft.markdown,
        version: String(current.revision + 1),
      },
    };
    return { status: "committed", state: structuredClone(current) } as T;
  };
  await act(async () =>
    root.render(
      <TooltipProvider>
        <RevisionEditor initial={initial} />
      </TooltipProvider>,
    ),
  );
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  if (!mounted.editor || !mounted.controller)
    throw new Error("Expected the actual editor and controller");
  const editor = mounted.editor as Editor;
  const controller = mounted.controller as RevisionSessionController;
  vi.useFakeTimers();
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="comment-rail-s1-action-accept"]',
      )
      ?.click();
    await controller.flush();
    await vi.advanceTimersByTimeAsync(0);
  });
  const kept = controller.readDraft();
  expect(kept.reviewed).toHaveLength(1);
  expect(kept.cleanMarkdown).toContain("Review new wording.");
  expect(kept.cleanMarkdown).toContain("* Keep this exact list marker.\r\n");
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === opening) from = pos;
  });
  expect(from).toBeGreaterThan(0);
  await act(async () => {
    editor.view.dispatch(
      closeHistory(
        editor.state.tr.insertText(rewritten, from, from + opening.length),
      ),
    );
    for (const [index, character] of [...suffix].entries())
      editor.view.dispatch(
        editor.state.tr.insertText(character, from + rewritten.length + index),
      );
    await controller.flush();
    await vi.advanceTimersByTimeAsync(0);
  });
  const saved = controller.readDraft();
  const expected = cleanRevisionSourceMarkdown(source)
    .replace("Review old wording.", "Review new wording.")
    .replace(opening, rewritten + suffix);
  expect(saved.cleanMarkdown).toBe(expected);
  expect(current.disk?.text).toBe(expected);
  expect(
    saved.reviewComments.find((comment) => comment.id === "c1")?.content,
  ).toBe("Keep this comment attached.");
  expect(
    extractRoughdraftReviewIndex(saved.markdown)
      .items.filter((item) => item.kind === "suggestion")
      .map((item) => item.id),
  ).toEqual(["s2"]);
  expect(saved.reviewed).toHaveLength(1);
  await act(async () => {
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    await controller.flush();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(controller.readDraft().cleanMarkdown).toBe(
    expected.replace(rewritten + suffix, opening),
  );
});
