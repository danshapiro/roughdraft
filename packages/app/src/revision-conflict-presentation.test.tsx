import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SyncConflict } from "@roughdraft/rfm";
import { RevisionConflictBanner } from "./RevisionConflictBanner";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function element(id: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}
async function mount(item: SyncConflict) {
  const resolve = vi.fn(async () => true);
  await act(async () =>
    root.render(
      <RevisionConflictBanner
        conflict={{
          kind: "conflict",
          message: "A newer saved review is available.",
          state: null,
          conflicts: [item],
          signature: "exact-overlap-signature",
        }}
        local={{
          markdown: "My complete annotated review.",
          decisions: {},
          reviewComments: [],
        }}
        onResolve={resolve}
        onRetry={async () => {}}
        onSaveSeparately={() => {}}
      />,
    ),
  );
  await act(async () => element("revision-compare-changes")?.click());
  return resolve;
}

test("a comment removal comparison shows readable feedback and field names instead of raw IDs or object JSON", async () => {
  await mount({
    id: "unchanged-identity",
    kind: "comment",
    label: "comment:c17",
    base: null,
    local: {
      id: "c17",
      changeId: "document",
      content: 'Keep the literal text {"ready":true}.',
      authorType: "user",
    },
    incoming: undefined,
  });
  const dialog = element("revision-compare-dialog");
  expect(dialog?.textContent).toContain("Comment");
  expect(dialog?.textContent).not.toContain("comment:c17");
  const versions = [
    ...document.querySelectorAll('[data-testid="revision-compare-source"]'),
  ].map((node) => node.textContent);
  expect(versions[0]).toContain('Text: Keep the literal text {"ready":true}.');
  expect(versions[0]).toContain("Author: You");
  expect(versions[0]).not.toContain('"changeId"');
  expect(versions[1]).toBe("Removed");
});

test.each([
  [
    "frontmatter.release.owner",
    "Document details · Release · Owner",
    "Nora",
    "Dan",
  ],
  ["frontmatter.decision", "Document details · Decision", "accept", "reject"],
])("metadata comparison preserves authored values for %s", async (label, heading, local, incoming) => {
  await mount({
    id: "metadata-overlap",
    kind: "metadata",
    label,
    base: "Original",
    local,
    incoming,
  });
  expect(element("revision-compare-dialog")?.textContent).toContain(heading);
  const versions = [
    ...document.querySelectorAll('[data-testid="revision-compare-source"]'),
  ].map((node) => node.textContent);
  expect(versions).toEqual([local, incoming]);
});

test("friendly History decisions preserve the exact conflict identity used for confirmation", async () => {
  const item: SyncConflict = {
    id: "history-conflict-id",
    kind: "history",
    label: "history:uuid-unchanged.decision",
    base: null,
    local: "accept",
    incoming: "reject",
  };
  const before = structuredClone(item);
  const resolve = await mount(item);
  expect(element("revision-compare-dialog")?.textContent).toContain(
    "History · Decision",
  );
  const versions = [
    ...document.querySelectorAll('[data-testid="revision-compare-source"]'),
  ].map((node) => node.textContent);
  expect(versions).toEqual(["Kept", "Reverted"]);
  await act(async () => element("revision-compare-done")?.click());
  await act(async () => element("revision-overwrite")?.click());
  await act(async () => element("revision-resolve-confirm")?.click());
  expect(resolve).toHaveBeenCalledExactlyOnceWith(
    "local",
    "exact-overlap-signature",
  );
  expect(item).toEqual(before);
});
