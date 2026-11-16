import { describe, expect, it } from "vitest";
import type { DayItem, Place } from "../packages/trip-schema/src/index.js";
import { buildDayMap, decodePolyline, placeSequences } from "../apps/web/src/lib/day-map.js";
import type { DayRouting } from "../apps/web/src/lib/day-routing.js";

const place = (id: string, latitude = 35, longitude = 139): Place => ({ id, name: id, latitude, longitude });
const stop = (id: string, placeId = id): DayItem => ({ id, type: "place", placeId });
const stay = { key: "hotel", placeId: "hotel", name: "Hotel", checkInDate: "2026-11-21", checkOutDate: "2026-11-23" };
function routing(overrides: Partial<DayRouting> = {}): DayRouting {
  return {
    plan: { start: [], end: [] }, flights: [], routeItems: [], wokeInSlot: undefined,
    sleepsIn: undefined, legs: new Map(), endLeg: undefined, timings: new Map(), journeys: [], ...overrides,
  };
}

describe("day map geometry", () => {
  it("decodes the published E5 example including negative deltas", () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  });
  it("rejects truncated, invalid and out-of-range geometry", () => {
    for (const value of ['_', '?', '\u0000', '~~~~~~~~~~~~~', '_p~iF~ps|U_']) expect(decodePolyline(value)).toEqual([]);
  });
  it("keeps card numbering through notes, hotels and repeated stops", () => {
    const items: DayItem[] = [stop("hotel"), stop("one"), { id: "note", type: "note", text: "Note" }, stop("two"), stop("again", "one")];
    expect(placeSequences(items, new Set(["hotel"]))).toEqual([0, 1, 0, 2, 3]);
    const data = buildDayMap(routing({ routeItems: items, wokeInSlot: { role: "morning", stay }, sleepsIn: stay }), {
      places: { hotel: place("hotel"), one: place("one", 35.1), two: place("two", 35.2) },
    }, new Set(["hotel"]));
    expect(data.stops.find((s) => s.place.id === "one")?.labels).toEqual(["1", "3"]);
    expect(data.stops.find((s) => s.place.id === "hotel")?.roles).toEqual(["Start hotel", "Hotel", "End hotel"]);
    expect(data.paths.at(-1)?.points).toEqual([[35.1, 139], [35, 139]]);
  });
  it("shows real route geometry and marks missing or malformed geometry approximate", () => {
    const data = buildDayMap(routing({
      routeItems: [stop("one"), stop("two"), stop("three")],
      legs: new Map([
        ["two", { id: "leg", fromPlaceId: "one", toPlaceId: "two", travelMode: "walking", encodedPolyline: '_p~iF~ps|U_ulLnnqC' }],
        ["three", { id: "bad", fromPlaceId: "two", toPlaceId: "three", travelMode: "transit", encodedPolyline: '_' }],
      ]),
    }), { places: { one: place("one", 38.5, -120.2), two: place("two", 40.7, -120.95), three: place("three", 41, -121) } }, new Set());
    expect(data.paths[0]).toMatchObject({ mode: "walking", approximate: false, points: [[38.5, -120.2], [40.7, -120.95]] });
    expect(data.paths[1]).toMatchObject({ mode: "transit", approximate: true, points: [[40.7, -120.95], [41, -121]] });
  });
  it("replaces a bogus airport surface leg with a schematic flight", () => {
    const data = buildDayMap(routing({
      routeItems: [stop("depart"), stop("arrive")],
      flights: [{ id: "flight", type: "flight", departPlaceId: "depart", arrivePlaceId: "arrive" }],
      legs: new Map([["arrive", { id: "bogus", fromPlaceId: "depart", toPlaceId: "arrive", travelMode: "ferry" }]]),
    }), { places: { depart: place("depart"), arrive: place("arrive", 37, 127) } }, new Set());
    expect(data.paths).toEqual([{ mode: "flight", approximate: true, points: [[35, 139], [37, 127]] }]);
  });
  it("does not bridge over a stop with missing coordinates", () => {
    const data = buildDayMap(routing({ routeItems: [stop("one"), stop("missing"), stop("two")] }), {
      places: { one: place("one"), missing: { id: "missing", name: "Missing" }, two: place("two", 36) },
    }, new Set());
    expect(data.missingPlaces).toBe(1);
    expect(data.stops.map((s) => s.labels)).toEqual([["1"], ["3"]]);
    expect(data.paths).toEqual([]);
  });
  it("accepts empty days and zero-valued coordinates", () => {
    expect(buildDayMap(routing(), { places: {} }, new Set())).toEqual({ stops: [], paths: [], missingPlaces: 0 });
    expect(buildDayMap(routing({ routeItems: [stop("zero")] }), { places: { zero: place("zero", 0, 0) } }, new Set()).stops[0]?.point).toEqual([0, 0]);
  });
});
