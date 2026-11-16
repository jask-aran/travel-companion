import { afterEach, describe, expect, it, vi } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";

vi.mock("../apps/web/src/lib/pages-function.js", () => ({ hasPagesFunction: true }));

const { LOOKUPS_PER_OPEN, keepMediaOffline } = await import("../apps/web/src/lib/offline-media.js");
const { findPlacePhoto, mediaFailed } = await import("../apps/web/src/lib/place-photo.js");

/**
 * Stops: a place with a photo name, a hotel with a Google id but no name,
 * an address-only flat. An airport the cards never show.
 */
const trip = {
  trip: { title: "t", startDate: "2026-12-01", endDate: "2026-12-02" },
  places: {
    "google-place:named": { id: "google-place:named", name: "Temple", photo: { name: "places/named/photos/1" } },
    "google-place:hotel": { id: "google-place:hotel", name: "Hotel", latitude: 35.1, longitude: 136.1 },
    "source-block:7": { id: "source-block:7", name: "Flat", latitude: 35.2, longitude: 136.2 },
    "google-place:airport": { id: "google-place:airport", name: "Airport", latitude: 35.3, longitude: 136.3 },
  },
  routeLegs: {},
  days: [{
    id: "d1", date: "2026-12-01", title: "", timezone: "Asia/Tokyo",
    items: [
      { id: "i1", type: "place", placeId: "google-place:named" },
      { id: "i2", type: "lodging", name: "Hotel", placeId: "google-place:hotel", checkInDate: "2026-12-01", checkOutDate: "2026-12-02" },
      { id: "i3", type: "lodging", name: "Flat", placeId: "source-block:7", checkInDate: "2026-12-02", checkOutDate: "2026-12-03" },
    ],
  }],
} as unknown as TripBundle;

function setup(answer: (url: string) => string) {
  const kept = new Map<string, Response>();
  const cache = { match: async (url: string) => kept.get(url), put: async (url: string, response: Response) => void kept.set(url, response) };
  const asked = vi.fn(async (url: string) => new Response("x", { headers: { "x-media": answer(url) } }));
  vi.stubGlobal("window", { caches: {} });
  vi.stubGlobal("caches", { open: async () => cache });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", asked);
  return { asked, kept };
}

const routes = (asked: ReturnType<typeof setup>["asked"]) =>
  asked.mock.calls.map(([url]) => {
    const query = new URL(url, "https://x.test").searchParams;
    return `${url.split("?")[0]} ${query.get("place")}`;
  });

afterEach(() => vi.unstubAllGlobals());

describe("keeping media offline", () => {
  it("asks only for what the cards show: photos, and a stay's map once it has no photo", async () => {
    const { asked } = setup((url) => (url.includes("place=hotel") ? "none" : "image"));
    await keepMediaOffline(trip);
    expect(routes(asked)).toEqual([
      "/api/photo named",
      "/api/photo hotel",
      "/api/map google-place:hotel",
      "/api/map source-block:7",
    ]);
    // A second open finds them all on the phone.
    await keepMediaOffline(trip);
    expect(asked).toHaveBeenCalledTimes(4);
  });

  it(`looks up at most ${LOOKUPS_PER_OPEN} places without a photo name per open`, async () => {
    const ids = Array.from({ length: LOOKUPS_PER_OPEN + 5 }, (_, index) => `google-place:p${index}`);
    const many = {
      ...trip,
      places: Object.fromEntries(ids.map((id) => [id, { id, name: id }])),
      days: [{ id: "d1", date: "2026-12-01", title: "", timezone: "Asia/Tokyo", items: ids.map((id) => ({ id, type: "place", placeId: id })) }],
    } as unknown as TripBundle;
    const { asked } = setup(() => "image");
    await keepMediaOffline(many);
    expect(asked).toHaveBeenCalledTimes(LOOKUPS_PER_OPEN);
  });

  it("stops at the first unavailable answer", async () => {
    const { asked, kept } = setup(() => "unavailable");
    await keepMediaOffline(trip);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(kept.size).toBe(0);
  });
});

describe("a card's photo lookup", () => {
  it("remembers an unavailable answer for the session", async () => {
    const { asked } = setup(() => "unavailable");
    const url = "/api/photo?place=hotel&t=";
    expect(await findPlacePhoto(url)).toBeUndefined();
    expect(await findPlacePhoto(url)).toBeUndefined();
    expect(mediaFailed(url)).toBe(true);
    expect(asked).toHaveBeenCalledTimes(1);
  });
});
