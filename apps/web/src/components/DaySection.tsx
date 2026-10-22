import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { DayItem, RouteLeg, TripBundle, TripDay } from "@travel-companion/trip-schema";
import {
  formatArrows,
  formatDayHeading,
  formatDistance,
  formatDurationShort,
  parseTripDate,
} from "../lib/format";
import {
  collectStays,
  daySummarySlots,
  slotToLodgingItem,
  stayForDay,
  stayPlace,
  type LodgingSlot,
} from "../lib/lodging";
import { bindFlights } from "../lib/flight-binding";
import { dayTravelSeconds, dayWalking, stopsBetween, type RouteLegIndex } from "../lib/route-legs";
import { dayRouting, legOutOf as legOutOfDay } from "../lib/day-routing";
import { departureKey } from "../lib/departure-targets";
import { isDayCollapsed, setDayCollapsed } from "../lib/collapsed-days";
import { fold, unfold } from "../lib/fold-motion";
import { sunTimes, type FlightTiming } from "../lib/day-times";
import { DayItemRow, FlightConnector, FlightRow, LodgingBand, RouteLegRow } from "./ItemCards";
import { Hidden, Icon, type IconName } from "./Icon";

/** A stat's name as an icon, the word kept for screen readers. */
function StatName(props: { icon: IconName; label: string }) {
  return (
    <dt class={`day-stats__name day-stats__name--${props.icon}`} title={props.label}>
      <Icon name={props.icon} />
      <Hidden>{props.label}</Hidden>
    </dt>
  );
}

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

