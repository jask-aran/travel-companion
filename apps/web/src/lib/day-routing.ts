import type { DayItem, FlightItem, RouteLeg, TripBundle, TripDay } from "@travel-companion/trip-schema";
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
  const routeItems = day.items.filter((item) => item.type !== "lodging" && item.type !== "flight");
  // Wanderlog starts each day at the hotel you woke in and ends it at the one
  // you sleep in, routing to and from them without listing either as a stop.
  const wokeInSlot = plan.start.find((slot) => slot.role === "check-out" || slot.role === "morning");
  const sleepsIn = (
    plan.start.find((slot) => slot.role === "check-in") ??
    plan.end.find((slot) => slot.role === "evening")
  )?.stay;
  const legs = legsForDay(routeItems, legIndex, wokeInSlot?.stay.placeId);
  const endLeg = closingLeg(routeItems, legIndex, sleepsIn?.placeId);
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
