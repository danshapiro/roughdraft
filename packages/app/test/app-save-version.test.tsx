import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { detectBackend } from "../src/detect-backend";
import type { StorageBackend } from "../src/storage";

const workspace = vi.hoisted(() => ({
  saveDocument: null as null | ((id: string, content: string) => Promise<void>),
}));
vi.mock("../src/detect-backend", () => ({ detectBackend: vi.fn() }));
vi.mock("../src/update-status", () => ({
  fetchUpdateStatus: async () => null,
}));
vi.mock("../src/DocumentWorkspace", () => ({
  DocumentWorkspace: ({
    onSaveDocument,
  }: {
    onSaveDocument: (id: string, content: string) => Promise<void>;
  }) => {
    workspace.saveDocument = onSaveDocument;
    return null;
  },
}));

afterEach(() => {
  window.history.replaceState(null, "", "/");
  workspace.saveDocument = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("uses the acknowledged version for a queued save before React renders", async () => {
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
  window.history.replaceState(null, "", "/?path=%2Fwork%2Fdraft.md");
  const initialPage = {
    id: "draft.md",
    title: "Draft",
    content: "Original",
    version: "v1",
  };
  const saveMarkdownFile = vi
    .fn()
    .mockResolvedValueOnce({
      ...initialPage,
      content: "First draft",
      version: "v2",
    })
    .mockResolvedValueOnce({
      ...initialPage,
      content: "Latest draft",
      version: "v3",
    });
  vi.mocked(detectBackend).mockResolvedValue({
    info: { kind: "local-files", label: "Local files", detail: "draft.md" },
    canManageProjects: false,
    getMarkdownFile: async () => initialPage,
    saveMarkdownFile,
  } as unknown as StorageBackend);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    const saveDocument = workspace.saveDocument;
    if (!saveDocument) throw new Error("Expected the document save callback");

    // React batches these state updates, as it does when the autosave queue
    // continues immediately after a save response resolves.
    await act(async () => {
      await saveDocument("draft.md", "First draft");
      await saveDocument("draft.md", "Latest draft");
    });

    expect(saveMarkdownFile).toHaveBeenNthCalledWith(
      1,
      "draft.md",
      "First draft",
      "v1",
    );
    expect(saveMarkdownFile).toHaveBeenNthCalledWith(
      2,
      "draft.md",
      "Latest draft",
      "v2",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
