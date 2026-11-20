import type { DayItem, Place, RouteLeg, TripBundle } from "@travel-companion/trip-schema";

/** Wanderlog stores travel between stops as route legs keyed by place pair, not as day items. */
export type RouteLegIndex = Map<string, RouteLeg>;

const pairKey = (fromPlaceId: string, toPlaceId: string) => `${fromPlaceId}>${toPlaceId}`;

export function indexRouteLegs(bundle: TripBundle): RouteLegIndex {
  const index: RouteLegIndex = new Map();
  for (const leg of Object.values(bundle.routeLegs ?? {})) {
    index.set(pairKey(leg.fromPlaceId, leg.toPlaceId), leg);
  }
  return index;
}

/**
 * A leg between two stops of one day cannot take 6 hours or more: one that does
 * is a ground route Google found where the real connection is a flight (22 h of
 * ferries from Kansai to Gimpo). Dropped whether or not the flight parsed;
 * every other leg is passed through, since "looks wrong" filters misfire.
 */
const BEYOND_DAY_SCALE_SECONDS = 6 * 60 * 60;

const isBeyondDayScale = (leg: RouteLeg) =>
  (leg.durationSeconds ?? 0) >= BEYOND_DAY_SCALE_SECONDS;

/**
 * Map each place item to the leg that leads *into* it from the previous stop.
 * Notes and other non-place items sit between stops without breaking the
 * chain, which matches how the legs are generated upstream.
 *
 * `startPlaceId` is where the day begins, the hotel you woke in. Wanderlog
 * routes the first stop from there ("56 mins from <hotel>") without listing
 * the hotel as a stop.
 */
export function legsForDay(
  items: DayItem[],
  index: RouteLegIndex,
  startPlaceId?: string,
): Map<string, RouteLeg> {
  const legs = new Map<string, RouteLeg>();
  let previousPlaceId = startPlaceId;

  for (const item of items) {
    if (item.type !== "place") continue;
    if (previousPlaceId && previousPlaceId !== item.placeId) {
      const leg = index.get(pairKey(previousPlaceId, item.placeId));
      if (leg && !isBeyondDayScale(leg)) legs.set(item.id, leg);
    }
    previousPlaceId = item.placeId;
  }

  return legs;
}

/**
 * The leg home: last stop to the hotel you sleep in. Wanderlog ends each day
 * there without listing the hotel as a stop.
 */
export function closingLeg(
  items: DayItem[],
  index: RouteLegIndex,
  endPlaceId?: string,
): RouteLeg | undefined {
  const last = items.filter((item) => item.type === "place").at(-1);
  if (!endPlaceId || last?.type !== "place" || last.placeId === endPlaceId) return undefined;
  const leg = index.get(pairKey(last.placeId, endPlaceId));
  return leg && !isBeyondDayScale(leg) ? leg : undefined;
}

/** Time spent riding: every leg not on foot (walking has its own figure, dayWalking). */
export function dayRidingSeconds(legs: Iterable<RouteLeg>): number {
  let total = 0;
  for (const leg of legs) {
    if (leg.travelMode !== "walking") total += leg.durationSeconds ?? 0;
  }
  return total;
}

/**
 * Google's transport types: somewhere you pass through rather than spend
 * time. Matched exactly, since a substring would also catch a border
 * crossing ("border_crossing_station") or a sightseeing cruise.
 */
const WAYPOINT_TYPES = new Set([
  "train_station",
  "subway_station",
  "transit_station",
  "logical_transit_station",
  "light_rail_station",
  "bus_station",
  "bus_stop",
  "transit_depot",
  "ferry_terminal",
  "airport",
  "international_airport",
  "transportation_service",
]);

/** A station Google gave no category to still reads as one by its name. */
export const isWaypoint = (place?: Place) =>
  WAYPOINT_TYPES.has(place?.category ?? "") || (!place?.category && /\bStation$/i.test(place?.name?.trim() ?? ""));

/**
 * How many places you spend time at between two journeys: the stops from
 * where one arrives to where the next leaves, both included, leaving out
 * hotels and waypoints. A handful reads as a day out; none, as a change of
 * train.
 */
export function stopsBetween(
  items: DayItem[],
  fromIndex: number,
  toIndex: number,
  places: Record<string, Place>,
  stayPlaceIds: Set<string>,
): number {
  let count = 0;
  for (let index = Math.max(0, fromIndex); index <= toIndex && index < items.length; index += 1) {
    const item = items[index];
    if (item?.type !== "place" || stayPlaceIds.has(item.placeId)) continue;
    if (!isWaypoint(places[item.placeId])) count += 1;
  }
  return count;
}

/** Time and distance on foot across the day's legs. */
export function dayWalking(legs: Iterable<RouteLeg>): { seconds: number; metres: number } {
  let seconds = 0;
  let metres = 0;
  for (const leg of legs) {
    if (leg.travelMode !== "walking") continue;
    seconds += leg.durationSeconds ?? 0;
    metres += leg.distanceMetres ?? 0;
  }
  return { seconds, metres };
}

/** Straight-line kilometres between two places, when both have coordinates. */
export function crowKm(from?: Place, to?: Place): number | undefined {
  if (from?.latitude == null || from.longitude == null) return undefined;
  if (to?.latitude == null || to.longitude == null) return undefined;
  const rad = Math.PI / 180;
  const dLat = (to.latitude - from.latitude) * rad;
  const dLon = (to.longitude - from.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from.latitude * rad) * Math.cos(to.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * A leg worth calling out in the day summary: it changes town (20 km as the
 * crow flies, since transit routes inflate road distance) or it is simply
 * long. On this trip that is Nagoya to Takayama, the airport runs and the
 * legs out and back on day trips, but not a long ride across one city.
 */
export const JOURNEY_KM = 20;
export const JOURNEY_SECONDS = 75 * 60;

export function isJourney(leg: RouteLeg, places: Record<string, Place>): boolean {
  if ((leg.durationSeconds ?? 0) >= JOURNEY_SECONDS) return true;
  return (crowKm(places[leg.fromPlaceId], places[leg.toPlaceId]) ?? 0) >= JOURNEY_KM;
}

/** Legs at or above this read as a haul, and get a proportionally tall block. */
export const LONG_LEG_SECONDS = 60 * 60;
