import type { TripBundle } from "../../packages/trip-schema/src/index.js";
import { fetchPhoto } from "../../packages/trip-normaliser/src/place-photos.js";
import {
  MEDIA_STATE_HEADER,
  PHOTO_CREDIT_HEADER,
  PHOTO_WIDTH_PX,
  isGooglePlaceId,
  isLatLng,
  isPhotoName,
  isTripPlaceId,
  latLngOf,
  photoMediaUrl,
  photoPlaceId,
  staticMapUpstream,
  type MediaState,
} from "../../apps/web/src/lib/media.js";
import { FAILURE_REMEMBERED_MS, counting, type Defer, type Fetcher, type Guard } from "./guard.js";
import { shared } from "./stored-trip.js";
import { dayStaticMapUpstream } from "../../apps/web/src/lib/day-map-preview.js";
import { buildDayMap } from "../../apps/web/src/lib/day-map.js";
import { dayRouting } from "../../apps/web/src/lib/day-routing.js";
import { collectStays } from "../../apps/web/src/lib/lodging.js";
import { indexRouteLegs } from "../../apps/web/src/lib/route-legs.js";

/**
 * `api/photo` and `api/map`: a place photo or street map from Google, kept
 * in R2 and served from there. Only for the stored trip's own places, and
 * the Google request is built here from the trip (its photo name, its
 * coordinates), never from the request. R2 is read first; the trip is only
 * opened on a miss, when Google would be asked. Kept in R2 outside Google's
 * standard caching terms, by the operator's choice. A fetch that fails
 * after asking Google (a 5xx, a timeout, not an image) leaves a marker at
 * the item's key, so for an hour the item is "unavailable" without asking.
 *
 * Request shapes: `api/photo?place=<Google place id>`,
 * `api/map?place=<trip place id>&at=<lat,lng>`. An app shell from before
 * these still sends `api/photo?name=<photo name>` or `api/map?at=` alone: it
 * gets what R2 holds, and otherwise a blank "unavailable", never a fetch.
 */

/** The R2 operations this worker uses. */
export type MediaStore = {
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  } | null>;
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer, options: {
    httpMetadata: { contentType: string };
    customMetadata?: Record<string, string>;
  }): Promise<unknown>;
};

export type MediaContext = {
  cacheOnly?: boolean;
  publicId: string;
  apiKey: string;
  store: MediaStore;
  guard: Guard;
  /** The stored trip, opened only when it is needed. */
  trip(): Promise<TripBundle | undefined>;
  /** Keeps a fetch-and-store running after the response (the runtime's waitUntil). */
  defer?: Defer;
};

const BROWSER_CACHE_SECONDS = 30 * 86_400;

/**
 * Photos by place, not by photo name: a name changes when it is fetched
 * again and expires, the place's image doesn't. Maps by everything that
 * draws them, so a new size or style is a new object, not a stale one.
 */
const photoKey = (publicId: string, place: string) => `${publicId}/photos/${PHOTO_WIDTH_PX}/${place}`;

