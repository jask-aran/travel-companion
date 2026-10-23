import { parseTripBundle, type TripBundle } from "../../packages/trip-schema/src/index.js";
import { parseWanderlogSource } from "../../packages/wanderlog-import/src/index.js";
import { attachPlaceDetails } from "../../packages/trip-normaliser/src/place-details.js";
import { normaliseCompleteWanderlog } from "../../packages/trip-normaliser/src/complete.js";
import { decryptTrip, encryptTrip, type EncryptedPayload } from "../../apps/web/src/lib/trip-crypto.js";
import { MEDIA_ROUTES, mediaToken, mediaUpstream } from "../../apps/web/src/lib/media.js";
import { departureTargets } from "../../apps/web/src/lib/departure-targets.js";

/**
 * Pages advanced-mode worker. Static files still come from the deployment.
 * The encrypted trip lives in KV so a phone can replace it without a Vite build.
 *
 * Google photo names are copied from the previous payload. Refetching them
 * would be one subrequest per place and can kill the invocation on the free
 * plan. A local `pnpm ship` still refreshes photos.
 *
 * Departure boards are carried the same way, for every leg that still
 * exists: NAVITIME's plan counts each request, and a phone tap must not
 * spend it. A board keeps its own target time, so a moved stop shows what it
 * was fetched for until the next local pull.
 */

const OBJECT_KEY = "trip.enc";
const MAX_SOURCE_BYTES = 8_000_000;

type TripStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
};

type RefreshEnv = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  TRIP: TripStore;
  PUBLIC_ID: string;
  WANDERLOG_TRIP_ID?: string;
  TRIP_PASSPHRASE?: string;
  /** Server-side only: photos and maps are fetched with it here (media.ts). */
  GOOGLE_MAPS_API_KEY?: string;
};

function tokenMatches(presented: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(presented);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length);
  let difference = left.length === right.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function carryPhotos(next: TripBundle, previous: TripBundle | undefined): number {
  if (!previous) return 0;
  let copied = 0;
  for (const [id, place] of Object.entries(next.places)) {
    const photo = previous.places[id]?.photo;
    if (!photo || place.photo) continue;
    place.photo = photo;
    copied += 1;
  }
  return copied;
}

function carryDepartures(next: TripBundle, previous: TripBundle | undefined): number {
  if (!previous?.departures) return 0;
  // Every leg that still gets a board, including the airport transfers the
  // app adds where Wanderlog has no leg (a flight's airports aren't stops).
  const legs = new Set([
    ...Object.values(next.routeLegs).map((leg) => `${leg.fromPlaceId}>${leg.toPlaceId}`),
    ...departureTargets(next).map((target) => target.key),
  ]);
  const kept = Object.entries(previous.departures).filter(([key]) => legs.has(key));
  if (kept.length) next.departures = Object.fromEntries(kept);
  return kept.length;
}

/**
 * `revision` hashes the raw Wanderlog response, which can shift without a
 * real edit, and `generatedAt` always does. Everything else is what the
 * app renders, so equal content means there is nothing to write.
 */
function sameTrip(next: TripBundle, previous: TripBundle): boolean {
  const content = ({ revision: _revision, generatedAt: _generatedAt, ...rest }: TripBundle) =>
    JSON.stringify(rest);
  return content(next) === content(previous);
}

async function previousBundle(env: RefreshEnv, passphrase: string): Promise<TripBundle | undefined> {
  const existing = await env.TRIP.get(OBJECT_KEY);
  if (!existing) return undefined;
  try {
    const payload = JSON.parse(existing) as EncryptedPayload;
    return parseTripBundle(JSON.parse(await decryptTrip(payload, passphrase)));
  } catch {
    return undefined;
  }
}

