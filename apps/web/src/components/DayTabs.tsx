import { For, createEffect, on } from "solid-js";
import type { TripDay } from "@travel-companion/trip-schema";
import { formatTabDayMonth, formatTabWeekday } from "../lib/format";
import { scrollToDay } from "../lib/active-day";

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
        const tab = scroller?.querySelector<HTMLElement>(`[data-day-id="${activeId}"]`);
        if (!tab || !scroller) return;
        const tabLeft = tab.offsetLeft;
        const tabRight = tabLeft + tab.offsetWidth;
        const viewLeft = scroller.scrollLeft;
        const viewRight = viewLeft + scroller.clientWidth;
        if (tabLeft < viewLeft + 12) {
          scroller.scrollTo({ left: Math.max(0, tabLeft - 24), behavior: "smooth" });
        } else if (tabRight > viewRight - 12) {
          scroller.scrollTo({
            left: tabRight - scroller.clientWidth + 24,
            behavior: "smooth",
          });
        }
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
                onClick={() => {
                  props.onSelect(day.id);
                  scrollToDay(day.id);
                }}
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
