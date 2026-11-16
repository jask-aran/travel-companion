import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place, TripBundle } from "../packages/trip-schema/src/index.js";
import worker from "../workers/refresh/index.js";
import { liveBoard } from "../workers/refresh/live-boards.js";
import { NAVITIME_MONTHLY_REQUESTS, createGuard, forgetGuardMemory } from "../workers/refresh/guard.js";
import { mediaToken } from "../apps/web/src/lib/media.js";
import { departureTargets } from "../apps/web/src/lib/departure-targets.js";
import { boardQuestion } from "../apps/web/src/lib/departures-api.js";

const navitime = readFileSync(new URL("./fixtures/navitime-narita-shinjuku.json", import.meta.url), "utf8");

const place = (id: string, name: string, latitude: number, longitude: number): Place =>
  ({ id, name, latitude, longitude, timeZone: "Asia/Tokyo" }) as Place;

/** Narita to Shinjuku, leaving Narita at 13:20 on `date`. */
const trip = (date = "2026-12-06") =>
  ({
    trip: { title: "t", startDate: date, endDate: date },
    places: {
      nrt: place("nrt", "Narita Airport Terminal 1", 35.7647, 140.3864),
      shinjuku: place("shinjuku", "Shinjuku Station", 35.696445, 139.705724),
    },
    routeLegs: { a: { id: "a", fromPlaceId: "nrt", toPlaceId: "shinjuku", travelMode: "transit", durationSeconds: 5400 } },
    days: [{
      id: "d1", date, title: "", timezone: "Asia/Tokyo",
      items: [
        { id: "s1", type: "place", placeId: "nrt", endTime: "13:20" },
        { id: "s2", type: "place", placeId: "shinjuku" },
      ],
    }],
  }) as unknown as TripBundle;
const LEG = "nrt>shinjuku";
/** The guard counts NAVITIME by the real clock's calendar month. */
const MONTH_KEY = `guard/navitime/${new Date().toISOString().slice(0, 7)}`;
/** Boards kept in KV (failure markers alone don't count). */
const keptBoards = (kv: Map<string, string>) =>
  [...kv].filter(([key, value]) => key.startsWith("boards/") && "board" in (JSON.parse(value) as object));
const question = (bundle: TripBundle) => boardQuestion(departureTargets(bundle)[0]!, bundle)!;

function setup(upstream: (url: string) => Response | Promise<Response> = () => new Response(navitime)) {
  const kv = new Map<string, string>();
  const env = {
    ASSETS: { fetch: vi.fn(async () => new Response(null, { status: 404 })) },
    TRIP: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => void kv.set(key, value)),
    },
    MEDIA: { get: async () => null, put: async () => {} },
    PUBLIC_ID: "trip-a",
    TRIP_PASSPHRASE: "secret",
    GOOGLE_MAPS_API_KEY: "gkey",
    NAVITIME_API_KEY: "nkey",
    GOOGLE_PROJECT_NUMBER: "42",
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.startsWith("https://translation.googleapis.com/")) {
      const { q } = JSON.parse(String(init?.body)) as { q: string[] };
      return Response.json({ data: { translations: q.map((text) => ({ translatedText: `en:${text}` })) } });
    }
    return upstream(input);
  });
  vi.stubGlobal("fetch", fetchMock);
  const providerCalls = () => fetchMock.mock.calls.filter(([url]) => url.includes("navitime")).length;
  return { env, kv, fetchMock, providerCalls };
}

/** The app's ask: by leg, with its question. `leg: null` is an app shell from before `leg=`. */
const ask = async (env: ReturnType<typeof setup>["env"], at: string, bundle = trip(), leg: string | null = LEG, q = question(bundle)) => {
  const params = new URLSearchParams({ q: JSON.stringify(q), ...(leg === null ? {} : { leg }) });
  const response = await liveBoard(params, env, createGuard(env.TRIP), async () => bundle, new Date(at));
  return { state: response.headers.get("x-board"), body: (await response.json()) as { board: { options: unknown[]; target: unknown } | null } };
};

