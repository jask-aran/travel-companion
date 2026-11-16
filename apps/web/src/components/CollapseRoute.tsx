import { Show } from "solid-js";
import type { TripDay } from "@travel-companion/trip-schema";
import { isDayCollapsed, setDayCollapsed } from "../lib/collapsed-days";

/** Folds or opens the selected day’s route. */
export function CollapseRoute(props: {
  day: TripDay;
}) {
  const folded = () => isDayCollapsed(props.day.id, props.day.date);
  const label = () => (folded() ? "Expand day route" : "Collapse day route");

  return (
    <button
      type="button"
      class="header-button"
      onClick={() => {
        setDayCollapsed(props.day.id, !folded());
      }}
      aria-expanded={!folded()}
      aria-controls={`body-${props.day.id}`}
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