async function mapKey(at: string, publicId: string): Promise<string> {
  const drawn = new TextEncoder().encode(staticMapUpstream(at, ""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", drawn));
  const hash = [...digest.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${publicId}/maps/${at}/${hash}`;
}

/**
 * "Google has no photo of this place", kept in R2 at the photo's own key so
 * the one lookup that finds a photo finds this too. Asked again after a month.
 */
const NO_PHOTO_TYPE = "application/x-no-photo";
const NO_PHOTO_FOR_MS = 30 * 86_400_000;
/** "Google was asked and failed", at the item's own key; asked again after FAILURE_REMEMBERED_MS. */
const FAILED_TYPE = "application/x-media-failed";
/** A transparent 1×1 GIF: what a slot gets when there is no picture. */
const BLANK_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (char) => char.charCodeAt(0));

function imageReply(
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  contentType: string,
  state: "r2-hit" | "r2-miss",
  credit?: string,
): Response {
  return new Response(body, { headers: {
    "content-type": contentType,
    "cache-control": `private, max-age=${BROWSER_CACHE_SECONDS}`,
    "x-media-cache": state,
    [MEDIA_STATE_HEADER]: "image" satisfies MediaState,
    ...(credit ? { [PHOTO_CREDIT_HEADER]: credit } : {}),
  } });
}

/** No picture, as a blank image: an <img> shows nothing and logs nothing. */
function blankReply(state: Exclude<MediaState, "image">): Response {
  return new Response(BLANK_GIF, { headers: {
    "content-type": "image/gif",
    // "none" may sit on the phone; "unavailable" is asked again next session.
    "cache-control": state === "none" ? "private, max-age=86400" : "no-store",
    [MEDIA_STATE_HEADER]: state,
  } });
}

const notInTrip = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

const isImage = (response: Response | undefined): boolean =>
  Boolean(response?.ok && response.body && (response.headers.get("content-type") ?? "").startsWith("image/"));

/** What one fetch found, as plain data so requests sharing it each make their own reply. */
type Fetched =
  | { kind: "image"; bytes: ArrayBuffer; contentType: string; credit?: string }
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "not-in-trip" };

function replyFor(fetched: Fetched): Response {
  // A copy each: requests sharing one fetch each send their own body.
  if (fetched.kind === "image") return imageReply(fetched.bytes.slice(0), fetched.contentType, "r2-miss", fetched.credit);
  if (fetched.kind === "not-in-trip") return notInTrip();
  return blankReply(fetched.kind);
}

type Saved = NonNullable<Awaited<ReturnType<MediaStore["get"]>>>;

/** A failure marker still in force; its body is let go either way. */
async function failedRecently(saved: Saved): Promise<boolean> {
  await saved.body.cancel().catch(() => undefined);
  return Date.now() - Date.parse(saved.customMetadata?.failedAt ?? "") < FAILURE_REMEMBERED_MS;
}

/** Runs one fetch-and-store under the runtime's waitUntil, so a caller going away doesn't lose what was paid for. */
async function kept(key: string, context: MediaContext, work: () => Promise<Fetched>): Promise<Response> {
  const running = shared<Fetched>(key, work, { kind: "unavailable" });
  context.defer?.(running);
  return replyFor(await running);
}

/** Paid for already: a failed R2 write is logged, never the reason the image is lost. */
async function keep(store: MediaStore, key: string, ...[body, options]: [Uint8Array | ArrayBuffer, Parameters<MediaStore["put"]>[2]]) {
  try {
    await store.put(key, body, options);
  } catch (error) {
    console.error(JSON.stringify({ message: "media not kept", key, error: String(error) }));
  }
}

async function ask(fetcher: Fetcher, url: string): Promise<Response | undefined> {
  try {
    return await fetcher(url);
  } catch {
    // Refused by the guard, timed out, or the network failed.
    return undefined;
  }
}

type Found = { response: Response; credit?: string } | "none" | undefined;

/**
 * A place's image from Google: by the trip's photo name if it has one, else
 * (or once that name has expired: 400 or 404, nothing else) by asking for
 * the place's current photo (Place Details, photos field only). "none" when
 * Google has no photo or no such place; undefined when Google refused, failed
 * or wasn't asked, which is not kept.
 */
async function findPhoto(name: string | undefined, place: string, apiKey: string, fetcher: Fetcher): Promise<Found> {
  if (name) {
    const response = await ask(fetcher, photoMediaUrl(name, apiKey));
    if (response && isImage(response)) return { response };
    if (!response || (response.status !== 400 && response.status !== 404)) return undefined;
  }
  let current: Awaited<ReturnType<typeof fetchPhoto>>;
  try {
    current = await fetchPhoto(place, apiKey, fetcher);
  } catch (error) {
    const status = (error as { status?: number }).status;
    // No such place (an old or mistyped id): as good as no photo.
    if (status === 400 || status === 404) return "none";
    console.warn(JSON.stringify({ message: "photo lookup failed", status: status ?? String(error) }));
    return undefined;
  }
  if (!current?.name || !isPhotoName(current.name)) return "none";
  const response = await ask(fetcher, photoMediaUrl(current.name, apiKey));
  if (!response || !isImage(response)) return undefined;
  const credit = (current.authorAttributions ?? []).map((entry) => entry.displayName).filter(Boolean).join(", ");
  return { response, ...(credit ? { credit: encodeURIComponent(credit) } : {}) };
}

/**
 * Cost of a first view: one R2 read; the trip (KV, or the static file);
 * then, only for a place of the trip that Google can be asked about, the
 * guard's KV reads, the photo by the trip's name, and only if that name has
 * expired a Place Details request and the new name's image, each with the
 * guard's count read and write; one R2 write (the image, "no photo", or a
 * failure marker). A later view: one R2 read.
 */
export async function photo(url: URL, context: MediaContext): Promise<Response> {
  const byPlace = url.searchParams.get("place");
  const byName = url.searchParams.get("name");
  const place = byPlace !== null
    ? (isGooglePlaceId(byPlace) ? byPlace : undefined)
    : byName !== null && isPhotoName(byName) ? byName.split("/")[1] : undefined;
  if (!place) return notInTrip();
  const key = photoKey(context.publicId, place);
  const saved = await context.store.get(key);
  if (saved) {
    const contentType = saved.httpMetadata?.contentType ?? "image/jpeg";
    if (contentType === FAILED_TYPE) {
      if (await failedRecently(saved)) return blankReply("unavailable");
    } else if (contentType !== NO_PHOTO_TYPE) {
      return imageReply(saved.body, contentType, "r2-hit", saved.customMetadata?.credit);
    } else {
      await saved.body.cancel().catch(() => undefined);
      const checkedAt = Date.parse(saved.customMetadata?.checkedAt ?? "");
      if (Date.now() - checkedAt < NO_PHOTO_FOR_MS) return blankReply("none");
    }
  }
  // An app shell from before `place=`: only what R2 holds.
  if (byPlace === null || context.cacheOnly) return blankReply("unavailable");
  return kept(key, context, () => fetchPlacePhoto(place, key, context));
}

/** Remembers, at the item's key, that Google was asked and failed. */
const markFailed = (store: MediaStore, key: string) =>
  keep(store, key, BLANK_GIF, {
    httpMetadata: { contentType: FAILED_TYPE },
    customMetadata: { failedAt: new Date().toISOString() },
  });

async function fetchPlacePhoto(place: string, key: string, context: MediaContext): Promise<Fetched> {
  // The trip first: an id it doesn't have costs no guard reads.
  const bundle = await context.trip();
  const tripPlace = bundle && Object.values(bundle.places).find((candidate) => photoPlaceId(candidate) === place);
  if (!tripPlace) return { kind: "not-in-trip" };
  if (!(await context.guard.available("google"))) return { kind: "unavailable" };
  const name = tripPlace.photo?.name && isPhotoName(tripPlace.photo.name) ? tripPlace.photo.name : undefined;
  const asked = counting(context.guard.fetch);
  const found = await findPhoto(name, place, context.apiKey, asked.fetch);
  if (found === "none") {
    await keep(context.store, key, BLANK_GIF, {
      httpMetadata: { contentType: NO_PHOTO_TYPE },
      customMetadata: { checkedAt: new Date().toISOString() },
    });
    return { kind: "none" };
  }
  if (!found) {
    if (asked.sent()) await markFailed(context.store, key);
    return { kind: "unavailable" };
  }
  const contentType = found.response.headers.get("content-type") ?? "image/jpeg";
  const bytes = await found.response.arrayBuffer();
  await keep(context.store, key, bytes.slice(0), {
    httpMetadata: { contentType },
    ...(found.credit ? { customMetadata: { credit: found.credit } } : {}),
  });
  return { kind: "image", bytes, contentType, ...(found.credit ? { credit: found.credit } : {}) };
}

/**
 * Cost of a first view: one R2 read; the trip; then, only for the trip's
 * own coordinates and if Google can be asked, the guard's KV reads, one
 * Static Maps request with its count read and write, and one R2 write (the
 * map or a failure marker).
 * `at` must be where the stored trip has the place: it names the R2 object,
 * and the map is drawn from the trip's own coordinates.
 */
export async function map(url: URL, context: MediaContext): Promise<Response> {
  const at = url.searchParams.get("at") ?? "";
  const place = url.searchParams.get("place");
  if (!isLatLng(at) || (place !== null && !isTripPlaceId(place))) return notInTrip();
  const key = await mapKey(at, context.publicId);
  const saved = await context.store.get(key);
  if (saved) {
    const contentType = saved.httpMetadata?.contentType ?? "image/jpeg";
    if (contentType !== FAILED_TYPE) return imageReply(saved.body, contentType, "r2-hit");
    if (await failedRecently(saved)) return blankReply("unavailable");
  }
  // An app shell from before `place=`: only what R2 holds.
  if (place === null) return blankReply("unavailable");
  if (context.cacheOnly) return blankReply("unavailable");
  return kept(key, context, async () => {
    // The trip first: coordinates it doesn't have cost no guard reads.
    const tripPlace = (await context.trip())?.places[place];
    const drawnAt = tripPlace && latLngOf(tripPlace);
    if (!drawnAt || drawnAt !== at) return { kind: "not-in-trip" };
    if (!(await context.guard.available("google"))) return { kind: "unavailable" };
    const asked = counting(context.guard.fetch);
    const response = await ask(asked.fetch, staticMapUpstream(drawnAt, context.apiKey));
    if (!response || !isImage(response)) {
      if (asked.sent()) await markFailed(context.store, key);
      return { kind: "unavailable" };
    }
    const contentType = response.headers.get("content-type") ?? "image/png";
    const bytes = await response.arrayBuffer();
    await keep(context.store, key, bytes.slice(0), { httpMetadata: { contentType } });
    return { kind: "image", bytes, contentType };
  });
}

/** A day overview drawn from the stored trip only, shared by every traveller. */
export async function dayMap(url: URL, context: MediaContext): Promise<Response> {
  const dayId = url.searchParams.get("day");
  if (!dayId || !isTripPlaceId(dayId)) return notInTrip();
  const bundle = await context.trip();
  const day = bundle?.days.find((candidate) => candidate.id === dayId);
  if (!bundle || !day) return notInTrip();
  const revision = url.searchParams.get("v");
  if (revision && revision !== bundle.revision) return blankReply("unavailable");
  const stays = collectStays(bundle);
  const hotels = new Set(stays.flatMap((stay) => stay.placeId ? [stay.placeId] : []));
  const data = buildDayMap(dayRouting(bundle, day, stays, indexRouteLegs(bundle)), bundle, hotels);
  const drawing = dayStaticMapUpstream(data, "");
  if (!drawing) return blankReply("none");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(drawing)));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // Drawing changes spend again; edited notes, arbitrary query parameters and a new revision don't.
  const key = `${context.publicId}/day-maps/${hash}`;
  const saved = await context.store.get(key);
  if (saved) {
    const type = saved.httpMetadata?.contentType ?? "image/png";
    if (type !== FAILED_TYPE) return imageReply(saved.body, type, "r2-hit");
    if (await failedRecently(saved)) return blankReply("unavailable");
  }
  if (context.cacheOnly) return blankReply("unavailable");
  return kept(key, context, async () => {
    if (!(await context.guard.available("google"))) return { kind: "unavailable" };
    const upstream = new URL(drawing);
    upstream.searchParams.set("key", context.apiKey);
    const asked = counting(context.guard.fetch);
    const response = await ask(asked.fetch, upstream.toString());
    if (!response || !isImage(response)) {
      if (asked.sent()) await markFailed(context.store, key);
      return { kind: "unavailable" };
    }
    const contentType = response.headers.get("content-type") ?? "image/png";
    const bytes = await response.arrayBuffer();
    await keep(context.store, key, bytes.slice(0), { httpMetadata: { contentType } });
    return { kind: "image", bytes, contentType };
  });
}
