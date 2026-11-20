import { createSignal } from "solid-js";

/**
 * Which view each day shows: its Day summary, or its Full Day Route. Every
 * day opens on the summary; a swipe or a tap is remembered for this visit
 * only, so nothing is stored and a reload starts on the summary again.
 */
export type DayView = "summary" | "route";

const [views, setViews] = createSignal<Record<string, DayView>>({});

export function dayView(dayId: string): DayView {
  return views()[dayId] ?? "summary";
}

export function setDayView(dayId: string, view: DayView): void {
  if (dayView(dayId) === view) return;
  setViews({ ...views(), [dayId]: view });
}
