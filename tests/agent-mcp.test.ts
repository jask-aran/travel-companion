import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";

// The renderer belongs to packages/trip-brief; these tests stand in for it.
vi.mock("../packages/trip-brief/src/index.js", () => ({
  tripBrief: (bundle: TripBundle) => `TRIP ${bundle.trip.title}: ${bundle.days.map((day) => day.date).join(" ")}`,
  tripOverview: (bundle: TripBundle) => `OVERVIEW ${bundle.trip.title}`,
  tripBookings: (bundle: TripBundle) => `BOOKINGS ${bundle.trip.title}`,
  dayBrief: (bundle: TripBundle, date: string, through?: string) =>
    bundle.days.some((day) => day.date === date) ? `DAY ${date}${through ? ` THROUGH ${through}` : ""}` : undefined,
  tripDates: (bundle: TripBundle) => bundle.days.map((day) => day.date),
}));

import worker from "../workers/refresh/index.js";
import { AGENT_LIMIT, WRONG_TOKEN_LIMIT, resetMcpState } from "../workers/refresh/mcp.js";
import { agentLink, agentToken } from "../apps/web/src/lib/agent-link.js";
import { mediaToken } from "../apps/web/src/lib/media.js";
import { encryptTrip } from "../apps/web/src/lib/trip-crypto.js";

const PASS = "secret";
const day = (date: string) => ({
  id: date, date, title: date, timezone: "Asia/Tokyo", items: [],
  map: { orderedPlaceIds: [], routeLegIds: [] },
});
const bundle = (title: string) => ({
  schemaVersion: 1, tripId: "t", revision: "r", generatedAt: "2026-01-01T00:00:00Z",
  trip: { title, startDate: "2026-12-01", endDate: "2026-12-02" },
  days: [day("2026-12-01"), day("2026-12-02")], places: {}, routeLegs: {},
});
const cipher = async (title: string) => JSON.stringify(await encryptTrip(JSON.stringify(bundle(title)), PASS));

function setup(kvTrip: string | null, assetTrip?: string) {
  const env = {
    ASSETS: { fetch: vi.fn(async (request: Request) =>
      assetTrip && new URL(request.url).pathname === "/japankorea2026/trip.enc"
        ? new Response(assetTrip)
        : new Response("<html>shell</html>", { status: 404, headers: { "content-type": "text/html" } })) },
    TRIP: { get: vi.fn(async () => kvTrip), put: async () => {} },
    MEDIA: { get: async () => null, put: async () => {} },
    PUBLIC_ID: "t",
    TRIP_PASSPHRASE: PASS,
  };
  return env;
}

type Env = ReturnType<typeof setup>;
const url = async (token?: string) =>
  agentLink("https://example.test/japankorea2026/", token ?? await agentToken(PASS));

async function post(env: Env, body: unknown, headers: Record<string, string> = {}, token?: string) {
  return worker.fetch(new Request(await url(token), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  }), env as never);
}
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });
const legacy = { "mcp-protocol-version": "2025-06-18" };
type ToolResult = { result: { content: { text: string }[]; isError?: boolean } };
const tool = async (env: Env, name: string, args: Record<string, unknown> = {}) =>
  ((await (await post(env, rpc("tools/call", { name, arguments: args }), legacy)).json()) as ToolResult).result;

beforeEach(() => resetMcpState());
afterEach(() => vi.restoreAllMocks());

describe("agent link", () => {
  it("is a different, full-length token from the media token", async () => {
    const token = await agentToken(PASS);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(await mediaToken(PASS));
    expect(agentLink("https://x.test/a", "tok")).toBe("https://x.test/a/mcp/tok");
    expect(agentLink("https://x.test/a/", "tok")).toBe("https://x.test/a/mcp/tok");
  });
});

