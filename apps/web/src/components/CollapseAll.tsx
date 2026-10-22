import { Show } from "solid-js";
import type { TripDay } from "@travel-companion/trip-schema";
import { allDaysCollapsed, setDaysCollapsed } from "../lib/collapsed-days";

/** Folds every day to its header, or opens them all again. */
export function CollapseAll(props: {
  days: TripDay[];
  /** Called just before the change, so the page can hold its place. */
  onToggle?: () => void;
}) {
  const folded = () => allDaysCollapsed(props.days);
  const label = () => (folded() ? "Expand all days" : "Collapse all days");

  return (
    <button
      type="button"
      class="header-button"
      onClick={() => {
        props.onToggle?.();
        setDaysCollapsed(props.days.map((day) => day.id), !folded());
      }}
      aria-label={label()}
      title={label()}
    >
      <Show
        when={folded()}
        fallback={
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 4l5 5 5-5M7 20l5-5 5 5" />
          </svg>
        }
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />
        </svg>
      </Show>
    </button>
  );
}
