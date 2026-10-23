import { readFileSync } from "node:fs";
import type { DepartureBoard, DepartureOption, DepartureSegment } from "../../trip-schema/src/index.js";

type TimetableDeparture = {
  train: string;
  depart: string;
  arrive: string;
  days?: "daily" | "weekdays" | "weekends";
};

type CuratedTimetable = {
  id: string;
  operator: string;
  service: string;
  serviceNames: string[];
  kind: DepartureSegment["kind"];
  fromStations: string[];
  toStations: string[];
  stationNames: {
    from: { ja: string; en: string };
    to: { ja: string; en: string };
  };
  source: { url: string; retrieved: string; note: string };
  departures: TimetableDeparture[];
};

const timetables = JSON.parse(
  readFileSync(new URL("../../../data/timetables.json", import.meta.url), "utf8"),
) as CuratedTimetable[];

const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const formatClock = (minutes: number) => {
  const wrapped = (minutes + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};

/** Ignore terminal detail in NAVITIME station names, such as a terminal number. */
function stationKey(value: string): string {
  return value.normalize("NFKC").replace(/[（(].*?[）)]/g, "").replace(/\s+/g, "").toLocaleLowerCase();
}

function serviceKey(value: string): string {
  return value.normalize("NFKC").replace(/[\s　]/g, "").toLocaleLowerCase();
}

function dayMatches(date: string, days: TimetableDeparture["days"]): boolean {
  if (!days || days === "daily") return true;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return days === "weekends" ? weekday === 0 || weekday === 6 : weekday > 0 && weekday < 6;
}

function matches(segment: DepartureSegment, table: CuratedTimetable): boolean {
  const name = serviceKey(segment.nameLocal ?? segment.name);
  const from = segment.from ? stationKey(segment.from) : "";
  const to = segment.to ? stationKey(segment.to) : "";
  return (
    table.serviceNames.some((service) => serviceKey(service) === name) &&
    table.fromStations.some((station) => stationKey(station) === from) &&
    table.toStations.some((station) => stationKey(station) === to)
  );
}

function withinWindow(departure: TimetableDeparture, board: DepartureBoard): boolean {
  const target = clockMinutes(board.target.time);
  const depart = clockMinutes(departure.depart);
  if (Math.abs(depart - target) > 180) return false;
  return board.target.kind === "arrive"
    ? clockMinutes(departure.arrive) <= target
    : depart >= target;
}

function durationBetween(start: string, end: string): number {
  return (clockMinutes(end) - clockMinutes(start) + 1440) % 1440;
}

function scheduledOption(
  option: DepartureOption,
  segmentIndex: number,
  table: CuratedTimetable,
  departure: TimetableDeparture,
): DepartureOption {
  const original = option.segments[segmentIndex]!;
  const departShift = clockMinutes(departure.depart) - clockMinutes(original.departTime);
  const arriveShift = clockMinutes(departure.arrive) - clockMinutes(original.arriveTime);
  const segments = option.segments.map((segment, index) => {
    if (index === segmentIndex) {
      const { nameLocal: _nameLocal, ...rest } = segment;
      return {
        ...rest,
        name: departure.train,
        kind: table.kind,
        departTime: departure.depart,
        arriveTime: departure.arrive,
        from: table.stationNames.from.en,
        to: table.stationNames.to.en,
      };
    }
    const shift = index < segmentIndex ? departShift : arriveShift;
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

export type CuratedBoardResult = {
  matched: boolean;
  board?: DepartureBoard;
};

/** Replace matching NAVITIME estimates with published train times. */
export function curateDepartureBoard(board: DepartureBoard): CuratedBoardResult {
  if (board.provider !== "navitime") return { matched: false, board };

  const options: Array<{ option: DepartureOption; operator: string }> = [];
  const operators = new Set<string>();
  let matched = false;

  for (const option of board.options) {
    for (const [segmentIndex, segment] of option.segments.entries()) {
      for (const table of timetables) {
        if (!matches(segment, table)) continue;
        matched = true;
        for (const departure of table.departures) {
          if (!dayMatches(board.target.date, departure.days) || !withinWindow(departure, board)) continue;
          options.push({ option: scheduledOption(option, segmentIndex, table, departure), operator: table.operator });
          operators.add(table.operator);
        }
      }
    }
  }

  if (!matched) return { matched: false, board };
  if (!options.length) return { matched: true };

  const unique = new Map<string, DepartureOption>();
  for (const { option } of options) {
    const key = option.segments
      .map((segment) => `${segment.name}|${segment.departTime}|${segment.arriveTime}`)
      .join(";");
    if (!unique.has(key)) unique.set(key, option);
  }

  return {
    matched: true,
    board: {
      ...board,
      approximate: false,
      source: { type: "curated", operator: [...operators].join(" / ") },
      options: [...unique.values()].sort((a, b) => a.departTime.localeCompare(b.departTime)).slice(0, 8),
    },
  };
}
