import { Show } from "solid-js";
import type { TripDay } from "@travel-companion/trip-schema";
import { dayView, setDayView } from "../lib/day-view";

/** Switches the selected day between its Day summary and its Full Day Route. */
export function CollapseRoute(props: {
  day: TripDay;
}) {
  const onRoute = () => dayView(props.day.id) === "route";
  const label = () => (onRoute() ? "Show the Day summary" : "Show the Full Day Route");

  return (
    <button
      type="button"
      class="header-button"
      onClick={() => setDayView(props.day.id, onRoute() ? "summary" : "route")}
      aria-controls={`body-${props.day.id}`}
      aria-pressed={onRoute()}
      aria-label={label()}
      title={label()}
    >
      <Show
        when={!onRoute()}
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
