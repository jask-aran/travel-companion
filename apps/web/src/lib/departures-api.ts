import type { DepartureBoard, Place, TripBundle } from "@travel-companion/trip-schema";
import type { DepartureTarget } from "./departure-targets.js";

/**
 * Live departure boards: the app asks its worker (`api/departures`) for a
 * leg's board, the worker asks Google or NAVITIME and keeps the answer, so
 * everyone who opens the trip sees the same board and the providers are
 * asked about it at most twice a day. Shared by the app, the Pages worker
 * and Vite's dev middleware, as media.ts is for photos.
 *
 * The question carries what building a board needs, not the trip: the worker
 * can't read the itinerary without the passphrase, and doesn't need to.
 */

export const DEPARTURES_ROUTE = "api/departures";

/** What a board needs to know about each end of the leg. */
export type BoardPlace = Pick<Place, "id" | "name" | "latitude" | "longitude" | "googlePlaceId" | "timeZone" | "utcOffsetMinutes">;

export type BoardQuestion = {
  provider: DepartureBoard["provider"];
  kind: DepartureBoard["target"]["kind"];
  date: string;
  time: string;
  until?: string;
  from: BoardPlace;
  to: BoardPlace;
  /** Wanderlog's estimate for the leg, which rules out wildly slow routes. */
  estimateSeconds?: number;
};

/** Today and tomorrow, where the leg starts, are fetched live. */
export const LIVE_DAYS = 2;
/** How long a live board is good for: two asks a day. */
export const SOON_LIFETIME_MS = 12 * 3_600_000;
/** A board for a later day (a stop the pull has no board for) changes little. */
export const LATER_LIFETIME_MS = 7 * 86_400_000;

const pick = (place: Place): BoardPlace => ({
  id: place.id,
  name: place.name,
  ...(place.latitude != null ? { latitude: place.latitude } : {}),
  ...(place.longitude != null ? { longitude: place.longitude } : {}),
  ...(place.googlePlaceId ? { googlePlaceId: place.googlePlaceId } : {}),
  ...(place.timeZone ? { timeZone: place.timeZone } : {}),
  ...(place.utcOffsetMinutes != null ? { utcOffsetMinutes: place.utcOffsetMinutes } : {}),
});

/** The question for a target, or undefined if a place is missing. */
export function boardQuestion(target: DepartureTarget, bundle: Pick<TripBundle, "places" | "routeLegs">): BoardQuestion | undefined {
  const from = bundle.places[target.fromPlaceId];
  const to = bundle.places[target.toPlaceId];
  if (!from || !to) return undefined;
  // The same leg the pull's plausibility check reads.
  const leg = Object.values(bundle.routeLegs).find(
    (candidate) => candidate.fromPlaceId === target.fromPlaceId && candidate.toPlaceId === target.toPlaceId,
  );
  return canonical({
    provider: target.provider,
    kind: target.kind,
    date: target.date,
    time: target.time,
    ...(target.until ? { until: target.until } : {}),
    from: pick(from),
    to: pick(to),
    ...(leg?.durationSeconds ? { estimateSeconds: leg.durationSeconds } : {}),
  });
}

/** Fields in one order, so the same question is the same text, and the same stored board. */
function canonical(question: BoardQuestion): BoardQuestion {
  const place = (value: BoardPlace): BoardPlace => ({
    id: value.id,
    name: value.name,
    ...(value.latitude != null ? { latitude: value.latitude } : {}),
    ...(value.longitude != null ? { longitude: value.longitude } : {}),
    ...(value.googlePlaceId ? { googlePlaceId: value.googlePlaceId } : {}),
    ...(value.timeZone ? { timeZone: value.timeZone } : {}),
    ...(value.utcOffsetMinutes != null ? { utcOffsetMinutes: value.utcOffsetMinutes } : {}),
  });
  return {
    provider: question.provider,
    kind: question.kind,
    date: question.date,
    time: question.time,
    ...(question.until ? { until: question.until } : {}),
    from: place(question.from),
    to: place(question.to),
    ...(question.estimateSeconds ? { estimateSeconds: question.estimateSeconds } : {}),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;
const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/;

const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;
const number = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;

function readPlace(value: unknown): BoardPlace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const place = value as Record<string, unknown>;
  if (!text(place.id, 200) || !text(place.name, 200)) return undefined;
  if (place.latitude !== undefined && !number(place.latitude, -90, 90)) return undefined;
  if (place.longitude !== undefined && !number(place.longitude, -180, 180)) return undefined;
  if (place.googlePlaceId !== undefined && !(typeof place.googlePlaceId === "string" && PLACE_ID.test(place.googlePlaceId))) return undefined;
  if (place.timeZone !== undefined && !(typeof place.timeZone === "string" && ZONE.test(place.timeZone))) return undefined;
  if (place.utcOffsetMinutes !== undefined && !number(place.utcOffsetMinutes, -900, 900)) return undefined;
  return place as BoardPlace;
}

/** A question as the worker receives it (JSON in `q`), or undefined if it isn't one. */
export function readBoardQuestion(raw: string | null): BoardQuestion | undefined {
  if (!raw || raw.length > 3000) return undefined;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  if (value.provider !== "google" && value.provider !== "navitime") return undefined;
  if (value.kind !== "arrive" && value.kind !== "depart") return undefined;
  if (typeof value.date !== "string" || !DATE.test(value.date)) return undefined;
  if (typeof value.time !== "string" || !CLOCK.test(value.time)) return undefined;
  if (value.until !== undefined && !(typeof value.until === "string" && CLOCK.test(value.until))) return undefined;
  if (value.estimateSeconds !== undefined && !number(value.estimateSeconds, 0, 172_800)) return undefined;
  const from = readPlace(value.from);
  const to = readPlace(value.to);
  if (!from || !to) return undefined;
  return canonical({ ...(value as unknown as BoardQuestion), from, to });
}

/** The calendar date now where a place is: its zone, else its offset, else this device's. */
export function localDate(place: Pick<BoardPlace, "timeZone" | "utcOffsetMinutes">, now: Date): string {
  if (place.timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: place.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    } catch {
      // An unknown zone falls through to the offset.
    }
  }
  if (place.utcOffsetMinutes != null) return new Date(now.getTime() + place.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

type Dated = { date: string; from: Pick<BoardPlace, "timeZone" | "utcOffsetMinutes"> };

/** Whether a leg is today or tomorrow where it starts. */
export function isSoon(question: Dated, now: Date): boolean {
  const today = localDate(question.from, now);
  return question.date >= today && question.date < addDays(today, LIVE_DAYS);
}

/** How long the worker keeps a board before asking again. */
export function boardLifetimeMs(question: Dated, now: Date): number {
  return isSoon(question, now) ? SOON_LIFETIME_MS : LATER_LIFETIME_MS;
}
