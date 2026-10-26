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
  it("reuses a photo name fetched in the last few days, without asking Google", async () => {
    const next = bundle();
    const report = await attachPlacePhotos(next, "KEY", previous("2026-10-24T00:00:00Z"), now);
    expect(report).toMatchObject({ reused: 1, requested: 0 });
    expect(next.places["google-place:a"]?.photo?.name).toBe("places/a/photos/old");
  });

  it("asks again for a stale name, or one with no fetch time", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ photos: [{ name: "places/a/photos/new" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    for (const fetchedAt of ["2026-10-20T00:00:00Z", undefined]) {
      const next = bundle();
      const report = await attachPlacePhotos(next, "KEY", previous(fetchedAt), now);
      expect(report).toMatchObject({ reused: 0, requested: 1, attached: 1 });
      expect(next.places["google-place:a"]?.photo).toMatchObject({
        name: "places/a/photos/new",
        fetchedAt: now.toISOString(),
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
