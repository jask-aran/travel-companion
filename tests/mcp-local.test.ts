import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalMcp } from "../scripts/mcp-local.js";
import { resetMcpState } from "../workers/refresh/mcp.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-local-"));
const bundlePath = join(dir, "working.json");
const bundle = (title: string) => ({
  schemaVersion: 1, tripId: "trip", revision: "r", generatedAt: "2026-01-01T00:00:00.000Z",
  trip: { title, startDate: "2026-03-02", endDate: "2026-03-02" },
  days: [{ id: "day-2026-03-02", date: "2026-03-02", title: "Somewhere", timezone: "Asia/Tokyo",
    items: [{ id: "i1", type: "place", placeId: "p1" }], map: { orderedPlaceIds: ["p1"], routeLegIds: [] } }],
  places: { p1: { id: "p1", name: "Harbour Market" } },
  routeLegs: {},
});

let server: Server;
let port = 0;
beforeAll(async () => {
  resetMcpState();
  writeFileSync(bundlePath, JSON.stringify(bundle("Synthetic Trip")));
  server = await startLocalMcp({ port: 0, bundlePath });
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, params?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() as Record<string, any> : undefined };
};

describe("local connector over HTTP", () => {
  it("listens on loopback only", () => {
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("initializes, lists tools and answers a tool call from the bundle on disk", async () => {
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body!.result.serverInfo.name).toBe("trip-companion");

    const list = await call("tools/list");
    expect(list.body!.result.tools.map((tool: { name: string }) => tool.name)).toContain("get_trip");

    const trip = await call("tools/call", { name: "get_trip", arguments: {} });
    expect(trip.body!.result.content[0].text).toContain("Synthetic Trip");

    // A new pull shows without a restart.
    writeFileSync(bundlePath, JSON.stringify(bundle("Pulled Again")));
    const again = await call("tools/call", { name: "get_trip", arguments: {} });
    expect(again.body!.result.content[0].text).toContain("Pulled Again");
  });

  it("answers nothing but /mcp", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/other`, { method: "POST" })).status).toBe(404);
  });

  it("refuses a request addressed to another host name (DNS rebinding)", async () => {
    const status = await new Promise<number>((done) => {
      const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example" } }, (res) => done(res.statusCode ?? 0));
      req.end("{}");
    });
    expect(status).toBe(404);
  });
});
