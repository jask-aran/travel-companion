import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DepartureBoard,
  DepartureOption,
  DepartureSegment,
  Place,
  TripBundle,
} from "../../trip-schema/src/index.js";
import { englishHeadsign, englishLineName } from "./line-names.js";

/**
 * Departure options for the legs that need them, fetched at pull time and
 * stored on the bundle so they work offline. Google answers for Korea;
 * Google's API has no Japanese transit (its FAQ excludes Japan's partners),
 * so NAVITIME answers for Japan.
 *
 * NAVITIME's marketplace plan allows 500 requests a month and counts failed
 * ones, so answers are cached on disk and reused for a week, and a run
 * stops asking once it has spent its budget.
 */

/** What to fetch; the trip's own rules pick these (departure-targets). */
export type DepartureRequest = {
  key: string;
  fromPlaceId: string;
  toPlaceId: string;
  provider: DepartureBoard["provider"];
  kind: DepartureBoard["target"]["kind"];
  date: string;
  time: string;
};

export type DepartureKeys = { google?: string | undefined; navitime?: string | undefined };

export type DepartureReport = {
  boards: number;
  cached: number;
  requested: { google: number; navitime: number };
  skipped: number;
  errors: string[];
};

type CacheEntry = { fetchedAt: string; approximate?: boolean; options: DepartureOption[] };
type Cache = Record<string, CacheEntry>;

const CACHE_DAYS = 7;
/** Per run; the month allows 500. A full trip is about a dozen legs. */
const NAVITIME_BUDGET = 40;
const OPTIONS_KEPT = 5;
/** Japan and Korea are both UTC+9, with no daylight saving. */
const UTC_OFFSET_HOURS = 9;

const cacheKey = (request: DepartureRequest) =>
  [request.provider, request.fromPlaceId, request.toPlaceId, request.kind, `${request.date}T${request.time}`].join("|");

async function readCache(path: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Cache;
  } catch {
    return {};
  }
}

const fresh = (entry: CacheEntry | undefined, now: Date) =>
  Boolean(entry) && now.getTime() - Date.parse(entry!.fetchedAt) < CACHE_DAYS * 86_400_000;

export async function attachDepartures(
  bundle: TripBundle,
  requests: DepartureRequest[],
  keys: DepartureKeys,
  cachePath: string,
  now = new Date(),
): Promise<DepartureReport> {
  const report: DepartureReport = {
    boards: 0,
    cached: 0,
    requested: { google: 0, navitime: 0 },
    skipped: 0,
    errors: [],
  };
  const cache = await readCache(cachePath);
  const boards: Record<string, DepartureBoard> = {};

  for (const request of requests) {
    const key = cacheKey(request);
    let entry = fresh(cache[key], now) ? cache[key] : undefined;
    if (entry) report.cached += 1;
    else {
      const apiKey = keys[request.provider];
      const from = bundle.places[request.fromPlaceId];
      const to = bundle.places[request.toPlaceId];
      const spent = request.provider === "navitime" && report.requested.navitime >= NAVITIME_BUDGET;
      if (!apiKey || !from || !to || spent) {
        // A stale answer beats none: the timetable rarely moves.
        entry = cache[key];
        if (!entry) report.skipped += 1;
      } else {
        report.requested[request.provider] += 1;
        try {
          const options =
            request.provider === "google"
              ? parseGoogleRoutes(await fetchGoogle(request, from, to, apiKey))
              : parseNavitime(await fetchNavitime(request, from, to, apiKey));
          entry = {
            fetchedAt: now.toISOString(),
            ...(request.provider === "navitime" ? { approximate: true } : {}),
            options,
          };
          cache[key] = entry;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (report.errors.length < 5) report.errors.push(`${from.name} → ${to.name}: ${message}`);
          entry = cache[key];
        }
      }
    }
    if (!entry) continue;
    const options = plausible(entry.options, request, bundle).map(retranslate);
    if (!options.length) continue;
    boards[request.key] = {
      provider: request.provider,
      target: { kind: request.kind, date: request.date, time: request.time },
      fetchedAt: entry.fetchedAt,
      ...(entry.approximate ? { approximate: true } : {}),
      options,
    };
    report.boards += 1;
  }

  if (report.boards) bundle.departures = boards;
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return report;
}

/**
 * Options that answer the question asked: arriving by the target or leaving
 * at or after it, and not wildly slower than Wanderlog's own estimate for the
 * leg. Without bus timetables NAVITIME routes a bus-only trip (Takayama to
 * Shinhotaka) as five hours of trains via Matsumoto; better no board than
 * that one.
 */
