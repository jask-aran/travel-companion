import type { DepartureBoard, DepartureOption, DepartureSegment, Place } from "../../trip-schema/src/index.js";

type TimetableDeparture = {
  train: string;
  stops: Record<string, string | { arrive?: string; depart?: string }>;
  days?: "daily" | "weekdays" | "weekends";
  dates?: string[];
};

export type CuratedTimetable = {
  id: string;
  operator: string;
  service: string;
  serviceNames: string[];
  kind: DepartureSegment["kind"];
  stationNames: Record<string, string>;
  /** Where each stop is, [latitude, longitude], keyed exactly as in `departures[].stops`. */
  stopCoordinates?: Record<string, [number, number]>;
  /** Dates this timetable is good for, inclusive ISO dates. Outside them nothing runs. */
  valid?: { from: string; to: string };
  /** Every departure of the service day is listed, so the table can make a whole-day board. */
  allDay?: boolean | undefined;
  source: { urls: string[]; retrieved: string; note: string };
  departures: TimetableDeparture[];
};

export const DAY_OPTIONS_KEPT = 40;
const DIRECT_WALK_METRES = 1200;

/** Operators as one name each, once: jointly run services list theirs as "Nohi Bus / Hokutetsu". */
const operatorsOf = (names: (string | undefined)[]) =>
  [...new Set(names.flatMap((name) => name?.split(" / ") ?? []))].join(" / ");

const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Remove terminal details that NAVITIME adds to a station name. */
function stationKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\([^)]*\)|〔[^〕]*〕/g, "")
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}

function serviceKey(value: string): string {
  return value.normalize("NFKC").replace(/[\s　]/g, "").toLocaleLowerCase();
}

function stationTime(
  stops: TimetableDeparture["stops"],
  name: string | undefined,
  event: "arrive" | "depart",
): string | undefined {
  if (!name) return undefined;
  const key = stationKey(name);
  const match = Object.entries(stops).find(([station]) => stationKey(station) === key);
  const time = match?.[1];
  return typeof time === "string" ? time : time?.[event];
}

function dayMatches(date: string, departure: TimetableDeparture, table: CuratedTimetable): boolean {
  if (table.valid && (date < table.valid.from || date > table.valid.to)) return false;
  if (departure.dates) return departure.dates.includes(date);
  if (!departure.days || departure.days === "daily") return true;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return departure.days === "weekends" ? weekday === 0 || weekday === 6 : weekday > 0 && weekday < 6;
}

function serviceMatches(segment: DepartureSegment, table: CuratedTimetable): boolean {
  const rawName = (segment.nameLocal ?? segment.name).normalize("NFKC");
  const name = serviceKey(rawName);
  return table.serviceNames.some((service) => {
    const key = serviceKey(service);
    if (key === name) return true;
    if (!name.startsWith(key)) return false;

    // NAVITIME can append the stretch to the service name, for example
    // "京成スカイライナー 空港第2ビル(...)→日暮里".
    const routeStart = rawName.split("→", 1)[0] ?? "";
    const suffix = stationKey(routeStart).slice(key.length);
    return Boolean(segment.from && suffix === stationKey(segment.from));
  });
}

type ScheduledRide = {
  index: number;
  table: CuratedTimetable;
  train: TimetableDeparture;
  depart: string;
  arrive: string;
};

/**
 * Trains worth listing: to leave at a time, the ones after it; to arrive by
 * one, those arriving in the hours before it and, so a board can say the
 * target is missed rather than go blank, the first couple of hours after.
 */
function withinWindow(ride: Pick<ScheduledRide, "depart" | "arrive">, board: Pick<DepartureBoard, "target">): boolean {
  if (board.target.kind === "day") return clockMinutes(ride.depart) >= clockMinutes(board.target.time);
  if (board.target.kind === "depart") {
    const target = clockMinutes(board.target.time);
    const depart = clockMinutes(ride.depart);
    return depart >= target && depart <= target + 180;
  }
  const target = clockMinutes(board.target.until ?? board.target.time);
  const arrive = clockMinutes(ride.arrive);
  return arrive >= target - 180 && arrive <= target + 120;
}

