import { describe, expect, it } from "vitest";
import type { DayItem, Place, RouteLeg } from "../packages/trip-schema/src/index.js";
import { blockStops, cutAtAirports, dayNotes, dayStops, dayTimes, exploreBlocks, hoursOn, noteHasWords } from "../apps/web/src/lib/day-insights.js";

const SAT = 6;
const every = (open: string, close?: string) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, ...(close ? { close } : {}) }));
const place = (id: string, hours?: { day: number; open: string; close?: string }[], category?: string): Place => ({
  id, name: id, latitude: 35, longitude: 135, ...(category ? { category } : {}), ...(hours ? { details: { openingPeriods: hours } } : {}),
});
const leg = (to: string, minutes: number): RouteLeg => ({ id: `leg-${to}`, fromPlaceId: "x", toPlaceId: to, travelMode: "transit", durationSeconds: minutes * 60 });
const item = (id: string, extra: Partial<DayItem> = {}) => ({ id, type: "place", placeId: id, ...extra }) as DayItem;

describe("day insights", () => {
  it("reads Google's hours: 24 hours, closed that weekday, past midnight", () => {
    expect(hoursOn(place("a", every("00:00")), SAT)).toEqual({ kind: "always" });
    expect(hoursOn(place("b", every("10:00", "17:00").filter((p) => p.day !== 3)), 3)).toEqual({ kind: "closed" });
    expect(hoursOn(place("c", every("18:00", "02:00")), SAT)).toEqual({ kind: "open", windows: [{ open: 1080, close: 1560 }] });
    expect(hoursOn(place("d"), SAT)).toEqual({ kind: "unknown" });
  });

  it("lists the plan's times, stations included", () => {
    const places = { nagoya: place("Nagoya Station", undefined, "transit_station"), suzuka: place("Suzuka Circuit"), x: place("x") };
    const items = [item("nagoya", { startTime: "07:00" }), item("x"), item("suzuka", { startTime: "09:00", endTime: "17:00" })];
    expect(dayTimes(items, places)).toEqual([
      { time: "07:00", name: "Nagoya Station" },
      { time: "09:00–17:00", name: "Suzuka Circuit" },
    ]);
  });

  it("leaves out of the times line what another card already times", () => {
    const places = { kix: place("Kansai International Airport"), war: place("War Memorial") };
    const items = [item("kix", { startTime: "06:00" }), item("war", { startTime: "13:00", endTime: "15:00" })];
    expect(dayTimes(items, places, new Set(["kix"]))).toEqual([{ time: "13:00–15:00", name: "War Memorial" }]);
  });

  it("tells a note with words from a bare link", () => {
    const bare = "[https://www.japan-guide.com/e/e4900.html](https://www.japan-guide.com/e/e4900.html)";
    expect(noteHasWords(bare)).toBe(false);
    expect(noteHasWords("Tickets release on 27th september\n\n" + bare)).toBe(true);
  });

  it("splits the day into blocks of exploring at its journeys", () => {
    // Hotel to trailhead is a journey (from index -1), then the town; or a day out between two rides.
    expect(exploreBlocks(9, [{ fromIndex: -1, toIndex: 0 }])).toEqual([{ from: 0, to: 8, before: undefined }]);
    expect(exploreBlocks(17, [{ fromIndex: -1, toIndex: 0 }, { fromIndex: 15, toIndex: 16 }])).toEqual([
      { from: 0, to: 15, before: 1 }, { from: 16, to: 16, before: undefined },
    ]);
    const places = { a: place("a"), station: place("station", undefined, "train_station"), b: place("b"), hotel: place("hotel") };
    const items = [item("hotel"), item("a"), item("station"), item("b")];
    const stops = dayStops(items, places, new Set(["hotel"]), new Map());
    expect(blockStops(stops, { from: 0, to: 3, before: undefined }).map((stop) => stop.place.name)).toEqual(["a", "b"]);
  });

  it("collects your notes with the stop each belongs to", () => {
    const places = { a: place("a"), b: place("b") };
    const items: DayItem[] = [item("a", { notes: "get there at dawn" }), { id: "n", type: "note", text: "At Night" }, item("b")];
    expect(dayNotes(items, dayStops(items, places, new Set(), new Map()))).toEqual([
      { text: "get there at dawn", order: 1, stop: "a" },
      { text: "At Night", after: "a" },
    ]);
  });
});

describe("blocks across a flight", () => {
  it("keeps the stretch on the side of the airports with the places", () => {
    const places = { kix: place("kix", undefined, "international_airport"), gmp: place("gmp", undefined, "international_airport"), a: place("a"), b: place("b") };
    const items = [item("kix"), item("gmp"), item("a"), item("b")];
    const stops = dayStops(items, places, new Set(), new Map());
    expect(cutAtAirports({ from: 0, to: 3, before: undefined }, stops)).toEqual({ from: 2, to: 3, before: undefined });
  });
});
