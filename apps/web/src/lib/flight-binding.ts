import type { DayItem, FlightItem } from "@travel-companion/trip-schema";

/**
 * Wanderlog keeps flights outside a day's sequence, in their own section. But
 * people add the departure and arrival airports as ordinary stops so that
 * Wanderlog's UI will draw the travel legs to them — which leaves the day
 * saying "go to Kansai, then somehow be at Gimpo" with a 22-hour ferry route
 * between, because Google was asked for a ground route between two airports.
 *
 * Binding on the airports' place ids puts the flight back where it belongs.
 * Three shapes occur in practice:
 *
 *   between  both airports are consecutive stops   (Kansai -> Gimpo)
 *   arrives  only the arrival airport is a stop    (land at Narita, day 1)
 *   departs  only the departure airport is a stop  (leave from Narita, day 21)
 */
export type FlightBinding = {
  /** Flight to draw immediately above this stop, keyed by the stop's item id. */
  before: Map<string, FlightItem>;
  /** Flight to draw immediately below this stop. */
  after: Map<string, FlightItem>;
  /**
   * Stops whose incoming route leg is superseded: the real connection is the
   * flight, so any surface route Google invented for it must not be drawn.
   */
  supersededLegs: Set<string>;
  /** Flights that matched no stop; they stay in the day summary only. */
  unbound: FlightItem[];
};

export function bindFlights(stops: DayItem[], flights: FlightItem[]): FlightBinding {
  const before = new Map<string, FlightItem>();
  const after = new Map<string, FlightItem>();
  const supersededLegs = new Set<string>();
  const unbound: FlightItem[] = [];

  const placeStops = stops.filter(
    (item): item is Extract<DayItem, { type: "place" }> => item.type === "place",
  );

  for (const flight of flights) {
    const departIndex = placeStops.findIndex((stop) => stop.placeId === flight.departPlaceId);
    const arriveIndex = placeStops.findIndex((stop) => stop.placeId === flight.arrivePlaceId);

    const arrivalStop = arriveIndex >= 0 ? placeStops[arriveIndex] : undefined;
    const departureStop = departIndex >= 0 ? placeStops[departIndex] : undefined;

    if (arrivalStop) {
      // Covers both "between" and "arrives": the flight lands at this stop, so
      // it is drawn above it and replaces whatever leg led into it.
      before.set(arrivalStop.id, flight);
      supersededLegs.add(arrivalStop.id);
      continue;
    }

    if (departureStop) {
      after.set(departureStop.id, flight);
      // You leave by air, so the ground route onward from here is not real.
      const next = placeStops[departIndex + 1];
      if (next) supersededLegs.add(next.id);
      continue;
    }

    unbound.push(flight);
  }

  return { before, after, supersededLegs, unbound };
}
