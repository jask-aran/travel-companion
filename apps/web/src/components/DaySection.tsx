import { For, Match, Show, Switch, createEffect, createMemo, type JSX } from "solid-js";
import type { DepartureBoard, DepartureOption, RouteLeg, TripBundle, TripDay } from "@travel-companion/trip-schema";
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
import { dayRidingSeconds, dayWalking, isWaypoint, stopsBetween, type RouteLegIndex } from "../lib/route-legs";
import { leaveFor, pickDeparture, readyAfter } from "../lib/departure-pick";
import { buildDayMap, placeSequences, type MapPath, type MapVisit } from "../lib/day-map";
import { blockStops, cutAtAirports, dayNotes, dayStops, dayTimes, exploreBlocks, minutesOf } from "../lib/day-insights";
import { BlockStopsLine, DayTimesLine, FreeDay, HoursFold, MiniMap, NotesFold, PlacesStrip, SummaryFlight, TomorrowLine } from "./DaySummaryCards";
import { DayMap } from "./DayMap";
import { earlyStart } from "../lib/tomorrow";
import { dayRouting, legOutOf as legOutOfDay } from "../lib/day-routing";
import { departureKey } from "../lib/departure-targets";
import { dayView, setDayView } from "../lib/day-view";
import { DayViews } from "./DayViews";
import { shiftClock, sunTimes, type FlightTiming } from "../lib/day-times";
import { clock } from "../lib/clock";
import { dayOpened } from "../lib/live-departures";
import { DayItemRow, FlightConnector, HotelPill, LodgingBand, PlaceRow, RouteLegRow, StayLine } from "./ItemCards";
import { Hidden, Icon, type IconName } from "./Icon";

/**
 * Under this much walking between stops the figure says nothing about the
 * day: it is the hotel-to-station hop on a day spent on trains.
 */
const WALK_WORTH_SHOWING_METRES = 1000;

