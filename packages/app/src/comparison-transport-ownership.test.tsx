import { reviewDraftSignature } from "@roughdraft/rfm";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonReview } from "./ComparisonReview";
import { preloadComparison } from "./comparison-bootstrap";
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

function syncState(initial: ComparisonReviewData) {
  if (!initial.draft) throw new Error("Expected a file-backed draft");
  const draft = { ...initial.draft, reviewComments: [] };
  return {
    review: initial,
    draft,
    revision: initial.revision,
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
  };
}

test("Strict Mode startup shares the pending authoritative state read", async () => {
  const initial = review(true);
  const reads: string[] = [];
  const finishes: Array<() => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, window.location.origin);
      if (!url.pathname.endsWith("/state")) return Response.json(initial);
      reads.push(url.pathname);
      return new Promise<Response>((resolve) =>
        finishes.push(() => resolve(Response.json(syncState(initial)))),
      );
    }),
  );
  await act(async () =>
    root.render(
      <StrictMode>
        <ComparisonReview id={initial.id} />
      </StrictMode>,
    ),
  );
  const count = reads.length;
  await act(async () => {
    for (const finish of finishes) finish();
  });
  expect(count).toBe(1);
});

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
  if (unified) {
    expect(paths.filter((path) => path.endsWith("/state"))).toHaveLength(1);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(paths.filter((path) => path.endsWith("/state"))).toHaveLength(2);
  }
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fullRequests()).toHaveLength(unified ? 1 : 3);
  expect(paths.some((path) => path.endsWith("/state"))).toBe(unified);
  await act(async () => root.unmount());
  const requestCount = paths.length;
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(paths).toHaveLength(requestCount);
  root = createRoot(container);
});

test("mounting a review in Strict Mode shares its pending initial read", async () => {
  const initial = review(false);
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  await act(async () => {
    root.render(
      <StrictMode>
        <ComparisonReview id={initial.id} />
      </StrictMode>,
    );
  });
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => finish(Response.json(initial)));
  expect(container.textContent).toContain(initial.targetPath);
  expect(container.textContent).not.toContain("Loading comparison");
});

test("consumes the route's completed early read without another request and reads fresh on a later visit", async () => {
  const initial = review(false);
  const fetcher = vi.fn(async () => Response.json(initial));
  vi.stubGlobal("fetch", fetcher);
  const early = preloadComparison(initial.id);
  await early;
  await act(async () =>
    root.render(<ComparisonReview id={initial.id} initialReview={early} />),
  );
  expect(fetcher).toHaveBeenCalledOnce();
  expect(container.textContent).toContain(initial.targetPath);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<ComparisonReview id={initial.id} />));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("an older navigation's delayed read cannot replace the current review", async () => {
  const initial = review(false);
  const old = { ...initial, id: "old", targetPath: "/practice/old.md" };
  const current = {
    ...initial,
    id: "current",
    targetPath: "/practice/current.md",
  };
  let finishOld!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input.endsWith("/old")
        ? new Promise<Response>((resolve) => {
            finishOld = resolve;
          })
        : Response.json(current),
    ),
  );
  await act(async () => root.render(<ComparisonReview id={old.id} />));
  await act(async () => root.render(<ComparisonReview id={current.id} />));
  expect(container.textContent).toContain(current.targetPath);
  await act(async () => finishOld(Response.json(old)));
  expect(container.textContent).toContain(current.targetPath);
  expect(container.textContent).not.toContain(old.targetPath);
});

test("a failed early read reports its error and does not cache that failure", async () => {
  const initial = review(false);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: "Review server unavailable" }, { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json(initial));
  vi.stubGlobal("fetch", fetcher);
  const early = preloadComparison(initial.id);
  await expect(early).rejects.toThrow("Review server unavailable");
  await act(async () =>
    root.render(<ComparisonReview id={initial.id} initialReview={early} />),
  );
  expect(
    container.querySelector('[data-testid="comparison-page"]')?.textContent,
  ).toBe("Review server unavailable");
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<ComparisonReview id={initial.id} />));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(initial.targetPath);
});

test("a stalled early read is bounded and the next attempt can fetch again", async () => {
  const initial = review(false);
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      (_input: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Read timed out", "AbortError")),
          );
        }),
    )
    .mockResolvedValueOnce(Response.json(initial));
  vi.stubGlobal("fetch", fetcher);
  const early = preloadComparison(initial.id);
  const failure = expect(early).rejects.toThrow("Read timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await failure;
  const fresh = await preloadComparison(initial.id);
  expect(fresh).toEqual(initial);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
