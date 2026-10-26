import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { DayItem, DepartureBoard, DepartureOption, RouteLeg, TripBundle, TripDay } from "@travel-companion/trip-schema";
import {
  formatArrows,
  formatDayHeading,
  formatDistance,
  formatDurationShort,
  cityOf,
  isUntitled,
  parseTripDate,
} from "../lib/format";
import {
  collectStays,
  daySummarySlots,
  slotToLodgingItem,
  stayDisplay,
  stayForDay,
  stayPlace,
  type LodgingSlot,
} from "../lib/lodging";
import { bindFlights } from "../lib/flight-binding";
import { dayTravelSeconds, dayWalking, isWaypoint, stopsBetween, type RouteLegIndex } from "../lib/route-legs";
import { leaveFor, pickDeparture, readyAfter } from "../lib/departure-pick";
import { dayRouting, legOutOf as legOutOfDay } from "../lib/day-routing";
import { departureKey } from "../lib/departure-targets";
import { isDayCollapsed, setDayCollapsed } from "../lib/collapsed-days";
import { fold, unfold } from "../lib/fold-motion";
import { shiftClock, sunTimes, type FlightTiming } from "../lib/day-times";
import { clock } from "../lib/clock";
import { DayItemRow, FlightConnector, FlightRow, HotelPill, LodgingBand, RouteLegRow, StayLine, chainOf } from "./ItemCards";
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

