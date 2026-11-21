/** Reveal every native disclosure around a target before scrolling or focusing it. No data or action side effects. */
export function revealElement(element: HTMLElement, options: ScrollIntoViewOptions = {}) {
  let ancestor: HTMLElement | null = element;
  while (ancestor) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
  element.scrollIntoView({ block: "center", behavior: "smooth", ...options });
}

/** Navigation can arrive before the target or the content above it. Follow layout changes briefly, never the reader. */
export function revealWhenReady(target: () => HTMLElement | null, options: ScrollIntoViewOptions = {}): () => void {
  let previous: string | null = null;
  let active = true;
  let interval: number;
  let deadline: number;
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const stop = () => {
    active = false;
    window.clearInterval(interval);
    window.clearTimeout(deadline);
    inputs.forEach((type) => window.removeEventListener(type, stop, true));
  };
  const position = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    // Cancel out scrolling itself: only actual layout changes should trigger another reveal.
    let top = rect.top;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) top += parent.scrollTop;
    return `${Math.round(top)}:${Math.round(rect.height)}:${Math.round(rect.width)}`;
  };
  const tick = () => {
    if (!active) return;
    const element = target();
    if (!element?.isConnected || position(element) === previous) return;
    revealElement(element, { ...options, behavior: previous === null ? (options.behavior ?? "smooth") : "auto" });
    previous = position(element);
  };
  inputs.forEach((type) => window.addEventListener(type, stop, { capture: true, passive: true }));
  interval = window.setInterval(tick, 120);
  deadline = window.setTimeout(stop, 4000);
  tick();
  return stop;
}
