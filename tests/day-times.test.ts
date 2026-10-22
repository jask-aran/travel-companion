import { describe, expect, it } from "vitest";
import type { DayItem, FlightItem, Place, RouteLeg } from "../packages/trip-schema/src/index.js";
import { flightTiming, sunTimes, sunsetTime } from "../apps/web/src/lib/day-times.js";

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

  it.each([
    ["2026-12-03", 35.68, 139.77, "Asia/Tokyo", "06:33"],
    ["2026-12-04", 37.57, 126.98, "Asia/Seoul", "07:30"],
    ["2026-11-21", -37.81, 144.96, "Australia/Melbourne", "05:56"],
    ["2026-06-21", 51.48, 0, "Europe/London", "04:43"],
  ])("sunrise %s at %f,%f is within two minutes of the reference", (date, lat, lng, zone, expected) => {
    const actual = sunTimes(date, lat, lng, zone).sunrise;
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
    expect(flightTiming(flight, items, legs, places, "hotel")).toEqual({
      airportBy: "06:30",
      leaveBy: "05:30",
      legs: [legs.get("s1")],
      fromHotel: true,
      checkOut: true,
    });
  });

  it("gives only the airport time when nothing routes into it", () => {
    expect(flightTiming(flight, [], legs, places)).toEqual({
      airportBy: "06:30",
      legs: [],
      fromHotel: false,
      checkOut: false,
    });
  });

  it("does not call an evening run from the hotel a check-out", () => {
    // Straight from the hotel to the airport for a 20:10 flight.
    const timing = flightTiming({ ...flight, departTime: "20:10" }, items, legs, places, "hotel");
    expect(timing?.fromHotel).toBe(true);
    expect(timing?.checkOut).toBe(false);
    expect(timing?.leaveBy).toBe("17:10");
  });

  describe("through a station on the way", () => {
    // Hotel → walk to the station → train to the airport, as on 6 Dec.
    const stationPlaces = {
      ...places,
      exit: { id: "exit", name: "Hongik University Station Exit 4", category: "transportation_service" },
      mall: { id: "mall", name: "Coex Mall", category: "shopping_mall" },
    } as Record<string, Place>;
    const via = (stop: string) =>
      [
        { id: "s0", type: "place", placeId: stop },
        { id: "s1", type: "place", placeId: "kix" },
      ] as DayItem[];
    const chainLegs = (stop: string) =>
      new Map<string, RouteLeg>([
        ["s0", { id: "a", fromPlaceId: "hotel", toPlaceId: stop, travelMode: "walking", durationSeconds: 240 }],
        ["s1", { id: "b", fromPlaceId: stop, toPlaceId: "kix", travelMode: "transit", durationSeconds: 86 * 60 }],
      ]);

    it("traces the transfer back to the hotel", () => {
      // 06:30 − 86 − 4 = 05:00.
      const timing = flightTiming(flight, via("exit"), chainLegs("exit"), stationPlaces, "hotel");
      expect(timing?.leaveBy).toBe("05:00");
      expect(timing?.fromHotel).toBe(true);
      expect(timing?.legs.map((leg) => leg.id)).toEqual(["a", "b"]);
    });

    it("stops at somewhere you spend time", () => {
      const timing = flightTiming(flight, via("mall"), chainLegs("mall"), stationPlaces, "hotel");
      expect(timing?.fromHotel).toBe(false);
      expect(timing?.legs.map((leg) => leg.id)).toEqual(["b"]);
    });

    it("does not call an afternoon departure a check-out", () => {
      // An evening flight: you left the hotel hours earlier, as on 11 Dec.
      const evening = { ...flight, departTime: "20:10" };
      const timing = flightTiming(evening, via("exit"), chainLegs("exit"), stationPlaces, "hotel");
      expect(timing?.fromHotel).toBe(false);
      expect(timing?.leaveBy).toBe("16:40");
    });
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
