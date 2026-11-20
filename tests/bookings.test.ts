import { describe, expect, it } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";
import { daysUntil, tripFlights, tripPlace, tripStays } from "../apps/web/src/lib/bookings.js";
import { earlyStart } from "../apps/web/src/lib/tomorrow.js";
import { collectStays } from "../apps/web/src/lib/lodging.js";
import { indexRouteLegs } from "../apps/web/src/lib/route-legs.js";

const flight = (id: string, from: string, to: string, time: string, number: string, ref = "NWC7WJ") => ({
  id, type: "flight", airlineCode: "JQ", flightNumber: number, departAirport: from, arriveAirport: to,
  departTime: time, departDate: "2026-11-21", arriveDate: "2026-11-21", confirmationNumber: ref, travellerNames: ["a", "b"],
});

const bundle = {
  trip: { title: "t", startDate: "2026-11-21", endDate: "2026-11-23" },
  places: { inn: { id: "inn", name: "Via Inn", address: "Nakamura Ward, Nagoya, Aichi, Japan", latitude: 35, longitude: 136 } },
  routeLegs: {},
  days: [
    { id: "d1", date: "2026-11-21", title: "", items: [
      // Wanderlog lists the later flight first; the page goes by departure.
      flight("f2", "CNS", "NRT", "11:55", "25"),
      flight("f1", "MEL", "CNS", "06:15", "34"),
      { id: "in", type: "lodging", placeId: "inn", name: "Via Inn", checkInDate: "2026-11-21", checkOutDate: "2026-11-23", phase: "check-in" },
    ], map: { orderedPlaceIds: [], routeLegIds: [] } },
    { id: "d3", date: "2026-11-23", title: "", items: [
      { id: "out", type: "lodging", placeId: "inn", name: "Via Inn", checkInDate: "2026-11-21", checkOutDate: "2026-11-23", phase: "check-out",
        confirmationNumber: "5111079555", cancellationDeadline: "2026-11-19 23:59", guests: { adultCount: 6, roomCount: 3 } },
    ], map: { orderedPlaceIds: [], routeLegIds: [] } },
  ],
} as unknown as TripBundle;

describe("bookings", () => {
  it("joins a connection on one booking into one journey, in departure order", () => {
    expect(tripFlights(bundle)).toEqual([
      { date: "2026-11-21", route: ["MEL", "CNS", "NRT"], numbers: ["JQ34", "JQ25"], departTime: "06:15", ref: "NWC7WJ", travellers: 2, dayId: "d1" },
    ]);
  });

  it("keeps two flights on different bookings apart", () => {
    const apart = { ...bundle, days: [{ ...bundle.days[0]!, items: [flight("a", "MEL", "CNS", "06:15", "34", "X"), flight("b", "CNS", "NRT", "11:55", "25", "Y")] }] } as TripBundle;
    expect(tripFlights(apart).map((booking) => booking.route)).toEqual([["MEL", "CNS"], ["CNS", "NRT"]]);
  });

  it("gathers a stay's booking from whichever lodging item carries it", () => {
    expect(tripStays(bundle)).toEqual([
      expect.objectContaining({ name: "Via Inn", city: "Nagoya", nights: 2, ref: "5111079555", rooms: 3, cancelBy: "2026-11-19 23:59", dayId: "d1" }),
    ]);
  });

  it("counts days to a deadline and places today in the trip", () => {
    expect(daysUntil("2026-11-17", "2026-11-19 23:59")).toBe(2);
    expect(daysUntil("2026-11-20", "2026-11-19")).toBe(-1);
    expect(tripPlace(bundle, "2026-11-17")).toEqual({ kind: "before", days: 4 });
    expect(tripPlace(bundle, "2026-11-22")).toEqual({ kind: "during", day: 2, of: 3 });
    expect(tripPlace(bundle, "2026-12-01")).toEqual({ kind: "after" });
  });
});

describe("tomorrow's early start", () => {
  const trip = (startTime: string) =>
    ({
      ...bundle,
      places: { ...bundle.places, shrine: { id: "shrine", name: "Fushimi Inari", latitude: 35, longitude: 136 } },
      days: [bundle.days[0]!, { id: "d2", date: "2026-11-22", title: "", items: [{ id: "s", type: "place", placeId: "shrine", startTime }], map: { orderedPlaceIds: [], routeLegIds: [] } }],
    }) as unknown as TripBundle;
  const next = (data: TripBundle) => earlyStart(data, data.days[1], collectStays(data), indexRouteLegs(data));

  it("names a first planned time before 08:00", () => {
    expect(next(trip("06:40"))).toMatchObject({ time: "06:40", text: "Fushimi Inari", date: "2026-11-22" });
  });

  it("says nothing for a later start, or past the last day", () => {
    expect(next(trip("09:00"))).toBeUndefined();
    expect(earlyStart(bundle, undefined, [], indexRouteLegs(bundle))).toBeUndefined();
  });
});
