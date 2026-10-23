import type { DayItem, FlightItem, PlaceItem, RouteLeg, TripBundle, TripDay } from "@travel-companion/trip-schema";
import { planDayLodging, type DayLodgingPlan, type LodgingSlot, type Stay } from "./lodging.js";
import { closingLeg, isJourney, legsForDay, type RouteLegIndex } from "./route-legs.js";
import { flightTiming, type FlightTiming } from "./day-times.js";

/**
 * How a day moves: where it starts and ends, the legs between its stops, the
 * runs to and from each flight, and the long journeys. The day summary shows
 * these, and the trip pull fetches departure times for the same legs, so both
 * read them from here.
 */
export type DayRouting = {
  plan: DayLodgingPlan;
  /** In departure order: Wanderlog keeps flights in the order they were added. */
  flights: FlightItem[];
  /** Lodging bookends a day, flights headline it. What is left is the route. */
  routeItems: DayItem[];
  /** The hotel you woke in, and the slot it fills. */
  wokeInSlot: LodgingSlot | undefined;
  /** The hotel you sleep in tonight. */
  sleepsIn: Stay | undefined;
  /** The leg into each place item, keyed by item id. */
  legs: Map<string, RouteLeg>;
  /** Last stop to tonight's hotel. */
  endLeg: RouteLeg | undefined;
  timings: Map<string, FlightTiming | undefined>;
  /** Each long journey with where it sits in the route (see `journeysOf`). */
  journeys: Journey[];
};

/**
 * A journey leaves from `fromIndex` (-1 is the hotel) and arrives at
 * `toIndex` (past the end is the hotel), indexes into `routeItems`.
 */
export type Journey = { leg: RouteLeg; fromIndex: number; toIndex: number };

/**
 * The run out of the arrival airport: the leg into the next stop, or the leg
 * to tonight's hotel when the airport ends the day.
 */
export function legOutOf(routing: DayRouting, placeId: string | undefined): RouteLeg | undefined {
  if (!placeId) return undefined;
  const items = routing.routeItems;
  const at = items.findIndex((item) => item.type === "place" && item.placeId === placeId);
  if (at < 0) return undefined;
  const next = items.slice(at + 1).find((item) => item.type === "place");
  return next ? routing.legs.get(next.id) : routing.endLeg;
}

export function dayRouting(
  bundle: TripBundle,
  day: TripDay,
  stays: Stay[],
  legIndex: RouteLegIndex,
): DayRouting {
  const plan = planDayLodging(day.date, stays, bundle.trip.startDate, bundle.trip.endDate);
  const flights = day.items
    .filter((item): item is FlightItem => item.type === "flight")
    .sort((a, b) =>
      `${a.departDate ?? ""} ${a.departTime ?? ""}`.localeCompare(
        `${b.departDate ?? ""} ${b.departTime ?? ""}`,
      ),
    );
  const routeItems = withAirports(
    day.items.filter((item) => item.type !== "lodging" && item.type !== "flight"),
    flights,
    bundle,
  );
  // Wanderlog starts each day at the hotel you woke in and ends it at the one
  // you sleep in, routing to and from them without listing either as a stop.
  const wokeInSlot = plan.start.find((slot) => slot.role === "check-out" || slot.role === "morning");
  const sleepsIn = (
    plan.start.find((slot) => slot.role === "check-in") ??
    plan.end.find((slot) => slot.role === "evening")
  )?.stay;
  const legs = legsForDay(routeItems, legIndex, wokeInSlot?.stay.placeId);
  const endLeg =
    closingLeg(routeItems, legIndex, sleepsIn?.placeId) ??
    airportTransfer(routeItems.at(-1), sleepsIn?.placeId, bundle);
  fillAirportTransfers(routeItems, legs, wokeInSlot?.stay.placeId, flights, bundle);
  const timings = new Map(
    flights.map((flight) => [
      flight.id,
      flightTiming(flight, routeItems, legs, bundle.places, wokeInSlot?.stay.placeId),
    ]),
  );

  const routing: DayRouting = {
    plan,
    flights,
    routeItems,
    wokeInSlot,
    sleepsIn,
    legs,
    endLeg,
    timings,
    journeys: [],
  };
  routing.journeys = journeysOf(routing, bundle);
  return routing;
}

/**
 * Long journeys of the day in route order, shown in the summary like the
 * airport transfers. Those already shown beside a flight are not repeated.
 */
function journeysOf(routing: DayRouting, bundle: TripBundle): Journey[] {
  const shown = new Set<string>();
  for (const flight of routing.flights) {
    for (const leg of routing.timings.get(flight.id)?.legs ?? []) shown.add(leg.id);
    const out = legOutOf(routing, flight.arrivePlaceId);
    if (out) shown.add(out.id);
  }
  const items = routing.routeItems;
  const placeBefore = (index: number) => {
    for (let i = index - 1; i >= 0; i -= 1) if (items[i]?.type === "place") return i;
    return -1;
  };
  const placed = [...routing.legs.entries()].map(([itemId, leg]) => {
    const toIndex = items.findIndex((item) => item.id === itemId);
    return { leg, toIndex, fromIndex: placeBefore(toIndex) };
  });
  if (routing.endLeg) {
    placed.push({ leg: routing.endLeg, toIndex: items.length, fromIndex: placeBefore(items.length) });
  }
  return placed.filter(({ leg }) => !shown.has(leg.id) && isJourney(leg, bundle.places));
}

