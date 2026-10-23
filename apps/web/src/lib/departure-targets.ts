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
 * Use NAVITIME for Japan and Google elsewhere.
 */
export type DepartureTarget = {
  key: string;
  fromPlaceId: string;
  toPlaceId: string;
  provider: DepartureBoard["provider"];
  kind: DepartureBoard["target"]["kind"];
  date: string;
  time: string;
  /** For "arrive": any arrival from `time` up to this is fine. */
  until?: string;
};

/**
 * Off the plane to on a train: from 90 minutes after an international
 * landing (immigration, customs, bags, the platform), 30 after a domestic one.
 */
export const ARRIVAL_MARGIN_MINUTES = { international: 90, domestic: 30 };

export const departureKey = (leg: Pick<RouteLeg, "fromPlaceId" | "toPlaceId">) =>
  `${leg.fromPlaceId}>${leg.toPlaceId}`;

/**
 * NAVITIME in Japan, Google everywhere else: Google's Routes API has no
 * Japanese transit (its FAQ excludes Japan's partners), and NAVITIME covers
 * only Japan. No coordinates means no provider.
 * An address ending in Japan or 日本 overrides the coordinate boxes below.
 * The boxes approximate Japan's islands because addresses can omit the country.
 */
export function providerFor(place?: Place): DepartureTarget["provider"] | undefined {
  const lat = place?.latitude;
  const lng = place?.longitude;
  if (lat == null || lng == null) return undefined;
  if (/(?:\bJapan|日本)\s*$/iu.test(place?.address ?? "")) return "navitime";

  // [south, north, west, east], in degrees. These are island bounds, not borders.
  const japanBoxes = [
    [30, 34, 128.4, 140], // Kyushu, Shikoku, and southern Honshu; below South Korea.
    [34, 37, 130, 142], // Central Honshu; east of South Korea's mainland.
    [37, 41.6, 136, 142], // Northern Honshu; east of Korea's Ulleungdo island.
    [41.3, 45.6, 139.3, 145.35], // Hokkaido; south of Sakhalin, west of the Kurils.
    [43, 43.6, 145.35, 145.9], // Nemuro peninsula; south of the Kurils.
    [24, 30, 122.9, 131], // Ryukyu Islands, including Okinawa; east of Taiwan.
    [34.05, 34.75, 129.1, 129.6], // Tsushima; south of Busan.
  ] as const;
  return japanBoxes.some(([south, north, west, east]) =>
    lat >= south && lat <= north && lng >= west && lng <= east
  ) ? "navitime" : "google";
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
    until?: string,
  ) => {
    if (!leg || leg.travelMode !== "transit" || !date || !time) return;
    const provider = providerFor(bundle.places[leg.fromPlaceId]);
    if (!provider) return;
    const key = departureKey(leg);
    if (targets.has(key)) return;
    targets.set(key, {
      key,
      fromPlaceId: leg.fromPlaceId,
      toPlaceId: leg.toPlaceId,
      provider,
      kind,
      date,
      time,
      ...(until ? { until } : {}),
    });
  };

  for (const day of bundle.days) {
    const routing = dayRouting(bundle, day, stays, legIndex);

    for (const flight of routing.flights) {
      // The ride into the airport, arriving by the airport margin. A walk to
      // the station before it needs no timetable.
      const timing = routing.timings.get(flight.id);
      const ride = timing?.legs.findLast((leg) => leg.travelMode !== "walking");
      add(ride, "arrive", flight.departDate ?? day.date, timing?.airportBy, timing?.airportUntil);

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
