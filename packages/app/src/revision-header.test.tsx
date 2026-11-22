import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import { RevisionEditor } from "./RevisionEditor";

vi.mock("./comparison-reading-position", () => ({
  useComparisonReadingPosition: () => () => {},
}));
vi.mock("./revision-session", () => ({
  useRevisionSession: (session: ComparisonReviewData, draft: unknown) => ({
    session,
    draft,
    updateDraft: vi.fn(),
    readDraft: () => draft,
    run: vi.fn(),
    inspect: vi.fn(),
    recoveryPending: false,
    writePaused: false,
    reviewChanged: false,
    flush: vi.fn(),
  }),
}));
vi.mock("./PageCard", () => ({
  RichTextEditorSurface: ({ interactionMode }: { interactionMode: string }) => (
    <div data-testid="header-test-editor-mode">{interactionMode}</div>
  ),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

function review(overrides: Record<string, unknown> = {}): ComparisonReviewData {
  return {
    id: "review-header",
    revision: 1,
    mode: "compare",
    title: "Improve the laser product page",
    beforeLabel: "Original",
    afterLabel: "Revised",
    beforePath: "/project/test-results/SKILL-before.md",
    afterPath: "/project/skills/laser/SKILL.md",
    autosave: "/project/skills/laser/SKILL.md",
    handoff: "chat",
    targetPath: null,
    beforeText: "Original text\n",
    afterText: "Revised text\n",
    destinationPath: "/project/skills/laser/SKILL.md",
    savedPath: "/project/skills/laser/SKILL.md",
    savedText: "Revised text\n",
    segments: [],
    comment: "",
    status: "open",
    targetChanged: false,
    completion: null,
    ...overrides,
  } as ComparisonReviewData;
}

function byId(id: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function render(overrides: Record<string, unknown> = {}) {
  await act(async () =>
    root.render(<RevisionEditor initial={review(overrides)} />),
  );
}

test("the compact identity shows the agent's title and friendly versions", async () => {
  await render();
  expect(byId("revision-path")?.textContent).toBe(
    "Improve the laser product page",
  );
  expect(byId("revision-identity")?.textContent).toContain("Original");
  expect(byId("revision-identity")?.textContent).toContain("Revised");
  expect(byId("revision-identity")?.textContent).not.toContain("/project/");
  expect(byId("revision-before-label")?.title).toBe(
    "/project/test-results/SKILL-before.md",
  );
  expect(byId("revision-after-label")?.title).toBe(
    "/project/skills/laser/SKILL.md",
  );
});

test("review details expose the exact source paths and preset save destination", async () => {
  await render();
  expect(byId("revision-details")).not.toBeNull();
  await act(async () => byId("revision-details")?.click());
  expect(byId("revision-details-before")?.textContent).toBe(
    "/project/test-results/SKILL-before.md",
  );
  expect(byId("revision-details-after")?.textContent).toBe(
    "/project/skills/laser/SKILL.md",
  );
  expect(byId("revision-details-autosave")?.textContent).toBe(
    "/project/skills/laser/SKILL.md",
  );
});

test("chat reviews have no send-feedback or file-picker actions", async () => {
  await render();
  expect(byId("revision-send")).toBeNull();
  expect(byId("revision-save-as")).toBeNull();
  expect(byId("revision-base-dialog")).toBeNull();
});

test("button integrations retain their explicit feedback action", async () => {
  await render({ handoff: "button" });
  expect(byId("revision-send")?.textContent).toBe("Send feedback");
});

test("saved files use an accessible icon without another status line", async () => {
  await render();
  expect(byId("revision-file-status")?.getAttribute("aria-label")).toBe(
    "Saved to file",
  );
  expect(byId("revision-file-status")?.textContent).toBe("");
});

test("an untouched no-file review with inline comments is already saved", async () => {
  await render({
    autosave: "none",
    destinationPath: null,
    savedPath: null,
    savedText: null,
    draft: null,
    reviewComments: [],
    afterText: "Read {==this==}{>>Check wording<<}{#c1}\n",
  });
  expect(byId("revision-file-status")?.getAttribute("aria-label")).toBe(
    "Review saved",
  );
});

test("explicit no-file reviews stay editable and switch modes through a dropdown", async () => {
  await render({
    autosave: "none",
    destinationPath: null,
    savedPath: null,
    savedText: null,
  });
  expect(byId("header-test-editor-mode")?.textContent).toBe("editing");
  expect(byId("revision-mode")).not.toBeNull();
  await act(async () => byId("revision-mode")?.click());
  expect(byId("revision-mode-suggest")).not.toBeNull();
  await act(async () => byId("revision-mode-suggest")?.focus());
  await act(async () => byId("revision-mode-suggest")?.click());
  expect(byId("header-test-editor-mode")?.textContent).toBe("suggesting");
  expect(byId("revision-base-dialog")).toBeNull();
});

test("the Markdown icon exposes its action and active state", async () => {
  await render();
  expect(byId("revision-format")?.getAttribute("aria-label")).toBe(
    "Show Markdown",
  );
  expect(byId("revision-format")?.textContent).toBe("");
  expect(byId("revision-format")?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => byId("revision-format")?.click());
  expect(byId("revision-format")?.getAttribute("aria-pressed")).toBe("true");
  expect(byId("revision-format")?.getAttribute("aria-label")).toBe(
    "Show formatted document",
  );
  const host =
    byId("revision-markdown")?.querySelector<HTMLElement>(".cm-editor");
  expect(host).toBeTruthy();
  if (!host) throw new Error("Markdown editor was not mounted");
  const source = EditorView.findFromDOM(host);
  expect(source?.state.doc.toString()).toBe("Revised text\n");
  expect(source?.state.readOnly).toBe(false);
});
