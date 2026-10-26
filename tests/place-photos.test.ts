import { afterEach, describe, expect, it, vi } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";
import { attachPlacePhotos } from "../packages/trip-normaliser/src/place-photos.js";

const now = new Date("2026-10-26T00:00:00Z");
const bundle = () =>
  ({ places: { "google-place:a": { id: "google-place:a", name: "A", googlePlaceId: "a" } } }) as unknown as TripBundle;
const previous = (fetchedAt?: string) =>
  ({ places: { "google-place:a": { photo: { name: "places/a/photos/old", ...(fetchedAt ? { fetchedAt } : {}) } } } }) as unknown as TripBundle;

afterEach(() => vi.unstubAllGlobals());

describe("attachPlacePhotos", () => {
  it("keeps a place's photo name however old, without asking Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const fetchedAt of ["2026-10-24T00:00:00Z", "2026-01-01T00:00:00Z", undefined]) {
      const next = bundle();
      const report = await attachPlacePhotos(next, "KEY", previous(fetchedAt), now);
      expect(report).toMatchObject({ reused: 1, requested: 0 });
      expect(next.places["google-place:a"]?.photo?.name).toBe("places/a/photos/old");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks about a place that has no photo name yet", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ photos: [{ name: "places/a/photos/new" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const next = bundle();
    const report = await attachPlacePhotos(next, "KEY", undefined, now);
    expect(report).toMatchObject({ reused: 0, requested: 1, attached: 1 });
    expect(next.places["google-place:a"]?.photo).toMatchObject({
      name: "places/a/photos/new",
      fetchedAt: now.toISOString(),
    });
  });
});
