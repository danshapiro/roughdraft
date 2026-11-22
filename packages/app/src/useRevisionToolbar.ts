import { useLayoutEffect, useRef, useState } from "react";

/** Fit the toolbar's current contents, independently of viewport or input type. */
export function useRevisionToolbar() {
  const containerRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

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
      const required =
        primary.reduce(
          (width, element) => width + element.getBoundingClientRect().width,
          0,
        ) +
        gap * Math.max(0, primary.length - 1) +
        measured.getBoundingClientRect().width;
      setCompact(required > available + 0.5);
    };
    const observer = new ResizeObserver(update);
    for (const element of [container, measured, ...primary])
      observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);

  return { containerRef, toolsRef, measureRef, compact };
}
