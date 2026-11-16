import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentToken } from "../apps/web/src/lib/agent-link.js";
import worker, { CHECK_EVERY_MS, REFRESH_GAP_MS, forgetLastCheck } from "../workers/refresh/index.js";
import { openTrip, resetMcpState } from "../workers/refresh/mcp.js";
import { encryptTrip } from "../apps/web/src/lib/trip-crypto.js";

/** A KV stand-in holding a stored trip and, optionally, when Wanderlog was last asked. */
function setup(checkedAt?: string) {
  const store = new Map<string, string>([["trip.enc", "stored ciphertext"]]);
  if (checkedAt) store.set("checked-at", checkedAt);
  const env = {
    PUBLIC_ID: "test-trip",
    WANDERLOG_TRIP_ID: "plan-key",
    TRIP_PASSPHRASE: "correct horse",
    TRIP: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    },
    MEDIA: { get: async () => null, put: async () => {} },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  return { env, store };
}

const readTrip = (env: ReturnType<typeof setup>["env"]) =>
  worker.fetch(new Request("https://trips.example/trip/trip.enc"), env as never);

describe("the idle check before a read of the trip", () => {
  const wanderlog = vi.fn();
  beforeEach(() => {
    forgetLastCheck();
    wanderlog.mockReset();
    vi.stubGlobal("fetch", wanderlog);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("leaves Wanderlog alone when it was asked within the hour", async () => {
    const { env } = setup(new Date(Date.now() - CHECK_EVERY_MS / 2).toISOString());
    const response = await readTrip(env);
    expect(await response.text()).toBe("stored ciphertext");
    expect(wanderlog).not.toHaveBeenCalled();
  });

  it("asks Wanderlog after an idle hour, once, and still serves the stored trip when it fails", async () => {
    const { env, store } = setup(new Date(Date.now() - CHECK_EVERY_MS * 2).toISOString());
    wanderlog.mockResolvedValue(new Response("down", { status: 500 }));
    const before = Date.now();
    const first = await readTrip(env);
    expect(await first.text()).toBe("stored ciphertext");
    expect(wanderlog).toHaveBeenCalledTimes(1);
    expect(String(wanderlog.mock.calls[0]?.[0])).toContain("wanderlog.com/api/tripPlans/plan-key");
    expect(Date.parse(store.get("checked-at") ?? "")).toBeGreaterThanOrEqual(before);

    // The failed pull still counts as this hour's check.
    await readTrip(env);
    forgetLastCheck(); // another isolate, knowing only what KV says
    await readTrip(env);
    expect(wanderlog).toHaveBeenCalledTimes(1);
  });

  it("asks when no check was ever recorded, and survives Wanderlog not answering", async () => {
    const { env } = setup();
    wanderlog.mockRejectedValue(new Error("timed out"));
    const response = await readTrip(env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("stored ciphertext");
    expect(wanderlog).toHaveBeenCalledTimes(1);
  });

  it("a connector call with no stored trip pulls at once, even inside the hour", async () => {
    const { env, store } = setup(new Date(Date.now() - REFRESH_GAP_MS - 1_000).toISOString());
    store.delete("trip.enc");
    wanderlog.mockResolvedValue(new Response("down", { status: 500 }));
    const token = await agentToken(env.TRIP_PASSPHRASE);
    const response = await worker.fetch(
      new Request(`https://trips.example/mcp/${token}`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_overview", arguments: {} } }),
      }),
      { ...env, ASSETS: { fetch: async () => new Response("<html>index</html>") } } as never,
    );
    expect(wanderlog).toHaveBeenCalledTimes(1);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("a connector call with no stored trip and no recorded check pulls once, not twice", async () => {
    const { env, store } = setup();
    store.delete("trip.enc");
    wanderlog.mockResolvedValue(new Response("down", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.fetch(
      new Request(`https://trips.example/mcp/${await agentToken(env.TRIP_PASSPHRASE)}`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_overview", arguments: {} } }),
      }),
      { ...env, ASSETS: { fetch: async () => new Response("<html>index</html>") } } as never,
    );
    expect(wanderlog).toHaveBeenCalledTimes(1);
  });
});

describe("pulls with Wanderlog down", () => {
  const wanderlog = vi.fn();
  beforeEach(() => {
    forgetLastCheck();
    wanderlog.mockReset();
    vi.stubGlobal("fetch", wanderlog);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a connector with no stored trip pulls at most once per refresh gap, however often it is called", async () => {
    const { env, store } = setup();
    store.delete("trip.enc");
    wanderlog.mockResolvedValue(new Response("down", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const connectorEnv = { ...env, ASSETS: { fetch: async () => new Response("<html>index</html>") } };
    const callOnce = async () => worker.fetch(
      new Request(`https://trips.example/mcp/${await agentToken(env.TRIP_PASSPHRASE)}`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_overview", arguments: {} } }),
      }),
      connectorEnv as never,
    );
    for (let calls = 0; calls < 5; calls += 1) {
      await callOnce();
      if (calls === 2) forgetLastCheck(); // another isolate, knowing only KV
    }
    expect(wanderlog).toHaveBeenCalledTimes(1);
  });

  it("gives up on Wanderlog after the pull timeout and serves the stored trip", async () => {
    const { env } = setup();
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(20));
    wanderlog.mockImplementation((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await readTrip(env);
    expect(await response.text()).toBe("stored ciphertext");
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(wanderlog).toHaveBeenCalledTimes(1);
  });
});

describe("the refresh button", () => {
  const press = (env: object) => worker.fetch(
    new Request("https://trips.example/api/refresh", { method: "POST", headers: { Authorization: "Bearer correct horse" } }),
    env as never,
  );
  const wanderlog = vi.fn(async () => new Response("down", { status: 500 }));
  beforeEach(() => {
    forgetLastCheck();
    wanderlog.mockClear();
    vi.stubGlobal("fetch", wanderlog);
  });
  afterEach(() => vi.unstubAllGlobals());

  it(`ignores a press within ${REFRESH_GAP_MS / 1000} s of the last check, in any isolate`, async () => {
    expect(REFRESH_GAP_MS).toBe(120_000);
    const { env, store } = setup();
    expect((await press(env)).status).toBe(502);
    expect(await (await press(env)).json()).toEqual({ ok: true, changed: false, checkedRecently: true });
    forgetLastCheck();
    expect(await (await press(env)).json()).toEqual({ ok: true, changed: false, checkedRecently: true });
    expect(wanderlog).toHaveBeenCalledTimes(1);
    forgetLastCheck();
    store.set("checked-at", new Date(Date.now() - REFRESH_GAP_MS).toISOString());
    await press(env);
    expect(wanderlog).toHaveBeenCalledTimes(2);
  });

  it("carries the shipped file's photo names and boards into the first pull", async () => {
    resetMcpState();
    const block = (id: number) => ({ id, type: "place", place: { place_id: `p${id}`, name: `Stop ${id}`, geometry: { location: { lat: 36.1, lng: 137.2 } } } });
    wanderlog.mockResolvedValue(new Response(JSON.stringify({
      tripPlan: { title: "T", startDate: "2026-11-01", endDate: "2026-11-01", itinerary: { sections: [{ date: "2026-11-01", blocks: [block(1), block(2)] }] } },
      resources: { distancesBetweenPlaces: { r: { fromPlaceId: "p1", toPlaceId: "p2", travelMode: "transit", route: { duration: { value: 3600 } } } } },
    })));
    const board = { provider: "navitime", target: { kind: "day", date: "2026-11-01", time: "05:00" }, fetchedAt: "2026-10-01T00:00:00Z", options: [] };
    const shipped = JSON.stringify(await encryptTrip(JSON.stringify({
      schemaVersion: 1, tripId: "test-trip", revision: "r", generatedAt: "2026-01-01T00:00:00Z",
      trip: { title: "T", startDate: "2026-11-01", endDate: "2026-11-01" }, days: [], routeLegs: {},
      places: { "google-place:p1": { id: "google-place:p1", name: "Stop 1", photo: { name: "places/p1/photos/a" } } },
      departures: { "google-place:p1>google-place:p2": board },
    }), "correct horse"));
    const { env, store } = setup();
    store.delete("trip.enc");
    const assets = { fetch: async (request: Request) => new URL(request.url).pathname === "/trip.enc" ? new Response(shipped) : new Response("<html></html>") };
    expect((await press({ ...env, ASSETS: assets })).status).toBe(200);
    const stored = await openTrip(store.get("trip.enc")!, "correct horse");
    expect(stored.places["google-place:p1"]?.photo?.name).toBe("places/p1/photos/a");
    expect(Object.keys(stored.departures ?? {})).toEqual(["google-place:p1>google-place:p2"]);
    expect(wanderlog).toHaveBeenCalledTimes(1);
  });
});

describe("town names in the function's pull", () => {
  const town = (id: number, name: string) => ({
    id,
    type: "place",
    place: {
      place_id: `p${id}`,
      name: `Stop ${id}`,
      address_components: [{ long_name: name, types: ["locality"] }],
      geometry: { location: { lat: 36.1, lng: 137.2 } },
    },
  });
  const plan = JSON.stringify({
    tripPlan: { title: "T", startDate: "2026-11-01", endDate: "2026-11-01", itinerary: { sections: [{ date: "2026-11-01", blocks: [town(1, "高山市"), town(2, "Kanazawa")] }] } },
  });
  const calls = vi.fn();
  const pull = (env: object, translate: () => Response) => {
    forgetLastCheck();
    vi.stubGlobal("fetch", async (input: string) => {
      calls(String(input));
      return String(input).startsWith("https://translation.googleapis.com/") ? translate() : new Response(plan);
    });
    return worker.fetch(
      new Request("https://trips.example/api/refresh", { method: "POST", headers: { Authorization: "Bearer correct horse" } }),
      env as never,
    );
  };
  const localities = async (store: Map<string, string>) =>
    Object.values((await openTrip(store.get("trip.enc")!, "correct horse")).places).map((place) => place.locality);
  const translated = () => Response.json({ data: { translations: [{ translatedText: "Takayama City" }] } });
  beforeEach(() => calls.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  it("asks once for a new name, and never again for it", async () => {
    const { env, store } = setup();
    store.delete("trip.enc");
    const keyed = { ...env, GOOGLE_MAPS_API_KEY: "KEY" };
    expect((await pull(keyed, translated)).status).toBe(200);
    expect(calls.mock.calls.filter(([url]) => url.includes("translation")).length).toBe(1);
    expect(await localities(store)).toEqual(["Takayama", "Kanazawa"]);

    // A fresh trip from the shipped file, say: the stored translation answers.
    store.delete("trip.enc");
    store.delete("checked-at");
    calls.mockReset();
    expect((await pull(keyed, translated)).status).toBe(200);
    expect(calls.mock.calls.some(([url]) => url.includes("translation"))).toBe(false);
    expect(await localities(store)).toEqual(["Takayama", "Kanazawa"]);
  });

  it("stores the trip with the name as given when translation fails or there is no key", async () => {
    for (const env of [{ ...setup().env, GOOGLE_MAPS_API_KEY: "KEY" }, setup().env]) {
      const store = new Map<string, string>();
      const response = await pull({ ...env, TRIP: { get: async (key: string) => store.get(key) ?? null, put: async (key: string, value: string) => void store.set(key, value) } }, () => new Response("billing", { status: 403 }));
      expect(response.status).toBe(200);
      expect(await localities(store)).toEqual(["高山市", "Kanazawa"]);
    }
  });
});
