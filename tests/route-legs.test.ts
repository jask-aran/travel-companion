import { describe, expect, it } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";
import {
  dayTravelSeconds,
  indexRouteLegs,
  legsForDay,
} from "../apps/web/src/lib/route-legs.js";
import {
  cleanAddress,
  formatArrows,
  formatDuration,
  formatRating,
  noteRestatesNames,
} from "../apps/web/src/lib/format.js";

const bundle = {
  routeLegs: {
    a: {
      id: "a",
      fromPlaceId: "p1",
      toPlaceId: "p2",
      travelMode: "walking",
      distanceMetres: 1171,
      durationSeconds: 843,
    },
    b: {
      id: "b",
      fromPlaceId: "p2",
      toPlaceId: "p3",
      travelMode: "transit",
      distanceMetres: 14200,
      durationSeconds: 1320,
    },
  },
} as unknown as TripBundle;

const items = [
  { id: "i1", type: "place", placeId: "p1" },
  { id: "n1", type: "note", text: "grab lockers" },
  { id: "i2", type: "place", placeId: "p2" },
  { id: "i3", type: "place", placeId: "p3" },
] as TripBundle["days"][number]["items"];

describe("route leg pairing", () => {
  const index = indexRouteLegs(bundle);

  it("links consecutive place items, ignoring non-place items between them", () => {
    const legs = legsForDay(items, index);
    // Keyed by the id of the item the leg leads *into*.
    expect(legs.get("i2")?.travelMode).toBe("walking");
    expect(legs.get("i3")?.travelMode).toBe("transit");
  });

  it("has no leg before the first stop", () => {
    expect(legsForDay(items, index).get("i1")).toBeUndefined();
  });

  it("omits pairs with no matching leg", () => {
    const orphan = [
      { id: "x1", type: "place", placeId: "p9" },
      { id: "x2", type: "place", placeId: "p8" },
    ] as TripBundle["days"][number]["items"];
    expect(legsForDay(orphan, index).size).toBe(0);
  });
});

describe("display formatting", () => {
  it("turns ascii arrows into real ones", () => {
    expect(formatArrows("Tokyo -> Nagoya")).toBe("Tokyo → Nagoya");
    expect(formatArrows("A --> B")).toBe("A → B");
    expect(formatArrows("no arrow here")).toBe("no arrow here");
  });

  it("formats ratings to one decimal with a compact count", () => {
    expect(formatRating(4, 5080)).toBe("4.0 · 5.1k");
    expect(formatRating(4.3, 29569)).toBe("4.3 · 29.6k");
    expect(formatRating(4.2, 842)).toBe("4.2 · 842");
    expect(formatRating(undefined, 10)).toBeUndefined();
  });

  it("reduces a noisy Google address to a readable locality", () => {
    expect(
      cleanAddress("Japan, \u3012453-0015 Aichi, Nagoya, Nakamura Ward, Tsubakicho, 9\u221213 9\u756a13\u53f7 9\u22129\u221213 9\u756a13\u53f7 13\u53f7"),
    ).toBe("Aichi, Nagoya, Nakamura Ward");

    expect(cleanAddress("Takayama, Gifu 506-0021, Japan")).toBe("Takayama, Gifu");
    expect(cleanAddress("49-1 Hatotani, Shirakawa, Ono District, Gifu 501-5629, Japan"))
      .toBe("Hatotani, Shirakawa, Ono District");
    expect(cleanAddress(undefined)).toBeUndefined();
  });
});

describe("legs that cannot fit inside a day", () => {
  // Google answers "ground route between these two stops" even when the real
  // connection is the flight listed separately, returning 22 hours of ferries.
  const bundle = {
    routeLegs: {
      air: {
        id: "air",
        fromPlaceId: "kix",
        toPlaceId: "gmp",
        travelMode: "transit",
        distanceMetres: 997_000,
        durationSeconds: 1332 * 60,
      },
      city: {
        id: "city",
        fromPlaceId: "gmp",
        toPlaceId: "hotel",
        travelMode: "transit",
        distanceMetres: 15_000,
        durationSeconds: 28 * 60,
      },
      longButReal: {
        id: "longButReal",
        fromPlaceId: "hotel",
        toPlaceId: "dmz",
        travelMode: "transit",
        distanceMetres: 50_000,
        durationSeconds: 127 * 60,
      },
    },
  } as unknown as TripBundle;

  const index = indexRouteLegs(bundle);
  const day = [
    { id: "s1", type: "place", placeId: "kix" },
    { id: "s2", type: "place", placeId: "gmp" },
    { id: "s3", type: "place", placeId: "hotel" },
    { id: "s4", type: "place", placeId: "dmz" },
  ] as TripBundle["days"][number]["items"];

  it("drops a leg longer than the day that contains it", () => {
    expect(legsForDay(day, index).get("s2")).toBeUndefined();
  });

  it("applies the rule without needing a flight item on the day", () => {
    const withFlight = [
      { id: "f1", type: "flight", airline: "JL", flightNumber: "1" },
      ...day,
    ] as TripBundle["days"][number]["items"];
    expect(legsForDay(withFlight, index).get("s2")).toBeUndefined();
  });

  it("keeps ordinary legs, including a genuinely long 2 h one", () => {
    const legs = legsForDay(day, index);
    expect(legs.get("s3")?.durationSeconds).toBe(28 * 60);
    expect(legs.get("s4")?.durationSeconds).toBe(127 * 60);
  });

  it("excludes only the dropped leg from the day's moving total", () => {
    expect(dayTravelSeconds(legsForDay(day, index))).toBe((28 + 127) * 60);
  });
});

describe("very short legs", () => {
  // Wanderlog itself shows "< 1 min \u00b7 20 m" for two POIs in one complex
  // (Starfield Library sits inside Coex Mall), so the leg is real: keep it.
  const bundle = {
    routeLegs: {
      adjacent: {
        id: "adjacent",
        fromPlaceId: "p1",
        toPlaceId: "p2",
        travelMode: "walking",
        distanceMetres: 15,
        durationSeconds: 20,
      },
    },
  } as unknown as TripBundle;

  const items = [
    { id: "a", type: "place", placeId: "p1" },
    { id: "b", type: "place", placeId: "p2" },
  ] as TripBundle["days"][number]["items"];

  it("keeps a sub-minute leg rather than inventing a reason to drop it", () => {
    expect(legsForDay(items, indexRouteLegs(bundle)).get("b")?.distanceMetres).toBe(15);
  });

  it("renders it the way Wanderlog does", () => {
    expect(formatDuration(20)).toBe("< 1 min");
    expect(formatDuration(0)).toBeUndefined();
  });
});

describe("passenger list de-duplication", () => {
  const names = ["Jaskaran Singh", "Mathew Knowles", "Georgia Campbell"];

  it("treats a note that is only the passenger list as redundant", () => {
    expect(
      noteRestatesNames("For Jaskaran Singh, Mathew Knowles, and Georgia Campbell", names),
    ).toBe(true);
  });

  it("keeps a note that adds anything beyond the names", () => {
    expect(
      noteRestatesNames(
        "For Jaskaran Singh, Mathew Knowles, and Georgia Campbell - check bags",
        names,
      ),
    ).toBe(false);
  });

  it("keeps a note when the names are absent", () => {
    expect(noteRestatesNames("Window seats booked", names)).toBe(false);
    expect(noteRestatesNames(undefined, names)).toBe(false);
  });
});
