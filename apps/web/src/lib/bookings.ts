import type { FlightItem, LodgingItem, TripBundle } from "@travel-companion/trip-schema";
import { cityOf } from "./format.js";
import { stayDisplay, stayKey } from "./lodging.js";

/**
 * The trip's bookings in one place, for the Bookings page: flights (a
 * connection on one booking as one journey) and stays, each with its
 * reference, and for stays the free-cancellation deadline. Worked out from
 * the trip alone.
 */

export type FlightBooking = {
  date: string;
  /** Airport codes in order: "MEL", "CNS", "NRT" for a connection. */
  route: string[];
  /** "JQ34", "JQ25". */
  numbers: string[];
  departTime?: string;
  ref?: string;
  travellers?: number;
  /** The day it leaves, to jump to. */
  dayId: string;
};

export type StayBooking = {
  key: string;
  name: string;
  city?: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  ref?: string;
  rooms?: number;
  /** "2026-11-19 23:59" or "2026-11-19", as the booking gives it. */
  cancelBy?: string;
  cancelPolicy?: string;
  /** The check-in day, to jump to. */
  dayId?: string;
};

const nightsBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

const flightCode = (flight: FlightItem) =>
  flight.flightNumber ? `${flight.airlineCode ?? ""}${flight.flightNumber}` : flight.airline ?? "Flight";

export function tripFlights(bundle: TripBundle): FlightBooking[] {
  const flights = bundle.days.flatMap((day) =>
    day.items.filter((item): item is FlightItem => item.type === "flight").map((flight) => ({ flight, day })),
  );
  flights.sort((a, b) =>
    `${a.flight.departDate ?? a.day.date} ${a.flight.departTime ?? ""}`.localeCompare(`${b.flight.departDate ?? b.day.date} ${b.flight.departTime ?? ""}`),
  );
  const out: FlightBooking[] = [];
  for (const { flight, day } of flights) {
    const last = out.at(-1);
    const date = flight.departDate ?? day.date;
    // A flight leaving from where the last one landed, the same day, on the same booking, is its connection.
    if (last && last.date === date && last.route.at(-1) === flight.departAirport && last.ref === flight.confirmationNumber) {
      if (flight.arriveAirport) last.route.push(flight.arriveAirport);
      last.numbers.push(flightCode(flight));
      continue;
    }
    const booking: FlightBooking = {
      date,
      route: [flight.departAirport, flight.arriveAirport].filter((code): code is string => Boolean(code)),
      numbers: [flightCode(flight)],
      dayId: day.id,
    };
    if (flight.departTime) booking.departTime = flight.departTime;
    if (flight.confirmationNumber) booking.ref = flight.confirmationNumber;
    if (flight.travellerNames?.length) booking.travellers = flight.travellerNames.length;
    out.push(booking);
  }
  return out;
}

export function tripStays(bundle: TripBundle): StayBooking[] {
  const byKey = new Map<string, StayBooking>();
  for (const day of bundle.days) {
    for (const item of day.items) {
      if (item.type !== "lodging" || !item.checkInDate || !item.checkOutDate) continue;
      const key = stayKey(item);
      const known = byKey.get(key);
      if (known) {
        fill(known, item);
        continue;
      }
      const place = item.placeId ? bundle.places[item.placeId] : undefined;
      const stay: StayBooking = {
        key,
        name: stayDisplay(item.name, place).name,
        checkInDate: item.checkInDate,
        checkOutDate: item.checkOutDate,
        nights: nightsBetween(item.checkInDate, item.checkOutDate),
      };
      const city = cityOf(place?.address) ?? place?.locality;
      if (city) stay.city = city;
      const checkInDay = bundle.days.find((candidate) => candidate.date === item.checkInDate);
      if (checkInDay) stay.dayId = checkInDay.id;
      fill(stay, item);
      byKey.set(key, stay);
    }
  }
  return [...byKey.values()].sort((a, b) => a.checkInDate.localeCompare(b.checkInDate));
}

/** Booking details can sit on either the check-in or the check-out item. */
function fill(stay: StayBooking, item: LodgingItem): void {
  if (!stay.ref && item.confirmationNumber) stay.ref = item.confirmationNumber;
  if (!stay.rooms && item.guests?.roomCount) stay.rooms = item.guests.roomCount;
  if (!stay.cancelBy && item.cancellationDeadline) stay.cancelBy = item.cancellationDeadline;
  if (!stay.cancelPolicy && item.cancellationPolicy) stay.cancelPolicy = item.cancellationPolicy;
}

/** Days from `today` to a deadline's date: 0 on the day itself, negative once past. */
export const daysUntil = (today: string, deadline: string) => nightsBetween(today, deadline.slice(0, 10));

/** A deadline worth flagging: still ahead, and this close. */
export const URGENT_DAYS = 10;

export type TripPlace =
  | { kind: "before"; days: number }
  | { kind: "during"; day: number; of: number }
  | { kind: "after" };

/** Where today sits in the trip. */
export function tripPlace(bundle: TripBundle, today: string): TripPlace {
  const { startDate, endDate } = bundle.trip;
  if (today < startDate) return { kind: "before", days: nightsBetween(today, startDate) };
  if (today > endDate) return { kind: "after" };
  return { kind: "during", day: nightsBetween(startDate, today) + 1, of: nightsBetween(startDate, endDate) + 1 };
}