async function refresh(request: Request, env: RefreshEnv): Promise<Response> {
  const tripId = env.WANDERLOG_TRIP_ID;
  const passphrase = env.TRIP_PASSPHRASE;
  if (!tripId || !passphrase) {
    return Response.json({ error: "Refresh is not configured" }, { status: 503 });
  }
  if (!tokenMatches(bearer(request), passphrase)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const upstream = await fetch(
    `https://wanderlog.com/api/tripPlans/${encodeURIComponent(tripId)}?clientSchemaVersion=2`,
  );
  if (!upstream.ok) {
    return Response.json(
      { error: `Wanderlog returned ${upstream.status}` },
      { status: 502 },
    );
  }
  const sourceBytes = await upstream.arrayBuffer();
  if (sourceBytes.byteLength > MAX_SOURCE_BYTES) {
    return Response.json({ error: "Wanderlog response was too large" }, { status: 502 });
  }
  const sourceText = new TextDecoder().decode(sourceBytes);
  const parsed = parseWanderlogSource(sourceText);
  const result = normaliseCompleteWanderlog(parsed.data, {
    sourceKind: parsed.kind,
    sourceText,
    generatedAt: new Date().toISOString(),
  });
  result.bundle.tripId = env.PUBLIC_ID;
  const detailCount = attachPlaceDetails(result.bundle, parsed.data);
  const previous = await previousBundle(env, passphrase);
  const photosCopied = carryPhotos(result.bundle, previous);
  const departuresCopied = carryDepartures(result.bundle, previous);
  const bundle = parseTripBundle(result.bundle);
  if (previous && sameTrip(bundle, previous)) {
    console.log(JSON.stringify({ message: "trip unchanged" }));
    return Response.json({ ok: true, changed: false });
  }
  const encrypted = await encryptTrip(JSON.stringify(bundle, null, 2) + "\n", passphrase);
  await env.TRIP.put(OBJECT_KEY, JSON.stringify(encrypted) + "\n");

  console.log(JSON.stringify({
    message: "trip refreshed",
    days: result.report.counts.days,
    items: result.report.counts.items,
    places: result.report.counts.places,
    details: detailCount,
    photosCopied,
    departuresCopied,
  }));

  return Response.json({
    ok: true,
    changed: true,
    days: result.report.counts.days,
    items: result.report.counts.items,
    places: result.report.counts.places,
    photosCopied,
  });
}

/**
 * The service worker decides which build every other file comes from, so a
 * cached copy pins a device to an old app. It gets `no-store`: the zone's
 * Browser Cache TTL rewrote `no-cache` on it into a 4 h max-age. HTML only
 * has to revalidate. Hashed assets keep whatever Pages sends.
 */
const WORKER_SCRIPTS = /\/(sw|workbox-[^/]+)\.js$/;

function cacheControlFor(pathname: string, response: Response): string | undefined {
  if (WORKER_SCRIPTS.test(pathname)) return "no-store, must-revalidate";
  if ((response.headers.get("content-type") ?? "").startsWith("text/html")) return "no-cache";
  return undefined;
}

async function fromAssets(request: Request, env: RefreshEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const cacheControl = cacheControlFor(new URL(request.url).pathname, response);
  if (!cacheControl) return response;
  const headed = new Response(response.body, response);
  headed.headers.set("cache-control", cacheControl);
  return headed;
}

/**
 * A place photo or street map from Google, with the key added here so it
 * never ships to the browser. Only for a caller who can open the trip (the
 * token is a hash of the passphrase), and only photos and maps of a point,
 * so the key can't be spent on anything else. Not stored at the edge:
 * Google's terms forbid re-hosting photos.
 */
async function media(route: string, url: URL, env: RefreshEnv): Promise<Response> {
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  const passphrase = env.TRIP_PASSPHRASE;
  if (!apiKey || !passphrase) return new Response(null, { status: 503 });
  if (!tokenMatches(url.searchParams.get("t") ?? "", await mediaToken(passphrase))) {
    return new Response(null, { status: 401 });
  }
  const upstream = mediaUpstream(route, url.searchParams, apiKey);
  if (!upstream) return new Response(null, { status: 404 });
  const response = await fetch(upstream);
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": response.ok ? "private, max-age=86400" : "no-store",
    },
  });
}

function isTripPayload(pathname: string): boolean {
  return pathname.endsWith("/trip.enc");
}

async function handle(request: Request, env: RefreshEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname.endsWith("/api/refresh")) {
    return refresh(request, env);
  }
  const route = Object.values(MEDIA_ROUTES).find((name) => url.pathname.endsWith(`/${name}`));
  if (request.method === "GET" && route) return media(route, url, env);
  if ((request.method === "GET" || request.method === "HEAD") && isTripPayload(url.pathname)) {
    try {
      const body = await env.TRIP.get(OBJECT_KEY);
      if (body) {
        return new Response(request.method === "HEAD" ? null : body, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-cache",
          },
        });
      }
    } catch (error) {
      console.error(JSON.stringify({ message: "trip object unreadable", error: String(error) }));
    }
  }
  return fromAssets(request, env);
}

export default {
  async fetch(request: Request, env: RefreshEnv): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(JSON.stringify({ message: "refresh worker failed", error: String(error) }));
      if (request.method === "GET" || request.method === "HEAD") return env.ASSETS.fetch(request);
      return Response.json({ error: "Refresh failed" }, { status: 500 });
    }
  },
};
