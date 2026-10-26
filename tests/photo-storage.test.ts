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
    PHOTOS: photos,
    PUBLIC_ID: "trip-a",
    TRIP_PASSPHRASE: "secret",
    GOOGLE_MAPS_API_KEY: "key",
  } satisfies Env;
  const request = async (name = "places/abc/photos/old", token?: string) =>
    worker.fetch(new Request(`https://example.test/api/photo?${new URLSearchParams({
      name, t: token ?? await mediaToken("secret"),
    })}`), env, { waitUntil: vi.fn() });
  return { env, photos, objects, request };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("persistent place photos", () => {
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