/** One of the day's figures: its name over the number, as a board labels a column. */
function Stat(props: { icon: IconName; label: string; title?: string | undefined; children: JSX.Element }) {
  return (
    <div class={`day-stats__tile day-stats__tile--${props.icon}`} title={props.title}>
      <dt>
        <Icon name={props.icon} />
        {props.label}
      </dt>
      <dd>{props.children}</dd>
    </div>
  );
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
          compact={props.slot.role === "check-out"}
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
  /** A stay by its stay name ("Stay in Nipponbashi"), not its place's, often a street address. */
  const stayNames = createMemo(
    () => new Map(stays().flatMap((stay) => (stay.placeId ? [[stay.placeId, stayDisplay(stay.name, props.bundle.places[stay.placeId]).name] as const] : []))),
  );
  const stayNameOf = (placeId: string) => stayNames().get(placeId);

  const routing = createMemo(() => dayRouting(props.bundle, props.day, stays(), props.legIndex));
  /** An early start tomorrow, said tonight. */
  const tomorrow = createMemo(() => earlyStart(props.bundle, props.bundle.days[props.index + 1], stays(), props.legIndex));
  const plan = () => routing().plan;
  const flights = () => routing().flights;
  /** Minutes between landing and the next take-off, when that flight leaves the same airport the same day. */
  const layoverBefore = (index: number) => {
    const before = flights()[index - 1];
    const next = flights()[index];
    if (!before?.arriveTime || !next?.departTime || before.arriveAirport !== next.departAirport) return undefined;
    if ((before.arriveDate ?? props.day.date) !== (next.departDate ?? props.day.date)) return undefined;
    const minutes = minutesOf(next.departTime.padStart(5, "0")) - minutesOf(before.arriveTime.padStart(5, "0"));
    return minutes > 0 ? minutes : undefined;
  };
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
  /** What a leg rides: the option picked for it, whose lines name and colour the leg. */
  const rideFor = (leg: RouteLeg) => {
    const board = boardFor(leg);
    if (!board) return undefined;
    return [...legPlans().values()].find((plan) => plan.board === board)?.option ?? board.options[0];
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
    return { depart: option.departTime, arrive: option.arriveTime, approximate: Boolean(board.approximate) };
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

  /**
   * The Day map's step card draws stops and legs exactly as the route below
   * does. A hotel that bookends the day isn't a route item, so it stands in
   * as one, with no plan of its own.
   */
  const mapStop = (visit: MapVisit) => {
    const index = routeItems().findIndex((item) => item.id === visit.id);
    const listed = routeItems()[index];
    const item = listed?.type === "place" ? listed : { id: visit.id, type: "place" as const, placeId: visit.place.id };
    return (
      <ul class="timeline">
        <PlaceRow item={item} place={visit.place} sequence={sequences()[index] ?? 0} isStay={props.stayPlaceIds.has(visit.place.id)} weekday={weekday()} />
      </ul>
    );
  };
  const mapLeg = (path: MapPath) => {
    const leg = path.leg;
    if (!leg) return undefined;
    return (
      <ol class="timeline">
        <RouteLegRow
          leg={leg}
          places={props.bundle.places}
          board={boardFor(leg)}
          ride={rideFor(leg)}
          notBefore={path.planKey ? legPlans().get(path.planKey)?.notBefore : undefined}
        />
      </ol>
    );
  };

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
  /** Time on trains, buses and in cars: walking has its own figure. */
  const ridingLabel = createMemo(() => formatDurationShort(dayRidingSeconds(allLegs().values())));
  /**
   * On foot between stops. It is a floor, not the day's walking: nothing in
   * the plan measures the walking inside a sight, a station or a market, so
   * the figure carries a "+" and is left out when it is too small to mean
   * anything.
   */
  const walking = createMemo(() => {
    const walk = dayWalking(allLegs().values());
    if (walk.metres < WALK_WORTH_SHOWING_METRES) return undefined;
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
    () => Boolean(ridingLabel()) || Boolean(walking()) || Boolean(sun()),
  );
  /*
   * What the day holds besides its long journeys (lib/day-insights.ts). After
   * `weekday` and `sun`: memos run as they are made.
   */
  const stops = createMemo(() => dayStops(routeItems(), props.bundle.places, props.stayPlaceIds, legs()));
  /** Places you visit, leaving out stations and the like you pass through. */
  const visitStops = createMemo(() => stops().filter((stop) => !stop.waypoint));
  // Stays have their own lines, and a flight row times its airports.
  const times = createMemo(() =>
    dayTimes(
      routeItems(),
      props.bundle.places,
      new Set([...props.stayPlaceIds, ...flights().flatMap((flight) => [flight.departPlaceId, flight.arrivePlaceId].filter((id): id is string => Boolean(id)))]),
    ),
  );
  const notes = createMemo(() => dayNotes(routeItems(), stops()));
  const hoursKnown = createMemo(() => visitStops().filter((stop) => stop.place.details?.openingPeriods?.length).length >= 2);
  /** The Day map's geometry, shared by the fixed maps of each block of exploring. */
  const mapData = createMemo(() => buildDayMap(routing(), props.bundle, props.stayPlaceIds));
  const blocks = createMemo(() =>
    exploreBlocks(routeItems().length, journeys())
      .map((whole) => cutAtAirports(whole, stops()))
      .map((block) => ({ block, stops: blockStops(stops(), block) }))
      .filter((entry) => entry.stops.length > 0),
  );
  /** A block as a fixed map: its stops, numbered as on the Day map, and the lines between them. */
  const blockMap = (block: { from: number; to: number }) => {
    const shown = new Set(blockStops(stops(), { ...block, before: undefined }).map((stop) => stop.item.id));
    // Lines run through the block's stations too, so they join up.
    const inside = new Set(stops().filter((stop) => stop.index >= block.from && stop.index <= block.to).map((stop) => stop.item.id));
    const visits = mapData().visits.filter((visit) => shown.has(visit.id));
    return {
      stops: visits.map((visit) => {
        const area = cityOf(visit.place.address) ?? visit.place.locality?.split(", ")[0];
        return { lat: visit.point[0], lng: visit.point[1], label: visit.label, name: visit.place.name, ...(area ? { area } : {}) };
      }),
      lines: mapData()
        .paths.filter((path) => path.mode !== "flight" && path.fromVisitId && path.toVisitId && inside.has(path.fromVisitId) && inside.has(path.toVisitId))
        .map((path) => ({ points: path.points, mode: path.mode, approximate: path.approximate })),
    };
  };
  /** A block's fixed map; its stops and lines are read live, so a trip refresh redraws it. */
  const BlockMap = (p: { entry: { block: { from: number; to: number }; stops: { place: { name: string } }[] } }) => {
    const map = createMemo(() => blockMap(p.entry.block));
    const label = () => `Map of ${stopsLabel(p.entry.stops.length).toLowerCase()}: ${p.entry.stops.map((stop) => stop.place.name).join(", ")}`;
    // One stop is named; more are counted.
    const caption = () => (p.entry.stops.length === 1 ? p.entry.stops[0]!.place.name : stopsLabel(p.entry.stops.length));
    return <MiniMap stops={map().stops} lines={map().lines} caption={caption()} label={label()} />;
  };
  /** Blocks drawn as a fixed map: 2+ places between journeys, 1+ after the last. */
  const mapped = (entry: { block: { before: number | undefined }; stops: unknown[] }) => entry.stops.length >= (entry.block.before === undefined ? 1 : 2);
  const blockBefore = (journeyIndex: number) => blocks().find((entry) => entry.block.before === journeyIndex);
  const lastBlock = () => blocks().find((entry) => entry.block.before === undefined);
  /** A day with nothing planned: where you stay, and the same city's places on other days. */
  const freeDay = createMemo(() => {
    if (stops().length > 0) return undefined;
    const stay = stayForDay(stays(), props.day.date);
    if (!stay) return undefined;
    const city = baseCity();
    const others = city
      ? props.bundle.days
          .filter((day) => day.date !== props.day.date)
          .flatMap((day) =>
            day.items.flatMap((item) => {
              if (item.type !== "place" || props.stayPlaceIds.has(item.placeId)) return [];
              const place = props.bundle.places[item.placeId];
              const where = cityOf(place?.address) ?? place?.locality;
              return place && where === city && !isWaypoint(place) ? [{ name: place.name, when: formatDayHeading(day.date) }] : [];
            }),
          )
          .slice(0, 3)
      : [];
    return { stay: stayPlace(props.bundle, stay), city, others };
  });
  const hasSummary = createMemo(
    () => hasStats() || summarySlots().length > 0 || flights().length > 0 || visitStops().length > 0 || Boolean(freeDay()) || Boolean(tomorrow()),
  );
  const view = createMemo(() => dayView(props.day.id));
  const bodyId = () => `body-${props.day.id}`;
  const hasRoute = () => routeItems().length > 0;
  // A route on screen is the cue to fetch boards its legs don't have yet.
  createEffect(() => hasRoute() && (view() === "route" || !hasSummary()) && dayOpened(props.day.date));

  /** The day at a glance; one of the two views. */
  const summaryCard = () => (
    <div class="day-summary">
                    <Show when={hasStats()}>
                      <dl class="day-stats">
                        <Show when={ridingLabel()}>
                          {(label) => (
                            <Stat icon="clock" label="Transit">
                              {label()}
                            </Stat>
                          )}
                        </Show>
                        <Show when={walking()}>
                          {(walk) => (
                            <Stat
                              icon="walk"
                              label="Walk"
                              title={`${walk().time} on foot between stops. Walking inside sights and stations is not counted.`}
                            >
                              {walk().distance}
                              <span class="day-stats__mark" aria-hidden="true">
                                +
                              </span>
                              <Hidden> or more</Hidden>
                            </Stat>
                          )}
                        </Show>
                        <Show when={sun()}>
                          {(times) => (
                            <Stat icon="sunset" label="Daylight">
                              <span class="day-stats__mark" aria-hidden="true">
                                ↑
                              </span>
                              <Hidden>Sunrise </Hidden>
                              {times().rise}
                              <span class="day-stats__mark day-stats__mark--set" aria-hidden="true">
                                ↓
                              </span>
                              <Hidden> Sunset </Hidden>
                              {times().set}
                            </Stat>
                          )}
                        </Show>
                      </dl>
                    </Show>
                    <Show when={times().length}><DayTimesLine times={times()} /></Show>
                    <For each={leaving()}>
                      {(slot) => (
                        <LodgingSlotView slot={slot} bundle={props.bundle} date={props.day.date} checkOutBy={checkOutBy()} />
                      )}
                    </For>
                    {/* Each flight with its transfers either side, each its own section,
                        so the summary alone gets you from hotel to hotel. A
                        transfer is drawn exactly like a journey: both ends named. */}
                    <For each={flights()}>
                      {(item, index) => (
                        <>
                          <Show when={timings().get(item.id)?.legs.length}>
                            <ol class="day-summary__transfer">
                              <For each={timings().get(item.id)?.legs}>
                                {(leg) => <RouteLegRow leg={leg} places={props.bundle.places} ride={rideFor(leg)} times={timesFor(leg)} showEnds nameOf={stayNameOf} />}
                              </For>
                            </ol>
                          </Show>
                          <SummaryFlight
                            item={item}
                            timing={timings().get(item.id)}
                            leaveLabel={leaveLabel(timings().get(item.id))}
                            layover={layoverBefore(index())}
                          />
                          <Show when={legOutOf(item.arrivePlaceId)}>
                            {(leg) => (
                              <ol class="day-summary__transfer">
                                <RouteLegRow leg={leg()} places={props.bundle.places} ride={rideFor(leg())} times={timesFor(leg())} showEnds nameOf={stayNameOf} />
                              </ol>
                            )}
                          </Show>
                        </>
                      )}
                    </For>
                    {/* Stop counts between journeys give the day its shape: a
                        handful between two long legs is a day out. No stops is a
                        change of train, and two journeys in a row already say so. */}
                    <For each={journeys()}>
                      {(journey, index) => (
                        <>
                          {/* A block of exploring before this journey: a fixed map of it,
                              else the count of stops, as before. */}
                          <Show
                            when={blockBefore(index())}
                            keyed
                            fallback={
                              <Show when={index() > 0 && (stopsBefore(index()) ?? 0) > 0}>
                                <p class="day-summary__between with-icon">
                                  <Icon name="pin" />
                                  {stopsLabel(stopsBefore(index()) ?? 0)}
                                </p>
                              </Show>
                            }
                          >
                            {(entry) => (mapped(entry) ? <BlockMap entry={entry} /> : <BlockStopsLine stops={entry.stops} />)}
                          </Show>
                          <ol class="day-summary__transfer">
                            <RouteLegRow
                              leg={journey.leg}
                              places={props.bundle.places}
                              ride={rideFor(journey.leg)}
                              times={timesFor(journey.leg)}
                              showEnds
                              nameOf={stayNameOf}
                            />
                          </ol>
                        </>
                      )}
                    </For>
                    {/* The stretch after the last journey, or the whole day when there is none. */}
                    <Show when={lastBlock()} keyed>
                      {(entry) => (mapped(entry) ? <BlockMap entry={entry} /> : <BlockStopsLine stops={entry.stops} />)}
                    </Show>
                    <Show when={visitStops().length >= 2}><PlacesStrip stops={visitStops()} /></Show>
                    <Show when={hoursKnown()}><HoursFold stops={visitStops()} weekday={weekday()} sunset={sun()?.set} /></Show>
                    <Show when={notes().length}><NotesFold notes={notes()} open={visitStops().length <= 1} /></Show>
                    <For each={arriving()}>
                      {(slot) => <LodgingSlotView slot={slot} bundle={props.bundle} date={props.day.date} />}
                    </For>
                    <Show when={freeDay()}>
                      {(free) => <FreeDay stay={free().stay} city={free().city} others={free().others} wanderlogUrl={props.bundle.trip.wanderlogUrl} />}
                    </Show>
                    <Show when={tomorrow()}>{(early) => <TomorrowLine start={early()} />}</Show>
                  </div>
  );
  /** Every stop and leg in order; the other view. */
  const routeList = () => (
    <ol class="timeline">
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
                                ride={rideFor(leg())}
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
                          ride={rideFor(leg())}
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
  );

  return (
    <section
      class="day-section"
      id={props.day.id}
      aria-labelledby={`heading-${props.day.id}`}
    >
      {/* The whole header switches between the summary and the route: a
          big target, and the title stays the section's accessible name. */}
      <button
        type="button"
        class="day-section__header"
        aria-controls={bodyId()}
        onClick={() => {
          setDayView(props.day.id, view() === "route" ? "summary" : "route");
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
          <Switch>
            <Match when={hasSummary() && hasRoute()}>
              <DayViews
                view={view()}
                onView={(next) => setDayView(props.day.id, next)}
                summary={summaryCard}
                route={routeList}
                routeHint={stopCount() > 0 ? stopsLabel(stopCount()) : undefined}
                routeId={bodyId()}
              />
            </Match>
            <Match when={hasSummary()}>
              <div class="day-part">
                <p class="day-part__label">Day summary</p>
                {summaryCard()}
              </div>
            </Match>
            <Match when={hasRoute()}>
              <div class="day-part" id={bodyId()}>
                <p class="day-part__label">Full Day Route</p>
                {routeList()}
              </div>
            </Match>
          </Switch>
          <Show when={routeItems().length === 0 && !freeDay()}>
            <p class="day-part__empty">Nothing planned yet</p>
          </Show>
          <DayMap routing={routing()} bundle={props.bundle} stayPlaceIds={props.stayPlaceIds} renderStop={mapStop} renderLeg={mapLeg} />
      </div>
    </section>
  );
}
