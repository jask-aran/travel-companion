import { describe, expect, it } from "vitest";
import type { Place } from "../packages/trip-schema/src/index.js";
import { latLngOf, mediaToken, photoMediaUrl, photoPlaceId, staticMapUpstream } from "../apps/web/src/lib/media.js";

describe("media requests", () => {
  it("builds the Google URLs with the key added server side", () => {
    expect(photoMediaUrl("places/abc_1/photos/xyz-2", "KEY")).toBe("https://places.googleapis.com/v1/places/abc_1/photos/xyz-2/media?maxWidthPx=480&key=KEY");
    expect(staticMapUpstream("35.17,136.88", "KEY")).toContain("center=35.17%2C136.88");
  });

  it("asks for a photo by the place's Google id and a map by its coordinates", () => {
    const place = (fields: Partial<Place>) => ({ id: "x", name: "x", ...fields }) as Place;
    expect(photoPlaceId(place({ id: "google-place:abc" }))).toBe("abc");
    expect(photoPlaceId(place({ googlePlaceId: "def" }))).toBe("def");
    expect(photoPlaceId(place({ photo: { name: "places/ghi/photos/1" } }))).toBe("ghi");
    expect(photoPlaceId(place({ id: "source-block:4" }))).toBeUndefined();
    expect(latLngOf({ latitude: 35.17, longitude: 136.88 })).toBe("35.17,136.88");
    expect(latLngOf({ latitude: 35.123456789, longitude: 136.88 })).toBeUndefined();
  });

  it("derives a stable token that is not the passphrase", async () => {
    const token = await mediaToken("secret phrase");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await mediaToken("secret phrase")).toBe(token);
    expect(await mediaToken("other phrase")).not.toBe(token);
  });
});
