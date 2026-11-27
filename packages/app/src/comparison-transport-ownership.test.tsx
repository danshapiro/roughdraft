import { reviewDraftSignature } from "@roughdraft/rfm";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonReview } from "./ComparisonReview";
import type { ComparisonReviewData } from "./comparison-types";

// Keep the actual route, unified editor, controller and live transport mounted.
// The rich-text DOM is unrelated to which parent owns background requests.
vi.mock("./PageCard", () => ({
  RichTextEditorSurface: () => <div data-testid="transport-editor-surface" />,
}));
vi.mock("./comparison-reading-position", () => ({
  useComparisonReadingPosition: () => () => {},
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("SharedWorker", undefined);
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function review(unified: boolean): ComparisonReviewData {
  const markdown = "First paragraph.\n\nFinal paragraph.\n";
  return {
    id: unified ? "unified-transport" : "legacy-transport",
    revision: 1,
    mode: unified ? "document" : "compare",
    ...(unified ? { editor: "unified" as const } : {}),
    title: "Background updates for the release plan",
    beforeLabel: "Original",
    afterLabel: "Working",
    targetPath: "/practice/release-plan.md",
    beforeText: markdown,
    afterText: markdown,
    segments: [],
    comment: "",
    reviewComments: [],
    status: "open",
    completion: null,
    targetChanged: false,
    autosave: "/practice/release-plan.md",
    handoff: "chat",
    destinationPath: "/practice/release-plan.md",
    savedPath: "/practice/release-plan.md",
    savedText: markdown,
    draft: {
      markdown,
      cleanMarkdown: markdown,
      decisions: {},
    },
  };
}

test.each([
  true,
  false,
])("background destination polling has one owner (unified editor: %s)", async (unified) => {
  const initial = review(unified);
  const fullReviewPath = `/api/comparisons/${initial.id}`;
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, window.location.origin);
      paths.push(url.pathname);
      if (url.pathname === fullReviewPath) return Response.json(initial);
      if (url.pathname === `${fullReviewPath}/state`) {
        if (!initial.draft) throw new Error("Expected a file-backed draft");
        const draft = { ...initial.draft, reviewComments: [] };
        return Response.json({
          review: initial,
          draft,
          revision: 1,
          signature: reviewDraftSignature(draft),
          registryGeneration: "unchanged",
          disk: {
            path: initial.targetPath,
            version: "file-v1",
            hash: "file-hash",
            text: draft.markdown,
            availability: "available",
          },
          operationContext: {
            owner: "test",
            epoch: "one",
            acceptUntil: Date.now() + 120_000,
          },
        });
      }
      throw new Error(`Unexpected background request ${url.pathname}`);
    }),
  );
  await act(async () => root.render(<ComparisonReview id={initial.id} />));
  const fullRequests = () => paths.filter((path) => path === fullReviewPath);
  expect(fullRequests()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fullRequests()).toHaveLength(unified ? 1 : 3);
  expect(paths.some((path) => path.endsWith("/state"))).toBe(unified);
  await act(async () => root.unmount());
  const requestCount = paths.length;
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(paths).toHaveLength(requestCount);
  root = createRoot(container);
});
