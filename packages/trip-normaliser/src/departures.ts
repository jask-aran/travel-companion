import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DepartureBoard,
  DepartureOption,
  DepartureSegment,
  Place,
  TripBundle,
} from "../../trip-schema/src/index.js";
import {
  englishName,
  englishStation,
  localHeadsign,
  localLineName,
  needsTranslation,
  stationQuery,
} from "./line-names.js";
import { curateDepartureBoard } from "./curated-timetables.js";
import { translateNames, type TranslationReport } from "./translate.js";

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
  /** For "arrive": the latest acceptable arrival; options from `time` to here are all fine. */
  until?: string;
};

export type DepartureKeys = {
  google?: string | undefined;
  navitime?: string | undefined;
  /** Google Cloud Translation, for names NAVITIME and Google give in Japanese or Korean. */
  translate?: string | undefined;
  /** The Google Cloud project's number, which selects the Translation LLM. */
  translateProject?: string | undefined;
};

export type DepartureReport = {
  boards: number;
  cached: number;
  requested: { google: number; navitime: number };
  skipped: number;
  translation?: TranslationReport;
  errors: string[];
};

type CacheEntry = { version?: number; fetchedAt: string; approximate?: boolean; options: DepartureOption[] };
type Cache = Record<string, CacheEntry>;

const CACHE_DAYS = 7;
/** Bump when the fields parsed from an answer change, so old entries are re-asked. */
const CACHE_VERSION = 3;
/** Per run; the month allows 500. A full trip is about a dozen legs. */
const NAVITIME_BUDGET = 40;
const OPTIONS_KEPT = 8;
/**
 * One ask returns a handful of options clustered at the time asked. Asking
 * again half an hour and an hour out (later to leave, earlier to arrive)
 * fills out a board, so you can see how often things run and what the next
 * one is if you miss yours.
 *
 * Google only. NAVITIME's marketplace plan has no timetable: its "departure"
 * is the time asked plus an average wait, so asking at 19:30, 20:00 and
 * 20:30 returns the same Skyliner exactly 30 minutes apart. One ask gives
 * the route and a typical ride; more would invent a timetable.
 */
const SAMPLE_OFFSETS_MINUTES: Record<DepartureBoard["provider"], number[]> = {
  google: [0, 30, 60],
  navitime: [0],
};

type Sample = DepartureRequest & { time: string };

const cacheKey = (sample: Sample) =>
  [sample.provider, sample.fromPlaceId, sample.toPlaceId, sample.kind, `${sample.date}T${sample.time}`].join("|");

async function readCache(path: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Cache;
  } catch {
    return {};
  }
}

const fresh = (entry: CacheEntry | undefined, now: Date) =>
  entry?.version === CACHE_VERSION && now.getTime() - Date.parse(entry!.fetchedAt) < CACHE_DAYS * 86_400_000;

