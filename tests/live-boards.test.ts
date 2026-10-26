import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../workers/refresh/index.js";
import { LIVE_NAVITIME_MONTHLY, liveBoard } from "../workers/refresh/live-boards.js";
import { mediaToken } from "../apps/web/src/lib/media.js";
import type { BoardQuestion } from "../apps/web/src/lib/departures-api.js";

const navitime = readFileSync(new URL("./fixtures/navitime-narita-shinjuku.json", import.meta.url), "utf8");

/** Narita to Shinjuku on 6 Dec, as the app asks it. */
const question = (date = "2026-12-06"): BoardQuestion => ({
  provider: "navitime",
  kind: "depart",
  date,
  time: "13:20",
  from: { id: "nrt", name: "Narita Airport Terminal 1", latitude: 35.7647, longitude: 140.3864, timeZone: "Asia/Tokyo" },
  to: { id: "shinjuku", name: "Shinjuku Station", latitude: 35.696445, longitude: 139.705724, timeZone: "Asia/Tokyo" },
  estimateSeconds: 5400,
});

function setup(upstream: (url: string) => Response = () => new Response(navitime)) {
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

const ask = async (env: ReturnType<typeof setup>["env"], at: string, q = question()) => {
  const response = await liveBoard(JSON.stringify(q), env, new Date(at));
  return { state: response.headers.get("x-board"), body: (await response.json()) as { board: { options: unknown[]; target: unknown } | null } };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live departure boards in the worker", () => {
  it("answers only a trip token holder, and only a question", async () => {
    const { env } = setup();
    const url = (params: Record<string, string>) => `https://example.test/japankorea2026/api/departures?${new URLSearchParams(params)}`;
    expect((await worker.fetch(new Request(url({ q: JSON.stringify(question()) })), env)).status).toBe(401);
    const t = await mediaToken("secret");
    expect((await worker.fetch(new Request(url({ q: "{}", t })), env)).status).toBe(400);
    const response = await worker.fetch(new Request(url({ q: JSON.stringify(question()), t })), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-board")).toBe("fetched");
  });

  it("asks the provider once, then gives everyone the stored board", async () => {
    const { env, kv, providerCalls } = setup();
    const first = await ask(env, "2026-12-06T01:00:00Z");
    expect(first.state).toBe("fetched");
    expect(first.body.board?.options.length).toBeGreaterThan(0);
    expect(first.body.board?.target).toEqual({ kind: "depart", date: "2026-12-06", time: "13:20" });
    const again = await ask(env, "2026-12-06T02:00:00Z");
    expect(again).toEqual({ ...first, state: "stored" });
    expect(providerCalls()).toBe(1);
    expect(kv.get("navitime/2026-12")).toBe("1");
    // Names translated once, by the LLM the project number selects, for every later board.
    const translations = JSON.parse(kv.get("translations")!) as Record<string, Record<string, string>>;
    expect(Object.keys(translations)).toEqual(["projects/42/locations/global/models/general/translation-llm"]);
  });

  it("asks again after half a day for today and tomorrow, after a week for later", async () => {
    const { env, providerCalls } = setup();
    await ask(env, "2026-12-05T01:00:00Z");
    expect((await ask(env, "2026-12-05T12:00:00Z")).state).toBe("stored");
    expect((await ask(env, "2026-12-05T13:30:00Z")).state).toBe("fetched");
    const later = question("2026-12-20");
    await ask(env, "2026-12-05T01:00:00Z", later);
    expect((await ask(env, "2026-12-10T01:00:00Z", later)).state).toBe("stored");
    expect(providerCalls()).toBe(3);
  });

  it("stops asking NAVITIME when the month's share is spent, and serves what it has", async () => {
    const { env, kv, providerCalls } = setup();
    await ask(env, "2026-12-05T01:00:00Z");
    kv.set("navitime/2026-12", String(LIVE_NAVITIME_MONTHLY));
    const stale = await ask(env, "2026-12-06T01:00:00Z");
    expect(stale.state).toBe("stale");
    expect(stale.body.board?.options.length).toBeGreaterThan(0);
    expect((await ask(env, "2026-12-06T01:00:00Z", question("2026-12-07"))).body.board).toBeNull();
    expect(providerCalls()).toBe(1);
  });

  it("keeps nothing from a failed ask, so the next one tries again", async () => {
    const { env, kv, providerCalls } = setup(() => new Response("busy", { status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ask(env, "2026-12-06T01:00:00Z")).toEqual({ state: "none", body: { board: null } });
    expect([...kv.keys()].some((key) => key.startsWith("boards/"))).toBe(false);
    await ask(env, "2026-12-06T01:05:00Z");
    expect(providerCalls()).toBe(2);
  });
});
