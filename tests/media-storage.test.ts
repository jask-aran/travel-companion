import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../workers/refresh/index.js";
import { forgetGuardMemory } from "../workers/refresh/guard.js";
import { resetMcpState } from "../workers/refresh/mcp.js";
import { mediaToken } from "../apps/web/src/lib/media.js";
import { encryptTrip } from "../apps/web/src/lib/trip-crypto.js";

type Env = Parameters<typeof worker.fetch>[1];

/** A stored trip: a place with a photo name, one without, and two flats with only coordinates. */
const bundle = {
  schemaVersion: 1, tripId: "t", revision: "r", generatedAt: "2026-01-01T00:00:00Z",
  trip: { title: "T", startDate: "2026-12-01", endDate: "2026-12-01" },
  days: [{
    id: "day-1", date: "2026-12-01", title: "Day 1", timezone: "Asia/Tokyo",
    items: [{ id: "i1", type: "place", placeId: "source-block:1" }, { id: "i2", type: "place", placeId: "source-block:2" }],
    map: { orderedPlaceIds: [], routeLegIds: [] },
  }],
  routeLegs: {},
  places: {
    "google-place:abc": { id: "google-place:abc", name: "Named", photo: { name: "places/abc/photos/old" } },
    "google-place:bare": { id: "google-place:bare", name: "Bare" },
    "source-block:1": { id: "source-block:1", name: "Flat", latitude: 35.17, longitude: 136.88 },
    "source-block:2": { id: "source-block:2", name: "Flat 2", latitude: 35.18, longitude: 136.88 },
  },
};
let cipher = "";
beforeAll(async () => {
  cipher = JSON.stringify(await encryptTrip(JSON.stringify(bundle), "secret"));
});

const image = (text = "image bytes", type = "image/jpeg") => new Response(text, { headers: { "content-type": type } });

function setup(upstream: (url: string) => Response | Promise<Response> = () => image()) {
  type Saved = { bytes: ArrayBuffer; contentType: string; customMetadata?: Record<string, string> };
  const objects = new Map<string, Saved>();
  const photos = {
    get: vi.fn(async (key: string) => {
      const saved = objects.get(key);
      return saved ? {
        body: new Blob([saved.bytes]).stream(),
        httpMetadata: { contentType: saved.contentType },
        ...(saved.customMetadata ? { customMetadata: saved.customMetadata } : {}),
      } : null;
    }),
    put: vi.fn(async (
      key: string,
      body: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer,
      options: { httpMetadata: { contentType: string }; customMetadata?: Record<string, string> },
    ) => {
      objects.set(key, {
        bytes: await new Response(body as BodyInit).arrayBuffer(),
        contentType: options.httpMetadata.contentType,
        ...(options.customMetadata ? { customMetadata: options.customMetadata } : {}),
      });
    }),
  };
  const kv = new Map<string, string>([["trip.enc", cipher]]);
  const env = {
    ASSETS: { fetch: vi.fn(async () => new Response(null, { status: 404 })) },
    TRIP: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => void kv.set(key, value) },
    MEDIA: photos,
    PUBLIC_ID: "trip-a",
    TRIP_PASSPHRASE: "secret",
    GOOGLE_MAPS_API_KEY: "key",
  } satisfies Env;
  const upstreamMock = vi.fn(async (url: string, _init?: RequestInit) => upstream(url));
  vi.stubGlobal("fetch", upstreamMock);
  const get = async (route: string, params: Record<string, string>, token?: string, headers?: HeadersInit) =>
    worker.fetch(new Request(`https://example.test/trip/${route}?${new URLSearchParams({
      ...params, t: token ?? await mediaToken("secret"),
    })}`, headers ? { headers } : {}), env);
  const byPlace = (place: string) => get("api/photo", { place });
  const map = (place: string | undefined, at: string) => get("api/map", { ...(place ? { place } : {}), at });
  return { env, kv, photos, objects, upstream: upstreamMock, get, byPlace, map };
}

