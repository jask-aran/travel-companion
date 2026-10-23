import { describe, expect, it } from "vitest";
import type { Place, TripBundle } from "../packages/trip-schema/src/index.js";
import { dayRouting, isAddedAirport } from "../apps/web/src/lib/day-routing.js";
import { collectStays } from "../apps/web/src/lib/lodging.js";
import { indexRouteLegs } from "../apps/web/src/lib/route-legs.js";
import { pickDeparture, leaveFor } from "../apps/web/src/lib/departure-pick.js";

const place = (id: string, latitude: number, longitude: number, category?: string): Place =>
  ({ id, name: id, latitude, longitude, ...(category ? { category } : {}) }) as Place;

/** Seoul to Tokyo with neither airport listed as a stop. */
const bundle = {
  trip: { title: "t", startDate: "2026-12-03", endDate: "2026-12-11" },
  places: {
    airbnb: place("airbnb", 37.56, 126.92),
    icn: place("icn", 37.46, 126.44, "airport"),
    nrt: place("nrt", 35.77, 140.38, "airport"),
    hotel: place("hotel", 35.69, 139.7),
  },
  routeLegs: {},
  departures: {
    "airbnb>icn": {
      provider: "google",
      target: { kind: "arrive", date: "2026-12-06", time: "07:25", until: "08:25" },
      fetchedAt: "x",
      options: [
        { departTime: "06:10", arriveTime: "07:08", minutes: 58, walkMinutes: 6, segments: [] },
        { departTime: "06:21", arriveTime: "07:19", minutes: 58, walkMinutes: 6, segments: [] },
        { departTime: "06:31", arriveTime: "07:30", minutes: 59, walkMinutes: 6, segments: [] },
        { departTime: "07:31", arriveTime: "08:30", minutes: 59, walkMinutes: 6, segments: [] },
      ],
    },
  },
  days: [
    { id: "d3", date: "2026-12-03", title: "", timezone: "Asia/Seoul", items: [
      { id: "in", type: "lodging", placeId: "airbnb", name: "airbnb", checkInDate: "2026-12-03", checkOutDate: "2026-12-06" },
    ], map: { orderedPlaceIds: [], routeLegIds: [] } },
    { id: "d6", date: "2026-12-06", title: "", timezone: "Asia/Seoul", items: [
      { id: "stay", type: "lodging", placeId: "hotel", name: "hotel", checkInDate: "2026-12-06", checkOutDate: "2026-12-11" },
      { id: "f", type: "flight", departTime: "10:25", arriveTime: "12:50", departDate: "2026-12-06", arriveDate: "2026-12-06", departPlaceId: "icn", arrivePlaceId: "nrt" },
    ], map: { orderedPlaceIds: [], routeLegIds: [] } },
  ],
} as unknown as TripBundle;

describe("a flight whose airports aren't stops", () => {
  const day = bundle.days[1]!;
  const routing = dayRouting(bundle, day, collectStays(bundle), indexRouteLegs(bundle));

  it("routes hotel → airport, flies, then airport → hotel", () => {
    expect(routing.routeItems.map((item) => (item.type === "place" ? item.placeId : item.type))).toEqual(["icn", "nrt"]);
    expect(routing.routeItems.every(isAddedAirport)).toBe(true);
    const [icn, nrt] = routing.routeItems;
    expect(routing.legs.get(icn!.id)).toMatchObject({ fromPlaceId: "airbnb", toPlaceId: "icn", durationSeconds: 64 * 60 });
    // No ground leg between the airports: the flight is the connection.
    expect(routing.legs.has(nrt!.id)).toBe(false);
    expect(routing.endLeg).toMatchObject({ fromPlaceId: "nrt", toPlaceId: "hotel", travelMode: "transit" });
  });

  it("lists arrivals from 3 h before the flight to 2 h before, and times leaving from the first", () => {
    const { option, listed } = pickDeparture(bundle.departures!["airbnb>icn"]!);
    expect(option?.departTime).toBe("06:21");
    expect(listed.map((entry) => entry.departTime)).toEqual(["06:21", "06:31"]);
    expect(leaveFor(option)).toBe("06:15");
  });

  it("moves to the first departure after an earlier ride arrives", () => {
    const { option, missed } = pickDeparture(bundle.departures!["airbnb>icn"]!, "06:25");
    expect(option?.departTime).toBe("06:31");
    expect(missed).toContain("06:25");
  });
});