/** Item ids for airports the day reaches only through a flight. */
const AIRPORT_ITEM = "airport:";

export const isAddedAirport = (item: DayItem) => item.id.startsWith(AIRPORT_ITEM);

const minutesOf = (time: string | undefined) =>
  time && /^\d{2}:\d{2}$/.test(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) : undefined;

/**
 * A flight's airports as stops when the day doesn't list them, so the run
 * to the airport and the one out of it are on the route like any other leg.
 * Wanderlog itself only routes between listed stops.
 *
 * The departure airport goes after the last stop timed before take-off; with
 * no times to go by, a morning flight starts the day and a later one ends
 * it. The arrival airport follows the departure, or leads the day if only it
 * is missing.
 */
function withAirports(items: DayItem[], flights: FlightItem[], bundle: TripBundle): DayItem[] {
  const route = [...items];
  const placeIndex = (placeId: string | undefined) =>
    route.findIndex((item) => item.type === "place" && item.placeId === placeId);
  const airport = (flight: FlightItem, end: "depart" | "arrive", placeId: string): PlaceItem => ({
    id: `${AIRPORT_ITEM}${flight.id}:${end}`,
    type: "place",
    placeId,
  });

  for (const flight of flights) {
    const from = flight.departPlaceId && bundle.places[flight.departPlaceId] ? flight.departPlaceId : undefined;
    const to = flight.arrivePlaceId && bundle.places[flight.arrivePlaceId] ? flight.arrivePlaceId : undefined;
    if (from && placeIndex(from) < 0) {
      const at = placeIndex(to);
      if (at >= 0) route.splice(at, 0, airport(flight, "depart", from));
      else {
        const takeOff = minutesOf(flight.departTime) ?? 0;
        const timed = route
          .map((item, index) => ({ index, time: minutesOf(item.endTime ?? item.startTime) }))
          .filter((entry) => entry.time !== undefined);
        const before = timed.filter((entry) => entry.time! <= takeOff).at(-1);
        const position = timed.length
          ? before ? before.index + 1 : 0
          : takeOff < 12 * 60 ? 0 : route.length;
        route.splice(position, 0, airport(flight, "depart", from));
      }
    }
    if (to && placeIndex(to) < 0) {
      // Flights crossing midnight land on the next day's page in Wanderlog.
      if (flight.arriveDate && flight.departDate && flight.arriveDate !== flight.departDate) continue;
      const at = placeIndex(from);
      route.splice(at >= 0 ? at + 1 : 0, 0, airport(flight, "arrive", to));
    }
  }
  return route;
}

/**
 * A transit leg Wanderlog never routed: to or from an added airport. Its
 * length comes from the timetable fetched for it, the quickest way door to
 * door, so the day's totals and the summary still have a figure.
 */
function airportTransfer(
  from: DayItem | string | undefined,
  toPlaceId: string | undefined,
  bundle: TripBundle,
): RouteLeg | undefined {
  const fromPlaceId = typeof from === "string" ? from : from?.type === "place" ? from.placeId : undefined;
  if (typeof from === "object" && from && !isAddedAirport(from)) return undefined;
  if (!fromPlaceId || !toPlaceId || fromPlaceId === toPlaceId) return undefined;
  const leg: RouteLeg = { id: `transfer:${fromPlaceId}>${toPlaceId}`, fromPlaceId, toPlaceId, travelMode: "transit" };
  const options = bundle.departures?.[`${fromPlaceId}>${toPlaceId}`]?.options ?? [];
  const quickest = Math.min(...options.map((option) => option.minutes + (option.walkMinutes ?? 0)));
  if (Number.isFinite(quickest)) leg.durationSeconds = quickest * 60;
  return leg;
}

/**
 * Legs into and out of added airports. The leg between a flight's two
 * airports stays empty: the flight is that connection.
 */
function fillAirportTransfers(
  items: DayItem[],
  legs: Map<string, RouteLeg>,
  startPlaceId: string | undefined,
  flights: FlightItem[],
  bundle: TripBundle,
) {
  const flown = (from: string, to: string) =>
    flights.some((flight) => flight.departPlaceId === from && flight.arrivePlaceId === to);
  let previous: { placeId: string; added: boolean } | undefined = startPlaceId
    ? { placeId: startPlaceId, added: false }
    : undefined;
  for (const item of items) {
    if (item.type !== "place") continue;
    const added = isAddedAirport(item);
    const flightHop = previous && flown(previous.placeId, item.placeId);
    if (!legs.has(item.id) && previous && (added || previous.added) && !flightHop) {
      const leg = airportTransfer(previous.placeId, item.placeId, bundle);
      if (leg) legs.set(item.id, leg);
    }
    previous = { placeId: item.placeId, added };
  }
}