beforeEach(() => {
  forgetGuardMemory();
  resetMcpState();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("photos kept in R2", () => {
  it("fetches by the trip's photo name once, then serves R2, per trip namespace", async () => {
    const { env, objects, upstream, byPlace } = setup();
    const first = await byPlace("abc");
    expect(first.headers.get("x-media-cache")).toBe("r2-miss");
    expect(await first.text()).toBe("image bytes");
    expect(upstream.mock.calls[0]?.[0]).toContain("/v1/places/abc/photos/old/media");
    const next = await byPlace("abc");
    expect(next.headers.get("x-media-cache")).toBe("r2-hit");
    expect(next.headers.get("cache-control")).toBe("private, max-age=2592000");
    expect(upstream).toHaveBeenCalledTimes(1);
    env.PUBLIC_ID = "trip-b";
    await byPlace("abc");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect([...objects.keys()]).toEqual(["trip-a/photos/480/abc", "trip-b/photos/480/abc"]);
  });

  it("looks the place up only when the stored name has expired (400 or 404)", async () => {
    const { objects, upstream, byPlace } = setup((url) => {
      if (url.includes("/photos/old/media")) return new Response("expired", { status: 404 });
      if (url === "https://places.googleapis.com/v1/places/abc") return Response.json({ photos: [{ name: "places/abc/photos/current" }] });
      return image();
    });
    expect(await (await byPlace("abc")).text()).toBe("image bytes");
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(upstream.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-Goog-FieldMask": "photos" });
    expect([...objects.keys()]).toEqual(["trip-a/photos/480/abc"]);
  });

  it("a 403 on the photo is not looked up, and stops Google for every kind of media", async () => {
    const { photos, upstream, byPlace, map } = setup(() => new Response("billing", { status: 403 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const response of [await byPlace("abc"), await byPlace("bare"), await map("source-block:1", "35.17,136.88")]) {
      expect(response.headers.get("x-media")).toBe("unavailable");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(upstream).toHaveBeenCalledTimes(1);
    // Only a failure marker for the photo that was asked; no image.
    expect(photos.put.mock.calls.map(([key, , options]) => [key, options.httpMetadata.contentType]))
      .toEqual([["trip-a/photos/480/abc", "application/x-media-failed"]]);
  });

  it("asks nothing for a place, or coordinates, the stored trip doesn't have", async () => {
    const { upstream, byPlace, map } = setup();
    expect((await byPlace("someoneelses")).status).toBe(404);
    expect((await map("source-block:1", "35.18,136.88")).status).toBe(404);
    expect((await map("nowhere", "48.85,2.35")).status).toBe(404);
    expect((await map("google-place:abc", "35.17,136.88")).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("serves an old app shell's name= and at= from R2 only, never asking Google", async () => {
    const { upstream, get, byPlace, map } = setup();
    await byPlace("abc");
    await map("source-block:1", "35.17,136.88");
    upstream.mockClear();
    expect((await get("api/photo", { name: "places/abc/photos/anything" })).headers.get("x-media-cache")).toBe("r2-hit");
    expect((await map(undefined, "35.17,136.88")).headers.get("x-media-cache")).toBe("r2-hit");
    expect((await get("api/photo", { name: "places/bare/photos/x" })).headers.get("x-media")).toBe("unavailable");
    expect((await map(undefined, "35.18,136.88")).headers.get("x-media")).toBe("unavailable");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("serves the fetched image when R2 won't keep it", async () => {
    const { photos, upstream, byPlace } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    photos.put.mockRejectedValue(new Error("R2 down"));
    const response = await byPlace("abc");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("image bytes");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("makes one request for two travellers missing the same photo at once", async () => {
    const { upstream, byPlace } = setup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return image();
    });
    const both = await Promise.all([byPlace("abc"), byPlace("abc")]);
    expect(await Promise.all(both.map((response) => response.text()))).toEqual(["image bytes", "image bytes"]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("checks authentication and validates ids before accessing storage or Google", async () => {
    const { photos, upstream, get, byPlace } = setup();
    expect((await get("api/photo", { place: "abc" }, "wrong")).status).toBe(401);
    expect((await get("api/photo", { name: "places/abc/photos/../../bad" })).status).toBe(404);
    expect((await byPlace("../x")).status).toBe(404);
    expect(photos.get).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns an uncached media error if R2 fails, without serving app HTML", async () => {
    const { env, photos, byPlace } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    photos.get.mockRejectedValueOnce(new Error("R2 unavailable"));
    const response = await byPlace("abc");
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
});

describe("photos by place, for a place with no photo name", () => {
  it("serves R2's copy and credit without asking Google", async () => {
    const { objects, upstream, byPlace } = setup();
    objects.set("trip-a/photos/480/bare", { bytes: new TextEncoder().encode("kept").buffer as ArrayBuffer, contentType: "image/jpeg", customMetadata: { credit: "A%20B" } });
    const response = await byPlace("bare");
    expect(response.headers.get("x-photo-credit")).toBe("A%20B");
    expect(await response.text()).toBe("kept");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("finds, keeps and serves the place's photo on a miss, with its credit", async () => {
    const { objects, upstream, byPlace } = setup((url) => url === "https://places.googleapis.com/v1/places/bare"
      ? Response.json({ photos: [{ name: "places/bare/photos/p1", authorAttributions: [{ displayName: "Ana" }] }] })
      : image());
    const first = await byPlace("bare");
    expect(first.headers.get("x-photo-credit")).toBe("Ana");
    expect(await first.text()).toBe("image bytes");
    expect(objects.get("trip-a/photos/480/bare")?.customMetadata).toEqual({ credit: "Ana" });
    expect((await byPlace("bare")).headers.get("x-media-cache")).toBe("r2-hit");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("remembers that a place has no photo, in R2, and asks Google once", async () => {
    const { photos, upstream, byPlace } = setup(() => Response.json({}));
    for (let view = 0; view < 3; view += 1) {
      const response = await byPlace("bare");
      expect(response.headers.get("x-media")).toBe("none");
      expect(response.headers.get("content-type")).toBe("image/gif");
    }
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(photos.put).toHaveBeenCalledTimes(1);
  });
});

describe("maps kept in R2", () => {
  it("keeps a map per point and per look, drawn from the trip, fetched once", async () => {
    const { objects, upstream, map } = setup(() => image("map bytes", "image/png"));
    expect((await map("source-block:1", "35.17,136.88")).headers.get("x-media-cache")).toBe("r2-miss");
    const again = await map("source-block:1", "35.17,136.88");
    expect(again.headers.get("x-media-cache")).toBe("r2-hit");
    expect(await again.text()).toBe("map bytes");
    await map("source-block:2", "35.18,136.88");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[0]?.[0]).toContain("center=35.17%2C136.88");
    expect([...objects.keys()].every((key) => /^trip-a\/maps\/35\.1[78],136\.88\/[0-9a-f]{12}$/.test(key))).toBe(true);
  });
});

describe("day overview maps kept in R2", () => {
  it("draws the day from the stored trip, asks Google once, then serves R2 to everyone", async () => {
    const { objects, upstream, get } = setup(() => image("day bytes", "image/png"));
    const first = await get("api/day-map", { day: "day-1", v: "r" });
    expect(first.headers.get("x-media-cache")).toBe("r2-miss");
    expect(await first.text()).toBe("day bytes");
    const again = await get("api/day-map", { day: "day-1", v: "r", extra: "ignored" });
    expect(again.headers.get("x-media-cache")).toBe("r2-hit");
    expect(upstream).toHaveBeenCalledTimes(1);
    const asked = new URL(String(upstream.mock.calls[0]?.[0]));
    expect(asked.pathname).toBe("/maps/api/staticmap");
    expect(asked.searchParams.get("key")).toBe("key");
    expect([...objects.keys()].some((key) => /^trip-a\/day-maps\/[0-9a-f]{64}$/.test(key))).toBe(true);
  });
  it("asks nothing for an unknown day, a stale revision or a bad token", async () => {
    const { upstream, get } = setup();
    expect((await get("api/day-map", { day: "day-9" })).status).toBe(404);
    expect((await get("api/day-map", { day: "day-1", v: "old" })).headers.get("x-media")).toBe("unavailable");
    expect((await get("api/day-map", { day: "day-1" }, "wrong")).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("cache-only requests (ship:check)", () => {
  const cacheOnly = { "x-trip-cache-only": "1" };
  it("never asks Google on a miss for a photo, a map or a day map, and stores nothing", async () => {
    const { objects, upstream, get } = setup();
    for (const [route, params] of [
      ["api/photo", { place: "abc" }],
      ["api/photo", { place: "bare" }],
      ["api/map", { place: "source-block:1", at: "35.17,136.88" }],
      ["api/day-map", { day: "day-1" }],
    ] as const) {
      const response = await get(route, params, undefined, cacheOnly);
      expect(response.headers.get("x-media")).toBe("unavailable");
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });
  it("still serves what R2 already holds", async () => {
    const { upstream, get, byPlace } = setup();
    await byPlace("abc");
    const kept = await get("api/photo", { place: "abc" }, undefined, cacheOnly);
    expect(kept.headers.get("x-media-cache")).toBe("r2-hit");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("a failed fetch, remembered for an hour", () => {
  for (const [kind, view, key] of [
    ["photo", (setupResult: ReturnType<typeof setup>) => setupResult.byPlace("abc"), "trip-a/photos/480/abc"],
    ["map", (setupResult: ReturnType<typeof setup>) => setupResult.map("source-block:1", "35.17,136.88"), undefined],
  ] as const) {
    it(`answers a ${kind} "unavailable" without asking Google again after a 500, until the hour is up`, async () => {
      const result = setup(() => new Response("oops", { status: 500 }));
      const { objects, upstream } = result;
      for (let viewed = 0; viewed < 3; viewed += 1) {
        expect((await view(result)).headers.get("x-media")).toBe("unavailable");
      }
      expect(upstream).toHaveBeenCalledTimes(1);
      const marker = key ?? [...objects.keys()][0]!;
      expect(objects.get(marker)?.contentType).toBe("application/x-media-failed");
      // An hour on, Google is asked again, and the image replaces the marker.
      objects.get(marker)!.customMetadata = { failedAt: new Date(Date.now() - 3_600_000).toISOString() };
      upstream.mockImplementation(async () => image());
      expect((await view(result)).headers.get("x-media-cache")).toBe("r2-miss");
      expect(upstream).toHaveBeenCalledTimes(2);
      expect((await view(result)).headers.get("x-media-cache")).toBe("r2-hit");
    });
  }

  it("remembers nothing when the guard refused (nothing was asked)", async () => {
    const { kv, photos, upstream, byPlace } = setup();
    kv.set("guard/google/open-until", String(Date.now() + 60_000));
    expect((await byPlace("abc")).headers.get("x-media")).toBe("unavailable");
    expect(upstream).not.toHaveBeenCalled();
    expect(photos.put).not.toHaveBeenCalled();
  });
});

describe("cheap misses", () => {
  it("reads only the trip, not the guard, for a place the trip doesn't have", async () => {
    const { env, photos, upstream, byPlace, map } = setup();
    const reads = vi.spyOn(env.TRIP, "get");
    expect((await byPlace("someoneelses")).status).toBe(404);
    expect((await map("nowhere", "48.85,2.35")).status).toBe(404);
    expect(reads.mock.calls.map(([key]) => key)).toEqual(["trip.enc", "trip.enc"]);
    expect(photos.get).toHaveBeenCalledTimes(2);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("paid work outlives the response", () => {
  it("runs a photo's fetch-and-store under waitUntil when the runtime gives one", async () => {
    const { env, objects, upstream } = setup();
    const waitUntil = vi.fn();
    const response = await worker.fetch(new Request(`https://example.test/trip/api/photo?${new URLSearchParams({
      place: "abc", t: await mediaToken("secret"),
    })}`), env, { waitUntil });
    expect(await response.text()).toBe("image bytes");
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntil.mock.calls.map(([work]) => work));
    expect([...objects.keys()]).toEqual(["trip-a/photos/480/abc"]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("a deployment with no R2 bucket", () => {
  it("answers photos and maps with 503 and leaves the trip payload alone", async () => {
    const { env, upstream } = setup();
    const { MEDIA: _bucket, ...withoutBucket } = env;
    const photo = await worker.fetch(new Request(`https://example.test/api/photo?${new URLSearchParams({
      place: "abc", t: await mediaToken("secret"),
    })}`), withoutBucket);
    expect(photo.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
});