function durationBetween(start: string, end: string): number {
  return (clockMinutes(end) - clockMinutes(start) + 1440) % 1440;
}

function formatClock(minutes: number) {
  const wrapped = (minutes + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function scheduledOption(option: DepartureOption, rides: ScheduledRide[]): DepartureOption {
  const byIndex = new Map(rides.map((ride) => [ride.index, ride]));
  const ordered = [...rides].sort((a, b) => a.index - b.index);
  const segments = option.segments.map((segment, index) => {
    const ride = byIndex.get(index);
    if (ride) {
      const from = segment.from ? ride.table.stationNames[stationKey(segment.from)] ?? segment.from : undefined;
      const to = segment.to ? ride.table.stationNames[stationKey(segment.to)] ?? segment.to : undefined;
      const { nameLocal: _nameLocal, ...rest } = segment;
      return {
        ...rest,
        name: ride.train.train,
        kind: ride.table.kind,
        departTime: ride.depart,
        arriveTime: ride.arrive,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      };
    }

    const previous = ordered.filter((candidate) => candidate.index < index).at(-1);
    const next = ordered.find((candidate) => candidate.index > index);
    const reference = previous ?? next;
    if (!reference) return segment;
    const shift = previous
      ? clockMinutes(previous.arrive) - clockMinutes(option.segments[previous.index]!.arriveTime)
      : clockMinutes(next!.depart) - clockMinutes(option.segments[next!.index]!.departTime);
    return {
      ...segment,
      departTime: formatClock(clockMinutes(segment.departTime) + shift),
      arriveTime: formatClock(clockMinutes(segment.arriveTime) + shift),
    };
  });
  const first = segments[0]!;
  const last = segments.at(-1)!;
  return {
    departTime: first.departTime,
    arriveTime: last.arriveTime,
    minutes: durationBetween(first.departTime, last.arriveTime),
    ...(option.walkMinutes !== undefined ? { walkMinutes: option.walkMinutes } : {}),
    segments,
  };
}

function canConnect(option: DepartureOption, rides: ScheduledRide[]): boolean {
  const ordered = [...rides].sort((a, b) => a.index - b.index);
  return ordered.every((ride, index) => {
    const previous = ordered[index - 1];
    if (!previous || ride.index !== previous.index + 1) return true;
    const previousSegment = option.segments[previous.index]!;
    const segment = option.segments[ride.index]!;
    return (
      !previousSegment.to || !segment.from || stationKey(previousSegment.to) !== stationKey(segment.from) ||
      clockMinutes(ride.depart) >= clockMinutes(previous.arrive)
    );
  });
}

/**
 * Minutes to change trains at one station. Timetabled connections are often
 * cross-platform and a minute apart (Kintetsu at Ise-Wakamatsu: in 17:31,
 * out 17:32), so anything tighter than that is the only thing ruled out.
 */
const TRANSFER_MINUTES = 1;

/**
 * Whole journeys from the curated rides: each first ride, then for every
 * later ride the first train you can actually catch after it. Pairing every
 * train with every later one would fill the board with journeys nobody
 * takes (the 17:20 local followed by the 19:29 express).
 */
function connections(option: DepartureOption, choicesByIndex: ScheduledRide[][]): ScheduledRide[][] {
  const curated = choicesByIndex.map((choices, index) => ({ choices, index })).filter((entry) => entry.choices.length);
  const [first, ...rest] = curated;
  if (!first) return [];
  const between = (from: number, to: number) =>
    option.segments
      .slice(from + 1, to)
      .reduce((sum, segment) => sum + durationBetween(segment.departTime, segment.arriveTime), 0);
  return first.choices.flatMap((start) => {
    const chain = [start];
    for (const next of rest) {
      const previous = chain.at(-1)!;
      const ready = clockMinutes(previous.arrive) + between(previous.index, next.index) + TRANSFER_MINUTES;
      const caught = next.choices
        .filter((choice) => clockMinutes(choice.depart) >= ready)
        .sort((a, b) => clockMinutes(a.depart) - clockMinutes(b.depart))[0];
      if (!caught) return [];
      chain.push(caught);
    }
    return [chain];
  });
}

function rideChoices(option: DepartureOption, board: DepartureBoard, index: number, timetables: CuratedTimetable[]) {
  const segment = option.segments[index]!;
  const choices: ScheduledRide[] = [];
  let matched = false;
  // The service NAVITIME suggested, and any other curated service between
  // the same two stations: NAVITIME offers Namba to Kansai Airport only by
  // Rapi:t, but the airport express runs there too, earlier in the morning.
  // City subways are left out: their hops are short and run every few minutes.
  const alternatives = segment.kind !== "subway";
  for (const table of timetables) {
    if (board.target.kind === "day" && !table.allDay) continue;
    if (!serviceMatches(segment, table) && !(alternatives && table.kind !== "subway")) continue;
    for (const train of table.departures) {
      const depart = stationTime(train.stops, segment.from, "depart");
      const arrive = stationTime(train.stops, segment.to, "arrive");
      // Both stations on the train, in the direction of travel.
      if (!depart || !arrive || clockMinutes(arrive) <= clockMinutes(depart)) continue;
      matched = true;
      const ride = { index, table, train, depart, arrive };
      if (dayMatches(board.target.date, train, table) && withinWindow(ride, board)) choices.push(ride);
    }
  }
  return { matched, choices };
}

export type CuratedBoardResult = {
  matched: boolean;
  board?: DepartureBoard;
};

/** Replace matching NAVITIME estimates with published station times. */
export function curateDepartureBoard(board: DepartureBoard, timetables: CuratedTimetable[]): CuratedBoardResult {
  if (board.provider !== "navitime") return { matched: false, board };

  let matched = false;
  const curated: Array<{ option: DepartureOption; operator: string; estimatedRail: boolean }> = [];

  for (const option of board.options) {
    const byIndex = option.segments.map((_, index) => rideChoices(option, board, index, timetables));
    if (!byIndex.some((entry) => entry.matched)) continue;
    matched = true;

    const combinations = connections(option, byIndex.map((entry) => entry.choices));
    for (const rides of combinations) {
      if (!rides.length || !canConnect(option, rides)) continue;
      const result = scheduledOption(option, rides);
      // A journey that starts on NAVITIME's estimate for a train (a local
      // that runs twice an hour) gives a departure time nobody can rely on.
      // Estimates after a real train are fine: the Yamanote hop on from the
      // Skyliner runs every few minutes, and a subway start does too.
      const curatedIndexes = new Set(rides.map((ride) => ride.index));
      const firstRide = option.segments[0];
      const estimatedRail =
        !curatedIndexes.has(0) && firstRide !== undefined && firstRide.kind !== "subway" && firstRide.kind !== "bus";
      curated.push({
        option: result,
        operator: operatorsOf(rides.map((ride) => ride.table.operator)),
        estimatedRail,
      });
    }
  }

  if (!matched || !curated.length) return board.target.kind === "day" ? { matched } : { matched, board };

  // Journeys with every train on a timetable beat ones half on estimates;
  // the same trains listed twice (two sources) are one journey.
  const whole = curated.filter((entry) => !entry.estimatedRail);
  const unique = new Map<string, { option: DepartureOption; operator: string }>();
  for (const entry of whole.length ? whole : curated) {
    const key = entry.option.segments.map((segment) => `${segment.departTime}|${segment.arriveTime}`).join(";");
    if (!unique.has(key)) unique.set(key, entry);
  }

  const target = clockMinutes(board.target.time);
  const journeys = [...unique.values()];
  const nearby = board.target.kind === "day"
    ? journeys
      .filter(({ option }) => withinWindow({ depart: option.departTime, arrive: option.arriveTime }, board))
      .sort((a, b) => a.option.departTime.localeCompare(b.option.departTime))
      .slice(0, DAY_OPTIONS_KEPT)
    : journeys
      .sort((a, b) => {
        const aEvent = clockMinutes(board.target.kind === "arrive" ? a.option.arriveTime : a.option.departTime);
        const bEvent = clockMinutes(board.target.kind === "arrive" ? b.option.arriveTime : b.option.departTime);
        return Math.abs(aEvent - target) - Math.abs(bEvent - target);
      })
      .slice(0, 8)
      .sort((a, b) => a.option.departTime.localeCompare(b.option.departTime));

  return {
    matched: true,
    board: {
      ...board,
      approximate: false,
      source: { type: "curated", operator: operatorsOf(nearby.map((entry) => entry.operator)) },
      options: nearby.map((entry) => entry.option),
    },
  };
}

/** Great-circle distance in metres. */
function stopDistance(latitude: number, longitude: number, stop: [number, number]): number {
  const radians = Math.PI / 180;
  const lat = (stop[0] - latitude) * radians;
  const lon = (stop[1] - longitude) * radians;
  const a = Math.sin(lat / 2) ** 2 +
    Math.cos(latitude * radians) * Math.cos(stop[0] * radians) * Math.sin(lon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Build from located stops; keepOptions applies the caller's plausibility and dominance rules. */
export function directBoard(
  request: Pick<DepartureBoard, "provider" | "target">,
  from: Place,
  to: Place,
  timetables: CuratedTimetable[],
  now: Date,
  keepOptions: (options: DepartureOption[]) => DepartureOption[],
): DepartureBoard | undefined {
  const { latitude: fromLatitude, longitude: fromLongitude } = from;
  const { latitude: toLatitude, longitude: toLongitude } = to;
  if (fromLatitude == null || fromLongitude == null || toLatitude == null || toLongitude == null) return undefined;
  const operators = new Map<DepartureOption, string>();
  for (const table of timetables) {
    if (!table.stopCoordinates || (request.target.kind === "day" && !table.allDay)) continue;
    const stops = Object.entries(table.stopCoordinates).map(([name, coordinates]) => ({
      name,
      fromMetres: stopDistance(fromLatitude, fromLongitude, coordinates),
      toMetres: stopDistance(toLatitude, toLongitude, coordinates),
    }));
    for (const departure of table.departures) {
      if (!dayMatches(request.target.date, departure, table)) continue;
      let best: { from: string; to: string; depart: string; arrive: string; walk: number; total: number } | undefined;
      for (const start of stops) {
        if (start.fromMetres > DIRECT_WALK_METRES) continue;
        const depart = stationTime(departure.stops, start.name, "depart");
        if (!depart) continue;
        for (const end of stops) {
          if (end.name === start.name || end.toMetres > DIRECT_WALK_METRES) continue;
          const arrive = stationTime(departure.stops, end.name, "arrive");
          if (!arrive || clockMinutes(arrive) <= clockMinutes(depart)) continue;
          const total = start.fromMetres + end.toMetres;
          if (!best || total < best.total) {
            best = { from: start.name, to: end.name, depart, arrive, walk: start.fromMetres, total };
          }
        }
      }
      if (!best || !withinWindow(best, request)) continue;
      const walkMinutes = Math.ceil(best.walk * 1.25 / 80);
      operators.set({
        departTime: best.depart,
        arriveTime: best.arrive,
        minutes: durationBetween(best.depart, best.arrive),
        ...(walkMinutes > 0 ? { walkMinutes } : {}),
        segments: [{
          name: departure.train,
          kind: table.kind,
          departTime: best.depart,
          arriveTime: best.arrive,
          from: table.stationNames[best.from] ?? best.from,
          to: table.stationNames[best.to] ?? best.to,
        }],
      }, table.operator);
    }
  }
  const options = keepOptions([...operators.keys()]);
  if (!options.length) return undefined;
  return {
    provider: request.provider,
    target: request.target,
    fetchedAt: now.toISOString(),
    source: { type: "curated", operator: operatorsOf(options.map((option) => operators.get(option))) },
    options,
  };
}
