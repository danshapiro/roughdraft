import { type RefObject, useLayoutEffect, useRef } from "react";

interface ReadingPosition {
  viewKey: string;
  unit: string;
  quote: string[];
  offset: number;
  scrollY: number;
}

function visibleAnchors(root: HTMLElement) {
  return [
    ...root.querySelectorAll<HTMLElement>("[data-comparison-anchor]"),
  ].filter((element) => element.getBoundingClientRect().height > 0);
}

function textNodes(elements: HTMLElement[]) {
  const nodes: Text[] = [];
  for (const element of elements) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      nodes.push(node as Text);
  }
  return nodes;
}

function words(nodes: Text[]) {
  return nodes.flatMap((node) =>
    [...node.data.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({
      node,
      offset: match.index,
      text: match[0],
    })),
  );
}

function wordRange(word: { node: Text; offset: number; text: string }) {
  const range = document.createRange();
  range.setStart(word.node, word.offset);
  range.setEnd(word.node, word.offset + word.text.length);
  return range;
}

/** Source-block IDs map reading locations across all display projections. */
export function useComparisonReadingPosition(
  rootRef: RefObject<HTMLDivElement | null>,
  headerRef: RefObject<HTMLElement | null>,
  viewKey: string,
) {
  const pending = useRef<ReadingPosition | null>(null);
  const reading = useRef<ReadingPosition | null>(null);
  const restoredScroll = useRef<number | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const capture = () => {
    cancelRef.current?.();
    const root = rootRef.current;
    if (!root) return;
    // Keep the original passage while comparing versions, including versions
    // where that passage is absent. Actual reader movement starts a new anchor.
    if (
      reading.current &&
      restoredScroll.current !== null &&
      Math.abs(window.scrollY - restoredScroll.current) < 1
    ) {
      pending.current = { ...reading.current, viewKey };
      return;
    }
    if (window.scrollY === 0) {
      reading.current = {
        viewKey,
        unit: "",
        quote: [],
        offset: 0,
        scrollY: 0,
      };
      pending.current = reading.current;
      return;
    }
    const headerBottom = headerRef.current?.getBoundingClientRect().bottom ?? 0;
    // Anchor the reading passage in the upper quarter of the usable viewport.
    // Text wrapping can change above it when switching to literal Markdown.
    const line = headerBottom + (window.innerHeight - headerBottom) / 4;
    const anchors = visibleAnchors(root).filter((element) =>
      element.textContent?.trim(),
    );
    const first = anchors.find(
      (element) => element.getBoundingClientRect().bottom > line,
    );
    if (!first || first.getBoundingClientRect().top >= window.innerHeight) {
      pending.current = {
        viewKey,
        unit: "",
        quote: [],
        offset: 0,
        scrollY: window.scrollY,
      };
      reading.current = pending.current;
      return;
    }
    const unit = first.dataset.comparisonAnchor ?? "";
    const candidates = words(
      textNodes(
        anchors.filter((element) => element.dataset.comparisonAnchor === unit),
      ),
    );
    // Binary search the first reading line rather than measuring every word.
    let low = 0;
    let high = candidates.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (wordRange(candidates[middle]).getBoundingClientRect().bottom <= line)
        low = middle + 1;
      else high = middle;
    }
    const word = candidates[low];
    pending.current = {
      viewKey,
      unit,
      quote: candidates.slice(low, low + 8).map((item) => item.text),
      offset: word
        ? wordRange(word).getBoundingClientRect().top
        : first.getBoundingClientRect().top,
      scrollY: window.scrollY,
    };
    reading.current = pending.current;
  };

  useLayoutEffect(() => {
    const position = pending.current;
    pending.current = null;
    const root = rootRef.current;
    if (!position || !root || position.viewKey === viewKey) return;
    let frame = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      window.clearTimeout(timeout);
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
        window.removeEventListener(event, stop);
    };
    const restore = () => {
      if (stopped) return;
      if (!position.unit) {
        window.scrollTo({ top: position.scrollY, behavior: "instant" });
        restoredScroll.current = window.scrollY;
        return;
      }
      const anchors = visibleAnchors(root);
      let matching = anchors.filter(
        (element) => element.dataset.comparisonAnchor === position.unit,
      );
      if (!matching.length) {
        // A deleted passage has no clean counterpart. Stay at its nearest block.
        const number = Number(position.unit.slice(5));
        const nearest = anchors.sort(
          (left, right) =>
            Math.abs(Number(left.dataset.comparisonAnchor?.slice(5)) - number) -
            Math.abs(Number(right.dataset.comparisonAnchor?.slice(5)) - number),
        )[0];
        if (!nearest) return;
        matching = [nearest];
      }
      const candidates = words(textNodes(matching));
      let word: (typeof candidates)[number] | undefined;
      for (let length = position.quote.length; length > 0 && !word; length--) {
        const index = candidates.findIndex((_, start) =>
          position.quote
            .slice(0, length)
            .every((text, offset) => candidates[start + offset]?.text === text),
        );
        if (index >= 0) word = candidates[index];
      }
      const top = word
        ? wordRange(word).getBoundingClientRect().top
        : matching[0].getBoundingClientRect().top;
      const delta = top - position.offset;
      if (Math.abs(delta) > 0.5)
        window.scrollBy({ top: delta, behavior: "instant" });
      restoredScroll.current = window.scrollY;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    };
    // Native editors initialize after React commits. Observe their final content
    // and layout, and stop immediately when the reader starts another action.
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    const timeout = window.setTimeout(stop, 1000);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
      window.addEventListener(event, stop, { passive: true });
    cancelRef.current = stop;
    restore();
    schedule();
    return stop;
  }, [rootRef, viewKey]);

  return capture;
}
