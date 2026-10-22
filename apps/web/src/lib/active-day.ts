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

/**
 * Scroll a day's header to the top. Offscreen days render at an estimated
 * height (content-visibility), so a long smooth scroll can stop well short of
 * a far day as the days it passes take their real size. It keeps going in
 * smooth legs until close, then lands exactly. Resolves when it is done.
 */
export async function scrollToDay(dayId: string): Promise<void> {
  const el = document.getElementById(dayId);
  if (!el) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const target = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const offBy = () => el.getBoundingClientRect().top - target;

  if (!reduceMotion) {
    for (let leg = 0; leg < 4 && Math.abs(offBy()) > window.innerHeight / 2; leg += 1) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      await scrollEnd();
    }
  }
  await land(el, offBy);
}

/** Resolves when a scroll stops. Safari lacks scrollend, hence the timer. */
function scrollEnd(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("scrollend", done);
      resolve();
    };
    const timer = setTimeout(done, 2500);
    window.addEventListener("scrollend", done, { once: true });
  });
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Jump the last stretch without animation, then hold it there until it stays
 * put for a few frames: days rendered for the first time can still shift it.
 * "instant", not "auto": auto defers to the page's smooth scroll-behavior.
 */
async function land(el: HTMLElement, offBy: () => number): Promise<void> {
  let steady = 0;
  for (let frame = 0; frame < 60 && steady < 4; frame += 1) {
    if (Math.abs(offBy()) > 2) {
      el.scrollIntoView({ behavior: "instant", block: "start" });
      steady = 0;
    } else {
      steady += 1;
    }
    await nextFrame();
  }
}
