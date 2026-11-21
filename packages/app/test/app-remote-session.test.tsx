import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { detectBackend } from "../src/detect-backend";
import type { StorageBackend } from "../src/storage";

vi.mock("../src/detect-backend", () => ({ detectBackend: vi.fn() }));
vi.mock("../src/update-status", () => ({
  fetchUpdateStatus: async () => null,
}));
vi.mock("../src/RoughdraftFormatDemo", () => ({
  RoughdraftFormatDemo: () => null,
}));
vi.mock("../src/DocumentWorkspace", () => ({
  DocumentWorkspace: ({
    documentPage,
  }: {
    documentPage: { content: string };
  }) => (
    <div data-testid="remote-session-workspace">{documentPage.content}</div>
  ),
}));

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("opens the document workspace for a session URL without a local path", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.history.replaceState(null, "", "/?session=remote-session");
  const getMarkdownFile = vi.fn(async () => ({
    id: "remote-session",
    title: "Remote draft",
    content: "Remote draft contents",
    version: "v1",
  }));
  vi.mocked(detectBackend).mockResolvedValue({
    info: { kind: "remote", label: "Remote document", detail: "draft.md" },
    getMarkdownFile,
  } as unknown as StorageBackend);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(<App />));
    expect(getMarkdownFile).toHaveBeenCalledWith("draft.md");
    expect(
      container.querySelector('[data-testid="remote-session-workspace"]')
        ?.textContent,
    ).toBe("Remote draft contents");
    expect(container.querySelector('[data-testid="homepage"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
