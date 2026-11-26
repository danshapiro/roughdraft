import type { CopyDestination, SyncResult } from "@roughdraft/rfm";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import { RevisionSaveCopyDialog } from "./RevisionSaveCopyDialog";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const destination: CopyDestination = {
  path: "/practice-copy.md",
  displayPath: "/practice-copy.md",
  installationName: "Review server",
  exists: false,
  allowed: true,
  relativeLinks: [],
};
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function confirm() {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="revision-save-copy-confirm"]',
  );
}

test("StrictMode saves show the returned server path", async () => {
  const save = vi.fn(async () => ({
    status: "committed" as const,
    savedPath: "/actual/copy.md",
    reviewUrl: "?comparison=copy",
  }));
  const inspect = vi.fn(async () => destination);
  const check = vi.fn(async () => null);
  await act(async () =>
    root.render(
      <StrictMode>
        <RevisionSaveCopyDialog
          open
          onOpenChange={() => {}}
          inspect={inspect}
          save={save}
          unlock={() => {}}
          checkStatus={check}
        />
      </StrictMode>,
    ),
  );
  await act(async () => confirm()?.click());
  expect(save).toHaveBeenCalledTimes(1);
  expect(
    document.querySelector('[data-testid="revision-copy-saved-path"]')
      ?.textContent,
  ).toBe("/actual/copy.md");
});

test("Copy path works on the existing HTTP LAN installation without the Clipboard API", async () => {
  const copied: string[] = [];
  const select = vi
    .spyOn(HTMLTextAreaElement.prototype, "select")
    .mockImplementation(function (this: HTMLTextAreaElement) {
      copied.push(this.value);
    });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => true),
  });
  try {
    await act(async () =>
      root.render(
        <RevisionSaveCopyDialog
          open
          onOpenChange={() => {}}
          inspect={async () => destination}
          save={async () => ({
            status: "committed",
            savedPath: "/actual/copy.md",
          })}
          unlock={() => {}}
          checkStatus={async () => null}
        />,
      ),
    );
    await act(async () => confirm()?.click());
    const copy = document.querySelector<HTMLButtonElement>(
      '[data-testid="revision-copy-path-to-clipboard"]',
    );
    await act(async () => copy?.click());
    expect(copied).toEqual(["/actual/copy.md"]);
  } finally {
    select.mockRestore();
    Reflect.deleteProperty(document, "execCommand");
  }
});

test("two clicks during path inspection create one copy operation", async () => {
  const releases: Array<(value: CopyDestination) => void> = [];
  let delayed = false;
  const inspect = vi.fn(async () =>
    delayed
      ? await new Promise<CopyDestination>((resolve) => {
          releases.push(resolve);
        })
      : destination,
  );
  const save = vi.fn(async () => ({
    status: "committed" as const,
    savedPath: destination.path,
  }));
  await act(async () =>
    root.render(
      <RevisionSaveCopyDialog
        open
        onOpenChange={() => {}}
        inspect={inspect}
        save={save}
        unlock={() => {}}
        checkStatus={async () => null}
      />,
    ),
  );
  delayed = true;
  await act(async () => {
    confirm()?.click();
    confirm()?.click();
  });
  await act(async () => {
    for (const release of releases) release(destination);
  });
  expect(save).toHaveBeenCalledTimes(1);
});

