import { useLayoutEffect, useRef, useState } from "react";

/** Fit the toolbar's current contents, independently of viewport or input type. */
export function useRevisionToolbar() {
  const containerRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ visible: 5, compact: false });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const tools = toolsRef.current;
    const measured = measureRef.current;
    if (!container || !tools || !measured) return;
    const primary = [...tools.children].filter((element) =>
      element.hasAttribute("data-toolbar-primary"),
    );
    const update = () => {
      const style = getComputedStyle(container);
      const available =
        container.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      if (available <= 0) return;
      const gap = parseFloat(getComputedStyle(tools).columnGap) || 0;
      const primaryWidth =
        primary.reduce(
          (width, element) => width + element.getBoundingClientRect().width,
          0,
        ) +
        gap * Math.max(0, primary.length - 1);
      const actions = [
        ...measured.querySelectorAll("[data-toolbar-secondary]"),
      ];
      const overflow = measured.querySelector("[data-toolbar-overflow]");
      if (!actions.length || !overflow) return;
      const origin = measured.getBoundingClientRect();
      const rtl = getComputedStyle(measured).direction === "rtl";
      const prefixWidth = (count: number) => {
        if (!count) return 0;
        const last = actions[count - 1].getBoundingClientRect();
        return rtl ? origin.right - last.left : last.right - origin.left;
      };
      let visible = actions.length;
      if (primaryWidth + prefixWidth(visible) > available + 0.5) {
        visible = 0;
        const moreWidth = overflow.getBoundingClientRect().width;
        for (let count = 1; count < actions.length; count++) {
          if (
            primaryWidth + prefixWidth(count) + gap + moreWidth <=
            available + 0.5
          )
            visible = count;
        }
      }
      const compact = visible < actions.length;
      setLayout((previous) =>
        previous.visible === visible && previous.compact === compact
          ? previous
          : { visible, compact },
      );
    };
    const observer = new ResizeObserver(update);
    for (const element of [container, measured, ...primary])
      observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);

  return { containerRef, toolsRef, measureRef, ...layout };
}
