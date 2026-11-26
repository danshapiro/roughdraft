import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RevisionRecoveryDialog } from "./RevisionRecoveryDialog";
import { RevisionOutdatedFeedback } from "./RevisionOutdatedFeedback";
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
function button(id: string) {
  return document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
}
const draft = (markdown: string) => ({
  markdown,
  decisions: {},
  reviewComments: [],
});
test("Recovery copies inspect initial and latest source without importing either into the editor", async () => {
  const inspect = vi.fn(async () => ({
    entryDraft: draft("Initial source."),
    workingDraft: draft("Latest source."),
  }));
  await act(async () =>
    root.render(
      <RevisionRecoveryDialog
        open
        onOpenChange={() => {}}
        copies={[{ id: "copy", reason: "Before overwrite" }]}
        orphans={[]}
        onInspect={inspect}
        onInspectOrphan={() => {
          throw new Error("Unused");
        }}
      />,
    ),
  );
  await act(async () => button("revision-recovery-copy-copy")?.click());
  expect(inspect).toHaveBeenCalledWith("copy");
  expect(
    document.querySelector('[data-testid="revision-recovery-source"]')
      ?.textContent,
  ).toBe("Latest source.");
  await act(async () => button("revision-recovery-initial")?.click());
  expect(
    document.querySelector('[data-testid="revision-recovery-source"]')
      ?.textContent,
  ).toBe("Initial source.");
});
test("outdated proposals show original, proposed, attribution and the existing reply thread", async () => {
  await act(async () =>
    root.render(
      <RevisionOutdatedFeedback
        draft={{
          ...draft("Body."),
          outdatedSuggestions: [
            {
              id: "s1",
              originalText: "Original text",
              proposedText: "Proposed text",
              reason: "File changed",
              authorType: "ai",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          reviewComments: [
            {
              id: "c1",
              changeId: "s1",
              parentCommentId: "s1",
              content: "Retained reply",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }}
      />,
    ),
  );
  const section = document.querySelector(
    '[data-testid="revision-outdated-feedback"]',
  );
  expect(section?.textContent).toContain("Original text");
  expect(section?.textContent).toContain("Proposed text");
  expect(section?.textContent).toContain("AI");
  expect(section?.textContent).toContain("Retained reply");
});

test("restores only unfinished feedback after an explicit user action", async () => {
  const snapshot = {
    entryDraft: draft("Original document."),
    workingDraft: draft("Preserved document."),
    uiDrafts: {
      comments: {
        c1: { value: "Unfinished reply", original: "", editing: true },
      },
    },
  };
  const restore = vi.fn(async () => ({ restored: 1, skipped: 0 }));
  await act(async () =>
    root.render(
      <RevisionRecoveryDialog
        open
        onOpenChange={() => {}}
        copies={[{ id: "copy", reason: "Saved feedback" }]}
        orphans={[]}
        onInspect={async () => snapshot}
        onInspectOrphan={() => snapshot}
        onRestore={restore}
      />,
    ),
  );
  await act(async () => button("revision-recovery-copy-copy")?.click());
  expect(restore).not.toHaveBeenCalled();
  const action = document.querySelector<HTMLButtonElement>(
    '[data-testid="revision-recovery-restore-feedback"]',
  );
  expect(action).not.toBeNull();
  await act(async () => action?.click());
  expect(restore).toHaveBeenCalledWith(snapshot);
  expect(
    document.querySelector('[data-testid="revision-recovery-source"]')
      ?.textContent,
  ).toBe("Preserved document.");
  expect(document.body.textContent).toContain("Unfinished feedback restored.");
});

test("restoring the initial copy uses its own feedback and attachment context", async () => {
  const snapshot = {
    entryDraft: draft("Initial context."),
    workingDraft: draft("Latest context."),
    entryUiDrafts: {
      comments: { c1: { value: "Initial draft", original: "", editing: true } },
    },
    uiDrafts: {
      comments: { c1: { value: "Latest draft", original: "", editing: true } },
    },
  };
  const restore = vi.fn(async () => ({ restored: 1, skipped: 0 }));
  await act(async () =>
    root.render(
      <RevisionRecoveryDialog
        open
        onOpenChange={() => {}}
        copies={[{ id: "copy", reason: "Saved feedback" }]}
        orphans={[]}
        onInspect={async () => snapshot}
        onInspectOrphan={() => snapshot}
        onRestore={restore}
      />,
    ),
  );
  await act(async () => button("revision-recovery-copy-copy")?.click());
  await act(async () => button("revision-recovery-initial")?.click());
  await act(async () => button("revision-recovery-restore-feedback")?.click());
  expect(restore).toHaveBeenCalledWith({
    ...snapshot,
    workingDraft: snapshot.entryDraft,
    uiDrafts: snapshot.entryUiDrafts,
  });
});

test("an inspected orphan can be restored explicitly or dismissed only after confirmation", async () => {
  const restore = vi.fn(async () => {});
  const dismiss = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <RevisionRecoveryDialog
        open
        onOpenChange={() => {}}
        copies={[]}
        orphans={[{ key: "closed-tab", aliveAt: 1 }]}
        onInspect={async () => {
          throw new Error("Unused");
        }}
        onInspectOrphan={() => ({
          entryDraft: draft("Earlier."),
          workingDraft: draft("Recover this body."),
        })}
        onClaimOrphan={restore}
        onDismissOrphan={dismiss}
      />,
    ),
  );
  await act(async () => button("revision-recovery-orphan-closed-tab")?.click());
  expect(restore).not.toHaveBeenCalled();
  expect(dismiss).not.toHaveBeenCalled();
  expect(button("revision-recovery-claim")).not.toBeNull();
  await act(async () => button("revision-recovery-claim")?.click());
  expect(restore).toHaveBeenCalledWith("closed-tab");

  await act(async () => button("revision-recovery-orphan-closed-tab")?.click());
  await act(async () => button("revision-recovery-dismiss")?.click());
  expect(dismiss).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "This removes only this browser recovery copy",
  );
  await act(async () => button("revision-recovery-dismiss-confirm")?.click());
  expect(dismiss).toHaveBeenCalledWith("closed-tab");
});
