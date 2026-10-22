/**
 * Folding a day open and shut. Only opacity and a short slide animate: both
 * run on the compositor, so the fold holds the display's frame rate. An
 * animated height re-laid out the whole page below on every frame, which a
 * phone could not keep up with at 120 Hz and above. The days below move to
 * their new place at once; the eye is on the day being opened.
 */
const EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Drop any fold still running, so a quick reopen starts clean. */
function settle(element: HTMLElement): void {
  for (const animation of element.getAnimations()) animation.cancel();
}

export function unfold(element: HTMLElement): void {
  settle(element);
  if (reducedMotion()) return;
  element.animate(
    [
      { opacity: 0, transform: "translateY(-0.75rem)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 240, easing: EASING },
  );
}

/** Resolves once the body has faded, so the caller can unmount it. */
export function fold(element: HTMLElement): Promise<void> {
  if (reducedMotion()) return Promise.resolve();
  settle(element);
  const animation = element.animate(
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(-0.5rem)" },
    ],
    // Held at the end, so it does not flash back before the caller unmounts.
    { duration: 140, easing: "ease-in", fill: "forwards" },
  );
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}
