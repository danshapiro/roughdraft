import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useComparisonReadingPosition } from "./comparison-reading-position";

describe("comparison reading position", () => {
  it("follows the next passage when the reading line is below the previous paragraph's text", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let scrollY = 1000;
    let source = false;
    const initialScrollY = scrollY;
    const rect = (top: number, height: number) =>
      new DOMRect(0, top, 400, height);
    const paragraphRect = (unit: string, text: boolean) => {
      const drift = initialScrollY - scrollY;
      if (unit === "unit-0")
        return rect((text ? 197 : 170) + drift, text ? 20 : source ? 75 : 50);
      return rect(
        (text ? 240 : 238) + (source ? 25 : 0) + drift,
        text ? 20 : 50,
      );
    };
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(720);
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
    vi.spyOn(window, "scrollBy").mockImplementation(
      (options?: ScrollToOptions | number) => {
        if (typeof options === "object") scrollY += options.top ?? 0;
      },
    );
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.tagName === "HEADER") return rect(0, 52);
        return paragraphRect(this.dataset.comparisonAnchor ?? "unit-1", false);
      },
    );
    vi.spyOn(document, "createRange").mockImplementation(() => {
      let node: Node;
      return {
        setStart(next: Node) {
          node = next;
        },
        setEnd() {},
        getBoundingClientRect() {
          return paragraphRect(
            node.parentElement?.dataset.comparisonAnchor ?? "unit-1",
            true,
          );
        },
      } as unknown as Range;
    });

    function Reader() {
      const [literal, setLiteral] = useState(false);
      const documentRef = useRef<HTMLDivElement>(null);
      const headerRef = useRef<HTMLElement>(null);
      const capture = useComparisonReadingPosition(
        documentRef,
        headerRef,
        String(literal),
      );
      return (
        <>
          <header ref={headerRef}>
            <button
              type="button"
              data-testid="reading-position-switch"
              onClick={() => {
                capture();
                source = true;
                setLiteral(true);
              }}
            >
              Markdown
            </button>
          </header>
          <div ref={documentRef}>
            <p data-comparison-anchor="unit-0">
              Previous reference{literal ? " https://example.com" : ""}
            </p>
            <p data-comparison-anchor="unit-1">Current reading passage</p>
          </div>
        </>
      );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Reader />));
      await act(async () =>
        container
          .querySelector<HTMLElement>('[data-testid="reading-position-switch"]')
          ?.click(),
      );
      // The literal URL adds a line to the previous paragraph. Its trailing
      // line-box space must not make it the anchor for the next passage.
      expect(paragraphRect("unit-1", true).top).toBe(240);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
