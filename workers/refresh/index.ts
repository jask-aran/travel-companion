import { parseTripBundle, type TripBundle } from "../../packages/trip-schema/src/index.js";
import { parseWanderlogSource } from "../../packages/wanderlog-import/src/index.js";
import { attachPlaceDetails } from "../../packages/trip-normaliser/src/place-details.js";
import { normaliseCompleteWanderlog } from "../../packages/trip-normaliser/src/complete.js";
import { encryptTrip } from "../../apps/web/src/lib/trip-crypto.js";
import { MEDIA_ROUTES, STATUS_ROUTE, mediaToken } from "../../apps/web/src/lib/media.js";
import { departureTargets } from "../../apps/web/src/lib/departure-targets.js";
import { DEPARTURES_ROUTE } from "../../apps/web/src/lib/departures-api.js";
import { AGENT_ROUTE, agentToken } from "../../apps/web/src/lib/agent-link.js";
import { needsTranslation } from "../../packages/trip-normaliser/src/line-names.js";
import { liveBoard, translateStored, type LiveBoardEnv } from "./live-boards.js";
import { boardSession, connectorBoards } from "./connector-boards.js";
import { createGuard, guardStatus, type Defer, type Guard } from "./guard.js";
import { map, photo, type MediaStore } from "./media-routes.js";
import { OBJECT_KEY, storedCiphertext, storedTrip } from "./stored-trip.js";
import {
  AGENT_LIMIT,
  WRONG_TOKEN_LIMIT,
  handleMcp,
  mcpFailure,
  openTrip,
  retryAfterSeconds,
  takeToken,
} from "./mcp.js";

/**
 * Pages advanced-mode worker. The encrypted trip lives in KV so a phone can
 * replace it without a build.
 *
 * A refresh copies photo names and departure boards from the previous payload
 * (KV's, else the shipped file's): refetching costs a subrequest per place
 * (fatal on the free plan) and NAVITIME counts each request. What a refresh
 * can't carry is fetched when it is asked for, for the stored trip's own
 * places and legs only: a photo by its place (`api/photo?place=`), a map by
 * its place (`api/map`), a board by its leg (`api/departures?leg=`, and the
 * connector's get_day). Every Google and NAVITIME request goes through one
 * guard per invocation (guard.ts): a breaker, a budget per provider, a
 * timeout. Each paid fetch-and-store runs under the runtime's `waitUntil`,
 * so what was paid for is kept even if the caller goes away.
 */

const MAX_SOURCE_BYTES = 8_000_000;

type TripStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
};

type RefreshEnv = LiveBoardEnv & {
  ASSETS: { fetch(request: Request): Promise<Response> };
  TRIP: TripStore;
  /** Optional: without it photo and map requests get 503. */
  MEDIA?: MediaStore;
  PUBLIC_ID: string;
  WANDERLOG_TRIP_ID?: string;
  TRIP_PASSPHRASE?: string;
  /** Server-side only: photos and maps are fetched with it here (media.ts). */
  GOOGLE_MAPS_API_KEY?: string;
};

/** The part of the runtime's execution context this uses; absent in Node (tests, the local connector). */
type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void };

/** One request's worth of state. */
type Invocation = {
  env: RefreshEnv;
  guard: Guard;
  /** The shipped `trip.enc` beside the app, for when KV has none. */
  tripAsset: string;
  /** Wanderlog was pulled in this invocation: never twice. */
  pulled: boolean;
  /** KV's check time was read in this invocation (it is in `lastChecked`): never twice. */
  checkedRead: boolean;
  /** Keeps paid work running after the response. */
  defer: Defer;
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
    // A town translated at an earlier pull stays translated (see englishLocalities).
    const locality = previous.places[id]?.locality;
    const translated = (text: string) => !/[^\x00-\x7F]/.test(text);
    if (locality && place.locality && translated(locality) && !translated(place.locality)) {
      place.locality = locality;
    }
    const photo = previous.places[id]?.photo;
    if (!photo || place.photo) continue;
    place.photo = photo;
    copied += 1;
  }
  return copied;
}

/** Town names sent in one pull: one Translation request. The rest wait for the next pull. */
const LOCALITIES_PER_PULL = 50;
const LOCALITY_TIMEOUT_MS = 3_000;

/**
 * Towns Google names only in Japanese or Korean (高山市), in English
 * ("Takayama", as the other towns read), from the stored translations or one
 * capped Translation request. Never fails the pull: on any fault, or without
 * a Google key, the names stay as given. Costs nothing when every town is
 * already in English; else a KV read, plus a Translation request and a KV
 * write when a name is new.
 */
