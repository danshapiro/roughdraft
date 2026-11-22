import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";

describe("MarkdownCodeEditor interaction modes", () => {
  it("opens CRLF source without emitting an edit and preserves its line endings when typing", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    const original = "# Notes\r\n\r\nA paragraph.\r\n";
    try {
      await act(async () =>
        root.render(
          <MarkdownCodeEditor value={original} onChange={onChange} />,
        ),
      );
      const element = host.querySelector<HTMLElement>(".cm-editor");
      if (!element) throw new Error("Missing source editor");
      const view = EditorView.findFromDOM(element);
      if (!view) throw new Error("Missing editor state");
      expect(onChange).not.toHaveBeenCalled();
      expect(view.state.sliceDoc()).toBe(original);
      await act(async () => {
        view.dispatch({
          changes: { from: view.state.doc.length, insert: "Another line." },
        });
      });
      expect(onChange).toHaveBeenLastCalledWith(`${original}Another line.`);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it("does not put external document projections into editable source undo history", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    const original = "Use {~~old~>new~~}{#s1}.";
    let time = 1000;
    const date = vi.spyOn(Date, "now").mockImplementation(() => time);
    const render = async (value: string) =>
      act(async () =>
        root.render(<MarkdownCodeEditor value={value} onChange={onChange} />),
      );
    try {
      await render(original);
      time = 2000;
      await render("Use new.");
      time = 3000;
      await render(original);
      const host = container.querySelector<HTMLElement>(".cm-editor");
      if (!host) throw new Error("Missing source editor");
      const view = EditorView.findFromDOM(host);
      if (!view) throw new Error("Missing source editor state");
      await act(async () =>
        view.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "z",
            code: "KeyZ",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(view.state.doc.toString()).toBe(original);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      date.mockRestore();
      await act(async () => root.unmount());
      container.remove();
    }
  });
  it("preserves the current draft and selection when Viewing changes", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let value = "Original draft";
    const onChange = vi.fn((next: string) => {
      value = next;
    });
    const view = () => {
      const element = container.querySelector(".cm-editor");
      if (!(element instanceof HTMLElement))
        throw new Error("Missing code editor");
      const current = EditorView.findFromDOM(element);
      if (!current) throw new Error("Missing CodeMirror view");
      return current;
    };
    const render = async (readOnly: boolean) => {
      await act(async () =>
        root.render(
          <MarkdownCodeEditor
            value={value}
            onChange={onChange}
            readOnly={readOnly}
          />,
        ),
      );
    };

    try {
      await render(false);
      await act(async () =>
        view().dispatch({
          changes: { from: 0, to: value.length, insert: "Edited draft" },
          selection: { anchor: 5 },
        }),
      );
      await render(false);
      await render(true);
      expect(view().state.readOnly).toBe(true);
      expect(view().state.doc.toString()).toBe("Edited draft");
      expect(view().state.selection.main.anchor).toBe(5);
      await render(false);
      expect(view().state.readOnly).toBe(false);
      await act(async () =>
        view().dispatch({ changes: { from: value.length, insert: "!" } }),
      );
      expect(onChange).toHaveBeenLastCalledWith("Edited draft!");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
