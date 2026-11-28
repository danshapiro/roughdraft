import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComparisonReview } from "./ComparisonReview";
import type { ComparisonReviewData } from "./comparison-types";
import { TooltipProvider } from "./components/ui/tooltip";

const prefix = "/roughdraft/alpha/signed-review/";
const targetPath = "/home/dan/documents/alpha/nested/Draft.md";
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let base: HTMLBaseElement;

beforeEach(() => {
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
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  base = document.createElement("base");
  base.href = prefix;
  document.head.append(base);
  window.history.replaceState(null, "", `${prefix}?comparison=proposal-links`);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  base.remove();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function proposal(): ComparisonReviewData {
  const beforeText =
    "# Nested review\n\nOriginal nested alpha.\n\n[Neighbor](./Next.md#neighbor)\n\n[Parent](../Next.md#parent)\n";
  const afterText = beforeText.replace("Original", "Proposed");
  return {
    id: "proposal-links",
    revision: 1,
    mode: "proposal",
    title: "Nested review",
    beforeLabel: "Original",
    afterLabel: "Proposed",
    targetPath,
    beforeText,
    afterText,
    segments: [
      {
        id: "proposal-links-change",
        kind: "change",
        before: beforeText,
        after: afterText,
        oldStart: 1,
        newStart: 1,
        decision: "pending",
        comment: "",
      },
    ],
    comment: "",
    reviewComments: [],
    status: "open",
    targetChanged: false,
    completion: null,
  };
}

test.each([
  "diff",
  "before",
  "after",
] as const)("a mounted proposal resolves relative document links once in its %s view", async (view) => {
  const review = proposal();
  const initial = structuredClone(review);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ComparisonReview
          id={review.id}
          initialReview={Promise.resolve(review)}
        />
      </TooltipProvider>,
    ),
  );
  if (view !== "diff") {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="comparison-view-${view}"]`,
    );
    if (!button)
      throw new Error("The comparison version selector did not mount");
    await act(async () => button.click());
  }
  const surface = container.querySelector<HTMLElement>(
    view === "diff"
      ? '[data-testid="comparison-native-document"]'
      : '[data-testid="comparison-clean-preview"]',
  );
  if (!surface) throw new Error("The real comparison editor did not mount");
  expect(surface.textContent).toContain(
    view === "before" ? "Original" : "Proposed",
  );
  for (const [source, expectedPath, expectedHash] of [
    [
      "./Next.md#neighbor",
      "/home/dan/documents/alpha/nested/Next.md",
      "#neighbor",
    ],
    ["../Next.md#parent", "/home/dan/documents/alpha/Next.md", "#parent"],
  ]) {
    const link = surface.querySelector<HTMLAnchorElement>(
      `a[data-markdown-src="${source}"]`,
    ); // selector-check-ignore: authored Markdown destinations are the behavior under test.
    expect(link).not.toBeNull();
    const location = new URL(
      link?.getAttribute("href") ?? "",
      window.location.origin,
    );
    expect.soft(location.searchParams.get("path")).toBe(expectedPath);
    expect(location.pathname).toBe(prefix);
    expect(location.hash).toBe(expectedHash);
    expect(link?.getAttribute("data-markdown-src")).toBe(source);
  }
  expect(review).toEqual(initial);
});
