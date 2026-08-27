import { For, Show, createMemo } from "solid-js";
import type { DayItem, FlightItem, TripBundle, TripDay } from "@travel-companion/trip-schema";
import {
  formatArrows,
  formatDayHeading,
  formatDuration,
  parseTripDate,
} from "../lib/format";
import {
  collectStays,
  daySummarySlots,
  planDayLodging,
  slotToLodgingItem,
  stayPlace,
  type LodgingSlot,
} from "../lib/lodging";
import { bindFlights } from "../lib/flight-binding";
import { dayTravelSeconds, legsForDay, type RouteLegIndex } from "../lib/route-legs";
import { DayItemRow, FlightConnector, FlightRow, LodgingBand, RouteLegRow } from "./ItemCards";

/**
 * Number the sightseeing stops. A place stop that is one of the trip's own
 * stays (Wanderlog lists the hotel as a stop too) is somewhere you sleep, not
 * the Nth thing you see, so it is shown with a bed glyph and skipped here.
 */
function placeSequences(items: DayItem[], stayPlaceIds: Set<string>): number[] {
  let sequence = 0;
  return items.map((item) => {
    if (item.type === "place" && !stayPlaceIds.has(item.placeId)) {
      sequence += 1;
      return sequence;
    }
    return 0;
  });
}

function LodgingSlotView(props: { slot: LodgingSlot; bundle: TripBundle }) {
  return (
    <LodgingBand
      item={slotToLodgingItem(props.slot)}
      place={stayPlace(props.bundle, props.slot.stay)}
      role={props.slot.role}
    />
  );
}

export function DaySection(props: {
  day: TripDay;
  bundle: TripBundle;
  index: number;
  /** Precomputed once per trip in App to avoid recollecting stays per day. */
  stays?: ReturnType<typeof collectStays>;
  /** Precomputed once per trip: route legs indexed by place pair. */
  legIndex: RouteLegIndex;
  /** Place ids that are one of the trip's stays. */
  stayPlaceIds: Set<string>;
}) {
  const stays = createMemo(() => props.stays ?? collectStays(props.bundle));

  const plan = createMemo(() =>
    planDayLodging(
      props.day.date,
      stays(),
      props.bundle.trip.startDate,
      props.bundle.trip.endDate,
    ),
  );

  /** Flights headline the day, so they are lifted out of the route list. */
  const flights = createMemo(() =>
    props.day.items.filter((item): item is FlightItem => item.type === "flight"),
  );

  /** Lodging bookends a day, flights headline it. What is left is the route. */
  const routeItems = createMemo(() =>
    props.day.items.filter((item) => item.type !== "lodging" && item.type !== "flight"),
  );

  const binding = createMemo(() => bindFlights(routeItems(), flights()));
  const sequences = createMemo(() => placeSequences(routeItems(), props.stayPlaceIds));
  const legs = createMemo(() => legsForDay(routeItems(), props.legIndex));

  /** 0 = Sunday, matching Google's opening-hours numbering. */
  const weekday = createMemo(() => parseTripDate(props.day.date).getDay());
  const stopCount = createMemo(() => Math.max(0, ...sequences()));
  const movingLabel = createMemo(() => formatDuration(dayTravelSeconds(legs())));

  const summarySlots = createMemo(() => daySummarySlots(plan()));
  const hasSummary = createMemo(() => summarySlots().length > 0 || flights().length > 0);

  return (
    <section class="day-section" id={props.day.id} aria-labelledby={`heading-${props.day.id}`}>
      <header class="day-section__header">
        <div class="day-section__index" aria-hidden="true">
          {String(props.index + 1).padStart(2, "0")}
        </div>
        <div class="day-section__headtext">
          <p class="day-section__date">{formatDayHeading(props.day.date)}</p>
          <h2 class="day-section__title" id={`heading-${props.day.id}`}>
            {formatArrows(props.day.title)}
          </h2>
          <Show when={props.day.subtitle}>
            {(subtitle) => <p class="day-section__subtitle">{formatArrows(subtitle())}</p>}
          </Show>
          <Show when={stopCount() > 0 || movingLabel()}>
            <p class="day-section__count">
              <Show when={stopCount() > 0}>
                <span>
                  {stopCount()} stop{stopCount() === 1 ? "" : "s"}
                </span>
              </Show>
              <Show when={movingLabel()}>
                {(label) => <span class="day-section__moving">{label()} moving</span>}
              </Show>
            </p>
          </Show>
        </div>
      </header>

      {/* Where you sleep and whether you fly — the shape of the day, up front. */}
      <Show when={hasSummary()}>
        <div class="day-part">
          <p class="day-part__label">Day summary</p>
          <For each={summarySlots()}>
            {(slot) => <LodgingSlotView slot={slot} bundle={props.bundle} />}
          </For>
          <ol class="timeline">
            <For each={flights()}>{(item) => <FlightRow item={item} />}</For>
          </ol>
        </div>
      </Show>

      <Show when={routeItems().length > 0}>
        <div class="day-part">
          <p class="day-part__label">Day route</p>
          <ol class="timeline">
            <For each={routeItems()}>
              {(item, index) => (
                <>
                  {/* A bound flight replaces the ground route into this stop. */}
                  <Show when={binding().before.get(item.id)}>
                    {(flight) => <FlightConnector item={flight()} />}
                  </Show>
                  <Show when={!binding().supersededLegs.has(item.id) && legs().get(item.id)}>
                    {(leg) => <RouteLegRow leg={leg()} />}
                  </Show>
                  <DayItemRow
                    item={item}
                    bundle={props.bundle}
                    placeSequence={sequences()[index()] ?? 0}
                    isStay={item.type === "place" && props.stayPlaceIds.has(item.placeId)}
                    weekday={weekday()}
                  />
                  <Show when={binding().after.get(item.id)}>
                    {(flight) => <FlightConnector item={flight()} />}
                  </Show>
                </>
              )}
            </For>
          </ol>
        </div>
      </Show>
    </section>
  );
}
