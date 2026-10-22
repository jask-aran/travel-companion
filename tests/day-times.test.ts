import { describe, expect, it } from "vitest";
import type { DayItem, FlightItem, Place, RouteLeg } from "../packages/trip-schema/src/index.js";
import { flightTiming, sunsetTime } from "../apps/web/src/lib/day-times.js";

const minutes = (time: string | undefined) => {
  const [hours = 0, mins = 0] = (time ?? "").split(":").map(Number);
  return hours * 60 + mins;
};

describe("sunset", () => {
  // Expected times from NOAA's solar calculator method, an independent formula.
  it.each([
    ["2026-12-03", 35.68, 139.77, "Asia/Tokyo", "16:28"],
    ["2026-12-04", 37.57, 126.98, "Asia/Seoul", "17:13"],
    ["2026-11-21", -37.81, 144.96, "Australia/Melbourne", "20:15"],
    ["2026-06-21", 51.48, 0, "Europe/London", "21:21"],
  ])("%s at %f,%f is within two minutes of the reference", (date, lat, lng, zone, expected) => {
    const actual = sunsetTime(date, lat, lng, zone);
    expect(Math.abs(minutes(actual) - minutes(expected))).toBeLessThanOrEqual(2);
  });

  it("has no sunset in polar night", () => {
    expect(sunsetTime("2026-12-21", 78.2, 15.6, "Arctic/Longyearbyen")).toBeUndefined();
  });
});

describe("flight timing", () => {
  const places = {
    kix: { id: "kix", name: "Kansai International Airport", address: "Izumisano, Osaka 549-0001, Japan" },
    gmp: { id: "gmp", name: "Gimpo International Airport", address: "Gangseo-gu, Seoul, South Korea" },
    itm: { id: "itm", name: "Itami Airport", address: "Toyonaka, Osaka, Japan" },
    hotel: { id: "hotel", name: "1-chōme-21-1 Nipponbashi" },
  } as Record<string, Place>;
  const flight = {
    id: "f",
    type: "flight",
    departTime: "08:30",
    departAirport: "KIX",
    departPlaceId: "kix",
    arrivePlaceId: "gmp",
  } as FlightItem;
  const items = [{ id: "s1", type: "place", placeId: "kix" }] as DayItem[];
  const legs = new Map<string, RouteLeg>([
    ["s1", { id: "l", fromPlaceId: "hotel", toPlaceId: "kix", travelMode: "transit", durationSeconds: 3368 }],
  ]);

  it("works back from departure through the leg into the airport", () => {
    // 08:30 − 2 h = 06:30, − 57 min = 05:33, rounded down to 05:30.
    expect(flightTiming(flight, items, legs, places)).toEqual({
      airportBy: "06:30",
      leaveBy: "05:30",
      leaveFromPlaceId: "hotel",
    });
  });

  it("gives only the airport time when nothing routes into it", () => {
    expect(flightTiming(flight, [], legs, places)).toEqual({ airportBy: "06:30" });
  });

  it("uses the shorter margin only when both airports share a country", () => {
    const domestic = { ...flight, arrivePlaceId: "itm" };
    expect(flightTiming(domestic, [], legs, places)?.airportBy).toBe("07:30");
    const unknown = { ...flight, arrivePlaceId: "nowhere" };
    expect(flightTiming(unknown, [], legs, places)?.airportBy).toBe("06:30");
  });

  it("wraps before midnight", () => {
    expect(flightTiming({ ...flight, departTime: "01:00" }, [], legs, places)?.airportBy).toBe("23:00");
  });
});
