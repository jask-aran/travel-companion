/**
 * Scroll-spy for day sections: the active day is the first one crossing a
 * band just under the sticky tabs. Sections are contiguous, so the topmost
 * section in the band is the one you are reading. Ranking by visible ratio
 * instead let a short folded day beat a long open one that filled the screen.
 *
 * The last days can be too short to ever reach the band, so reaching the
 * bottom of the page selects the last day.
 */
export function observeActiveDay(
  sectionIds: string[],
  onChange: (dayId: string) => void,
  options?: { root?: Element | null; topOffsetPx?: number },
): () => void {
  if (typeof IntersectionObserver === "undefined" || sectionIds.length === 0) {
    const first = sectionIds[0];
    if (first) onChange(first);
    return () => undefined;
  }

  const topOffset = options?.topOffsetPx ?? 96;
  const inBand = new Set<string>();
  let current = "";
  let atBottom = false;

  const emit = (next: string | undefined) => {
    if (!next || next === current) return;
    current = next;
    onChange(next);
  };

  const pick = () => {
    if (atBottom) return emit(sectionIds.at(-1));
    emit(sectionIds.find((id) => inBand.has(id)));
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) inBand.add(entry.target.id);
        else inBand.delete(entry.target.id);
      }
      pick();
    },
    { root: options?.root ?? null, rootMargin: `-${topOffset}px 0px -55% 0px`, threshold: 0 },
  );

  for (const id of sectionIds) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }

  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const doc = document.documentElement;
      const bottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 4;
      if (bottom !== atBottom) {
        atBottom = bottom;
        pick();
      }
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    observer.disconnect();
    window.removeEventListener("scroll", onScroll);
    cancelAnimationFrame(frame);
  };
}

export function scrollToDay(dayId: string, behavior?: ScrollBehavior): void {
  const el = document.getElementById(dayId);
  if (!el) return;

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  el.scrollIntoView({
    behavior: behavior ?? (reduceMotion ? "auto" : "smooth"),
    block: "start",
  });
}