beforeEach(() => forgetGuardMemory());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live departure boards in the worker", () => {
  it("answers only a trip token holder, and only a question", async () => {
    const { env } = setup();
    const url = (params: Record<string, string>) => `https://example.test/japankorea2026/api/departures?${new URLSearchParams(params)}`;
    const q = JSON.stringify(question(trip()));
    expect((await worker.fetch(new Request(url({ q, leg: LEG })), env)).status).toBe(401);
    expect((await worker.fetch(new Request(url({ q: "{}", leg: LEG, t: await mediaToken("secret") })), env)).status).toBe(400);
  });

  it("asks the provider once, then gives everyone the stored board", async () => {
    const { env, kv, providerCalls } = setup();
    const first = await ask(env, "2026-12-06T01:00:00Z");
    expect(first.state).toBe("fetched");
    expect(first.body.board?.target).toEqual({ kind: "depart", date: "2026-12-06", time: "13:20" });
    const again = await ask(env, "2026-12-06T02:00:00Z");
    expect(again).toEqual({ ...first, state: "stored" });
    expect(providerCalls()).toBe(1);
    expect(kv.get(MONTH_KEY)).toBe("1");
    // Names translated once, by the LLM the project number selects, for every later board.
    const translations = JSON.parse(kv.get("translations")!) as Record<string, Record<string, string>>;
    expect(Object.keys(translations)).toEqual(["projects/42/locations/global/models/general/translation-llm"]);
  });

  it("asks once when the day becomes tomorrow, and before then after a week", async () => {
    const { env, providerCalls } = setup();
    await ask(env, "2026-12-03T01:00:00Z");
    expect((await ask(env, "2026-12-04T01:00:00Z")).state).toBe("stored");
    // 10:00 on the 5th in Tokyo: the 6th is tomorrow.
    expect((await ask(env, "2026-12-05T01:00:00Z")).state).toBe("fetched");
    expect((await ask(env, "2026-12-05T13:30:00Z")).state).toBe("stored");
    expect((await ask(env, "2026-12-06T10:00:00Z")).state).toBe("stored");
    const later = trip("2026-12-20");
    await ask(env, "2026-12-05T01:00:00Z", later);
    expect((await ask(env, "2026-12-10T01:00:00Z", later)).state).toBe("stored");
    expect(providerCalls()).toBe(3);
  });

  it("stops asking NAVITIME when the month's share is spent, and serves what it has", async () => {
    const { env, kv, providerCalls } = setup();
    await ask(env, "2026-12-03T01:00:00Z");
    forgetGuardMemory();
    kv.set(MONTH_KEY, String(NAVITIME_MONTHLY_REQUESTS));
    const stale = await ask(env, "2026-12-06T01:00:00Z");
    expect(stale.state).toBe("stale");
    expect(stale.body.board?.options.length).toBeGreaterThan(0);
    expect((await ask(env, "2026-12-06T01:00:00Z", trip("2026-12-07"))).body.board).toBeNull();
    expect(providerCalls()).toBe(1);
  });

  it("keeps no board from a 503, and doesn't ask for that leg again for an hour", async () => {
    const { env, kv, providerCalls } = setup(() => new Response("busy", { status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ask(env, "2026-12-06T01:00:00Z")).toEqual({ state: "none", body: { board: null } });
    expect(keptBoards(kv)).toHaveLength(0);
    expect(await ask(env, "2026-12-06T01:30:00Z")).toEqual({ state: "none", body: { board: null } });
    expect(await ask(env, "2026-12-06T01:59:59Z")).toEqual({ state: "none", body: { board: null } });
    expect(providerCalls()).toBe(1);
    await ask(env, "2026-12-06T02:00:00Z");
    expect(providerCalls()).toBe(2);
  });

  it("serves the old board, without asking, while a rebuild's failure is remembered", async () => {
    const { env, fetchMock, providerCalls } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await ask(env, "2026-12-03T01:00:00Z");
    fetchMock.mockImplementation(async () => { throw new Error("timed out"); });
    // On the day, last week's board is old: one rebuild, which fails; then the old board, unasked.
    expect((await ask(env, "2026-12-06T14:00:00Z")).state).toBe("stale");
    const again = await ask(env, "2026-12-06T14:30:00Z");
    expect(again.state).toBe("stale");
    expect(again.body.board?.options.length).toBeGreaterThan(0);
    expect(providerCalls()).toBe(2);
  });

  it("stops asking NAVITIME for the hour after a 429", async () => {
    const { env } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    await ask(env, "2026-12-06T01:00:00Z");
    await ask(env, "2026-12-07T01:05:00Z", trip("2026-12-07"));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a leg the stored trip doesn't have, and builds the trip's question, not the caller's", async () => {
    const { env, kv, fetchMock } = setup();
    await ask(env, "2026-12-06T01:00:00Z", trip(), "nrt>elsewhere");
    expect(fetchMock).not.toHaveBeenCalled();
    // A question for other coordinates, on the trip's leg: the trip's own question is built and kept.
    const forged = { ...question(trip()), to: { ...question(trip()).to, latitude: 48.85, longitude: 2.35 } };
    await ask(env, "2026-12-06T01:00:00Z", trip(), LEG, forged);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("goal=35.696445%2C139.705724");
    expect((await ask(env, "2026-12-06T02:00:00Z")).state).toBe("stored");
    expect([...kv.keys()].filter((key) => key.startsWith("boards/"))).toHaveLength(1);
  });

  it("serves an old app shell's question from KV only, never building", async () => {
    const { env, providerCalls } = setup();
    expect(await ask(env, "2026-12-06T01:00:00Z", trip(), null)).toEqual({ state: "none", body: { board: null } });
    await ask(env, "2026-12-03T01:00:00Z");
    expect((await ask(env, "2026-12-03T02:00:00Z", trip(), null)).state).toBe("stored");
    expect((await ask(env, "2026-12-06T14:00:00Z", trip(), null)).state).toBe("stale");
    expect(providerCalls()).toBe(1);
  });

  it("serves the board it paid for when KV won't keep it", async () => {
    const { env, providerCalls } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    env.TRIP.put.mockImplementation(async (key: string) => {
      if (key.startsWith("boards/") || key === "translations") throw new Error("KV write limit");
    });
    const answer = await ask(env, "2026-12-06T01:00:00Z");
    expect(answer.state).toBe("fetched");
    expect(answer.body.board?.options.length).toBeGreaterThan(0);
    expect(providerCalls()).toBe(1);
  });

  it("never builds a past day's board, even with nothing kept", async () => {
    const { env, fetchMock } = setup();
    expect(await ask(env, "2026-12-07T01:00:00Z")).toEqual({ state: "none", body: { board: null } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a build under waitUntil when the runtime gives one", async () => {
    const { env, kv } = setup();
    const defer = vi.fn();
    const params = new URLSearchParams({ q: JSON.stringify(question(trip())), leg: LEG });
    await liveBoard(params, env, createGuard(env.TRIP), async () => trip(), new Date("2026-12-06T01:00:00Z"), defer);
    expect(defer).toHaveBeenCalledTimes(1);
    await Promise.all(defer.mock.calls.map(([work]) => work));
    expect(keptBoards(kv)).toHaveLength(1);
  });

  it("makes one request for two travellers missing the same board at once", async () => {
    const { env, providerCalls } = setup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(navitime);
    });
    const both = await Promise.all([ask(env, "2026-12-06T01:00:00Z"), ask(env, "2026-12-06T01:00:00Z")]);
    expect(both.map((answer) => answer.state)).toEqual(["fetched", "fetched"]);
    expect(providerCalls()).toBe(1);
  });
});
