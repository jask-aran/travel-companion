import type { DayItem, FlightItem, Place, RouteLeg } from "@travel-companion/trip-schema";
import { isWaypoint } from "./route-legs";

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** Julian date of the Unix epoch. */
const UNIX_EPOCH_JD = 2_440_587.5;
const J2000 = 2_451_545;

/**
 * Sunrise and sunset for a date and place, as the local clock reads them in
 * `timeZone`.
 *
 * The standard sunrise equation, good to a minute or two away from the poles.
 * The −0.833° altitude allows for refraction and the sun's radius, matching
 * published tables. Either is undefined in polar day or night.
 */
export function sunTimes(
  isoDate: string,
  latitude: number,
  longitude: number,
  timeZone: string,
): { sunrise?: string; sunset?: string } {
  const midnightUtc = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(midnightUtc)) return {};

  const day = Math.ceil(midnightUtc / DAY_MS + UNIX_EPOCH_JD - J2000 + 0.0008);
  const meanNoon = day - longitude / 360;
  const anomaly = (357.5291 + 0.98560028 * meanNoon) % 360;
  const centre =
    1.9148 * Math.sin(anomaly * RAD) +
    0.02 * Math.sin(2 * anomaly * RAD) +
    0.0003 * Math.sin(3 * anomaly * RAD);
  const eclipticLongitude = (anomaly + centre + 180 + 102.9372) % 360;
  const transit =
    J2000 +
    meanNoon +
    0.0053 * Math.sin(anomaly * RAD) -
    0.0069 * Math.sin(2 * eclipticLongitude * RAD);
  const declination = Math.asin(Math.sin(eclipticLongitude * RAD) * Math.sin(23.4397 * RAD));
  const cosHourAngle =
    (Math.sin(-0.833 * RAD) - Math.sin(latitude * RAD) * Math.sin(declination)) /
    (Math.cos(latitude * RAD) * Math.cos(declination));
  if (cosHourAngle < -1 || cosHourAngle > 1) return {};

  const halfDay = Math.acos(cosHourAngle) / RAD / 360;
  const clock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
  const at = (julian: number) => clock.format(new Date((julian - UNIX_EPOCH_JD) * DAY_MS));
  return { sunrise: at(transit - halfDay), sunset: at(transit + halfDay) };
}

export const sunsetTime = (...args: Parameters<typeof sunTimes>) => sunTimes(...args).sunset;

/**
 * How long before departure to be at the airport. Domestic only when both
 * airports are known places in the same country; anything unsure gets the
 * international margin, since early is the safe mistake.
 */
export const INTERNATIONAL_BUFFER_MINUTES = 120;
export const DOMESTIC_BUFFER_MINUTES = 60;

const country = (place?: Place) => place?.address?.split(",").at(-1)?.trim();

function bufferMinutes(flight: FlightItem, places: Record<string, Place>): number {
  const from = country(places[flight.departPlaceId ?? ""]);
  const to = country(places[flight.arrivePlaceId ?? ""]);
  return from && from === to ? DOMESTIC_BUFFER_MINUTES : INTERNATIONAL_BUFFER_MINUTES;
}

/** HH:MM moved by `minutes`, wrapping at midnight. */
function shiftClock(time: string, minutes: number): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return undefined;
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes + 1440 * 2) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export type FlightTiming = {
  /** Be at the departure airport by this local time. */
  airportBy: string;
  /** Leave by this time, when the day routes into the airport. */
  leaveBy?: string;
  /** The transfer to the airport, in travel order. Empty when nothing routes there. */
  legs: RouteLeg[];
  /**
   * The transfer starts at the hotel, so `leaveBy` is when to check out. When
   * that is against the hotel's own check-out time is for the traveller.
   */
  fromHotel: boolean;
};

function leaveTime(airportBy: string, legs: RouteLeg[]): string | undefined {
  const [hours = 0, minutes = 0] = airportBy.split(":").map(Number);
  const travel = legs.reduce((sum, leg) => sum + Math.ceil((leg.durationSeconds ?? 0) / 60), 0);
  return shiftClock("00:00", Math.floor((hours * 60 + minutes - travel) / 5) * 5);
}

/**
 * Work back from departure: the airport margin, then the day's leg into the
 * airport stop. When stations sit between the hotel and the airport (walk to
 * the station, then the train), the transfer is traced back through them to
 * the hotel. Leave-by is rounded down to five minutes so it never reads
 * tighter than it is.
 */
export function flightTiming(
  flight: FlightItem,
  items: DayItem[],
  legs: Map<string, RouteLeg>,
  places: Record<string, Place>,
  hotelPlaceId?: string,
): FlightTiming | undefined {
  if (!flight.departTime) return undefined;
  const airportBy = shiftClock(flight.departTime, -bufferMinutes(flight, places));
  if (!airportBy) return undefined;

  const stops = items.filter((item) => item.type === "place");
  const at = stops.findIndex((item) => item.placeId === flight.departPlaceId);
  const direct = at >= 0 ? legs.get(stops[at]!.id) : undefined;
  if (!direct?.durationSeconds) return { airportBy, legs: [], fromHotel: false };

  const single: FlightTiming = {
    airportBy,
    legs: [direct],
    fromHotel: Boolean(hotelPlaceId) && direct.fromPlaceId === hotelPlaceId,
  };
  const singleLeave = leaveTime(airportBy, [direct]);
  if (singleLeave) single.leaveBy = singleLeave;
  if (!hotelPlaceId || single.fromHotel) return single;

  const chain = [direct];
  for (let index = at - 1; index >= 0; index -= 1) {
    const stop = stops[index]!;
    if (stop.type !== "place" || !isWaypoint(places[stop.placeId])) return single;
    const leg = legs.get(stop.id);
    if (!leg?.durationSeconds) return single;
    chain.unshift(leg);
    if (leg.fromPlaceId === hotelPlaceId) break;
  }
  if (chain[0]?.fromPlaceId !== hotelPlaceId) return single;

  const leaveBy = leaveTime(airportBy, chain);
  if (!leaveBy) return single;
  return { airportBy, leaveBy, legs: chain, fromHotel: true };
}