function plausible(
  options: DepartureOption[],
  request: DepartureRequest,
  bundle: TripBundle,
): DepartureOption[] {
  const leg = Object.values(bundle.routeLegs).find(
    (candidate) => candidate.fromPlaceId === request.fromPlaceId && candidate.toPlaceId === request.toPlaceId,
  );
  const estimate = (leg?.durationSeconds ?? 0) / 60;
  const ceiling = estimate ? Math.max(estimate * 2, estimate + 60) : Infinity;
  return options.filter(
    (option) =>
      option.minutes <= ceiling &&
      (request.kind === "arrive" ? option.arriveTime <= request.time : option.departTime >= request.time),
  );
}

/** Names from the provider's own text, so a new translation reaches cached boards. */
function retranslate(option: DepartureOption): DepartureOption {
  return {
    ...option,
    segments: option.segments.map((segment) => {
      const { nameLocal: _old, ...rest } = segment;
      const { name, nameLocal } = englishLineName(segment.nameLocal ?? segment.name);
      return { ...rest, name, ...(nameLocal ? { nameLocal } : {}) };
    }),
  };
}

/* ---------- Google Routes (Korea) ---------- */

const googleId = (place: Place) =>
  place.googlePlaceId ?? /^google-place:(.+)$/.exec(place.id)?.[1];

const waypoint = (place: Place) => {
  const id = googleId(place);
  if (id) return { placeId: id };
  return { location: { latLng: { latitude: place.latitude, longitude: place.longitude } } };
};

/** Local wall-clock date and time as the UTC instant Google wants. */
function utcInstant(date: string, time: string): string {
  const local = Date.parse(`${date}T${time}:00Z`);
  return new Date(local - UTC_OFFSET_HOURS * 3_600_000).toISOString();
}

