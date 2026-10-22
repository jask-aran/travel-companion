import { For, createEffect, on } from "solid-js";
import type { TripDay } from "@travel-companion/trip-schema";
import { formatTabDayMonth, formatTabWeekday } from "../lib/format";

export function DayTabs(props: {
  days: TripDay[];
  activeDayId: string;
  onSelect: (dayId: string) => void;
}) {
  let scroller!: HTMLDivElement;

  createEffect(
    on(
      () => props.activeDayId,
      (activeId) => {
        // Centre the active pill, so it stays in focus wherever it moved from.
        const tab = scroller?.querySelector<HTMLElement>(`[data-day-id="${activeId}"]`);
        if (!tab || !scroller) return;
        const tabBox = tab.getBoundingClientRect();
        const viewBox = scroller.getBoundingClientRect();
        const offset = tabBox.left + tabBox.width / 2 - (viewBox.left + viewBox.width / 2);
        scroller.scrollTo({ left: Math.max(0, scroller.scrollLeft + offset), behavior: "smooth" });
      },
    ),
  );

  return (
    <div class="day-tabs" role="tablist" aria-label="Trip days">
      <div class="day-tabs__scroller" ref={scroller}>
        <For each={props.days}>
          {(day, index) => {
            const active = () => day.id === props.activeDayId;
            return (
              <button
                type="button"
                role="tab"
                class="day-tab"
                classList={{ "day-tab--active": active() }}
                data-day-id={day.id}
                aria-selected={active()}
                id={`tab-${day.id}`}
                tabindex={active() ? 0 : -1}
                onClick={() => props.onSelect(day.id)}
              >
                <span class="day-tab__index">{String(index() + 1).padStart(2, "0")}</span>
                <span class="day-tab__weekday">{formatTabWeekday(day.date)}</span>
                <span class="day-tab__date">{formatTabDayMonth(day.date)}</span>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}
