/**
 * Observe day sections and report the one that owns the upper itinerary band.
 * Single observer, root-relative margins — no per-frame scroll math.
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

  const root = options?.root ?? null;
  const topOffset = options?.topOffsetPx ?? 96;
  const ratios = new Map<string, number>();
  let current = sectionIds[0] ?? "";

  const emit = (next: string) => {
    if (!next || next === current) return;
    current = next;
    onChange(next);
  };

  const pick = () => {
    let bestId = current;
    let bestRatio = -1;
    for (const id of sectionIds) {
      const ratio = ratios.get(id) ?? 0;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestId = id;
      }
    }
    if (bestRatio > 0) {
      emit(bestId);
      return;
    }

    // Fallback: nearest section whose top is at or above the observation band.
    const rootTop =
      root instanceof Element ? root.getBoundingClientRect().top : 0;
    const band = rootTop + topOffset;
    let nearestId = sectionIds[0] ?? current;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      const distance = Math.abs(top - band);
      if (top <= band + 8 && distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = id;
      }
    }
    emit(nearestId);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        ratios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
      }
      pick();
    },
    {
      root,
      // Bias toward the upper portion of the itinerary pane under the sticky tabs.
      rootMargin: `-${topOffset}px 0px -45% 0px`,
      // Three thresholds are enough to rank sections; six fired the callback
      // (and the O(sections) `pick`) far more often during momentum scroll.
      threshold: [0, 0.25, 0.6],
    },
  );

  for (const id of sectionIds) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }

  if (current) onChange(current);

  return () => observer.disconnect();
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
