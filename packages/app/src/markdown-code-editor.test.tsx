import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const rangeRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
const rangeBounds = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getBoundingClientRect",
);

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
  await act(async () => root.unmount());
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [
    ["getClientRects", rangeRects],
    ["getBoundingClientRect", rangeBounds],
  ] as const) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
    else Reflect.deleteProperty(Range.prototype, name);
  }
});
function editor() {
  const host = container.querySelector<HTMLElement>(".cm-editor");
  if (!host) throw new Error("Expected a real CodeMirror editor");
  const view = EditorView.findFromDOM(host);
  if (!view) throw new Error("Expected the CodeMirror view");
  return view;
}

test("source composition completion uses the latest callback without another document change", async () => {
  const previous = vi.fn();
  const current = vi.fn();
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <MarkdownCodeEditor
        value={"Stable source.\n"}
        onChange={onChange}
        onCompositionEnd={previous}
      />,
    ),
  );
  const view = editor();
  vi.useFakeTimers();
  await act(async () => {
    view.focus();
    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "日" }),
    );
    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }),
    );
    root.render(
      <MarkdownCodeEditor
        value={"Stable source.\n"}
        onChange={onChange}
        onCompositionEnd={current}
      />,
    );
  });
  await act(async () => vi.advanceTimersByTimeAsync(60));
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
  expect(view.state.sliceDoc()).toBe("Stable source.\n");
});

test("resumed source composition and unmount cancel a pending completion callback", async () => {
  const completed = vi.fn();
  await act(async () =>
    root.render(
      <MarkdownCodeEditor
        value={"Stable source.\n"}
        onChange={() => {}}
        onCompositionEnd={completed}
      />,
    ),
  );
  const view = editor();
  vi.useFakeTimers();
  const composition = (type: "compositionstart" | "compositionend") =>
    view.contentDOM.dispatchEvent(
      new CompositionEvent(type, { bubbles: true }),
    );
  await act(async () => {
    view.focus();
    composition("compositionstart");
    composition("compositionend");
    await vi.advanceTimersByTimeAsync(25);
    composition("compositionstart");
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(completed).not.toHaveBeenCalled();
  await act(async () => {
    composition("compositionend");
    root.render(null);
  });
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(completed).not.toHaveBeenCalled();
});

test("distant incoming source edits retain a caret in unchanged middle text", async () => {
  const original = "First paragraph.\n\nMiddle paragraph.\n\nLast paragraph.\n";
  const incoming = original
    .replace("First", "Incoming first")
    .replace("Last", "Incoming last");
  const onChange = vi.fn();
  await act(async () =>
    root.render(<MarkdownCodeEditor value={original} onChange={onChange} />),
  );
  const view = editor();
  const caret = original.indexOf("Middle") + 3;
  await act(async () => view.dispatch({ selection: { anchor: caret } }));
  await act(async () =>
    root.render(<MarkdownCodeEditor value={incoming} onChange={onChange} />),
  );
  expect(view.state.selection.main.anchor).toBe(incoming.indexOf("Middle") + 3);
  expect(onChange).not.toHaveBeenCalled();
});

test.each([
  "\n",
  "\r\n",
])("incoming source edits preserve backward Unicode selection and %j line endings", async (separator) => {
  const original = [
    "First paragraph.",
    "",
    "Middle 😀 café selected word.",
    "",
    "Last paragraph.",
    "",
  ].join(separator);
  const incoming = original
    .replace("First", "Incoming first")
    .replace("Last", "Incoming last");
  const onChange = vi.fn();
  await act(async () =>
    root.render(<MarkdownCodeEditor value={original} onChange={onChange} />),
  );
  const view = editor();
  const start = view.state.doc.toString().indexOf("selected");
  await act(async () =>
    view.dispatch({
      selection: { anchor: start + "selected".length, head: start },
    }),
  );
  await act(async () =>
    root.render(<MarkdownCodeEditor value={incoming} onChange={onChange} />),
  );
  const expected = view.state.doc.toString().indexOf("selected");
  expect(view.state.selection.main.anchor).toBe(expected + "selected".length);
  expect(view.state.selection.main.head).toBe(expected);
  expect(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
  ).toBe("selected");
  expect(view.state.sliceDoc()).toBe(incoming);
  expect(onChange).not.toHaveBeenCalled();
});

test("a broad outside rewrite keeps the untouched middle source paragraph selected", async () => {
  const words = (prefix: string) =>
    Array.from({ length: 5_000 }, (_, index) => `${prefix}${index}`).join(" ");
  const original = `${words("before")}\n\nStable middle paragraph.\n\n${words("old")}\n`;
  const incoming = `${words("after")}\n\nStable middle paragraph.\n\n${words("new")}\n`;
  const onChange = vi.fn();
  await act(async () =>
    root.render(<MarkdownCodeEditor value={original} onChange={onChange} />),
  );
  const view = editor();
  await act(async () =>
    view.dispatch({
      selection: {
        anchor: original.indexOf("middle"),
        head: original.indexOf("middle") + "middle".length,
      },
    }),
  );
  await act(async () =>
    root.render(<MarkdownCodeEditor value={incoming} onChange={onChange} />),
  );
  expect(view.state.selection.main.anchor).toBe(incoming.indexOf("middle"));
  expect(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
  ).toBe("middle");
  expect(view.state.sliceDoc()).toBe(incoming);
  expect(onChange).not.toHaveBeenCalled();
});

test("remote source updates keep keyboard Undo and Redo routed to shared history", async () => {
  const sourceHistory = { undo: vi.fn(), redo: vi.fn() };
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <MarkdownCodeEditor
        value="Initial source.\n"
        onChange={onChange}
        sourceHistory={sourceHistory}
      />,
    ),
  );
  const view = editor();
  await act(async () =>
    view.dispatch({ changes: { from: 0, insert: "Local " } }),
  );
  expect(onChange).toHaveBeenCalledOnce();
  const incoming = "Incoming heading.\n\nLocal Initial source.\n";
  await act(async () =>
    root.render(
      <MarkdownCodeEditor
        value={incoming}
        onChange={onChange}
        sourceHistory={sourceHistory}
      />,
    ),
  );
  for (const key of ["z", "y"])
    await act(async () => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: `Key${key.toUpperCase()}`,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  expect(sourceHistory.undo).toHaveBeenCalledOnce();
  expect(sourceHistory.redo).toHaveBeenCalledOnce();
  expect(view.state.sliceDoc()).toBe(incoming);
  expect(onChange).toHaveBeenCalledOnce();
});
