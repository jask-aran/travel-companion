import { readFileSync } from "node:fs";
import type { DepartureBoard, DepartureOption, DepartureSegment } from "../../trip-schema/src/index.js";

type TimetableDeparture = {
  train: string;
  stops: Record<string, string | { arrive?: string; depart?: string }>;
  days?: "daily" | "weekdays" | "weekends";
  dates?: string[];
};

type CuratedTimetable = {
  id: string;
  operator: string;
  service: string;
  serviceNames: string[];
  kind: DepartureSegment["kind"];
  stationNames: Record<string, string>;
  source: { urls: string[]; retrieved: string; note: string };
  departures: TimetableDeparture[];
};

const timetables = JSON.parse(
  readFileSync(new URL("../../../data/timetables.json", import.meta.url), "utf8"),
) as CuratedTimetable[];

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

function dayMatches(date: string, departure: TimetableDeparture): boolean {
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

function withinWindow(ride: ScheduledRide, board: DepartureBoard): boolean {
  const event = board.target.kind === "arrive" ? ride.arrive : ride.depart;
  return Math.abs(clockMinutes(event) - clockMinutes(board.target.time)) <= 180;
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

function rideChoices(option: DepartureOption, board: DepartureBoard, index: number) {
  const segment = option.segments[index]!;
  const choices: ScheduledRide[] = [];
  let matched = false;
  for (const table of timetables) {
    if (!serviceMatches(segment, table)) continue;
    for (const train of table.departures) {
      const depart = stationTime(train.stops, segment.from, "depart");
      const arrive = stationTime(train.stops, segment.to, "arrive");
      if (!depart || !arrive) continue;
      matched = true;
      const ride = { index, table, train, depart, arrive };
      if (dayMatches(board.target.date, train) && withinWindow(ride, board)) choices.push(ride);
    }
  }
  return { matched, choices };
}

export type CuratedBoardResult = {
  matched: boolean;
  board?: DepartureBoard;
};

/** Replace matching NAVITIME estimates with published station times. */
export function curateDepartureBoard(board: DepartureBoard): CuratedBoardResult {
  if (board.provider !== "navitime") return { matched: false, board };

  let matched = false;
  const curated: Array<{ option: DepartureOption; operator: string }> = [];

  for (const option of board.options) {
    const byIndex = option.segments.map((_, index) => rideChoices(option, board, index));
    if (!byIndex.some((entry) => entry.matched)) continue;
    matched = true;

    let combinations: ScheduledRide[][] = [[]];
    for (const { choices } of byIndex) {
      if (!choices.length) continue;
      combinations = combinations.flatMap((combination) => choices.map((choice) => [...combination, choice]));
    }
    for (const rides of combinations) {
      if (!rides.length || !canConnect(option, rides)) continue;
      const result = scheduledOption(option, rides);
      curated.push({
        option: result,
        operator: [...new Set(rides.map((ride) => ride.table.operator))].join(" / "),
      });
    }
  }

  if (!matched || !curated.length) return { matched, board };

  const unique = new Map<string, { option: DepartureOption; operator: string }>();
  for (const entry of curated) {
    const key = entry.option.segments
      .map((segment) => `${segment.name}|${segment.departTime}|${segment.arriveTime}`)
      .join(";");
    if (!unique.has(key)) unique.set(key, entry);
  }

  const target = clockMinutes(board.target.time);
  const nearby = [...unique.values()]
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
      source: { type: "curated", operator: [...new Set(nearby.map((entry) => entry.operator))].join(" / ") },
      options: nearby.map((entry) => entry.option),
    },
  };
}
