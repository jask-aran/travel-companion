import type { DayItem, Place, RouteLeg, TripBundle } from "@travel-companion/trip-schema";

/**
 * Wanderlog stores travel between stops as standalone route legs keyed by
 * place pair, not as items in the day list. Index them so a day can show what
 * happens *between* its stops — the connective tissue the itinerary is missing.
 */
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
 * The one structural rule worth applying to Wanderlog's legs.
 *
 * A leg connects two stops *within a single day*, so it cannot take longer
 * than a day. When it does, the leg is answering the wrong question: Google
 * was asked for a ground route between two consecutive stops when the real
 * connection is the flight listed separately that day, and it dutifully
 * returned 22 hours of ferries and trains from Kansai to Gimpo.
 *
 * Deliberately unconditional — it does not depend on a flight item being
 * parsed successfully, and 6 h leaves wide clearance over the longest genuine
 * leg in a trip of this shape (2.6 h).
 *
 * Everything else Wanderlog reports is passed through untouched. Filtering on
 * whether a duration "looks right" is not safe: walking legs cluster near
 * 5 km/h because that is roughly Google's walking speed, and nested POIs can
 * legitimately sit closer on foot than their centroids suggest.
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

/** Total time spent moving between a day's stops. */
export function dayTravelSeconds(legs: Map<string, RouteLeg>): number {
  let total = 0;
  for (const leg of legs.values()) total += leg.durationSeconds ?? 0;
  return total;
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

/** Ground distance covered by the day's legs, in metres. */
export function dayTravelMetres(legs: Map<string, RouteLeg>): number {
  let total = 0;
  for (const leg of legs.values()) total += leg.distanceMetres ?? 0;
  return total;
}

/** Legs at or above this read as a haul, and get a proportionally tall block. */
export const LONG_LEG_SECONDS = 60 * 60;
