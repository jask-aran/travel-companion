import { describe, expect, it } from "vitest";
import { MEDIA_ROUTES, mediaToken, mediaUpstream } from "../apps/web/src/lib/media.js";

const params = (entries: Record<string, string>) => new URLSearchParams(entries);

describe("media proxy", () => {
  it("forwards a photo or a map of a point, with the key added server side", () => {
    const photo = mediaUpstream(MEDIA_ROUTES.photo, params({ name: "places/abc_1/photos/xyz-2" }), "KEY");
    expect(photo).toBe("https://places.googleapis.com/v1/places/abc_1/photos/xyz-2/media?maxWidthPx=480&key=KEY");
    expect(mediaUpstream(MEDIA_ROUTES.map, params({ at: "35.17,136.88" }), "KEY")).toContain("center=35.17%2C136.88");
  });

  it("refuses anything else, so the key can't be spent elsewhere", () => {
    expect(mediaUpstream(MEDIA_ROUTES.photo, params({ name: "../../v1/places:searchText" }), "KEY")).toBeUndefined();
    expect(mediaUpstream(MEDIA_ROUTES.photo, params({ name: "places/a/photos/b?maxWidthPx=4800" }), "KEY")).toBeUndefined();
    expect(mediaUpstream(MEDIA_ROUTES.map, params({ at: "35.17,136.88&size=640x640" }), "KEY")).toBeUndefined();
    expect(mediaUpstream("api/other", params({}), "KEY")).toBeUndefined();
  });

  it("derives a stable token that is not the passphrase", async () => {
    const token = await mediaToken("secret phrase");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await mediaToken("secret phrase")).toBe(token);
    expect(await mediaToken("other phrase")).not.toBe(token);
  });
});
