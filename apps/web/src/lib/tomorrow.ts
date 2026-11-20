import type { TripBundle, TripDay } from "@travel-companion/trip-schema";
import { shiftClock } from "./day-times.js";
import { dayRouting } from "./day-routing.js";
import { stayDisplay, type Stay } from "./lodging.js";
import type { RouteLegIndex } from "./route-legs.js";

/**
 * An early start tomorrow, for the end of today's Day summary: the first
 * fixed time of the next day, when it falls before EARLY. Worked out from the
 * plan and the flights alone; live departure boards don't move it.
 */
export const EARLY = "08:00";

export type EarlyStart = {
  /** "04:30". */
  time: string;
  /** "Leave Stay in Nipponbashi for Kansai International Airport". */
  text: string;
  /** "MM735 at 08:30": what the time is for, where it isn't the place itself. */
  detail?: string;
  date: string;
};

export function earlyStart(bundle: TripBundle, day: TripDay | undefined, stays: Stay[], legIndex: RouteLegIndex): EarlyStart | undefined {
  if (!day) return undefined;
  const routing = dayRouting(bundle, day, stays, legIndex);
  const hotel = routing.wokeInSlot?.stay;
  const hotelPlace = hotel?.placeId ? bundle.places[hotel.placeId] : undefined;
  const hotelName = hotel ? stayDisplay(hotel.name, hotelPlace).name : undefined;
  const nameOf = (placeId: string | undefined) => (placeId ? bundle.places[placeId]?.name : undefined);
  const candidates: EarlyStart[] = [];

  for (const flight of routing.flights) {
    const timing = routing.timings.get(flight.id);
    if (!timing) continue;
    const airport = nameOf(flight.departPlaceId) ?? flight.departAirport ?? "the airport";
    const code = flight.flightNumber ? `${flight.airlineCode ?? ""}${flight.flightNumber}` : "Flight";
    const detail = flight.departTime ? `${code} at ${flight.departTime}` : code;
    if (timing.leaveBy && timing.fromHotel && hotelName) {
      candidates.push({ time: timing.leaveBy, text: `Leave ${hotelName} for ${airport}`, detail, date: day.date });
    } else {
      candidates.push({ time: timing.airportBy, text: `At ${airport}`, detail, date: day.date });
    }
  }

  const first = routing.routeItems.find((item) => item.type === "place");
  if (first?.type === "place" && first.startTime) {
    const place = nameOf(first.placeId) ?? "the first stop";
    const leg = routing.legs.get(first.id);
    const leave = leg?.durationSeconds && hotelName && leg.fromPlaceId === hotel?.placeId
      ? shiftClock(first.startTime, -Math.ceil(leg.durationSeconds / 60))
      : undefined;
    candidates.push(
      leave
        ? { time: leave, text: `Leave ${hotelName} for ${place}`, detail: `there at ${first.startTime}`, date: day.date }
        : { time: first.startTime, text: place, date: day.date },
    );
  }

  const earliest = candidates
    .map((candidate) => ({ ...candidate, time: candidate.time.padStart(5, "0") }))
    .sort((a, b) => a.time.localeCompare(b.time))[0];
  return earliest && earliest.time < EARLY ? earliest : undefined;
}
