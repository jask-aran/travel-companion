import { describe, expect, it } from "vitest";
import type { Place } from "../packages/trip-schema/src/index.js";
import { buildGoogleMapsUrl, buildGooglePlaceUrl, buildLegDirectionsUrl } from "../apps/web/src/lib/maps.js";
import {
  formatOpeningForDay,
  formatDistance,
  formatDuration,
  nightsBetween,
  parseTripDate,
} from "../apps/web/src/lib/format.js";

const basePlace: Place = {
  id: "place-1",
  name: "Tokyo Station",
};

const query = (url: string, key: string) => new URL(url).searchParams.get(key);

describe("Google Maps handoff", () => {
  it("gives directions to a place id with coordinates, else coordinates, address, then name", () => {
    const parsed = new URL(buildGoogleMapsUrl({ ...basePlace, googlePlaceId: "ChIJExample", latitude: 35.6812, longitude: 139.7671 }));
    expect(parsed.origin + parsed.pathname).toBe("https://www.google.com/maps/dir/");
    expect(parsed.searchParams.get("travelmode")).toBe("transit");
    expect(parsed.searchParams.get("destination")).toBe("35.6812,139.7671");
    expect(parsed.searchParams.get("destination_place_id")).toBe("ChIJExample");
    expect(parsed.searchParams.has("origin")).toBe(false);
    expect(query(buildGoogleMapsUrl({ ...basePlace, latitude: 35.1, longitude: 129.1 }), "destination")).toBe("35.1,129.1");
    expect(query(buildGoogleMapsUrl({ ...basePlace, address: "Shinjuku, Tokyo" }), "destination")).toBe("Shinjuku, Tokyo");
    expect(query(buildGoogleMapsUrl(basePlace), "destination")).toBe("Tokyo Station");
  });

  it("opens the place page rather than directions, with the same fallbacks", () => {
    const parsed = new URL(buildGooglePlaceUrl({ ...basePlace, googlePlaceId: "ChIJExample", latitude: 34.8431, longitude: 136.5407 }));
    expect(parsed.origin + parsed.pathname).toBe("https://www.google.com/maps/search/");
    expect(parsed.searchParams.get("query")).toBe("34.8431,136.5407");
    expect(parsed.searchParams.get("query_place_id")).toBe("ChIJExample");
    expect(query(buildGooglePlaceUrl({ ...basePlace, address: "1 Chome, Suzuka" }), "query")).toBe("1 Chome, Suzuka");
    expect(query(buildGooglePlaceUrl(basePlace), "query")).toBe("Tokyo Station");
  });
});

describe("format helpers", () => {
  it("formats calendar dates without UTC shift, durations, distances and nights", () => {
    const date = parseTripDate("2026-11-21");
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 10, 21]);
    expect(formatDuration(9000)).toBe("2 h 30 m");
    expect(formatDistance(350000)).toBe("350 km");
    expect(formatDistance(850)).toBe("850 m");
    expect(nightsBetween("2026-11-21", "2026-11-23")).toBe(2);
  });

  it("joins split opening windows for the day, and says nothing for a day the data omits", () => {
    const periods = [
      { day: 0, open: "11:00", close: "13:00" },
      { day: 0, open: "14:30", close: "16:30" },
      { day: 1, open: "09:30", close: "17:00" },
    ];
    expect(formatOpeningForDay(periods, 0)).toBe("11:00–13:00, 14:30–16:30");
    expect(formatOpeningForDay(periods, 1)).toBe("09:30–17:00");
    // Absence is not the same as closed, so callers must not render it as such.
    expect(formatOpeningForDay(periods, 3)).toBeUndefined();
    expect(formatOpeningForDay(undefined, 0)).toBeUndefined();
    expect(formatOpeningForDay([{ day: 2, open: "00:00" }], 2)).toBe("Open 24 hours");
  });
});

describe("route leg directions", () => {
  const from: Place = {
    id: "a",
    name: "Nagoya Station",
    googlePlaceId: "ChIJFrom",
    latitude: 35.17,
    longitude: 136.88,
  };
  const to: Place = { id: "b", name: "Takayama Station", address: "Takayama, Gifu" };

  it("routes stop to stop in the leg's mode", () => {
    const parsed = new URL(buildLegDirectionsUrl(from, to, "transit") ?? "");
    expect(parsed.origin + parsed.pathname).toBe("https://www.google.com/maps/dir/");
    expect(parsed.searchParams.get("origin")).toBe("35.17,136.88");
    expect(parsed.searchParams.get("origin_place_id")).toBe("ChIJFrom");
    expect(parsed.searchParams.get("destination")).toBe("Takayama, Gifu");
    expect(parsed.searchParams.has("destination_place_id")).toBe(false);
    expect(parsed.searchParams.get("travelmode")).toBe("transit");
  });

  it("uses Google's names for cycling and ferries, and has no link for a flight", () => {
    expect(query(buildLegDirectionsUrl(from, to, "cycling") ?? "", "travelmode")).toBe("bicycling");
    expect(query(buildLegDirectionsUrl(from, to, "ferry") ?? "", "travelmode")).toBe("transit");
    expect(buildLegDirectionsUrl(from, to, "flight")).toBeUndefined();
  });
});