test("a result returned while closed is acknowledged only after its saved path is shown on reopen", async () => {
  vi.useFakeTimers();
  const completed = {
    status: "committed" as const,
    operationId: "late-copy",
    savedPath: "/late-closed-copy.md",
  };
  let release = (_value: typeof completed) => {};
  const heldStatus = new Promise<typeof completed>((resolve) => {
    release = resolve;
  });
  let cached = false;
  let first = true;
  const check = vi.fn(async () => {
    if (first) {
      first = false;
      return await heldStatus;
    }
    return cached ? completed : null;
  });
  const shown = vi.fn(() => {
    expect(
      document.querySelector('[data-testid="revision-copy-saved-path"]')
        ?.textContent,
    ).toBe(completed.savedPath);
    cached = false;
  });
  const save = vi.fn(async () => completed);
  const render = (open: boolean) =>
    act(async () =>
      root.render(
        <RevisionSaveCopyDialog
          open={open}
          onOpenChange={() => {}}
          inspect={async () => destination}
          save={save}
          unlock={() => {}}
          checkStatus={check}
          onSavedResultShown={shown}
        />,
      ),
    );
  await render(true);
  await render(false);
  await act(async () => {
    cached = true;
    release(completed);
  });
  expect(shown).not.toHaveBeenCalled();
  await render(true);
  expect(
    document.querySelector('[data-testid="revision-copy-saved-path"]')
      ?.textContent,
  ).toBe(completed.savedPath);
  expect(shown).toHaveBeenCalledExactlyOnceWith(completed);
  await render(false);
  await render(true);
  expect(
    document.querySelector<HTMLInputElement>(
      '[data-testid="revision-copy-path"]',
    )?.value,
  ).toBe(destination.path);
  expect(save).not.toHaveBeenCalled();
});

test("a timed-out copy unlocks editing and reopening learns the same saved path", async () => {
  vi.useFakeTimers();
  let release: ((value: SyncResult<ComparisonReviewData>) => void) | undefined;
  let saved = false;
  const inspect = vi.fn(async () => destination);
  const unlock = vi.fn();
  const save = vi.fn(
    async () =>
      await new Promise<SyncResult<ComparisonReviewData>>((resolve) => {
        release = resolve;
      }),
  );
  const check = vi.fn(async () =>
    saved
      ? {
          status: "committed" as const,
          savedPath: "/late/copy.md",
          reviewUrl: "?comparison=copy",
        }
      : null,
  );
  const render = async (open: boolean) =>
    act(async () =>
      root.render(
        <StrictMode>
          <RevisionSaveCopyDialog
            open={open}
            onOpenChange={() => {}}
            inspect={inspect}
            save={save}
            unlock={unlock}
            checkStatus={check}
          />
        </StrictMode>,
      ),
    );
  await render(true);
  await act(async () => confirm()?.click());
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(unlock).toHaveBeenCalled();
  expect(document.body.textContent).toContain("Save status unknown");
  await render(false);
  saved = true;
  await render(true);
  expect(
    document.querySelector('[data-testid="revision-copy-saved-path"]')
      ?.textContent,
  ).toBe("/late/copy.md");
  await act(async () =>
    release?.({
      status: "committed",
      savedPath: "/late/copy.md",
      reviewUrl: "?comparison=copy",
    }),
  );
  expect(save).toHaveBeenCalledTimes(1);
});

test.each([
  "default response",
  "default error",
  "status response",
] as const)("an obsolete initial %s cannot replace a user's chosen path or its validation", async (late) => {
  vi.useFakeTimers();
  let releaseDefault = (_value: CopyDestination) => {};
  let rejectDefault = (_error: Error) => {};
  const defaultInspection = new Promise<CopyDestination>((resolve, reject) => {
    releaseDefault = resolve;
    rejectDefault = reject;
  });
  let releaseStatus = (_value: null) => {};
  const initialStatus = new Promise<null>((resolve) => {
    releaseStatus = resolve;
  });
  const inspect = vi.fn(async (path?: string) =>
    path
      ? { ...destination, path, displayPath: path }
      : await defaultInspection,
  );
  const save = vi.fn(async (path: string) => ({
    status: "committed" as const,
    savedPath: path,
  }));
  await act(async () =>
    root.render(
      <RevisionSaveCopyDialog
        open
        onOpenChange={() => {}}
        inspect={inspect}
        save={save}
        unlock={() => {}}
        checkStatus={async () =>
          late === "status response" ? await initialStatus : null
        }
      />,
    ),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="revision-copy-path"]',
  );
  if (!input) throw new Error("The copy path field is unavailable");
  const chosen = "/my-entered-copy.md";
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, chosen);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    if (late === "default error")
      rejectDefault(new Error("Obsolete default inspection failed"));
    else {
      releaseStatus(null);
      releaseDefault(destination);
    }
  });
  expect(input.value).toBe(chosen);
  expect(document.body.textContent).not.toContain(
    "Obsolete default inspection failed",
  );
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(confirm()?.disabled).toBe(false);
  await act(async () => confirm()?.click());
  expect(save).toHaveBeenCalledExactlyOnceWith(chosen, false);
});

