import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place, TripBundle } from "../packages/trip-schema/src/index.js";
import { handleMcp, resetMcpState } from "../workers/refresh/mcp.js";
import {
  MAX_BOARDS_BUILT,
  MORE_BOARDS_NEXT_CALL,
  boardSession,
  buildCost,
  connectorBoards,
  type BoardSession,
} from "../workers/refresh/connector-boards.js";
import worker from "../workers/refresh/index.js";
import { agentLink, agentToken } from "../apps/web/src/lib/agent-link.js";
import { encryptTrip } from "../apps/web/src/lib/trip-crypto.js";
import { createGuard, forgetGuardMemory } from "../workers/refresh/guard.js";
import { departureTargets } from "../apps/web/src/lib/departure-targets.js";

const navitime = readFileSync(new URL("./fixtures/navitime-narita-shinjuku.json", import.meta.url), "utf8");
const NOW = new Date("2026-12-01T00:00:00Z");

const place = (id: string, latitude: number): Place =>
  ({ id, name: `${id} Station`, latitude, longitude: 139.7, timeZone: "Asia/Tokyo" }) as Place;

/** One day in Japan: a chain of long train rides between `stops` stations, none with a board. */
function trip(stops: number): TripBundle {
  const ids = Array.from({ length: stops }, (_, index) => `s${index}`);
  return {
    trip: { title: "t", startDate: "2026-12-06", endDate: "2026-12-06" },
    places: Object.fromEntries(ids.map((id, index) => [id, place(id, 35 + index * 0.3)])),
    routeLegs: Object.fromEntries(ids.slice(1).map((id, index) => [`l${index}`, {
      id: `l${index}`, fromPlaceId: ids[index], toPlaceId: id, travelMode: "transit", durationSeconds: 6000,
    }])),
    days: [{
      id: "d1", date: "2026-12-06", title: "", timezone: "Asia/Tokyo",
      // Leaving each stop at 13:20 asks for a "depart" board, which the fixture answers.
      items: ids.map((id) => ({ id: `i-${id}`, type: "place", placeId: id, endTime: "13:20" })),
    }],
  } as unknown as TripBundle;
}

function setup(upstream: () => Response = () => new Response(navitime)) {
  const kv = new Map<string, string>();
  const env = {
    TRIP: { get: vi.fn(async (key: string) => kv.get(key) ?? null), put: vi.fn(async (key: string, value: string) => void kv.set(key, value)) },
    PUBLIC_ID: "t",
    NAVITIME_API_KEY: "nkey",
  };
  const fetchMock = vi.fn(async () => upstream());
  vi.stubGlobal("fetch", fetchMock);
  return { env, kv, fetchMock };
}

/** Boards kept in KV (failure markers alone don't count). */
const keptBoards = (kv: Map<string, string>) =>
  [...kv].filter(([key, value]) => key.startsWith("boards/") && "board" in (JSON.parse(value) as object));

