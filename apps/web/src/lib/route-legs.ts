import type { DayItem, RouteLeg, TripBundle } from "@travel-companion/trip-schema";

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
 */
export function legsForDay(items: DayItem[], index: RouteLegIndex): Map<string, RouteLeg> {
  const legs = new Map<string, RouteLeg>();
  let previousPlaceId: string | undefined;

  for (const item of items) {
    if (item.type !== "place") continue;
    if (previousPlaceId) {
      const leg = index.get(pairKey(previousPlaceId, item.placeId));
      if (leg && !isBeyondDayScale(leg)) legs.set(item.id, leg);
    }
    previousPlaceId = item.placeId;
  }

  return legs;
}

/** Total time spent moving between a day's stops. */
export function dayTravelSeconds(legs: Map<string, RouteLeg>): number {
  let total = 0;
  for (const leg of legs.values()) total += leg.durationSeconds ?? 0;
  return total;
}

/** Legs at or above this read as a haul, and get a proportionally tall block. */
export const LONG_LEG_SECONDS = 60 * 60;