async function fetchGoogle(request: DepartureRequest, from: Place, to: Place, apiKey: string) {
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.legs.steps.travelMode,routes.legs.steps.transitDetails",
    },
    body: JSON.stringify({
      origin: waypoint(from),
      destination: waypoint(to),
      travelMode: "TRANSIT",
      computeAlternativeRoutes: true,
      [request.kind === "arrive" ? "arrivalTime" : "departureTime"]: utcInstant(request.date, request.time),
      languageCode: "en",
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
  return (await response.json()) as GoogleRoutesResponse;
}

type GoogleTransit = {
  stopDetails?: { departureTime?: string; arrivalTime?: string };
  headsign?: string;
  transitLine?: { name?: string; nameShort?: string; color?: string; vehicle?: { type?: string } };
};
export type GoogleRoutesResponse = {
  routes?: { duration?: string; legs?: { steps?: { transitDetails?: GoogleTransit }[] }[] }[];
};

/** An RFC 3339 instant as local "HH:MM". */
function localClock(instant: string | undefined): string | undefined {
  if (!instant) return undefined;
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(11, 16);
}

function googleKind(type: string | undefined): DepartureSegment["kind"] {
  switch (type) {
    case "HIGH_SPEED_TRAIN":
      return "shinkansen";
    case "LONG_DISTANCE_TRAIN":
      return "express";
    case "SUBWAY":
    case "METRO_RAIL":
      return "subway";
    case "BUS":
    case "INTERCITY_BUS":
    case "TROLLEYBUS":
      return "bus";
    case "FERRY":
      return "ferry";
    case "RAIL":
    case "HEAVY_RAIL":
    case "COMMUTER_TRAIN":
    case "MONORAIL":
    case "TRAM":
      return "rail";
    default:
      return "other";
  }
}

export function parseGoogleRoutes(response: GoogleRoutesResponse): DepartureOption[] {
  const options: DepartureOption[] = [];
  for (const route of response.routes ?? []) {
    const segments: DepartureSegment[] = [];
    for (const step of route.legs?.flatMap((leg) => leg.steps ?? []) ?? []) {
      const transit = step.transitDetails;
      const departTime = localClock(transit?.stopDetails?.departureTime);
      const arriveTime = localClock(transit?.stopDetails?.arrivalTime);
      if (!transit || !departTime || !arriveTime) continue;
      const line = transit.transitLine;
      const { name, nameLocal } = englishLineName(line?.nameShort || line?.name || "Transit");
      const headsign = englishHeadsign(transit.headsign);
      segments.push({
        name,
        ...(nameLocal ? { nameLocal } : {}),
        kind: googleKind(line?.vehicle?.type),
        departTime,
        arriveTime,
        ...(headsign ? { headsign } : {}),
        ...(line?.color ? { color: line.color } : {}),
      });
    }
    const first = segments[0];
    const last = segments.at(-1);
    if (!first || !last) continue;
    options.push({ departTime: first.departTime, arriveTime: last.arriveTime, minutes: span(first, last), segments });
  }
  return tidy(options);
}

/* ---------- NAVITIME (Japan) ---------- */

async function fetchNavitime(request: DepartureRequest, from: Place, to: Place, apiKey: string) {
  if (from.latitude == null || from.longitude == null || to.latitude == null || to.longitude == null) {
    throw new Error("missing coordinates");
  }
  const params = new URLSearchParams({
    start: `${from.latitude},${from.longitude}`,
    goal: `${to.latitude},${to.longitude}`,
    [request.kind === "arrive" ? "goal_time" : "start_time"]: `${request.date}T${request.time}:00`,
    limit: String(OPTIONS_KEPT),
  });
  const response = await fetch(`https://navitime-route-totalnavi.p.rapidapi.com/route_transit?${params}`, {
    headers: {
      "x-rapidapi-host": "navitime-route-totalnavi.p.rapidapi.com",
      "x-rapidapi-key": apiKey,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
  return (await response.json()) as NavitimeResponse;
}

type NavitimeSection = {
  type?: string;
  move?: string;
  from_time?: string;
  to_time?: string;
  line_name?: string;
  transport?: { name?: string; color?: string; company?: { name?: string } };
};
export type NavitimeResponse = {
  items?: { summary?: { move?: { time?: number } }; sections?: NavitimeSection[] }[];
};

function navitimeKind(section: NavitimeSection): DepartureSegment["kind"] {
  const company = section.transport?.company?.name ?? "";
  switch (section.move) {
    case "superexpress_train":
      return "shinkansen";
    case "ultraexpress_train":
      return "express";
    case "local_bus":
    case "highway_bus":
    case "shuttle_bus":
      return "bus";
    case "ferry":
      return "ferry";
    case "express_train":
    case "rapid_train":
    case "semiexpress_train":
    case "local_train":
      return /メトロ|地下鉄|都営|交通局/.test(`${company}${section.transport?.name ?? ""}`) ? "subway" : "rail";
    default:
      return "other";
  }
}

export function parseNavitime(response: NavitimeResponse): DepartureOption[] {
  const options: DepartureOption[] = [];
  for (const item of response.items ?? []) {
    const segments: DepartureSegment[] = [];
    for (const section of item.sections ?? []) {
      if (section.type !== "move" || !section.move || section.move === "walk") continue;
      const departTime = section.from_time?.slice(11, 16);
      const arriveTime = section.to_time?.slice(11, 16);
      if (!departTime || !arriveTime) continue;
      // `transport.name` is the service; `line_name` may add the stretch ridden.
      const { name, nameLocal } = englishLineName(section.transport?.name || section.line_name || "Train");
      segments.push({
        name,
        ...(nameLocal ? { nameLocal } : {}),
        kind: navitimeKind(section),
        departTime,
        arriveTime,
        ...(section.transport?.color ? { color: section.transport.color } : {}),
      });
    }
    const first = segments[0];
    const last = segments.at(-1);
    if (!first || !last) continue;
    options.push({ departTime: first.departTime, arriveTime: last.arriveTime, minutes: span(first, last), segments });
  }
  return tidy(options);
}

const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Boarding to final arrival, wrapping past midnight. Provider totals count
 * the wait from the query time or the walk to the stop; a board compares
 * rides.
 */
function span(first: DepartureSegment, last: DepartureSegment): number {
  return (clockMinutes(last.arriveTime) - clockMinutes(first.departTime) + 1440) % 1440;
}

/**
 * Board order, by first departure. Drops any option another one beats on
 * both ends (leaves later, arrives sooner): nobody takes the 08:19 local to
 * arrive at 13:17 when the 08:34 Hida is in at 10:55. Same-time duplicates
 * (one train, different walks) go the same way.
 */
function tidy(options: DepartureOption[]): DepartureOption[] {
  const absolute = (option: DepartureOption) => {
    const depart = clockMinutes(option.departTime);
    return { depart, arrive: depart + option.minutes };
  };
  const kept = options.filter((option, index) => {
    const self = absolute(option);
    return !options.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      const them = absolute(other);
      const beats = them.depart >= self.depart && them.arrive <= self.arrive;
      const strictly = them.depart > self.depart || them.arrive < self.arrive;
      // Identical times: keep the first only.
      return beats && (strictly || otherIndex < index);
    });
  });
  return kept.sort((a, b) => a.departTime.localeCompare(b.departTime)).slice(0, OPTIONS_KEPT);
}
