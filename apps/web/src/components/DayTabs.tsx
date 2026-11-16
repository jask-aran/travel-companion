import { For, createEffect, on } from "solid-js";
import type { TripDay } from "@travel-companion/trip-schema";
import { formatTabDayMonth, formatTabWeekday, parseTripDate } from "../lib/format";

/**
 * "Mon 23" on one line; the month only where it changes (the first day, and
 * the 1st), so a three-week trip still reads as one run of days.
 */
function tabDate(date: string, first: boolean): string {
  return first || parseTripDate(date).getDate() === 1
    ? formatTabDayMonth(date)
    : String(parseTripDate(date).getDate());
}

export function DayTabs(props: {
  days: TripDay[];
  activeDayId: string;
  /** The phone's date: that day's tab reads "Today". */
  today: string;
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
    <div class="day-tabs" role="tablist" aria-label="Trip days" data-haptic="selection">
      <div class="day-tabs__scroller" ref={scroller}>
        <For each={props.days}>
          {(day, index) => {
            const active = () => day.id === props.activeDayId;
            const today = () => day.date === props.today;
            return (
              <button
                type="button"
                role="tab"
                class="day-tab"
                classList={{ "day-tab--active": active(), "day-tab--today": today() }}
                data-day-id={day.id}
                aria-selected={active()}
                aria-controls={day.id}
                aria-label={`Day ${index() + 1}, ${formatTabWeekday(day.date)} ${formatTabDayMonth(day.date)}${today() ? ", today" : ""}`}
                id={`tab-${day.id}`}
                tabindex={active() ? 0 : -1}
                onClick={() => props.onSelect(day.id)}
                onKeyDown={(event) => {
                  let next: number;
                  switch (event.key) {
                    case "ArrowRight": next = (index() + 1) % props.days.length; break;
                    case "ArrowLeft": next = (index() - 1 + props.days.length) % props.days.length; break;
                    case "Home": next = 0; break;
                    case "End": next = props.days.length - 1; break;
                    default: return;
                  }
                  const target = props.days[next];
                  if (!target) return;
                  event.preventDefault();
                  props.onSelect(target.id);
                  document.getElementById(`tab-${target.id}`)?.focus({ preventScroll: true });
                }}
              >
                <span class="day-tab__weekday">{today() ? "Today" : formatTabWeekday(day.date)}</span>
                <span class="day-tab__date">{tabDate(day.date, index() === 0)}</span>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}
