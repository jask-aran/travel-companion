import { describe, expect, it } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";
import {
  collectStays,
  daySummarySlots,
  planDayLodging,
} from "../apps/web/src/lib/lodging.js";

function bundleWithStays(): TripBundle {
  return {
    schemaVersion: 1,
    tripId: "t",
    revision: "r",
    generatedAt: "2026-01-01T00:00:00.000Z",
    trip: { title: "T", startDate: "2026-11-21", endDate: "2026-11-25" },
    days: [
      {
        id: "day-2026-11-21",
        date: "2026-11-21",
        title: "Day 1",
        timezone: "Asia/Tokyo",
        items: [
          {
            id: "l1",
            type: "lodging",
            name: "Hotel A",
            placeId: "a",
            checkInDate: "2026-11-21",
            checkOutDate: "2026-11-23",
            phase: "check-in",
            sourceBlockId: 1,
          },
        ],
        map: { orderedPlaceIds: [], routeLegIds: [] },
      },
      {
        id: "day-2026-11-22",
        date: "2026-11-22",
        title: "Day 2",
        timezone: "Asia/Tokyo",
        items: [],
        map: { orderedPlaceIds: [], routeLegIds: [] },
      },
      {
        id: "day-2026-11-23",
        date: "2026-11-23",
        title: "Day 3",
        timezone: "Asia/Tokyo",
        items: [
          {
            id: "l1-out",
            type: "lodging",
            name: "Hotel A",
            placeId: "a",
            checkInDate: "2026-11-21",
            checkOutDate: "2026-11-23",
            phase: "check-out",
            sourceBlockId: 1,
          },
          {
            id: "l2",
            type: "lodging",
            name: "Hotel B",
            placeId: "b",
            checkInDate: "2026-11-23",
            checkOutDate: "2026-11-25",
            phase: "check-in",
            sourceBlockId: 2,
          },
        ],
        map: { orderedPlaceIds: [], routeLegIds: [] },
      },
      {
        id: "day-2026-11-24",
        date: "2026-11-24",
        title: "Day 4",
        timezone: "Asia/Tokyo",
        items: [],
        map: { orderedPlaceIds: [], routeLegIds: [] },
      },
      {
        id: "day-2026-11-25",
        date: "2026-11-25",
        title: "Day 5",
        timezone: "Asia/Tokyo",
        items: [
          {
            id: "l2-out",
            type: "lodging",
            name: "Hotel B",
            placeId: "b",
            checkInDate: "2026-11-23",
            checkOutDate: "2026-11-25",
            phase: "check-out",
            sourceBlockId: 2,
          },
        ],
        map: { orderedPlaceIds: [], routeLegIds: [] },
      },
    ],
    places: {},
    routeLegs: {},
  };
}

describe("day lodging bookends", () => {
  const bundle = bundleWithStays();
  const stays = collectStays(bundle);

  it("collects unique stays from edge items", () => {
    expect(stays).toHaveLength(2);
  });

  it("first day: check-in at start, tonight at end", () => {
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
  const stay = (key: string) => ({
    key,
    name: key,
    checkInDate: "2026-12-03",
    checkOutDate: "2026-12-06",
  });

  it("drops Tonight when the same stay is already shown as Check in", () => {
    const slots = daySummarySlots({
      start: [{ role: "check-in", stay: stay("seoul") }],
      end: [{ role: "evening", stay: stay("seoul") }],
    });

    expect(slots.map((s) => s.role)).toEqual(["check-in"]);
  });

  it("drops Woke here when the same stay is already shown as Check out", () => {
    const slots = daySummarySlots({
      start: [
        { role: "check-out", stay: stay("osaka") },
        { role: "morning", stay: stay("osaka") },
      ],
      end: [],
    });

    expect(slots.map((s) => s.role)).toEqual(["check-out"]);
  });

  it("keeps Tonight when it is a different stay from the one checked out of", () => {
    const slots = daySummarySlots({
      start: [{ role: "check-out", stay: stay("osaka") }],
      end: [{ role: "evening", stay: stay("seoul") }],
    });

    expect(slots.map((s) => s.role)).toEqual(["check-out", "evening"]);
  });

  it("collapses a mid-stay day to one band instead of Woke here + Tonight", () => {
    const slots = daySummarySlots({
      start: [{ role: "morning", stay: stay("seoul") }],
      end: [{ role: "evening", stay: stay("seoul") }],
    });

    expect(slots.map((s) => s.role)).toEqual(["stay"]);
  });

  it("does not collapse when the two nights are different stays", () => {
    const slots = daySummarySlots({
      start: [{ role: "morning", stay: stay("osaka") }],
      end: [{ role: "evening", stay: stay("seoul") }],
    });

    expect(slots.map((s) => s.role)).toEqual(["morning", "evening"]);
  });
});
