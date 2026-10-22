/**
 * Short vibrations as touch feedback. Android browsers honour the Vibration
 * API; iOS Safari does not expose one, so there it is a silent no-op.
 */
function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Blocked by a permissions policy or an embedding frame.
  }
}

/** A tap landed: any button or tab. */
export const tick = () => vibrate(8);
/** Something finished well, like a refresh. */
export const success = () => vibrate([10, 60, 14]);
/** Something failed. */
export const failure = () => vibrate([30, 50, 30]);

/**
 * One delegated listener instead of a call in every handler: every enabled
 * button press ticks. Links are left alone; they leave the page.
 */
export function installTapHaptics(): void {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (target && !target.disabled) tick();
    },
    { passive: true },
  );
}