function LodgingSlotView(props: {
  slot: LodgingSlot;
  bundle: TripBundle;
  checkOutBy?: string | undefined;
}) {
  return (
    <LodgingBand
      item={slotToLodgingItem(props.slot)}
      place={stayPlace(props.bundle, props.slot.stay)}
      role={props.slot.role}
      checkOutBy={props.slot.role === "check-out" ? props.checkOutBy : undefined}
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
  /** Tapping the header makes this the active day, moving the tab pill. */
  onFocus?: (dayId: string) => void;
}) {
  const stays = createMemo(() => props.stays ?? collectStays(props.bundle));

  const routing = createMemo(() => dayRouting(props.bundle, props.day, stays(), props.legIndex));
  const plan = () => routing().plan;
  const flights = () => routing().flights;
  const routeItems = () => routing().routeItems;
  const binding = createMemo(() => bindFlights(routeItems(), flights()));
  const sequences = createMemo(() => placeSequences(routeItems(), props.stayPlaceIds));
  const wokeInSlot = () => routing().wokeInSlot;
  const wokeIn = () => wokeInSlot()?.stay;
  const sleepsIn = () => routing().sleepsIn;
  const legs = () => routing().legs;
  const endLeg = () => routing().endLeg;
  const placeName = (placeId: string) => props.bundle.places[placeId]?.name;
  /** Names a hotel end of a leg, since the hotel is not a stop beside it. */
  const legOrigin = (leg: { fromPlaceId: string }) =>
    leg.fromPlaceId === wokeIn()?.placeId ? `from ${placeName(leg.fromPlaceId)}` : undefined;
  const timings = () => routing().timings;
  /** The run to the airport starts at the hotel you check out of today. */
  const leavesFromCheckOut = (timing: FlightTiming | undefined) =>
    Boolean(timing?.fromHotel) && wokeInSlot()?.role === "check-out";
  /** Shown on the check-out band rather than the flight. */
  const checkOutBy = createMemo(
    () =>
      flights()
        .map((flight) => timings().get(flight.id))
        .find(leavesFromCheckOut)?.leaveBy,
  );
  const leaveLabel = (timing: FlightTiming | undefined) => {
    const from = timing?.legs[0]?.fromPlaceId;
    if (!from || leavesFromCheckOut(timing)) return undefined;
    return `Leave ${placeName(from) ?? "for the airport"} by`;
  };
  const legOutOf = (placeId: string | undefined) => legOutOfDay(routing(), placeId);
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
  const movingLabel = createMemo(() => formatDurationShort(dayTravelSeconds(allLegs())));
  /** On foot, time over distance: total distance mixed trains in and meant little. */
  const walking = createMemo(() => {
    const walk = dayWalking(allLegs().values());
    const time = formatDurationShort(walk.seconds);
    const distance = formatDistance(walk.metres);
    return time && distance ? { time, distance } : undefined;
  });

  const journeys = () => routing().journeys;
  /** Departure times fetched at pull time for a summary leg, if any. */
  const boardFor = (leg: RouteLeg) => props.bundle.departures?.[departureKey(leg)];

  const stopsLabel = (count: number) =>
    count === 0 ? "No stops" : `${count} stop${count === 1 ? "" : "s"}`;

  /** Places you spend time at between one journey and the next. */
  const stopsBefore = (index: number) => {
    const previous = journeys()[index - 1];
    const current = journeys()[index];
    if (!previous || !current) return undefined;
    return stopsBetween(
      routeItems(),
      previous.toIndex,
      current.fromIndex,
      props.bundle.places,
      props.stayPlaceIds,
    );
  };
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
  /** Where the day starts: the hotel you leave, or the one you stay on in. */
  const startsHere = (slot: LodgingSlot) =>
    slot.role === "check-out" || slot.role === "morning" || slot.role === "stay";
  const leaving = createMemo(() => summarySlots().filter(startsHere));
  const arriving = createMemo(() => summarySlots().filter((slot) => !startsHere(slot)));
  /**
   * Sunset where you are that evening: tonight's hotel, else the last stop
   * with coordinates. Every day carries one zone, which is right for Japan
   * and Korea (both UTC+9).
   */
  const sun = createMemo(() => {
    const stay = stayForDay(stays(), props.day.date);
    const hotel = stay ? stayPlace(props.bundle, stay) : undefined;
    const lastStop = routeItems()
      .flatMap((item) => (item.type === "place" ? [props.bundle.places[item.placeId]] : []))
      .filter((place) => place?.latitude !== undefined && place.longitude !== undefined)
      .at(-1);
    const place = hotel?.latitude !== undefined ? hotel : lastStop;
    if (place?.latitude === undefined || place.longitude === undefined) return undefined;
    const times = sunTimes(props.day.date, place.latitude, place.longitude, props.day.timezone);
    return times.sunrise && times.sunset ? { rise: times.sunrise, set: times.sunset } : undefined;
  });
  const hasStats = createMemo(
    () => stopCount() > 0 || Boolean(movingLabel()) || Boolean(walking()) || Boolean(sun()),
  );
  const hasSummary = createMemo(
    () => hasStats() || summarySlots().length > 0 || flights().length > 0,
  );
  /**
   * A memo, not a plain accessor: the collapsed set is one store for every
   * day, and a fold effect keyed on the raw read would re-run (and replay its
   * unfold) on every day whenever any one of them is toggled.
   */
  const collapsed = createMemo(() => isDayCollapsed(props.day.id, props.day.date));
  const bodyId = () => `body-${props.day.id}`;

  /**
   * The body stays mounted while it folds shut, so it can animate out, and
   * is unmounted after: a folded day costs nothing, photos included.
   */
  const [shown, setShown] = createSignal(!collapsed());
  let body: HTMLDivElement | undefined;
  createEffect(
    on(
      collapsed,
      (isCollapsed) => {
        if (!isCollapsed) {
          setShown(true);
          // After Solid mounts the body (and points `body` at it), before paint.
          queueMicrotask(() => body && unfold(body));
          return;
        }
        if (!body) return setShown(false);
        void fold(body).then(() => {
          // Reopened mid-fold: leave it mounted.
          if (collapsed()) setShown(false);
        });
      },
      { defer: true },
    ),
  );

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
        onClick={() => {
          setDayCollapsed(props.day.id, !collapsed());
          props.onFocus?.(props.day.id);
        }}
      >
        <div class="day-section__index" aria-hidden="true">
          <span class="day-section__num">{String(props.index + 1).padStart(2, "0")}</span>
        </div>
        <div class="day-section__headtext">
          <p class="day-section__date">
            {formatDayHeading(props.day.date)}
            <Show when={baseCity()}>
              {(city) => (
                <span class="day-section__city with-icon">
                  <Icon name="pin" />
                  {city()}
                </span>
              )}
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

      <Show when={shown()}>
        <div class="day-section__body" id={bodyId()} ref={body}>
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
                        <StatName icon="pin" label="Stops" />
                        <dd>{stopCount()}</dd>
                      </div>
                    </Show>
                    <Show when={movingLabel()}>
                      {(label) => (
                        <div>
                          <StatName icon="clock" label="Moving" />
                          <dd>{label()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={walking()}>
                      {(walk) => (
                        <div>
                          <StatName icon="walk" label="Walking" />
                          <dd class="day-stats__pair">
                            <span>{walk().time}</span>
                            <span>{walk().distance}</span>
                          </dd>
                        </div>
                      )}
                    </Show>
                    <Show when={sun()}>
                      {(times) => (
                        <div>
                          <StatName icon="sunset" label="Sunrise and sunset" />
                          <dd class="day-stats__pair">
                            <span>
                              <span aria-hidden="true">↑</span>
                              <Hidden>Sunrise </Hidden>
                              {times().rise}
                            </span>
                            <span>
                              <span aria-hidden="true">↓</span>
                              <Hidden>Sunset </Hidden>
                              {times().set}
                            </span>
                          </dd>
                        </div>
                      )}
                    </Show>
                  </dl>
                </Show>
                <For each={leaving()}>
                  {(slot) => (
                    <LodgingSlotView slot={slot} bundle={props.bundle} checkOutBy={checkOutBy()} />
                  )}
                </For>
                {/* Each flight with its transfers either side, each its own section,
                    so the summary alone gets you from hotel to hotel. A
                    transfer is drawn exactly like a journey: both ends named. */}
                <For each={flights()}>
                  {(item) => (
                    <>
                      <Show when={timings().get(item.id)?.legs.length}>
                        <ol class="day-summary__transfer">
                          <For each={timings().get(item.id)?.legs}>
                            {(leg) => <RouteLegRow leg={leg} places={props.bundle.places} showEnds board={boardFor(leg)} />}
                          </For>
                        </ol>
                      </Show>
                      <ol class="day-summary__flights">
                        <FlightRow
                          item={item}
                          timing={timings().get(item.id)}
                          leaveLabel={leaveLabel(timings().get(item.id))}
                        />
                      </ol>
                      <Show when={legOutOf(item.arrivePlaceId)}>
                        {(leg) => (
                          <ol class="day-summary__transfer">
                            <RouteLegRow leg={leg()} places={props.bundle.places} showEnds board={boardFor(leg())} />
                          </ol>
                        )}
                      </Show>
                    </>
                  )}
                </For>
                {/* Stop counts between journeys give the day its shape: a
                    handful between two long legs is a day out, none is a
                    change of train. */}
                <For each={journeys()}>
                  {(journey, index) => (
                    <>
                      {/* Not `when={count}`: a count of 0 is the case that matters most. */}
                      <Show when={index() > 0}>
                        <p class="day-summary__between with-icon">
                          <Icon name="pin" />
                          {stopsLabel(stopsBefore(index()) ?? 0)}
                        </p>
                      </Show>
                      <ol class="day-summary__transfer">
                        <RouteLegRow
                          leg={journey.leg}
                          places={props.bundle.places}
                          showEnds
                          board={boardFor(journey.leg)}
                        />
                      </ol>
                    </>
                  )}
                </For>
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