const call = async (bundle: TripBundle, env: ReturnType<typeof setup>["env"], name: string, args: object = {}, session?: BoardSession) => {
  const response = await handleMcp(new Request("https://x.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), { loadBundle: async () => bundle, withBoards: (copy, scope) => connectorBoards(copy, scope, env, createGuard(env.TRIP), { now: NOW, ...(session ? { session } : {}) }) });
  return ((await response.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
};

beforeEach(() => {
  resetMcpState();
  forgetGuardMemory();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("departure boards for the connector", () => {
  it("get_day builds boards for a trip with none, keeps them, and the next call reads them", async () => {
    const bundle = trip(3);
    expect(departureTargets(bundle)).toHaveLength(2);
    const { env, kv, fetchMock } = setup();
    const first = await call(bundle, env, "get_day", { date: "2026-12-06" });
    expect(first.isError).toBeUndefined();
    expect(first.content[0]!.text).toContain("Departures (leave from 13:20");
    expect(first.content[0]!.text).not.toContain(MORE_BOARDS_NEXT_CALL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...kv.keys()].filter((key) => key.startsWith("boards/"))).toHaveLength(2);
    expect(bundle.departures).toBeUndefined();
    const again = await call(bundle, env, "get_day", { date: "2026-12-06" });
    expect(again.content[0]!.text).toBe(first.content[0]!.text);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it(`builds at most ${MAX_BOARDS_BUILT} boards a call and says more are coming`, async () => {
    const bundle = trip(MAX_BOARDS_BUILT + 2);
    const { env, fetchMock } = setup();
    const first = await call(bundle, env, "get_day", { date: "2026-12-06" });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_BOARDS_BUILT);
    expect(first.content[0]!.text.trimEnd().endsWith(MORE_BOARDS_NEXT_CALL)).toBe(true);
    const second = await call(bundle, env, "get_day", { date: "2026-12-06" });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_BOARDS_BUILT + 1);
    expect(second.content[0]!.text).not.toContain(MORE_BOARDS_NEXT_CALL);
  });

  it("answers get_day when the provider fails, keeps nothing, and stops at the first failure without promising more", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, kv, fetchMock } = setup(() => new Response("quota", { status: 429 }));
    const result = await call(trip(6), env, "get_day", { date: "2026-12-06" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("2026-12-06");
    expect(result.content[0]!.text).not.toContain(MORE_BOARDS_NEXT_CALL);
    expect(keptBoards(kv)).toHaveLength(0);
    // The 429 opened the breaker: the next call asks nothing.
    await call(trip(6), env, "get_day", { date: "2026-12-06" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("builds nothing and promises nothing while the breaker is open", async () => {
    const { env, kv, fetchMock } = setup();
    kv.set("guard/navitime/open-until", String(Date.now() + 60_000));
    const result = await call(trip(6), env, "get_day", { date: "2026-12-06" });
    expect(result.content[0]!.text).not.toContain(MORE_BOARDS_NEXT_CALL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("get_trip asks no provider but includes boards already kept", async () => {
    const bundle = trip(3);
    const { env, fetchMock } = setup();
    const before = (await call(bundle, env, "get_trip")).content[0]!.text;
    expect(fetchMock).not.toHaveBeenCalled();
    await call(bundle, env, "get_day", { date: "2026-12-06" });
    fetchMock.mockClear();
    const after = (await call(bundle, env, "get_trip")).content[0]!.text;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(after).not.toBe(before);
    for (const name of ["get_overview", "get_bookings"]) await call(bundle, env, name);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.TRIP.get.mock.calls.length).toBeGreaterThan(0);
  });

  it("stops building after a failure that leaves the breaker shut (a 503)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, fetchMock } = setup(() => new Response("busy", { status: 503 }));
    const result = await call(trip(6), env, "get_day", { date: "2026-12-06" });
    expect(result.content[0]!.text).not.toContain(MORE_BOARDS_NEXT_CALL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't rebuild a leg whose build failed within the hour", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, fetchMock } = setup(() => new Response("busy", { status: 503 }));
    for (let calls = 0; calls < 3; calls += 1) await call(trip(2), env, "get_day", { date: "2026-12-06" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("builds no more than the invocation's subrequest budget allows", async () => {
    const { env, fetchMock } = setup();
    // Room for one lookup and one NAVITIME build, not a second.
    const session = { ...boardSession(), budget: 1 + buildCost({ provider: "navitime", kind: "depart" }) + 1 };
    const result = await call(trip(6), env, "get_day", { date: "2026-12-06" }, session);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content[0]!.text).toContain(MORE_BOARDS_NEXT_CALL);
  });

  it("never builds a past day's board", async () => {
    const { env, fetchMock } = setup();
    const bundle = trip(3);
    const response = await handleMcp(new Request("https://x.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_day", arguments: { date: "2026-12-06" } } }),
    }), {
      loadBundle: async () => bundle,
      withBoards: (copy, scope) => connectorBoards(copy, scope, env, createGuard(env.TRIP), { now: new Date("2026-12-07T00:00:00Z") }),
    });
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds the caps across a JSON-RPC batch of get_day messages", async () => {
    const { env, fetchMock } = setup();
    const passphrase = "secret";
    const legs = trip(8);
    const bundle = {
      ...legs, schemaVersion: 1, tripId: "t", revision: "r", generatedAt: "2026-01-01T00:00:00Z",
      days: legs.days.map((day) => ({ ...day, map: { orderedPlaceIds: [], routeLegIds: [] } })),
    };
    const kv = new Map([["trip.enc", JSON.stringify(await encryptTrip(JSON.stringify(bundle), passphrase))]]);
    const workerEnv = {
      ...env,
      TRIP: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => void kv.set(key, value) },
      TRIP_PASSPHRASE: passphrase,
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    };
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    try {
      const message = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_day", arguments: { date: "2026-12-06" } } });
      const response = await worker.fetch(new Request(agentLink("https://x.test/trip/", await agentToken(passphrase)), {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify([message(1), message(2), message(3)]),
      }), workerEnv as never);
      expect(((await response.json()) as unknown[]).length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchMock).toHaveBeenCalledTimes(MAX_BOARDS_BUILT);
  });
});
