import type { DepartureBoard, Place, RouteLeg, TripBundle } from "@travel-companion/trip-schema";
import { collectStays } from "./lodging.js";
import { indexRouteLegs } from "./route-legs.js";
import { dayRouting, legOutOf } from "./day-routing.js";
import { isDomestic, shiftClock } from "./day-times.js";

/**
 * Which legs get a departure board, and around what time. Only legs the day
 * summary shows (flight transfers and long journeys), by transit, and only
 * where a time pins them down: a flight, or a stop with a time set in
 * Wanderlog. A stop with a time is how you mark it as time-sensitive.
 */
export type DepartureTarget = {
  key: string;
  fromPlaceId: string;
  toPlaceId: string;
  provider: DepartureBoard["provider"];
  kind: DepartureBoard["target"]["kind"];
  date: string;
  time: string;
};

/**
 * Off the plane to on a train. International adds immigration and customs
 * on top of bags and finding the platform; an early board is cheap, missing
 * the first suggestion is not.
 */
export const ARRIVAL_MARGIN_MINUTES = { international: 75, domestic: 30 };

export const departureKey = (leg: Pick<RouteLeg, "fromPlaceId" | "toPlaceId">) =>
  `${leg.fromPlaceId}>${leg.toPlaceId}`;

/**
 * Google's API has no Japanese transit (its FAQ excludes Japan's partners);
 * NAVITIME covers Japan only. Coordinates decide, since addresses on this
 * trip do not always end in a country.
 */
export function providerFor(place?: Place): DepartureTarget["provider"] | undefined {
  const lat = place?.latitude;
  const lng = place?.longitude;
  if (lat == null || lng == null) return undefined;
  if (lat >= 33 && lat <= 38.7 && lng >= 124.5 && lng <= 130) return "google";
  if (lat >= 24 && lat <= 46 && lng >= 122.9 && lng <= 146) return "navitime";
  return undefined;
}

export function departureTargets(bundle: TripBundle): DepartureTarget[] {
  const stays = collectStays(bundle);
  const legIndex = indexRouteLegs(bundle);
  const targets = new Map<string, DepartureTarget>();

  const add = (
    leg: RouteLeg | undefined,
    kind: DepartureTarget["kind"],
    date: string | undefined,
    time: string | undefined,
  ) => {
    if (!leg || leg.travelMode !== "transit" || !date || !time) return;
    const provider = providerFor(bundle.places[leg.fromPlaceId]);
    if (!provider) return;
    const key = departureKey(leg);
    if (targets.has(key)) return;
    targets.set(key, { key, fromPlaceId: leg.fromPlaceId, toPlaceId: leg.toPlaceId, provider, kind, date, time });
  };

  for (const day of bundle.days) {
    const routing = dayRouting(bundle, day, stays, legIndex);

    for (const flight of routing.flights) {
      // The ride into the airport, arriving by the airport margin. A walk to
      // the station before it needs no timetable.
      const timing = routing.timings.get(flight.id);
      const ride = timing?.legs.findLast((leg) => leg.travelMode !== "walking");
      add(ride, "arrive", flight.departDate ?? day.date, timing?.airportBy);

      const out = legOutOf(routing, flight.arrivePlaceId);
      const margin = ARRIVAL_MARGIN_MINUTES[isDomestic(flight, bundle.places) ? "domestic" : "international"];
      const after = flight.arriveTime && shiftClock(flight.arriveTime, margin);
      // A margin that wraps past midnight would ask for the wrong day.
      if (after && flight.arriveTime && after > flight.arriveTime) {
        add(out, "depart", flight.arriveDate ?? day.date, after);
      }
    }

    for (const journey of routing.journeys) {
      const from = routing.routeItems[journey.fromIndex];
      const to = routing.routeItems[journey.toIndex];
      // Leaving when you are done somewhere beats arriving by the next start:
      // it is the plan's own word on when you go.
      if (from?.type === "place" && from.endTime) add(journey.leg, "depart", day.date, from.endTime);
      else if (to?.type === "place" && to.startTime) add(journey.leg, "arrive", day.date, to.startTime);
    }
  }

  return [...targets.values()];
}