/** What a figure is, in words under it; the stat's name already tells screen readers. */
function StatCaption(props: { children: string }) {
  return (
    <span class="day-stats__caption" aria-hidden="true">
      {props.children}
    </span>
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
  date: string;
  checkOutBy?: string | undefined;
}) {
  return (
    <Show
      when={props.slot.role === "stay"}
      fallback={
        <LodgingBand
          item={slotToLodgingItem(props.slot)}
          place={stayPlace(props.bundle, props.slot.stay)}
          role={props.slot.role}
          checkOutBy={props.slot.role === "check-out" ? props.checkOutBy : undefined}
        />
      }
    >
      <StayLine item={slotToLodgingItem(props.slot)} place={stayPlace(props.bundle, props.slot.stay)} date={props.date} />
    </Show>
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
  /** Departures for a leg, shown where you take it: on the day route. */
  const boardFor = (leg: RouteLeg) => props.bundle.departures?.[departureKey(leg)];
  /**
   * Each leg's recommended departure, in route order. Where a ride ends at a
   * station and the next leaves from it, the next can't leave before the
   * first arrives: that is how an impossible connection shows up.
   */
  const legPlans = createMemo(() => {
    const plans = new Map<string, { board: DepartureBoard; notBefore?: string; option?: DepartureOption }>();
    const ordered: [string, RouteLeg][] = [];
    for (const item of routeItems()) {
      const leg = item.type === "place" && !binding().supersededLegs.has(item.id) ? legs().get(item.id) : undefined;
      if (leg) ordered.push([item.id, leg]);
    }
    const last = endLeg();
    if (last) ordered.push(["end", last]);

    let ready: { at: string; placeId: string; sight: boolean } | undefined;
    for (const [key, leg] of ordered) {
      const board = boardFor(leg);
      const carried = ready?.placeId === leg.fromPlaceId ? ready : undefined;
      ready = undefined;
      if (!board) continue;
      // After a sight, a timed board keeps the plan's time (you stay a while);
      // a day board still can't pick a bus that leaves before you got there.
      const notBefore = carried && (!carried.sight || board.target.kind === "day") ? carried.at : undefined;
      const { option } = pickDeparture(board, notBefore);
      plans.set(key, { board, ...(notBefore ? { notBefore } : {}), ...(option ? { option } : {}) });
      // A day board's first bus of the day is no plan to carry on from.
      const at = board.target.kind !== "day" || notBefore ? readyAfter(option) : undefined;
      if (at) ready = { at, placeId: leg.toPlaceId, sight: !isWaypoint(props.bundle.places[leg.toPlaceId]) };
    }
    return plans;
  });
  /** What a leg rides, for the summary, which shows no board: the picked option's lines. */
  const lineFor = (leg: RouteLeg) => {
    const board = boardFor(leg);
    if (!board) return undefined;
    const option = [...legPlans().values()].find((plan) => plan.board === board)?.option ?? board.options[0];
    return option && chainOf(option);
  };
  /**
   * When a summary leg runs, where something with a time fixes it: a time
   * from Wanderlog or a flight (a timed board), or the ride before it (a day
   * board picked from when you get there). The first bus of a day nobody has
   * timed is no time to plan by, so it shows none. Estimates carry a "~".
   */
  const timesFor = (leg: RouteLeg) => {
    const board = boardFor(leg);
    const plan = board && [...legPlans().values()].find((candidate) => candidate.board === board);
    const option = plan?.option;
    if (!board || !option || (board.target.kind === "day" && !plan.notBefore)) return undefined;
    return `${board.approximate ? "~" : ""}${option.departTime}→${option.arriveTime}`;
  };
  /**
   * Out of the hotel by the recommended train, less the walk to it. A walk
   * to the station first (hotel, then Nagoya Station, then the Hida) is
   * worked back through, as long as the stops before the train are only
   * places you pass through.
   */
  const boardLeave = createMemo(() => {
    let previous = wokeIn()?.placeId;
    let lead = 0;
    for (const item of routeItems()) {
      if (item.type !== "place") continue;
      const leg = legs().get(item.id);
      if (!previous || !leg || leg.fromPlaceId !== previous) return undefined;
      // A day board has no time to be out of the hotel for.
      const train = boardFor(leg)?.target.kind === "day" ? undefined : legPlans().get(item.id)?.option;
      if (train) {
        const leave = leaveFor(train);
        return leave && shiftClock(leave, -lead);
      }
      if (item.startTime || !isWaypoint(props.bundle.places[item.placeId])) return undefined;
      lead += Math.ceil((leg.durationSeconds ?? 0) / 60);
      previous = item.placeId;
    }
    return undefined;
  });

  const placeName = (placeId: string) => props.bundle.places[placeId]?.name;

  /** Today's role for the hotel at each end of the route, for its pill. */
  /**
   * When to leave the hotel you woke in: for the airport on a flight day,
   * otherwise in time for the first stop you gave a time in Wanderlog.
   */
  const leaveHotelBy = () => {
    if (boardLeave()) return boardLeave();
    if (checkOutBy()) return checkOutBy();
    // Notes can sit above the first stop; the leg runs to the first place.
    const first = routeItems().find((item) => item.type === "place");
    const start = first?.type === "place" ? first.startTime : undefined;
    const leg = first ? legs().get(first.id) : undefined;
    if (!start || !leg?.durationSeconds || leg.fromPlaceId !== wokeIn()?.placeId) return undefined;
    return shiftClock(start, -Math.ceil(leg.durationSeconds / 60));
  };
  const checksInTonight = () =>
    routing().plan.start.some((slot) => slot.role === "check-in" && slot.stay.key === sleepsIn()?.key);
  const timings = () => routing().timings;
  /** The run to the airport starts at the hotel you check out of today. */
  const leavesFromCheckOut = (timing: FlightTiming | undefined) =>
    Boolean(timing?.fromHotel) && wokeInSlot()?.role === "check-out";
  /** Shown on the check-out band rather than the flight. */
  const checkOutBy = createMemo(() => {
    const timing = flights()
      .map((flight) => timings().get(flight.id))
      .find(leavesFromCheckOut);
    return timing ? (boardLeave() ?? timing.leaveBy) : undefined;
  });
  const leaveLabel = (timing: FlightTiming | undefined) => {
    const from = timing?.legs[0]?.fromPlaceId;
    if (!from || leavesFromCheckOut(timing)) return undefined;
    return `Leave ${placeName(from) ?? "for the airport"} by`;
  };
  /**
   * On the day itself, the next thing with a time: leaving the hotel, being
   * at the airport, a flight, a train or bus to catch, a stop you gave a time.
   * The one after it rides along, so a tight change is seen coming.
   */
  const upcoming = createMemo(() => {
    const now = clock();
    if (props.day.date !== now.date) return [];
    const events: { time: string; text: string }[] = [];
    const leave = leaveHotelBy();
    const stay = wokeIn();
    const hotel = stay && stayDisplay(stay.name, stayPlace(props.bundle, stay)).name;
    if (leave) events.push({ time: leave, text: hotel ? `Leave ${hotel}` : "Leave the hotel" });
    for (const flight of flights()) {
      const airport = flight.departCity ?? flight.departAirport;
      const airportBy = timings().get(flight.id)?.airportBy;
      if (airportBy) events.push({ time: airportBy, text: airport ? `At ${airport} airport` : "At the airport" });
      const code = flight.flightNumber ? `${flight.airlineCode ?? ""}${flight.flightNumber}` : "Flight";
      if (flight.departTime) events.push({ time: flight.departTime, text: `${code} departs` });
    }
    for (const plan of legPlans().values()) {
      // A day board's pick is the first bus you can make; on the day, from now.
      const from = [plan.notBefore, now.time].filter((time): time is string => Boolean(time)).sort().at(-1);
      const option = plan.board.target.kind === "day" ? pickDeparture(plan.board, from).option : plan.option;
      const ride = option?.segments[0];
      if (option && ride) events.push({ time: option.departTime, text: ride.from ? `${ride.name} from ${ride.from}` : ride.name });
    }
    for (const item of routeItems()) {
      if (item.type === "place" && item.startTime) {
        events.push({ time: item.startTime, text: placeName(item.placeId) ?? "Next stop" });
      }
    }
    return events
      .filter((event) => event.time >= now.time)
      .sort((a, b) => a.time.localeCompare(b.time))
      .slice(0, 2);
  });
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
    const place = stay ? stayPlace(props.bundle, stay) : undefined;
    return cityOf(place?.address) ?? place?.locality;
  });
  /** An untitled day goes by where it's spent. */
  const title = () =>
    isUntitled(props.day.title, props.day.date) ? (baseCity() ?? formatDayHeading(props.day.date)) : props.day.title;

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
    const times = sunTimes(props.day.date, place.latitude, place.longitude, props.day.utcOffsetMinutes ?? props.day.timezone);
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
   * The route stays mounted while it folds shut, so it can animate out, and
   * is unmounted after: a folded route costs nothing, photos included.
   */
  const [shown, setShown] = createSignal(!collapsed());
  let body: HTMLOListElement | undefined;
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
      {/* The whole header opens and closes the day's route (the summary is
          always shown): a big target, and the title stays the section's
          accessible name. */}
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
            {formatArrows(title())}
          </h2>
          <Show when={props.day.subtitle}>
            {(subtitle) => <p class="day-section__subtitle">{formatArrows(subtitle())}</p>}
          </Show>
        </div>
      </button>

      <div class="day-section__body">
          <Show when={upcoming()[0]}>
            {(next) => (
              <p class="next-up">
                <span class="next-up__label">Next</span>
                <span class="next-up__main">
                  <time class="next-up__time">{next().time}</time> {next().text}
                </span>
                <Show when={upcoming()[1]}>
                  {(then) => (
                    <span class="next-up__then">
                      then <time>{then().time}</time> {then().text}
                    </span>
                  )}
                </Show>
              </p>
            )}
          </Show>
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
                        <dd>
                          {stopCount()}
                          <StatCaption>{stopCount() === 1 ? "stop" : "stops"}</StatCaption>
                        </dd>
                      </div>
                    </Show>
                    <Show when={movingLabel()}>
                      {(label) => (
                        <div>
                          <StatName icon="clock" label="Moving" />
                          <dd>
                            {label()}
                            <StatCaption>in transit</StatCaption>
                          </dd>
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
                            <StatCaption>walking</StatCaption>
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
                            <StatCaption>daylight</StatCaption>
                          </dd>
                        </div>
                      )}
                    </Show>
                  </dl>
                </Show>
                <For each={leaving()}>
                  {(slot) => (
                    <LodgingSlotView slot={slot} bundle={props.bundle} date={props.day.date} checkOutBy={checkOutBy()} />
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
                            {(leg) => <RouteLegRow leg={leg} places={props.bundle.places} line={lineFor(leg)} times={timesFor(leg)} showEnds />}
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
                            <RouteLegRow leg={leg()} places={props.bundle.places} line={lineFor(leg())} times={timesFor(leg())} showEnds />
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
                          line={lineFor(journey.leg)}
                          times={timesFor(journey.leg)}
                          showEnds
                        />
                      </ol>
                    </>
                  )}
                </For>
                <For each={arriving()}>
                  {(slot) => <LodgingSlotView slot={slot} bundle={props.bundle} date={props.day.date} />}
                </For>
              </div>
            </div>
          </Show>

          <Show when={routeItems().length === 0}>
            <p class="day-part__empty">Nothing planned yet</p>
          </Show>
          <Show when={routeItems().length > 0}>
            <div class="day-part">
              {/* The route is what opens: the summary above says the day's
                  shape at a glance, the route is the detail. */}
              <button
                type="button"
                class="day-part__label day-part__toggle"
                aria-expanded={!collapsed()}
                aria-controls={bodyId()}
                onClick={() => setDayCollapsed(props.day.id, !collapsed())}
              >
                <span>Day route</span>
                <Show when={collapsed() && stopCount() > 0}>
                  <span class="day-part__count">{stopsLabel(stopCount())}</span>
                </Show>
                <span class="day-part__chevron" classList={{ "is-open": !collapsed() }} aria-hidden="true" />
              </button>
              <Show when={shown()}>
              <ol class="timeline" id={bodyId()} ref={body}>
                <Show when={wokeIn()}>
                  {(stay) => (
                    <HotelPill
                      name={stay().name}
                      place={stayPlace(props.bundle, stay())}
                      leaveBy={leaveHotelBy()}
                    />
                  )}
                </Show>
                <For each={routeItems()}>
                  {(item, index) => (
                    <>
                      {/* A bound flight replaces the ground route into this stop. */}
                      <Show when={binding().before.get(item.id)}>
                        {(flight) => <FlightConnector item={flight()} />}
                      </Show>
                      <Show when={!binding().supersededLegs.has(item.id) && legs().get(item.id)}>
                        {(leg) => (
                          <RouteLegRow
                            leg={leg()}
                            places={props.bundle.places}
                            board={boardFor(leg())}
                            notBefore={legPlans().get(item.id)?.notBefore}
                          />
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
                      board={boardFor(leg())}
                      notBefore={legPlans().get("end")?.notBefore}
                    />
                  )}
                </Show>
                <Show when={sleepsIn()}>
                  {(stay) => (
                    <HotelPill name={stay().name} place={stayPlace(props.bundle, stay())} checkIn={checksInTonight()} />
                  )}
                </Show>
              </ol>
              </Show>
            </div>
          </Show>
      </div>
    </section>
  );
}
