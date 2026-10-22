import { For, Show, createMemo } from "solid-js";
import type { DayItem, FlightItem, TripBundle, TripDay } from "@travel-companion/trip-schema";
import {
  formatArrows,
  formatDayHeading,
  formatDistance,
  formatDuration,
  parseTripDate,
} from "../lib/format";
import {
  collectStays,
  daySummarySlots,
  planDayLodging,
  slotToLodgingItem,
  stayForDay,
  stayPlace,
  type LodgingSlot,
} from "../lib/lodging";
import { bindFlights } from "../lib/flight-binding";
import {
  closingLeg,
  dayTravelMetres,
  dayTravelSeconds,
  legsForDay,
  type RouteLegIndex,
} from "../lib/route-legs";
import { isDayCollapsed, setDayCollapsed } from "../lib/collapsed-days";
import { flightTiming, sunsetTime } from "../lib/day-times";
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

  /**
   * Flights headline the day, so they are lifted out of the route list, in
   * departure order: Wanderlog keeps them in the order they were added.
   */
  const flights = createMemo(() =>
    props.day.items
      .filter((item): item is FlightItem => item.type === "flight")
      .sort((a, b) =>
        `${a.departDate ?? ""} ${a.departTime ?? ""}`.localeCompare(
          `${b.departDate ?? ""} ${b.departTime ?? ""}`,
        ),
      ),
  );

  /** Lodging bookends a day, flights headline it. What is left is the route. */
  const routeItems = createMemo(() =>
    props.day.items.filter((item) => item.type !== "lodging" && item.type !== "flight"),
  );

  const binding = createMemo(() => bindFlights(routeItems(), flights()));
  const sequences = createMemo(() => placeSequences(routeItems(), props.stayPlaceIds));
  /**
   * Wanderlog starts each day at the hotel you woke in and ends it at the one
   * you sleep in, routing to and from them without listing either as a stop.
   */
  const wokeInSlot = createMemo(() =>
    plan().start.find((slot) => slot.role === "check-out" || slot.role === "morning"),
  );
  const wokeIn = () => wokeInSlot()?.stay;
  const sleepsIn = createMemo(
    () =>
      (plan().start.find((slot) => slot.role === "check-in") ??
        plan().end.find((slot) => slot.role === "evening"))?.stay,
  );
  const legs = createMemo(() => legsForDay(routeItems(), props.legIndex, wokeIn()?.placeId));
  const endLeg = createMemo(() => closingLeg(routeItems(), props.legIndex, sleepsIn()?.placeId));
  const placeName = (placeId: string) => props.bundle.places[placeId]?.name;
  /** Names a hotel end of a leg, since the hotel is not a stop beside it. */
  const legOrigin = (leg: { fromPlaceId: string }) =>
    leg.fromPlaceId === wokeIn()?.placeId ? `from ${placeName(leg.fromPlaceId)}` : undefined;
  const timings = createMemo(
    () =>
      new Map(
        flights().map((flight) => [
          flight.id,
          flightTiming(flight, routeItems(), legs(), props.bundle.places),
        ]),
      ),
  );
  /** "Check out by" when the run to the airport starts at the hotel you leave today. */
  const leaveLabel = (fromPlaceId: string | undefined) => {
    if (!fromPlaceId) return undefined;
    if (wokeInSlot()?.role === "check-out" && fromPlaceId === wokeIn()?.placeId) return "Check out by";
    return `Leave ${placeName(fromPlaceId) ?? "for the airport"} by`;
  };

  /** 0 = Sunday, matching Google's opening-hours numbering. */
  const weekday = createMemo(() => parseTripDate(props.day.date).getDay());
  const stopCount = createMemo(() => Math.max(0, ...sequences()));
  /** Every leg the day travels, including the run back to the hotel. */
  const allLegs = createMemo(() => {
    const all = new Map(legs());
    const leg = endLeg();
    if (leg) all.set("end", leg);
    return all;
  });
  const movingLabel = createMemo(() => formatDuration(dayTravelSeconds(allLegs())));
  const distanceLabel = createMemo(() => {
    const metres = dayTravelMetres(allLegs());
    return metres > 0 ? formatDistance(metres) : undefined;
  });
  /** The town the day is based in, from where you sleep. Shown even folded. */
  const baseCity = createMemo(() => {
    const stay = stayForDay(stays(), props.day.date);
    return stay ? stayPlace(props.bundle, stay)?.locality : undefined;
  });

  const summarySlots = createMemo(() => daySummarySlots(plan()));
  /**
   * A day runs: leave the old place, fly, arrive at the new one, then the
   * route. Wanderlog has no check-in/out times, so the role decides the order.
   */
  const leaving = createMemo(() =>
    summarySlots().filter((slot) => slot.role === "check-out" || slot.role === "morning"),
  );
  const arriving = createMemo(() =>
    summarySlots().filter((slot) => slot.role !== "check-out" && slot.role !== "morning"),
  );
  /**
   * Sunset where you are that evening: tonight's hotel, else the last stop
   * with coordinates. Every day carries one zone, which is right for Japan
   * and Korea (both UTC+9).
   */
  const sunset = createMemo(() => {
    const stay = stayForDay(stays(), props.day.date);
    const hotel = stay ? stayPlace(props.bundle, stay) : undefined;
    const lastStop = routeItems()
      .flatMap((item) => (item.type === "place" ? [props.bundle.places[item.placeId]] : []))
      .filter((place) => place?.latitude !== undefined && place.longitude !== undefined)
      .at(-1);
    const place = hotel?.latitude !== undefined ? hotel : lastStop;
    if (place?.latitude === undefined || place.longitude === undefined) return undefined;
    return sunsetTime(props.day.date, place.latitude, place.longitude, props.day.timezone);
  });
  const hasStats = createMemo(
    () => stopCount() > 0 || Boolean(movingLabel()) || Boolean(distanceLabel()) || Boolean(sunset()),
  );
  const hasSummary = createMemo(
    () => hasStats() || summarySlots().length > 0 || flights().length > 0,
  );
  const collapsed = () => isDayCollapsed(props.day.id, props.day.date);
  const bodyId = () => `body-${props.day.id}`;

  return (
    <section
      class="day-section"
      classList={{ "day-section--collapsed": collapsed() }}
      id={props.day.id}
      aria-labelledby={`heading-${props.day.id}`}
    >
      {/* The whole header is the fold control: a big target, and the title
          stays the section's accessible name. */}
      <button
        type="button"
        class="day-section__header"
        aria-expanded={!collapsed()}
        aria-controls={bodyId()}
        onClick={() => setDayCollapsed(props.day.id, !collapsed())}
      >
        <div class="day-section__index" aria-hidden="true">
          {String(props.index + 1).padStart(2, "0")}
        </div>
        <div class="day-section__headtext">
          <p class="day-section__date">
            {formatDayHeading(props.day.date)}
            <Show when={baseCity()}>
              {(city) => <span class="day-section__city">{city()}</span>}
            </Show>
          </p>
          <h2 class="day-section__title" id={`heading-${props.day.id}`}>
            {formatArrows(props.day.title)}
          </h2>
          <Show when={props.day.subtitle}>
            {(subtitle) => <p class="day-section__subtitle">{formatArrows(subtitle())}</p>}
          </Show>
        </div>
        <span class="day-section__chevron" classList={{ "is-open": !collapsed() }} aria-hidden="true" />
      </button>

      <Show when={!collapsed()}>
        <div class="day-section__body" id={bodyId()}>
          {/* The shape of the day up front: how much of it is moving, where
              you sleep, whether you fly. An AI-written summary will sit
              between the figures and the bookings. */}
          <Show when={hasSummary()}>
            <div class="day-part">
              <p class="day-part__label">Day summary</p>
              <div class="day-summary">
                <Show when={hasStats()}>
                  <dl class="day-stats">
                    <Show when={stopCount() > 0}>
                      <div>
                        <dt>Stops</dt>
                        <dd>{stopCount()}</dd>
                      </div>
                    </Show>
                    <Show when={movingLabel()}>
                      {(label) => (
                        <div>
                          <dt>Moving</dt>
                          <dd>{label()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={distanceLabel()}>
                      {(label) => (
                        <div>
                          <dt>Distance</dt>
                          <dd>{label()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={sunset()}>
                      {(time) => (
                        <div>
                          <dt>Sunset</dt>
                          <dd>{time()}</dd>
                        </div>
                      )}
                    </Show>
                  </dl>
                </Show>
                <For each={leaving()}>
                  {(slot) => <LodgingSlotView slot={slot} bundle={props.bundle} />}
                </For>
                <Show when={flights().length > 0}>
                  <ol class="day-summary__flights">
                    <For each={flights()}>
                      {(item) => (
                        <>
                          {/* The run to the airport, so the summary alone gets you there. */}
                          <Show when={timings().get(item.id)?.leg}>
                            {(leg) => (
                              <RouteLegRow
                                leg={leg()}
                                places={props.bundle.places}
                                note={
                                  // The hotel is the band just above; only name a stop.
                                  leg().fromPlaceId === wokeIn()?.placeId
                                    ? undefined
                                    : `from ${placeName(leg().fromPlaceId)}`
                                }
                              />
                            )}
                          </Show>
                          <FlightRow
                            item={item}
                            timing={timings().get(item.id)}
                            leaveLabel={leaveLabel(timings().get(item.id)?.leg?.fromPlaceId)}
                          />
                        </>
                      )}
                    </For>
                  </ol>
                </Show>
                <For each={arriving()}>
                  {(slot) => <LodgingSlotView slot={slot} bundle={props.bundle} />}
                </For>
              </div>
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
                        {(leg) => (
                          <RouteLegRow leg={leg()} places={props.bundle.places} note={legOrigin(leg())} />
                        )}
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
                <Show when={endLeg()}>
                  {(leg) => (
                    <RouteLegRow
                      leg={leg()}
                      places={props.bundle.places}
                      note={`to ${placeName(leg().toPlaceId)}`}
                    />
                  )}
                </Show>
              </ol>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  );
}
