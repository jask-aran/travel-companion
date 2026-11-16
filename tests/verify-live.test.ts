import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";

vi.mock("../packages/trip-brief/src/index.js", () => ({
  tripBrief: () => "TRIP",
  tripOverview: (bundle: TripBundle) => `OVERVIEW ${bundle.trip.title}`,
  tripBookings: () => "BOOKINGS",
  dayBrief: () => undefined,
  tripDates: () => [],
}));

import worker from "../workers/refresh/index.js";
import { resetMcpState } from "../workers/refresh/mcp.js";
import { encryptTrip } from "../apps/web/src/lib/trip-crypto.js";
import { verifyLive, type Check } from "../scripts/verify-live.js";

const PASS = "local-secret";
const SITE = "https://example.test/trip/";
const bundle = {
  schemaVersion: 1, tripId: "t", revision: "r", generatedAt: "2026-01-01T00:00:00Z",
  trip: { title: "Synthetic", startDate: "2026-12-01", endDate: "2026-12-01" },
  days: [], routeLegs: {},
  places: { p: { id: "p", name: "Somewhere", photo: { name: "places/abc/photos/def" } } },
};

async function run(serverSecret: string | undefined, photos = true, connectorOnly = false): Promise<Record<string, Check>> {
  const trip = JSON.stringify(await encryptTrip(JSON.stringify(bundle), serverSecret ?? PASS));
  const assets: Record<string, [string, string]> = connectorOnly ? {} : {
    "/trip/": ["<html></html>", "text/html"],
    "/trip/manifest.webmanifest": ["{}", "application/manifest+json"],
    "/trip/sw.js": ["", "text/javascript"],
  };
  const env = {
    ASSETS: { fetch: async (request: Request) => {
      const asset = assets[new URL(request.url).pathname];
      return new Response(asset?.[0] ?? "<html></html>", { status: asset ? 200 : 404, headers: { "content-type": asset?.[1] ?? "text/html" } });
    } },
    // A recent check-at keeps the idle refresh from pulling Wanderlog.
    TRIP: { get: async (key: string) => (key === "trip.enc" ? trip : new Date().toISOString()), put: async () => {} },
    MEDIA: { get: async () => ({ body: new Response("img").body!, httpMetadata: { contentType: "image/jpeg" } }), put: async () => {} },
    PUBLIC_ID: "t",
    WANDERLOG_TRIP_ID: "w",
    TRIP_PASSPHRASE: serverSecret,
    GOOGLE_MAPS_API_KEY: "k",
  };
  const fetch = (async (input: string, init?: RequestInit) => worker.fetch(new Request(input, init), env as never)) as typeof globalThis.fetch;
  const checks = await verifyLive({ site: SITE, passphrase: PASS, connectorOnly, mediaBucket: photos, googleKey: photos, fetch });
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

beforeEach(() => resetMcpState());

describe("verifyLive", () => {
  it("passes a working deployment", async () => {
    const checks = await run(PASS);
    expect(Object.values(checks).map((check) => check.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
    expect(checks.Google?.reason).toBe("0 of 300 requests today. Never refused.");
  });

  it("names a server secret that differs from the local passphrase", async () => {
    const checks = await run("other-secret");
    expect(checks.Connector).toMatchObject({ status: "fail", reason: expect.stringContaining("differs") });
    expect(checks.Trip).toMatchObject({ status: "fail", reason: expect.stringContaining("differs from your local one") });
    expect(checks.Photos?.status).toBe("skipped");
    for (const check of Object.values(checks)) expect(check.reason).not.toContain(PASS);
  });

  it("names a missing secret from the 503", async () => {
    const checks = await run(undefined);
    expect(checks.Connector).toMatchObject({ status: "fail", reason: expect.stringContaining("secret is missing") });
    expect(checks["Refresh route"]?.status).toBe("fail");
  });

  it("skips photos when they are not configured", async () => {
    expect((await run(PASS, false)).Photos).toMatchObject({ status: "skipped", reason: expect.stringContaining("Not configured") });
  });

  it("checks only the connector and refresh route for a connector-only deployment", async () => {
    const checks = await run(PASS, false, true);
    expect(Object.keys(checks)).toEqual(["Connector", "Refresh route", "Photos"]);
    expect(checks.Connector?.status).toBe("pass");
    expect(checks["Refresh route"]?.status).toBe("pass");
  });
});
