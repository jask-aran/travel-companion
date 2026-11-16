import { describe, expect, it } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";
import {
  collectStays,
  daySummarySlots,
  planDayLodging,
  stayForDay,
} from "../apps/web/src/lib/lodging.js";

const lodging = (id: string, name: string, placeId: string, checkInDate: string, checkOutDate: string, phase: "check-in" | "check-out", sourceBlockId: number) =>
  ({ id, type: "lodging", name, placeId, checkInDate, checkOutDate, phase, sourceBlockId }) as const;
const day = (date: string, items: ReturnType<typeof lodging>[] = []) =>
  ({ id: `day-${date}`, date, title: date, timezone: "Asia/Tokyo", items, map: { orderedPlaceIds: [], routeLegIds: [] } });

function bundleWithStays(): TripBundle {
  return {
    schemaVersion: 1,
    tripId: "t",
    revision: "r",
    generatedAt: "2026-01-01T00:00:00.000Z",
    trip: { title: "T", startDate: "2026-11-21", endDate: "2026-11-25" },
    days: [
      day("2026-11-21", [lodging("l1", "Hotel A", "a", "2026-11-21", "2026-11-23", "check-in", 1)]),
      day("2026-11-22"),
      day("2026-11-23", [
        lodging("l1-out", "Hotel A", "a", "2026-11-21", "2026-11-23", "check-out", 1),
        lodging("l2", "Hotel B", "b", "2026-11-23", "2026-11-25", "check-in", 2),
      ]),
      day("2026-11-24"),
      day("2026-11-25", [lodging("l2-out", "Hotel B", "b", "2026-11-23", "2026-11-25", "check-out", 2)]),
    ],
    places: {},
    routeLegs: {},
  };
}

describe("day lodging bookends", () => {
  const bundle = bundleWithStays();
  const stays = collectStays(bundle);

  it("first day: check-in at start, tonight at end", () => {
    expect(stays).toHaveLength(2);
    const plan = planDayLodging("2026-11-21", stays, "2026-11-21", "2026-11-25");
    expect(plan.start.map((s) => s.role)).toEqual(["check-in"]);
    expect(plan.end.map((s) => `${s.role}:${s.stay.name}`)).toEqual(["evening:Hotel A"]);
  });

  it("continuing day: morning and evening same hotel", () => {
    const plan = planDayLodging("2026-11-22", stays, "2026-11-21", "2026-11-25");
    expect(plan.start.map((s) => `${s.role}:${s.stay.name}`)).toEqual(["morning:Hotel A"]);
    expect(plan.end.map((s) => `${s.role}:${s.stay.name}`)).toEqual(["evening:Hotel A"]);
  });

  it("transition day: checkout then check-in at start, new hotel tonight", () => {
    const plan = planDayLodging("2026-11-23", stays, "2026-11-21", "2026-11-25");
    expect(plan.start.map((s) => `${s.role}:${s.stay.name}`)).toEqual([
      "check-out:Hotel A",
      "check-in:Hotel B",
    ]);
    expect(plan.end.map((s) => `${s.role}:${s.stay.name}`)).toEqual(["evening:Hotel B"]);
  });

  it("last day: check-out only, no evening", () => {
    const plan = planDayLodging("2026-11-25", stays, "2026-11-21", "2026-11-25");
    expect(plan.start.map((s) => `${s.role}:${s.stay.name}`)).toEqual(["check-out:Hotel B"]);
    expect(plan.end).toEqual([]);
  });
});

describe("day summary lodging slots", () => {
  const stay = (key: string) => ({ key, name: key, checkInDate: "2026-12-03", checkOutDate: "2026-12-06" });
  type Slot = Parameters<typeof daySummarySlots>[0]["start"][number];
  const slot = (role: Slot["role"], key: string) => ({ role, stay: stay(key) }) as Slot;
  const roles = (start: Slot[], end: Slot[]) => daySummarySlots({ start, end }).map((s) => s.role);

  it("shows each stay once, and a mid-stay day as one band", () => {
    expect(roles([slot("check-in", "seoul")], [slot("evening", "seoul")])).toEqual(["check-in"]);
    expect(roles([slot("check-out", "osaka"), slot("morning", "osaka")], [])).toEqual(["check-out"]);
    expect(roles([slot("check-out", "osaka")], [slot("evening", "seoul")])).toEqual(["check-out", "evening"]);
    expect(roles([slot("morning", "seoul")], [slot("evening", "seoul")])).toEqual(["stay"]);
    expect(roles([slot("morning", "osaka")], [slot("evening", "seoul")])).toEqual(["morning", "evening"]);
  });
});

describe("day base", () => {
  const stays = [
    { key: "a", name: "A", checkInDate: "2026-11-21", checkOutDate: "2026-11-23" },
    { key: "b", name: "B", checkInDate: "2026-11-23", checkOutDate: "2026-11-25" },
  ];

  it("is the stay you sleep in that night, or leave on the last day", () => {
    expect(stayForDay(stays, "2026-11-22")?.key).toBe("a");
    // Moving day: you sleep in the new one.
    expect(stayForDay(stays, "2026-11-23")?.key).toBe("b");
    expect(stayForDay(stays, "2026-11-25")?.key).toBe("b");
    expect(stayForDay(stays, "2026-11-20")).toBeUndefined();
  });
});