/** "HH:MM" moved by minutes, or undefined if that leaves the day. */
function shifted(time: string, minutes: number): string | undefined {
  const total = clockMinutes(time) + minutes;
  if (total < 0 || total >= 1440) return undefined;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** A window is asked about more densely: each ask returns only a few. */
const WINDOW_OFFSETS_MINUTES = [0, 20, 40, 60, 80];

function samplesOf(request: DepartureRequest): Sample[] {
  const direction = request.kind === "depart" ? 1 : -1;
  const offsets =
    request.until && request.provider === "google" ? WINDOW_OFFSETS_MINUTES : SAMPLE_OFFSETS_MINUTES[request.provider];
  return offsets.flatMap((offset) => {
    const anchor = request.kind === "arrive" ? (request.until ?? request.time) : request.time;
    const time = shifted(anchor, offset * direction);
    return time ? [{ ...request, time }] : [];
  });
}

export async function attachDepartures(
  bundle: TripBundle,
  requests: DepartureRequest[],
  keys: DepartureKeys,
  cacheDir: string,
  now = new Date(),
): Promise<DepartureReport> {
  const report: DepartureReport = {
    boards: 0,
    cached: 0,
    requested: { google: 0, navitime: 0 },
    skipped: 0,
    errors: [],
  };
  const cachePath = join(cacheDir, "departures-cache.json");
  const cache = await readCache(cachePath);

  /** One provider answer, from the cache when fresh, else asked for. */
  const answer = async (sample: Sample): Promise<CacheEntry | undefined> => {
    const key = cacheKey(sample);
    if (fresh(cache[key], now)) {
      report.cached += 1;
      return cache[key];
    }
    const apiKey = keys[sample.provider];
    const from = bundle.places[sample.fromPlaceId];
    const to = bundle.places[sample.toPlaceId];
    const spent = sample.provider === "navitime" && report.requested.navitime >= NAVITIME_BUDGET;
    // A stale answer beats none: the timetable rarely moves.
    if (!apiKey || !from || !to || spent) {
      if (!cache[key]) report.skipped += 1;
      return cache[key];
    }
    report.requested[sample.provider] += 1;
    // Use UTC when the origin's offset is unknown.
    const utcOffsetMinutes = from.utcOffsetMinutes ?? 0;
    try {
      const options =
        sample.provider === "google"
          ? parseGoogleRoutes(await fetchGoogle(sample, from, to, apiKey, utcOffsetMinutes), utcOffsetMinutes)
          : parseNavitime(await fetchNavitime(sample, from, to, apiKey));
      const entry: CacheEntry = {
        version: CACHE_VERSION,
        fetchedAt: now.toISOString(),
        ...(sample.provider === "navitime" ? { approximate: true } : {}),
        options,
      };
      cache[key] = entry;
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (report.errors.length < 5) report.errors.push(`${from.name} → ${to.name} at ${sample.time}: ${message}`);
      return cache[key];
    }
  };

  const drafts: Record<string, DepartureBoard> = {};
  for (const request of requests) {
    const entries = (await Promise.all(samplesOf(request).map(answer))).filter(
      (entry): entry is CacheEntry => Boolean(entry),
    );
    entries.push(...(await windowTail(request, entries, answer)));
    const options = tidy(plausible(entries.flatMap((entry) => entry.options), request, bundle));
    if (!options.length) continue;
    const board: DepartureBoard = {
      provider: request.provider,
      target: {
        kind: request.kind,
        date: request.date,
        time: request.time,
        ...(request.until ? { until: request.until } : {}),
      },
      // The oldest answer is the one to doubt.
      fetchedAt: entries.map((entry) => entry.fetchedAt).sort()[0]!,
      ...(entries.some((entry) => entry.approximate) ? { approximate: true } : {}),
      options,
    };
    const curated = request.provider === "navitime" ? curateDepartureBoard(board, bundle.tripId) : { matched: false, board };
    if (curated.matched) {
      // Same dominance rule as provider answers: the 17:20 that arrives 18:44
      // goes when the 17:20 into 18:23 is on the board.
      if (curated.board) {
        // Held to the same window as provider answers, unless nothing in it
        // runs: then the board shows what does, and says the window is missed.
        const inWindow = plausible(curated.board.options, request, bundle);
        const options = tidy(inWindow.length ? inWindow : curated.board.options);
        drafts[request.key] = { ...curated.board, options };
      }
      continue;
    }
    drafts[request.key] = board;
  }

  await mkdir(cacheDir, { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");

  // Names in Japanese or Korean, translated once and cached.
  const locals = Object.values(drafts).flatMap((board) =>
    board.options.flatMap((option) =>
      option.segments.flatMap((segment) => [localOf(segment), segment.headsign ?? "", stationQuery(segment.from ?? ""), stationQuery(segment.to ?? "")]),
    ),
  );
  const { translations, report: translation } = await translateNames(
    locals.filter(needsTranslation),
    keys.translate,
    join(cacheDir, "translations-cache.json"),
    keys.translateProject,
  );
  report.translation = translation;

  const requestOf = new Map(requests.map((request) => [request.key, request]));
  const boards = Object.fromEntries(
    Object.entries(drafts).map(([key, board]) => {
      const request = requestOf.get(key)!;
      const ends = { from: bundle.places[request.fromPlaceId], to: bundle.places[request.toPlaceId] };
      return [
        key,
        { ...board, options: board.options.map((option) => endsNamed(named(option, translations), ends)) },
      ];
    }),
  );
  report.boards = Object.keys(boards).length;
  if (report.boards) bundle.departures = boards;
  return report;
}

/**
 * Google's "arrive by" answers land well before the time asked (ask for
 * 08:25 and the latest is in at 07:57), so the end of a window stays empty.
 * Asking "leave at" from just after the last train found fills it.
 */
async function windowTail(
  request: DepartureRequest,
  entries: CacheEntry[],
  answer: (sample: Sample) => Promise<CacheEntry | undefined>,
): Promise<CacheEntry[]> {
  if (!request.until || request.provider !== "google") return [];
  const options = entries.flatMap((entry) => entry.options);
  const latest = options.reduce<DepartureOption | undefined>(
    (best, option) => (!best || option.arriveTime > best.arriveTime ? option : best),
    undefined,
  );
  if (!latest || latest.arriveTime >= request.until) return [];
  const starts = [1, 21].flatMap((minutes) => shifted(latest.departTime, minutes) ?? []);
  const tail = await Promise.all(starts.map((time) => answer({ ...request, kind: "depart", time })));
  return tail.filter((entry): entry is CacheEntry => Boolean(entry));
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
  // A window (the airport, 3 h to 2 h ahead) wants what arrives within it,
  // plus a little before so the board can start from the nearest one; the
  // early-morning trains that would otherwise fill the board are noise.
  const earliest = request.until ? shifted(request.time, -WINDOW_LEAD_MINUTES) : undefined;
  return options.filter(
    (option) =>
      option.minutes <= ceiling &&
      (request.kind === "arrive"
        ? option.arriveTime <= (request.until ?? request.time) && (!earliest || option.arriveTime >= earliest)
        : option.departTime >= request.time),
  );
}

/** How far before an arrival window a board still lists trains. */
const WINDOW_LEAD_MINUTES = 20;

/** The provider's own name for a segment, whatever an older cache stored. */
const localOf = (segment: DepartureSegment) => localLineName(segment.nameLocal ?? segment.name);

/** English names over the provider's own, which stay for the tooltip. */
function named(option: DepartureOption, translations: Record<string, string>): DepartureOption {
  return {
    ...option,
    segments: option.segments.map((segment) => {
      const { nameLocal: _stored, headsign: _headsign, from: _from, to: _to, ...rest } = segment;
      const local = localOf(segment);
      const name = englishName(local, translations);
      const headsign = segment.headsign && englishName(segment.headsign, translations);
      const from = segment.from && englishStation(segment.from, translations);
      const to = segment.to && englishStation(segment.to, translations);
      return {
        ...rest,
        name,
        ...(name !== local ? { nameLocal: local } : {}),
        ...(headsign ? { headsign } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      };
    }),
  };
}

/** "Shiroko Station" as "Shiroko": a Wanderlog stop that is a station, by name. */
const stationOf = (place: Place | undefined) => /^(.+?)\s+Station$/i.exec(place?.name ?? "")?.[1];

/** Letters to change to turn one name into the other. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/**
 * Where a leg starts or ends at a station saved in the trip, the trip's own
 * spelling beats a machine romanisation (白子 comes back "Shirako"; the
 * station is Shiroko). Only a near-spelling, though: boarding at Kintetsu
 * Nagoya for a stop saved as Nagoya Station is a different station.
 */
const respelt = (given: string | undefined, saved: string) =>
  Boolean(given) && given !== saved && editDistance(given!.toLowerCase(), saved.toLowerCase()) <= 2;

function endsNamed(option: DepartureOption, ends: { from?: Place | undefined; to?: Place | undefined }): DepartureOption {
  const from = stationOf(ends.from);
  const to = stationOf(ends.to);
  const last = option.segments.length - 1;
  return {
    ...option,
    segments: option.segments.map((segment, index) => ({
      ...segment,
      ...(index === 0 && from && respelt(segment.from, from) ? { from } : {}),
      ...(index === last && to && respelt(segment.to, to) ? { to } : {}),
    })),
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
function utcInstant(date: string, time: string, utcOffsetMinutes: number): string {
  const local = Date.parse(`${date}T${time}:00Z`);
  return new Date(local - utcOffsetMinutes * 60_000).toISOString();
}

async function fetchGoogle(request: DepartureRequest, from: Place, to: Place, apiKey: string, utcOffsetMinutes: number) {
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.legs.steps.travelMode,routes.legs.steps.transitDetails,routes.legs.steps.staticDuration",
    },
    body: JSON.stringify({
      origin: waypoint(from),
      destination: waypoint(to),
      travelMode: "TRANSIT",
      computeAlternativeRoutes: true,
      [request.kind === "arrive" ? "arrivalTime" : "departureTime"]: utcInstant(request.date, request.time, utcOffsetMinutes),
      languageCode: "en",
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
  return (await response.json()) as GoogleRoutesResponse;
}

type GoogleTransit = {
  stopDetails?: {
    departureTime?: string;
    arrivalTime?: string;
    departureStop?: { name?: string };
    arrivalStop?: { name?: string };
  };
  headsign?: string;
  transitLine?: { name?: string; nameShort?: string; color?: string; vehicle?: { type?: string } };
};
export type GoogleRoutesResponse = {
  routes?: { duration?: string; legs?: { steps?: { travelMode?: string; staticDuration?: string; transitDetails?: GoogleTransit }[] }[] }[];
};

/** An RFC 3339 instant as local "HH:MM". */
export function localClock(instant: string | undefined, utcOffsetMinutes: number): string | undefined {
  if (!instant) return undefined;
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + utcOffsetMinutes * 60_000).toISOString().slice(11, 16);
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

/** A stop's name, folded like a headsign. */
function stopName(raw: string | undefined): string | undefined {
  return raw?.normalize("NFKC").trim() || undefined;
}

// Use UTC when the caller has no origin offset.
export function parseGoogleRoutes(response: GoogleRoutesResponse, utcOffsetMinutes = 0): DepartureOption[] {
  const options: DepartureOption[] = [];
  for (const route of response.routes ?? []) {
    const segments: DepartureSegment[] = [];
    const steps = route.legs?.flatMap((leg) => leg.steps ?? []) ?? [];
    const firstRide = steps.findIndex((step) => step.transitDetails);
    const walkSeconds = steps
      .slice(0, firstRide < 0 ? 0 : firstRide)
      .filter((step) => step.travelMode === "WALK")
      .reduce((sum, step) => sum + (Number.parseFloat(step.staticDuration ?? "") || 0), 0);
    const walkMinutes = Math.ceil(walkSeconds / 60);
    for (const step of steps) {
      const transit = step.transitDetails;
      const departTime = localClock(transit?.stopDetails?.departureTime, utcOffsetMinutes);
      const arriveTime = localClock(transit?.stopDetails?.arrivalTime, utcOffsetMinutes);
      if (!transit || !departTime || !arriveTime) continue;
      const line = transit.transitLine;
      const headsign = localHeadsign(transit.headsign);
      const from = stopName(transit.stopDetails?.departureStop?.name);
      const to = stopName(transit.stopDetails?.arrivalStop?.name);
      segments.push({
        name: localLineName(line?.nameShort || line?.name || "Transit"),
        kind: googleKind(line?.vehicle?.type),
        departTime,
        arriveTime,
        ...(headsign ? { headsign } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(line?.color ? { color: line.color } : {}),
      });
    }
    const first = segments[0];
    const last = segments.at(-1);
    if (!first || !last) continue;
    options.push({
      departTime: first.departTime,
      arriveTime: last.arriveTime,
      minutes: span(first, last),
      ...(walkMinutes > 0 ? { walkMinutes } : {}),
      segments,
    });
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
  /** Minutes, on move sections. */
  time?: number;
  name?: string;
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

/** A station's name; "start" and "goal" stand for the query's own points. */
function pointName(section: NavitimeSection | undefined): string | undefined {
  const name = stopName(section?.name);
  return name && name !== "start" && name !== "goal" ? name : undefined;
}

export function parseNavitime(response: NavitimeResponse): DepartureOption[] {
  const options: DepartureOption[] = [];
  for (const item of response.items ?? []) {
    const segments: DepartureSegment[] = [];
    const sections = item.sections ?? [];
    const moves = sections.filter((section) => section.type === "move");
    const firstRide = moves.findIndex((section) => section.move !== "walk");
    const walkMinutes = moves
      .slice(0, firstRide < 0 ? 0 : firstRide)
      .reduce((sum, section) => sum + (section.time ?? 0), 0);
    for (const [index, section] of sections.entries()) {
      if (section.type !== "move" || !section.move || section.move === "walk") continue;
      const departTime = section.from_time?.slice(11, 16);
      const arriveTime = section.to_time?.slice(11, 16);
      if (!departTime || !arriveTime) continue;
      const from = pointName(sections.slice(0, index).findLast((other) => other.type === "point"));
      const to = pointName(sections.slice(index + 1).find((other) => other.type === "point"));
      // `transport.name` is the service; `line_name` may add the stretch ridden.
      segments.push({
        name: localLineName(section.transport?.name || section.line_name || "Train"),
        kind: navitimeKind(section),
        departTime,
        arriveTime,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(section.transport?.color ? { color: section.transport.color } : {}),
      });
    }
    const first = segments[0];
    const last = segments.at(-1);
    if (!first || !last) continue;
    options.push({
      departTime: first.departTime,
      arriveTime: last.arriveTime,
      minutes: span(first, last),
      ...(walkMinutes > 0 ? { walkMinutes } : {}),
      segments,
    });
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
