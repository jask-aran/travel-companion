import type { Place } from "@travel-companion/trip-schema";

/**
 * Place photos and street maps come from Google, which needs the API key.
 * The key never reaches the browser: the app asks its own worker
 * (`api/photo?place=<Google place id>`, `api/map?place=<trip place id>&at=<lat,lng>`),
 * and the worker builds the Google request itself from the stored trip, for
 * that trip's places only. Shared by the app, the Pages worker and Vite's dev
 * middleware so all three agree on paths and parameters.
 *
 * Each request also carries a token derived from the trip passphrase, so
 * only someone who can open the trip can see its photos.
 */

export const MEDIA_ROUTES = { photo: "api/photo", map: "api/map", dayMap: "api/day-map" } as const;
/** What the worker's guard holds for each provider (requests counted, last refusal), for `pnpm ship:check`. */
export const STATUS_ROUTE = "api/status";
/** Verification requests may read cached data but must not contact a provider. */
export const CACHE_ONLY_HEADER = "x-trip-cache-only";

/**
 * The photo column is at most 9rem × 1.6 (its fade) on a wide phone: 480px
 * covers that on a 2x screen. Larger images only cost decode time while a
 * day opens; an opened card dims its photo to a backdrop anyway.
 */
export const PHOTO_WIDTH_PX = 480;

/** A Places photo resource name, as the trip stores it. */
const PHOTO_NAME = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;
/** A bare Google place id. */
const GOOGLE_ID = /^[A-Za-z0-9_-]{1,300}$/;
/** A trip's own place id (`google-place:…`, `source-block:…`). */
const TRIP_PLACE_ID = /^[A-Za-z0-9_:.-]{1,320}$/;
/** "lat,lng" with a handful of decimals. */
const LAT_LNG = /^-?\d{1,2}(\.\d{1,8})?,-?\d{1,3}(\.\d{1,8})?$/;

/**
 * Not the passphrase itself: a hash of it, so a token in a URL (history, a
 * log) gives access to photos, never to the trip.
 */
export async function mediaToken(passphrase: string): Promise<string> {
  const bytes = new TextEncoder().encode(`travel-companion/media/${passphrase}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const isPhotoName = (name: string) => PHOTO_NAME.test(name);
export const isGooglePlaceId = (id: string) => GOOGLE_ID.test(id);
export const isTripPlaceId = (id: string) => TRIP_PLACE_ID.test(id);
export const isLatLng = (at: string) => LAT_LNG.test(at);

type PhotoPlace = Pick<Place, "id" | "googlePlaceId" | "photo">;

/**
 * The Google place a trip place's photo is asked for by (`api/photo?place=`),
 * from its field, our `google-place:` id or its stored photo name. The worker
 * keeps the photo under it and finds the trip's place by it.
 */
export function photoPlaceId(place: PhotoPlace): string | undefined {
  const id =
    place.googlePlaceId ??
    /^google-place:(.+)$/.exec(place.id)?.[1] ??
    (place.photo?.name && PHOTO_NAME.test(place.photo.name) ? place.photo.name.split("/")[1] : undefined);
  return id && GOOGLE_ID.test(id) ? id : undefined;
}

/** "lat,lng" as a map is asked for and kept by (`api/map?at=`), or undefined. */
export function latLngOf(place: Pick<Place, "latitude" | "longitude">): string | undefined {
  if (place.latitude == null || place.longitude == null) return undefined;
  const at = `${place.latitude},${place.longitude}`;
  return LAT_LNG.test(at) ? at : undefined;
}

/**
 * What a photo or map answer is, in the `x-media` header: an image, Google has no
 * photo of the place ("none"), or Google couldn't be asked ("unavailable").
 * The last two are a blank 1×1 image, so a picture slot never errors.
 */
export const MEDIA_STATE_HEADER = "x-media";
export type MediaState = "image" | "none" | "unavailable";
/** The photo's credit (Google requires it shown), URI-encoded. */
export const PHOTO_CREDIT_HEADER = "x-photo-credit";

/** The Google Static Maps URL for a point. `at` must already be valid (isLatLng). */
export function staticMapUpstream(at: string, apiKey: string): string {
  // Portrait to fit the card's photo column; a quieter base map, since the
  // marker and the streets around it are the point.
  const query = new URLSearchParams({
    center: at,
    zoom: "16",
    size: "180x320",
    scale: "2",
    markers: `color:0xc8432b|${at}`,
    key: apiKey,
  });
  for (const style of ["feature:poi|visibility:off", "feature:transit|element:labels.icon|visibility:simplified"]) {
    query.append("style", style);
  }
  return `https://maps.googleapis.com/maps/api/staticmap?${query.toString()}`;
}

/** A photo's image at the card's width. `name` must already be a valid photo name. */
export function photoMediaUrl(name: string, apiKey: string): string {
  const query = new URLSearchParams({ maxWidthPx: String(PHOTO_WIDTH_PX), key: apiKey });
  return `https://places.googleapis.com/v1/${name}/media?${query.toString()}`;
}