test.each([
  "response",
  "error",
])("typing a new path immediately invalidates an old path inspection %s", async (late) => {
  vi.useFakeTimers();
  let release = (_value: CopyDestination) => {};
  let reject = (_error: Error) => {};
  const oldInspection = new Promise<CopyDestination>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  const inspect = vi.fn(async (path?: string) =>
    path === "/old-choice.md"
      ? await oldInspection
      : {
          ...destination,
          path: path ?? destination.path,
          displayPath: path ?? destination.displayPath,
        },
  );
  const save = vi.fn(async (path: string) => ({
    status: "committed" as const,
    savedPath: path,
  }));
  await act(async () =>
    root.render(
      <RevisionSaveCopyDialog
        open
        onOpenChange={() => {}}
        inspect={inspect}
        save={save}
        unlock={() => {}}
        checkStatus={async () => null}
      />,
    ),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="revision-copy-path"]',
  );
  if (!input) throw new Error("The copy path field is unavailable");
  const type = (value: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await act(async () => type("/old-choice.md"));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(inspect).toHaveBeenCalledWith("/old-choice.md");
  await act(async () => {
    type("/new-choice.md");
    if (late === "error") reject(new Error("The obsolete path is unavailable"));
    else
      release({
        ...destination,
        allowed: false,
        message: "The obsolete path is unavailable",
      });
  });
  expect(input.value).toBe("/new-choice.md");
  expect(document.body.textContent).not.toContain(
    "The obsolete path is unavailable",
  );
  expect(confirm()?.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(confirm()?.disabled).toBe(false);
  await act(async () => confirm()?.click());
  expect(save).toHaveBeenCalledExactlyOnceWith("/new-choice.md", false);
});

test("reopening after a completed copy can prefill a fresh default until the user edits it", async () => {
  vi.useFakeTimers();
  let reopening = false;
  let release = (_value: CopyDestination) => {};
  const nextDefault = new Promise<CopyDestination>((resolve) => {
    release = resolve;
  });
  const inspect = vi.fn(async (path?: string) =>
    !path && reopening
      ? await nextDefault
      : {
          ...destination,
          path: path ?? destination.path,
          displayPath: path ?? destination.displayPath,
        },
  );
  const save = vi.fn(async () => ({
    status: "committed" as const,
    savedPath: destination.path,
  }));
  const render = (open: boolean) =>
    act(async () =>
      root.render(
        <RevisionSaveCopyDialog
          open={open}
          onOpenChange={() => {}}
          inspect={inspect}
          save={save}
          unlock={() => {}}
          checkStatus={async () => null}
        />,
      ),
    );
  await render(true);
  await act(async () => confirm()?.click());
  expect(
    document.querySelector('[data-testid="revision-copy-saved-path"]')
      ?.textContent,
  ).toBe(destination.path);
  await render(false);
  reopening = true;
  await render(true);
  const next = {
    ...destination,
    path: "/fresh-default-copy.md",
    displayPath: "/fresh-default-copy.md",
  };
  await act(async () => release(next));
  expect(
    document.querySelector<HTMLInputElement>(
      '[data-testid="revision-copy-path"]',
    )?.value,
  ).toBe(next.path);
  expect(save).toHaveBeenCalledTimes(1);
});