describe("MCP endpoint", () => {
  it("answers a wrong token with a bare 401 and no MCP", async () => {
    const env = setup(await cipher("A"));
    const response = await post(env, rpc("initialize", {}), {}, await mediaToken(PASS));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(env.TRIP.get).not.toHaveBeenCalled();
  });

  it("is 503 without the secret", async () => {
    const env = { ...setup(null), TRIP_PASSPHRASE: undefined };
    expect((await post(env as never, rpc("ping"))).status).toBe(503);
  });

  it("initializes, negotiating the version", async () => {
    const env = setup(null);
    const response = await post(env, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    const { result } = await response.json() as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo.name).toBe("trip-companion");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    const unknown = await post(env, rpc("initialize", { protocolVersion: "1999-01-01" }));
    expect((await unknown.json() as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");
  });

  it("answers a notification, GET, ping and an unknown method", async () => {
    const env = setup(null);
    const note = await post(env, { jsonrpc: "2.0", method: "notifications/initialized" }, legacy);
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const get = await worker.fetch(new Request(await url()), env as never);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(await (await post(env, rpc("ping"), legacy)).json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const unknown = await (await post(env, rpc("resources/list"), legacy)).json() as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
  });

  it("lists four read-only tools, overview first", async () => {
    const { result } = await (await post(setup(null), rpc("tools/list"), legacy)).json() as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    expect(result.tools.map((tool) => tool.name)).toEqual(["get_overview", "get_bookings", "get_day", "get_trip"]);
    expect(result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  });

  it("reads the trip from KV, once per ciphertext", async () => {
    const env = setup(await cipher("From KV"));
    expect(await tool(env, "get_trip")).toEqual({ content: [{ type: "text", text: "TRIP From KV: 2026-12-01 2026-12-02" }] });
    expect((await tool(env, "get_overview")).content[0]?.text).toBe("OVERVIEW From KV");
    expect((await tool(env, "get_bookings")).content[0]?.text).toBe("BOOKINGS From KV");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("falls back to the static trip.enc", async () => {
    const env = setup(null, await cipher("From assets"));
    expect((await tool(env, "get_trip")).content[0]?.text).toBe("TRIP From assets: 2026-12-01 2026-12-02");
  });

  it("gives a day or a run of days, or a tool error listing the dates", async () => {
    const env = setup(await cipher("A"));
    expect(await tool(env, "get_day", { date: "2026-12-02" })).toEqual({ content: [{ type: "text", text: "DAY 2026-12-02" }] });
    expect((await tool(env, "get_day", { date: "2026-12-01", through: "2026-12-02" })).content[0]?.text)
      .toBe("DAY 2026-12-01 THROUGH 2026-12-02");
    for (const args of [{ date: "2027-01-01" }, { date: "2026-12-01", through: "2027-01-01" }, { date: "2026-12-01", through: 5 }]) {
      const bad = await tool(env, "get_day", args);
      expect(bad.isError).toBe(true);
      expect(bad.content[0]?.text).toContain("2026-12-01, 2026-12-02");
    }
    const backwards = await tool(env, "get_day", { date: "2026-12-02", through: "2026-12-01" });
    expect(backwards.isError).toBe(true);
    expect(backwards.content[0]?.text).toContain("before");
  });

  it("serves a modern (2026-07-28) request and checks its mirrored headers", async () => {
    const env = setup(null);
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    const headers = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" };
    const ok = await (await post(env, rpc("tools/list", meta), headers)).json() as { result: { resultType: string } };
    expect(ok.result.resultType).toBe("complete");
    const mismatch = await post(env, rpc("tools/list", meta), { ...headers, "mcp-method": "ping" });
    expect(mismatch.status).toBe(400);
    const unsupported = await post(env, rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01" } }), { ...headers, "mcp-protocol-version": "2030-01-01" });
    expect(((await unsupported.json()) as { error: { code: number } }).error.code).toBe(-32022);
  });

  it("never falls through to the HTML shell on a fault", async () => {
    const env = setup(null);
    env.TRIP.get = vi.fn(async () => { throw new Error("kv down"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post(env, rpc("tools/call", { name: "get_trip", arguments: {} }), legacy);
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32603);
  });

  it("returns 429 with retry-after over either limit", async () => {
    const env = setup(null);
    for (let index = 0; index < AGENT_LIMIT.requests; index += 1) {
      expect((await post(env, rpc("ping"), legacy)).status).toBe(200);
    }
    const limited = await post(env, rpc("ping"), legacy);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    resetMcpState();
    const probe = { "cf-connecting-ip": "203.0.113.9" };
    for (let index = 0; index < WRONG_TOKEN_LIMIT.requests; index += 1) {
      expect((await post(env, rpc("ping"), probe, "wrong")).status).toBe(401);
    }
    expect((await post(env, rpc("ping"), probe, "wrong")).status).toBe(429);
    // Another address, and the real token from the same address, are unaffected.
    expect((await post(env, rpc("ping"), { "cf-connecting-ip": "203.0.113.10" }, "wrong")).status).toBe(401);
    expect((await post(env, rpc("ping"), { ...legacy, ...probe })).status).toBe(200);
  });
});
