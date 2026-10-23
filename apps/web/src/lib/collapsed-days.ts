import { createSignal } from "solid-js";

/**
 * Which days have their route folded; every day's summary is always shown.
 * Only explicit choices are stored; with no choice, a route is open only on
 * the day itself, so the trip reads as a list of summaries with today's
 * route spelled out. Per device, like the theme: a reading preference, not
 * trip data. (A new key: the old one stored whole-day folds.)
 */
const STORAGE_KEY = "travel-companion:collapsed-routes";

type Choices = Record<string, boolean>;

function readStored(): Choices {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Choices) : {};
  } catch {
    // Private browsing and blocked site data both throw on access.
    return {};
  }
}

const [choices, setChoices] = createSignal<Choices>(readStored());

function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function isDayCollapsed(dayId: string, date: string): boolean {
  return choices()[dayId] ?? date !== localToday();
}

export function setDayCollapsed(dayId: string, collapsed: boolean): void {
  const next = { ...choices(), [dayId]: collapsed };
  setChoices(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Still works for this visit; it just will not be remembered.
  }
}

/** Fold or unfold every day at once, as explicit choices. */
export function setDaysCollapsed(dayIds: string[], collapsed: boolean): void {
  const next = { ...choices() };
  for (const id of dayIds) next[id] = collapsed;
  setChoices(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Still works for this visit; it just will not be remembered.
  }
}

export function allDaysCollapsed(days: { id: string; date: string }[]): boolean {
  return days.length > 0 && days.every((day) => isDayCollapsed(day.id, day.date));
}