async function englishLocalities(bundle: TripBundle, env: RefreshEnv, guard: Guard): Promise<number> {
  const local = Object.values(bundle.places).filter((place) => place.locality && needsTranslation(place.locality));
  if (!local.length) return 0;
  try {
    const { translations, report } = await translateStored(local.map((place) => place.locality!), env, guard, {
      limit: LOCALITIES_PER_PULL,
      signal: AbortSignal.timeout(LOCALITY_TIMEOUT_MS),
    });
    if (report?.failed) console.warn(JSON.stringify({ message: "locality translation failed", error: report.failed }));
    let translated = 0;
    for (const place of local) {
      const english = translations[place.locality!];
      if (!english) continue;
      place.locality = english.replace(/\s+City$/i, "");
      translated += 1;
    }
    return translated;
  } catch (error) {
    console.warn(JSON.stringify({ message: "locality translation failed", error: String(error) }));
    return 0;
  }
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

type PullResult =
  | { ok: true; changed: false; checkedRecently?: true }
  | { ok: true; changed: true; days: number; items: number; places: number; photosCopied: number }
  | { ok: false; error: string };

/**
 * Wanderlog's current plan, normalised and stored if it differs from the
 * stored trip (KV's, else the shipped file's, whose photo names and boards
 * are carried). Shared by the button (`api/refresh`), the hourly check and a
 * connector call with nothing stored.
 */
async function pullTrip(invocation: Invocation, tripId: string, passphrase: string): Promise<PullResult> {
  const { env } = invocation;
  invocation.pulled = true;
  // Marked before the pull: a slow or failing Wanderlog is then asked once an
  // hour by the idle check, not on every read.
  lastChecked = Date.now();
  await env.TRIP.put(CHECKED_KEY, new Date(lastChecked).toISOString());
  const upstream = await fetch(
    `https://wanderlog.com/api/tripPlans/${encodeURIComponent(tripId)}?clientSchemaVersion=2`,
    { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) },
  );
  if (!upstream.ok) return { ok: false, error: `Wanderlog returned ${upstream.status}` };
  const sourceBytes = await upstream.arrayBuffer();
  if (sourceBytes.byteLength > MAX_SOURCE_BYTES) {
    return { ok: false, error: "Wanderlog response was too large" };
  }
  const sourceText = new TextDecoder().decode(sourceBytes);
  const parsed = parseWanderlogSource(sourceText);
  const result = normaliseCompleteWanderlog(parsed.data, {
    sourceText,
    generatedAt: new Date().toISOString(),
  });
  result.bundle.tripId = env.PUBLIC_ID;
  const detailCount = attachPlaceDetails(result.bundle, parsed.data);
  const previous = await storedTrip(env, invocation.tripAsset, passphrase);
  const photosCopied = carryPhotos(result.bundle, previous);
  const departuresCopied = carryDepartures(result.bundle, previous);
  const localitiesTranslated = await englishLocalities(result.bundle, env, invocation.guard);
  const bundle = parseTripBundle(result.bundle);
  if (previous && sameTrip(bundle, previous)) {
    console.log(JSON.stringify({ message: "trip unchanged" }));
    return { ok: true, changed: false };
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
    localitiesTranslated,
  }));

  return {
    ok: true,
    changed: true,
    days: result.report.counts.days,
    items: result.report.counts.items,
    places: result.report.counts.places,
    photosCopied,
  };
}

/**
 * A press, or a connector call with no trip stored, this soon after the last
 * check (by anyone) pulls nothing: each pull writes the check time to KV,
 * whose free plan allows 1,000 writes a day, so pulls are at most 720 a day.
 */
export const REFRESH_GAP_MS = 2 * 60_000;

/** Whether anyone checked Wanderlog within `gapMs`; reads KV's check time at most once an invocation. */
async function checkedWithin(invocation: Invocation, gapMs: number): Promise<boolean> {
  if (Date.now() - lastChecked < gapMs) return true;
  if (!invocation.checkedRead) {
    invocation.checkedRead = true;
    const stored = Date.parse((await invocation.env.TRIP.get(CHECKED_KEY)) ?? "");
    if (Number.isFinite(stored)) lastChecked = Math.max(lastChecked, stored);
  }
  return Date.now() - lastChecked < gapMs;
}

