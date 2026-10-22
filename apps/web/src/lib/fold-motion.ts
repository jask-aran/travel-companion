/**
 * Height animations for folding a day open and shut. The body is measured
 * once it exists, so content of any length animates without a fixed height
 * in CSS. Long days are capped in duration: past a screenful the travel is
 * offscreen anyway.
 */
const EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const duration = (height: number) => Math.min(380, 180 + height / 10);

/**
 * Scroll anchoring off while anything folds. The browser would otherwise pin
 * a card inside the moving body and scroll the page along with it; the
 * header above stays still on its own, which is what the eye is on.
 */
let folding = 0;
function holdAnchoring(): () => void {
  folding += 1;
  document.documentElement.style.overflowAnchor = "none";
  return () => {
    folding -= 1;
    if (folding === 0) document.documentElement.style.overflowAnchor = "";
  };
}

function run(element: HTMLElement, from: number, to: number): Animation {
  element.style.overflow = "hidden";
  const release = holdAnchoring();
  const animation = element.animate(
    [
      { height: `${from}px`, opacity: from === 0 ? 0 : 1 },
      { height: `${to}px`, opacity: to === 0 ? 0 : 1 },
    ],
    { duration: duration(Math.max(from, to)), easing: EASING },
  );
  let done = false;
  const reset = () => {
    if (done) return;
    done = true;
    element.style.overflow = "";
    release();
  };
  animation.addEventListener("finish", reset);
  animation.addEventListener("cancel", reset);
  return animation;
}

/** Drop any fold still running, so a quick reopen starts clean. */
function settle(element: HTMLElement): void {
  for (const animation of element.getAnimations()) animation.cancel();
  element.style.height = "";
}

export function unfold(element: HTMLElement): void {
  settle(element);
  if (reducedMotion()) return;
  run(element, 0, element.scrollHeight);
}

/** Resolves once the body has closed, so the caller can unmount it. */
export function fold(element: HTMLElement): Promise<void> {
  if (reducedMotion()) return Promise.resolve();
  const height = element.getBoundingClientRect().height;
  settle(element);
  const animation = run(element, height, 0);
  // Hold the closed state until the caller unmounts, so it does not flash open.
  animation.addEventListener("finish", () => (element.style.height = "0px"));
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}
