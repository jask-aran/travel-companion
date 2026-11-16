/**
 * Short haptics as touch feedback, in a small vocabulary:
 *
 * - selection: moving between choices (day tabs, steps, pins, chips). Lightest.
 * - tick: an ordinary button press.
 * - thud: settling into something (the Day map's map mode).
 * - success / failure: something finished, well or not.
 *
 * Android browsers honour the Vibration API. iOS Safari has none, but since
 * iOS 18 toggling a switch-style checkbox (`<input type="checkbox" switch>`)
 * plays the system's selection haptic, so on iOS each pulse toggles a hidden
 * one. That is a workaround, not an API: it needs iOS 18 and, like
 * vibration, a user gesture, and it gives one strength only.
 */
const canVibrate = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

let iosSwitch: HTMLLabelElement | undefined;
function iosPulse(): void {
  if (typeof document === "undefined") return;
  if (!iosSwitch) {
    const label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.display = "none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    label.append(input);
    document.body.append(label);
    iosSwitch = label;
  }
  iosSwitch.click();
}

/** `pattern` for Android; `pulses` for iOS, which has one strength, so a pattern is a count. */
function haptic(pattern: number | number[], pulses = 1): void {
  try {
    if (canVibrate) {
      navigator.vibrate(pattern);
      return;
    }
    iosPulse();
    for (let pulse = 1; pulse < pulses; pulse += 1) setTimeout(iosPulse, pulse * 90);
  } catch {
    // Blocked by a permissions policy or an embedding frame.
  }
}

/** Moving between choices: a day, a step, a pin. */
export const selection = () => haptic(5);
/** A tap landed: any button. */
export const tick = () => haptic(8);
/** Settling into something: the Day map taking over the screen. */
export const thud = () => haptic(16);
/** Something finished well, like a refresh or a copy. */
export const success = () => haptic([10, 60, 14], 2);
/** Something failed. */
export const failure = () => haptic([30, 50, 30], 3);

const KINDS: Record<string, (() => void) | undefined> = { selection, tick, thud, none: undefined };

/**
 * One delegated listener instead of a call in every handler: every enabled
 * button press (and anything acting as one, like a map pin or a tab) ticks.
 * `data-haptic="selection"` (or "none") on the element or an ancestor picks
 * another kind. Links are left alone; they leave the page.
 */
export function installTapHaptics(): void {
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target.closest("button, [role='button'], [role='tab']") : null;
      if (!target || (target instanceof HTMLButtonElement && target.disabled) || target.getAttribute("aria-disabled") === "true") return;
      const kind = target.closest<HTMLElement>("[data-haptic]")?.dataset.haptic ?? "tick";
      (kind in KINDS ? KINDS[kind] : tick)?.();
    },
    { passive: true },
  );
}