async function refresh(request: Request, invocation: Invocation): Promise<Response> {
  const { env } = invocation;
  const tripId = env.WANDERLOG_TRIP_ID;
  const passphrase = env.TRIP_PASSPHRASE;
  if (!tripId || !passphrase) {
    return Response.json({ error: "Refresh is not configured" }, { status: 503 });
  }
  if (!tokenMatches(bearer(request), passphrase)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (await checkedWithin(invocation, REFRESH_GAP_MS)) {
    return Response.json({ ok: true, changed: false, checkedRecently: true } satisfies PullResult);
  }
  const result = await pullTrip(invocation, tripId, passphrase);
  if (!result.ok) return Response.json({ error: result.error }, { status: 502 });
  return Response.json(result);
}

/**
 * The idle check: a read of the trip pulls Wanderlog first when nobody has
 * for an hour. Pages has no timers, so reads are the only clock. Never fails
 * the read: on any fault the stored trip is served as it is.
 */
const CHECKED_KEY = "checked-at";
export const CHECK_EVERY_MS = 60 * 60_000;
/** Any pull waits this long for Wanderlog at most (a pull takes about 3 s). */
const PULL_TIMEOUT_MS = 10_000;
/** This isolate's last known check, so most reads skip the KV lookup. */
let lastChecked = 0;

/** Tests start each case with no memory of an earlier check. */
export function forgetLastCheck(): void {
  lastChecked = 0;
}

async function refreshIfIdle(invocation: Invocation): Promise<void> {
  const { env } = invocation;
  const tripId = env.WANDERLOG_TRIP_ID;
  const passphrase = env.TRIP_PASSPHRASE;
  if (!tripId || !passphrase) return;
  try {
    if (await checkedWithin(invocation, CHECK_EVERY_MS)) return;
    const result = await pullTrip(invocation, tripId, passphrase);
    if (!result.ok) console.error(JSON.stringify({ message: "idle refresh failed", error: result.error }));
  } catch (error) {
    console.error(JSON.stringify({ message: "idle refresh failed", error: String(error) }));
  }
}

/**
 * A cached service worker pins a device to an old app, so it gets `no-store`
 * (the zone's Browser Cache TTL rewrites `no-cache` into a max-age). HTML only
 * has to revalidate.
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
 * A place photo or street map (media-routes.ts), for a caller who can open
 * the trip (the token is a hash of the passphrase).
 */
async function media(route: string, url: URL, invocation: Invocation): Promise<Response> {
  const { env } = invocation;
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  const passphrase = env.TRIP_PASSPHRASE;
  const store = env.MEDIA;
  if (!apiKey || !passphrase || !store) return new Response(null, { status: 503 });
  if (!tokenMatches(url.searchParams.get("t") ?? "", await mediaToken(passphrase))) {
    return new Response(null, { status: 401 });
  }
  const context = {
    publicId: env.PUBLIC_ID,
    apiKey,
    store,
    guard: invocation.guard,
    trip: () => storedTrip(env, invocation.tripAsset, passphrase),
    defer: invocation.defer,
  };
  return route === MEDIA_ROUTES.photo ? photo(url, context) : map(url, context);
}

/** `<base>/mcp/<token>`: the agent link (agent-link.ts). */
const AGENT_PATH = new RegExp(`^(.*)/${AGENT_ROUTE}/([^/]+)/?$`);

function tooMany(key: string, limit: { windowMs: number }): Response {
  return new Response(null, { status: 429, headers: {
    "cache-control": "no-store",
    "retry-after": String(retryAfterSeconds(key, limit)),
  } });
}

/**
 * Wrong tokens are limited per client address, right ones share one generous
 * window: connectors call from the AI vendors' shared addresses, so a
 * stranger's wrong guesses must not lock the travellers out. Both are checked
 * before the trip is read.
 */
async function agent(request: Request, invocation: Invocation, token: string): Promise<Response> {
  const { env } = invocation;
  const passphrase = env.TRIP_PASSPHRASE;
  if (!passphrase) return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  const probeKey = `wrong:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
  if (!tokenMatches(token, await agentToken(passphrase))) {
    if (!takeToken(probeKey, WRONG_TOKEN_LIMIT)) return tooMany(probeKey, WRONG_TOKEN_LIMIT);
    return new Response(null, { status: 401, headers: { "cache-control": "no-store" } });
  }
  if (!takeToken("agent", AGENT_LIMIT)) return tooMany("agent", AGENT_LIMIT);
  if (request.method === "POST") await refreshIfIdle(invocation);
  const load = async () => {
    // Nothing pulled yet: the file from the last ship.
    let ciphertext = await storedCiphertext(env, invocation.tripAsset);
    // A connector-only deployment has no shipped file, so an earlier failed
    // pull must not leave it empty until the next idle check; but with
    // Wanderlog down, not a pull on every call either: the button's gap.
    if (!ciphertext && env.WANDERLOG_TRIP_ID && !invocation.pulled && !(await checkedWithin(invocation, REFRESH_GAP_MS))) {
      await pullTrip(invocation, env.WANDERLOG_TRIP_ID, passphrase).catch(() => undefined);
      ciphertext = (await env.TRIP.get(OBJECT_KEY)) ?? undefined;
    }
    if (!ciphertext) throw new Error("No trip is stored yet and Wanderlog could not be reached");
    return openTrip(ciphertext, passphrase);
  };
  // Once an invocation, and one set of board caps, however many messages a batch holds.
  let bundle: Promise<TripBundle> | undefined;
  const session = boardSession();
  return handleMcp(request, {
    loadBundle: () => (bundle ??= load()),
    withBoards: (trip, scope) => connectorBoards(trip, scope, env, invocation.guard, { session, defer: invocation.defer }),
  });
}

function isTripPayload(pathname: string): boolean {
  return pathname.endsWith("/trip.enc");
}

/** The shipped trip.enc for a request ending in `suffix`, which sits where the app does. */
const besideApp = (url: URL, suffix: string) =>
  new URL(`${url.pathname.slice(0, url.pathname.length - suffix.length)}${OBJECT_KEY}`, url).toString();

async function handle(request: Request, env: RefreshEnv, ctx: ExecutionContextLike | undefined): Promise<Response> {
  const url = new URL(request.url);
  const defer: Defer = (work) => {
    // A failure is the work's own to log; waitUntil only keeps it running.
    ctx?.waitUntil(work.catch(() => undefined));
  };
  const invocation = (suffix: string): Invocation => ({
    env,
    guard: createGuard(env.TRIP),
    tripAsset: besideApp(url, suffix),
    pulled: false,
    checkedRead: false,
    defer,
  });
  const agentPath = AGENT_PATH.exec(url.pathname);
  if (agentPath) {
    return agent(request, invocation(url.pathname.slice((agentPath[1] ?? "").length + 1)), agentPath[2] ?? "");
  }
  if (request.method === "POST" && url.pathname.endsWith("/api/refresh")) {
    return refresh(request, invocation("api/refresh"));
  }
  const route = Object.values(MEDIA_ROUTES).find((name) => url.pathname.endsWith(`/${name}`));
  if (request.method === "GET" && route) return media(route, url, invocation(route));
  if (request.method === "GET" && url.pathname.endsWith(`/${DEPARTURES_ROUTE}`)) {
    const passphrase = env.TRIP_PASSPHRASE;
    if (!passphrase) return new Response(null, { status: 503 });
    if (!tokenMatches(url.searchParams.get("t") ?? "", await mediaToken(passphrase))) {
      return new Response(null, { status: 401 });
    }
    const { guard, tripAsset } = invocation(DEPARTURES_ROUTE);
    return liveBoard(url.searchParams, env, guard, () => storedTrip(env, tripAsset, passphrase), new Date(), defer);
  }
  if (request.method === "GET" && url.pathname.endsWith(`/${STATUS_ROUTE}`)) {
    const passphrase = env.TRIP_PASSPHRASE;
    if (!passphrase) return new Response(null, { status: 503 });
    if (!tokenMatches(url.searchParams.get("t") ?? "", await mediaToken(passphrase))) {
      return new Response(null, { status: 401 });
    }
    return Response.json(await guardStatus(env.TRIP), { headers: { "cache-control": "no-store" } });
  }
  if ((request.method === "GET" || request.method === "HEAD") && isTripPayload(url.pathname)) {
    await refreshIfIdle(invocation(OBJECT_KEY));
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
  async fetch(request: Request, env: RefreshEnv, ctx?: ExecutionContextLike): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ message: "refresh worker failed", error: String(error) }));
      if (AGENT_PATH.test(new URL(request.url).pathname)) return mcpFailure();
      if ([...Object.values(MEDIA_ROUTES), DEPARTURES_ROUTE, STATUS_ROUTE].some((route) => new URL(request.url).pathname.endsWith(`/${route}`))) {
        return new Response(null, { status: 502, headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" || request.method === "HEAD") return env.ASSETS.fetch(request);
      return Response.json({ error: "Refresh failed" }, { status: 500 });
    }
  },
};
