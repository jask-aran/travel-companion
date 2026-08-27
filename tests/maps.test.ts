import { describe, expect, it } from "vitest";
import type { Place } from "../packages/trip-schema/src/index.js";
import { buildGoogleMapsUrl, buildGooglePlaceUrl } from "../apps/web/src/lib/maps.js";
import {
  formatOpeningForDay,
  formatVisitLength,
  formatDistance,
  formatDuration,
  formatTripRange,
  parseTripDate,
} from "../apps/web/src/lib/format.js";

const basePlace: Place = {
  id: "place-1",
  name: "Tokyo Station",
};

describe("Google Maps handoff", () => {
  it("prefers place id with coordinates", () => {
    const url = buildGoogleMapsUrl({
      ...basePlace,
      googlePlaceId: "ChIJExample",
      latitude: 35.6812,
      longitude: 139.7671,
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://www.google.com/maps/dir/");
    expect(parsed.searchParams.get("api")).toBe("1");
    expect(parsed.searchParams.get("travelmode")).toBe("transit");
    expect(parsed.searchParams.get("destination")).toBe("35.6812,139.7671");
    expect(parsed.searchParams.get("destination_place_id")).toBe("ChIJExample");
    expect(parsed.searchParams.has("origin")).toBe(false);
  });

  it("falls back through coordinates, address, then name", () => {
    expect(
      new URL(
        buildGoogleMapsUrl({
          ...basePlace,
          latitude: 35.1,
          longitude: 129.1,
        }),
      ).searchParams.get("destination"),
    ).toBe("35.1,129.1");

    expect(
      new URL(
        buildGoogleMapsUrl({
          ...basePlace,
          address: "Shinjuku, Tokyo",
        }),
      ).searchParams.get("destination"),
    ).toBe("Shinjuku, Tokyo");

    expect(
      new URL(buildGoogleMapsUrl(basePlace)).searchParams.get("destination"),
    ).toBe("Tokyo Station");
  });
});

describe("format helpers", () => {
  it("formats calendar dates without UTC shift", () => {
    const date = parseTripDate("2026-11-21");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(10);
    expect(date.getDate()).toBe(21);
    expect(formatTripRange("2026-11-21", "2026-11-26")).toContain("21");
  });

  it("formats duration and distance", () => {
    expect(formatDuration(9000)).toBe("2 h 30 m");
    expect(formatDistance(350000)).toBe("350 km");
    expect(formatDistance(850)).toBe("850 m");
  });
});

import { nightsBetween, formatLodgingDate } from "../apps/web/src/lib/format.js";

describe("lodging date helpers", () => {
  it("counts nights and formats dates", () => {
    expect(nightsBetween("2026-11-21", "2026-11-23")).toBe(2);
    expect(formatLodgingDate("2026-11-21")).toContain("21");
  });
});

describe("Google Maps place handoff", () => {
  it("opens the place page rather than directions", () => {
    const url = buildGooglePlaceUrl({
      ...basePlace,
      googlePlaceId: "ChIJExample",
      latitude: 34.8431,
      longitude: 136.5407,
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://www.google.com/maps/search/");
    expect(parsed.searchParams.get("travelmode")).toBeNull();
    expect(parsed.searchParams.get("query")).toBe("34.8431,136.5407");
    expect(parsed.searchParams.get("query_place_id")).toBe("ChIJExample");
  });

  it("falls back to address then name when there are no coordinates", () => {
    expect(
      new URL(buildGooglePlaceUrl({ ...basePlace, address: "1 Chome, Suzuka" })).searchParams.get(
        "query",
      ),
    ).toBe("1 Chome, Suzuka");

    expect(new URL(buildGooglePlaceUrl(basePlace)).searchParams.get("query")).toBe(
      "Tokyo Station",
    );
  });
});

describe("opening hours and visit length", () => {
  const periods = [
    { day: 0, open: "11:00", close: "13:00" },
    { day: 0, open: "14:30", close: "16:30" },
    { day: 1, open: "09:30", close: "17:00" },
  ];

  it("joins split windows for the day being visited", () => {
    expect(formatOpeningForDay(periods, 0)).toBe("11:00–13:00, 14:30–16:30");
  });

  it("returns a single window for a simple day", () => {
    expect(formatOpeningForDay(periods, 1)).toBe("09:30–17:00");
  });

  it("returns undefined for a day the data says nothing about", () => {
    // Absence is not the same as closed, so callers must not render it as such.
    expect(formatOpeningForDay(periods, 3)).toBeUndefined();
    expect(formatOpeningForDay(undefined, 0)).toBeUndefined();
  });

  it("recognises open-all-day", () => {
    expect(formatOpeningForDay([{ day: 2, open: "00:00" }], 2)).toBe("Open 24 hours");
  });

  it("formats visit length", () => {
    expect(formatVisitLength(45, 45)).toBe("45 min");
    expect(formatVisitLength(60, 90)).toBe("1 h–90 min");
    expect(formatVisitLength(undefined, undefined)).toBeUndefined();
  });
});
