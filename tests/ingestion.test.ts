import { describe, expect, it } from "vitest";
import { extractMobxState, parseWanderlogSource } from "../packages/wanderlog-import/src/index.js";
import { normaliseWanderlog } from "../packages/trip-normaliser/src/index.js";

const source = {
  success: true,
  tripPlan: {
    key: "example-trip",
    title: "Example trip",
    startDate: "2026-11-21",
    endDate: "2026-11-22",
    itinerary: {
      sections: [
        {
          id: 1,
          date: "2026-11-21",
          heading: "Tokyo",
          blocks: [
            {
              id: 10,
              type: "place",
              startTime: "09:00",
              imageKeys: ["wanderlog-image-key"],
              place: {
                name: "Tokyo Station",
                place_id: "google-tokyo-station",
                formatted_address: "1 Chome Marunouchi, Tokyo",
                geometry: { location: { lat: 35.6812, lng: 139.7671 } },
                rating: 4.2,
                user_ratings_total: 100,
              },
              text: { ops: [{ insert: "Meet beside the central exit\n" }] },
            },
            {
              id: 11,
              type: "note",
              text: { ops: [{ insert: "Take the shinkansen\n" }] },
            },
            {
              id: 12,
              type: "place",
              place: {
                name: "Nagoya Station",
                place_id: "google-nagoya-station",
                geometry: { location: { lat: 35.1709, lng: 136.8815 } },
                photo_urls: ["https://example.test/nagoya.jpg"],
              },
              text: { ops: [{ insert: "\n" }] },
            },
          ],
        },
      ],
    },
  },
  resources: {
    distancesBetweenPlaces: {
      route: {
        fromPlaceId: "google-tokyo-station",
        toPlaceId: "google-nagoya-station",
        travelMode: "transit",
        route: {
          distance: { value: 350000 },
          duration: { value: 7200 },
          polyline: "encoded",
        },
      },
    },
  },
};

describe("Wanderlog adapters", () => {
  it("parses CLI JSON", () => {
    const parsed = parseWanderlogSource(JSON.stringify(source));
    expect(parsed.kind).toBe("cli-json");
    expect(parsed.data.tripPlan).toBeDefined();
  });

  it("extracts embedded MobX JSON without regex matching nested objects", () => {
    const html = `<script>window.__MOBX_STATE__ = ${JSON.stringify({ tripPlanStore: { data: source } })};</script>`;
    const state = extractMobxState(html);
    expect(state.tripPlanStore).toBeDefined();
    expect(parseWanderlogSource(html).kind).toBe("html-mobx");
  });
});

describe("normaliser", () => {
  it("creates an allow-listed TripBundle", () => {
    const text = JSON.stringify(source);
    const { bundle, report } = normaliseWanderlog(source, {
      sourceKind: "cli-json",
      sourceText: text,
      generatedAt: "2026-07-26T00:00:00.000Z",
    });

    expect(bundle.trip.title).toBe("Example trip");
    expect(bundle.days).toHaveLength(1);
    expect(bundle.days[0]?.items).toHaveLength(3);
    expect(Object.keys(bundle.places)).toHaveLength(2);
    expect(Object.keys(bundle.routeLegs)).toHaveLength(1);
    expect(bundle.places["google-place:google-nagoya-station"]?.image?.url).toBe("https://example.test/nagoya.jpg");
    expect(report.redacted).toContain("booking confirmation numbers and reservation attachments");
  });

  it("applies source-keyed overrides", () => {
    const { bundle } = normaliseWanderlog(source, {
      sourceKind: "cli-json",
      sourceText: JSON.stringify(source),
      overrides: {
        places: {
          "source-block:10": { displayName: "Central Station", publishAddress: false },
        },
        items: {
          "source-block:10": { status: "tentative", startTime: "10:00" },
        },
      },
    });

    const place = bundle.places["google-place:google-tokyo-station"];
    expect(place?.name).toBe("Central Station");
    expect(place?.address).toBeUndefined();
    expect(bundle.days[0]?.items[0]).toMatchObject({ startTime: "10:00", status: "tentative" });
  });
});
