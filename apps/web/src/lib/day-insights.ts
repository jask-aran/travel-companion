import type { DayItem, Place, PlaceItem, RouteLeg } from "@travel-companion/trip-schema";
import { isWaypoint } from "./route-legs.js";
import { parseRichNotes } from "./rich-notes.js";

/**
 * What the Day summary can say about a day from the trip's own data: the
 * stops with the travel before each, their hours that weekday, the plan's
 * times, and the blocks of exploring between long journeys. All of it is worked out by rules: nothing is guessed.
 */

/** A stop you spend time at: a place item that isn't one of the trip's stays. */
export type DayStop = {
  /** The stop's number, as the Full Day Route and the Day map number it. */
  order: number;
  /** Its index in the day's route items. */
  index: number;
  item: PlaceItem;
  place: Place;
  /** Riding and walking from the start of the day to this stop. */
  travelBefore: number;
  /** A station or similar you pass through: numbered, but not a place you visit. */
  waypoint: boolean;
};

export function dayStops(
  items: DayItem[],
  places: Record<string, Place>,
  stayPlaceIds: Set<string>,
  legs: Map<string, RouteLeg>,
): DayStop[] {
  const stops: DayStop[] = [];
  let travel = 0;
  let order = 0;
  items.forEach((item, index) => {
    if (item.type !== "place") return;
    travel += legs.get(item.id)?.durationSeconds ?? 0;
    if (stayPlaceIds.has(item.placeId)) return;
    order += 1;
    const place = places[item.placeId];
    if (place) stops.push({ order, index, item, place, travelBefore: travel, waypoint: isWaypoint(place) });
  });
  return stops;
}

/** Minutes after midnight. */
export const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export type DayHours =
  | { kind: "unknown" }
  | { kind: "closed" }
  | { kind: "always" }
  | { kind: "open"; windows: { open: number; close: number | undefined }[] };

/** A place's hours on one weekday (0 = Sunday), as Google lists them. */
export function hoursOn(place: Place, weekday: number): DayHours {
  const periods = place.details?.openingPeriods;
  if (!periods?.length) return { kind: "unknown" };
  const today = periods.filter((period) => period.day === weekday);
  if (!today.length) return { kind: "closed" };
  // A window opening at 00:00 with no close is Google's "open 24 hours".
  if (today.length === 1 && today[0]?.open === "00:00" && !today[0].close) return { kind: "always" };
  return {
    kind: "open",
    windows: today.map((period) => {
      const open = minutesOf(period.open);
      const close = period.close ? minutesOf(period.close) : undefined;
      // A close at or before the open runs past midnight.
      return { open, close: close !== undefined && close <= open ? close + 24 * 60 : close };
    }),
  };
}

/** When a stop shuts for the day, where its hours say. */
export function closesAt(hours: DayHours): number | undefined {
  if (hours.kind !== "open") return undefined;
  const closes = hours.windows.map((window) => window.close).filter((close): close is number => close !== undefined);
  return closes.length ? Math.max(...closes) : undefined;
}

/** A place in the plan with a time on it, as Wanderlog has it: "09:00–17:00" or "07:50". */
export type TimedPlace = { time: string; name: string };

/**
 * The plan's times, in route order: every place item with a start time,
 * stations included (a 07:00 train is part of the plan too). `shownElsewhere`
 * leaves out places another card already times: the stays, and the airports
 * of the day's flights.
 */
export function dayTimes(items: DayItem[], places: Record<string, Place>, shownElsewhere: Set<string> = new Set()): TimedPlace[] {
  return items.flatMap((item) => {
    if (item.type !== "place" || !item.startTime || shownElsewhere.has(item.placeId)) return [];
    const name = places[item.placeId]?.name;
    if (!name) return [];
    const end = item.endTime && item.endTime !== item.startTime ? `–${item.endTime}` : "";
    return [{ time: `${item.startTime}${end}`, name }];
  });
}

/** Whether a note says anything besides its links. */
export const noteHasWords = (text: string) =>
  parseRichNotes(text).some((block) =>
    (block.type === "p" ? block.lines : block.items).some((line) => line.some((run) => !run.href && /\w/.test(run.text))),
  );

/**
 * The day's stretches of exploring: the route split at its long journeys.
 * Each block is a range of route item indexes; `before` names the journey it
 * comes before, or none for the stretch after the last one.
 */
export type ExploreBlock = { from: number; to: number; before: number | undefined };
export function exploreBlocks(itemCount: number, journeys: { fromIndex: number; toIndex: number }[]): ExploreBlock[] {
  const blocks: ExploreBlock[] = [];
  let from = 0;
  journeys.forEach((journey, index) => {
    blocks.push({ from, to: journey.fromIndex, before: index });
    from = journey.toIndex;
  });
  blocks.push({ from, to: itemCount - 1, before: undefined });
  return blocks.filter((block) => block.to >= block.from);
}

const AIRPORTS = new Set(["airport", "international_airport"]);

/**
 * A block cut at its airports, keeping the stretch with the most places to
 * visit: a flight is a long journey too, even where its transfers are drawn
 * with the flight rather than as journeys.
 */
export function cutAtAirports(block: ExploreBlock, stops: DayStop[]): ExploreBlock {
  const airports = stops.filter((stop) => stop.index >= block.from && stop.index <= block.to && AIRPORTS.has(stop.place.category ?? ""));
  if (!airports.length) return block;
  const edges = [block.from - 1, ...airports.map((stop) => stop.index), block.to + 1];
  let best = block;
  let most = -1;
  for (let i = 0; i < edges.length - 1; i += 1) {
    const piece = { ...block, from: edges[i]! + 1, to: edges[i + 1]! - 1 };
    const count = blockStops(stops, piece).length;
    if (count > most) { best = piece; most = count; }
  }
  return best;
}

/** The stops of a block that are places to visit. */
export const blockStops = (stops: DayStop[], block: ExploreBlock) =>
  stops.filter((stop) => !stop.waypoint && stop.index >= block.from && stop.index <= block.to);

/** Your notes for the day, in route order, each tied to the stop it sits on or follows. */
export type DayNote = { text: string; order?: number; stop?: string; after?: string };
export function dayNotes(items: DayItem[], stops: DayStop[]): DayNote[] {
  const byIndex = new Map(stops.map((stop) => [stop.index, stop]));
  const notes: DayNote[] = [];
  let previous: DayStop | undefined;
  items.forEach((item, index) => {
    const stop = byIndex.get(index);
    if (stop) {
      previous = stop;
      const text = stop.item.notes?.trim();
      if (text) notes.push({ text, order: stop.order, stop: stop.place.name });
    } else if (item.type === "note" && item.text.trim()) {
      notes.push({ text: item.text.trim(), ...(previous ? { after: previous.place.name } : {}) });
    }
  });
  return notes;
}
