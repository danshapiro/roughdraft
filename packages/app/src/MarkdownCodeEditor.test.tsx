import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";

describe("MarkdownCodeEditor interaction modes", () => {
  it("preserves the current draft, selection and undo history when Viewing changes", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let value = "Original draft";
    const onChange = vi.fn((next: string) => { value = next; });
    const view = () => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    const render = async (readOnly: boolean) => {
      await act(async () => root.render(<MarkdownCodeEditor value={value} onChange={onChange} readOnly={readOnly} />));
    };

    try {
      await render(false);
      await act(async () => view().dispatch({
        changes: { from: 0, to: value.length, insert: "Edited draft" },
        selection: { anchor: 5 },
      }));
      await render(false);
      await render(true);
      expect(view().state.doc.toString()).toBe("Edited draft");
      expect(view().state.selection.main.anchor).toBe(5);
      await render(false);
      await act(async () => view().dispatch({ changes: { from: value.length, insert: "!" } }));
      expect(onChange).toHaveBeenLastCalledWith("Edited draft!");
      await act(async () => { undo(view()); });
      expect(view().state.doc.toString()).toBe("Edited draft");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
