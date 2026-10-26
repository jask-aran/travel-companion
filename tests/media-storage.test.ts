import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../workers/refresh/index.js";
import { mediaToken } from "../apps/web/src/lib/media.js";

type Env = Parameters<typeof worker.fetch>[1];

function setup() {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  const photos = {
    get: vi.fn(async (key: string) => {
      const saved = objects.get(key);
      return saved ? {
        body: new Blob([saved.bytes]).stream(),
        httpMetadata: { contentType: saved.contentType },
      } : null;
    }),
    put: vi.fn(async (key: string, body: ReadableStream<Uint8Array>, options: { httpMetadata: { contentType: string } }) => {
      objects.set(key, {
        bytes: await new Response(body).arrayBuffer(),
        contentType: options.httpMetadata.contentType,
      });
    }),
  };
  const env = {
    ASSETS: { fetch: vi.fn(async () => new Response(null, { status: 404 })) },
    TRIP: { get: async () => null, put: async () => {} },
    MEDIA: photos,
    PUBLIC_ID: "trip-a",
    TRIP_PASSPHRASE: "secret",
    GOOGLE_MAPS_API_KEY: "key",
  } satisfies Env;
  const request = async (name = "places/abc/photos/old", token?: string) =>
    worker.fetch(new Request(`https://example.test/api/photo?${new URLSearchParams({
      name, t: token ?? await mediaToken("secret"),
    })}`), env);
  const map = async (at: string) =>
    worker.fetch(new Request(`https://example.test/api/map?${new URLSearchParams({
      at, t: await mediaToken("secret"),
    })}`), env);
  return { env, photos, objects, request, map };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("photos and maps kept in R2", () => {
  it("saves image bytes and reuses them across photo references and trip namespaces", async () => {
    const { env, photos, objects, request } = setup();
    const upstream = vi.fn(async () => new Response("image bytes", { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", upstream);
    const first = await request();
    expect(first.headers.get("x-media-cache")).toBe("r2-miss");
    expect(await first.text()).toBe("image bytes");
    const next = await request("places/abc/photos/refreshed");
    expect(next.headers.get("x-media-cache")).toBe("r2-hit");
    expect(next.headers.get("cache-control")).toBe("private, max-age=2592000");
    expect(await next.text()).toBe("image bytes");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(photos.put).toHaveBeenCalledTimes(1);
    env.PUBLIC_ID = "trip-b";
    await request();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect([...objects.keys()]).toEqual(["trip-a/photos/480/abc", "trip-b/photos/480/abc"]);
  });

  it("asks for a place's current photo name when the stored one has expired", async () => {
    const { objects, request } = setup();
    const upstream = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/photos/old/media")) return new Response("expired", { status: 400 });
      if (url === "https://places.googleapis.com/v1/places/abc") {
        return Response.json({ photos: [{ name: "places/abc/photos/current" }] });
      }
      if (url.includes("/photos/current/media")) return new Response("image bytes", { headers: { "content-type": "image/jpeg" } });
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("image bytes");
    expect(upstream.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-Goog-FieldMask": "photos" });
    expect([...objects.keys()]).toEqual(["trip-a/photos/480/abc"]);
  });

  it("keeps a map per point and per look, fetched once", async () => {
    const { objects, map } = setup();
    const upstream = vi.fn(async () => new Response("map bytes", { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", upstream);
    expect((await map("35.17,136.88")).headers.get("x-media-cache")).toBe("r2-miss");
    const again = await map("35.17,136.88");
    expect(again.headers.get("x-media-cache")).toBe("r2-hit");
    expect(again.headers.get("content-type")).toBe("image/png");
    expect(await again.text()).toBe("map bytes");
    await map("35.18,136.88");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect([...objects.keys()].every((key) => /^trip-a\/maps\/35\.1[78],136\.88\/[0-9a-f]{12}$/.test(key))).toBe(true);
  });

  it("checks authentication and validates names before accessing storage or Google", async () => {
    const { photos, request } = setup();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    expect((await request(undefined, "wrong")).status).toBe(401);
    expect((await request("places/abc/photos/../../bad")).status).toBe(404);
    expect(photos.get).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not store upstream failures or non-image responses", async () => {
    const { photos, request } = setup();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 403 }))
      .mockResolvedValueOnce(new Response("error page", { headers: { "content-type": "text/html" } })));
    const expired = await request();
    expect(expired.status).toBe(403);
    expect(expired.headers.get("cache-control")).toBe("no-store");
    expect((await request()).status).toBe(502);
    expect(photos.put).not.toHaveBeenCalled();
  });

  it("returns an uncached media error if R2 fails, without serving app HTML", async () => {
    const { env, photos, request } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    photos.get.mockRejectedValueOnce(new Error("R2 unavailable"));
    const response = await request();
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
});
