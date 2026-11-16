import { createSignal } from "solid-js";
import type { Place } from "@travel-companion/trip-schema";
import { MEDIA_ROUTES, MEDIA_STATE_HEADER, PHOTO_CREDIT_HEADER, latLngOf, photoPlaceId } from "./media.js";
import { hasPagesFunction } from "./pages-function.js";

/**
 * Photos and maps load through the app's own worker (see media.ts), which
 * holds the Google key. The worker saves photos in private R2 storage and
 * checks the trip token before serving them. A static build has no worker,
 * so it shows neither.
 */
declare const __TRIP_BASE__: string;
const base = typeof __TRIP_BASE__ === "string" ? __TRIP_BASE__ : "/";

/**
 * Set once the trip is open (App.tsx). Reactive, so photos rendered before
 * it lands pick it up. Dev serves without a token; its proxy doesn't check.
 */
const [token, setToken] = createSignal("");
export const setMediaToken = setToken;

/** A worker route, with the token that shows the caller can open the trip. */
export const mediaUrl = (route: string, params: Record<string, string>) =>
  `${base}${route}?${new URLSearchParams({ ...params, t: token() }).toString()}`;

/**
 * A place's photo, by its Google place: the worker uses the photo name the
 * stored trip has for it, else looks one up the first time (it may find none).
 */
export function placePhotoUrl(place: Place): string | undefined {
  if (!hasPagesFunction) return undefined;
  const id = photoPlaceId(place);
  return id ? mediaUrl(MEDIA_ROUTES.photo, { place: id }) : undefined;
}

/** Whether the trip itself names a photo for the place, so one is all but certain. */
export const hasNamedPhoto = (place: Place) => Boolean(place.photo?.name);

export type PhotoFound = { url: string; credit?: string };
const asked = new Map<string, Promise<PhotoFound | undefined>>();

/**
 * Whether a place the trip names no photo for has one, asked once per page
 * session (cards for the same place share it). The answer is the image
 * itself, so the <img> after it comes from the cache. Undefined for "no
 * photo" and on any failure, and that answer stands until the app is
 * reloaded: folding and unfolding a day doesn't ask again.
 */
export function findPlacePhoto(url: string): Promise<PhotoFound | undefined> {
  let answer = asked.get(url);
  if (!answer) {
    answer = fetch(url)
      .then((response) => {
        if (!response.ok || response.headers.get(MEDIA_STATE_HEADER) !== "image") {
          markMediaFailed(url);
          return undefined;
        }
        const credit = response.headers.get(PHOTO_CREDIT_HEADER);
        return { url, ...(credit ? { credit: decodeURIComponent(credit) } : {}) };
      })
      .catch(() => {
        markMediaFailed(url);
        return undefined;
      });
    asked.set(url, answer);
  }
  return answer;
}

/**
 * Photo and map URLs that came back blank or failed this session (an
 * <img> that loaded the worker's blank, or errored): not shown, and not
 * asked for again until the app is reloaded.
 */
const failedMedia = new Set<string>();
export const markMediaFailed = (url: string) => void failedMedia.add(url);
export const mediaFailed = (url: string) => failedMedia.has(url);

/** Google requires these to be shown wherever the photo is displayed. */
export function photoAttribution(place: Place): string | undefined {
  const names = place.photo?.attributions?.map((entry) => entry.displayName).filter(Boolean);
  return names?.length ? names.join(", ") : undefined;
}

/**
 * A street map of the place, for stays without a photo: the Airbnbs on this
 * trip are bare addresses, and the block they sit in is what you need to
 * recognise on arrival. By the trip's place; `at` names the kept map, so a
 * place that moves gets a new one.
 */
/**
 * A day's overview picture, drawn once by Google Static Maps and kept in R2 for
 * every traveller. `v` lets the worker refuse a drawing for a stale trip.
 */
export function dayMapPreviewUrl(dayId: string, revision: string): string | undefined {
  if (!hasPagesFunction) return undefined;
  return mediaUrl(MEDIA_ROUTES.dayMap, { day: dayId, v: revision });
}

export function staticMapUrl(place: Place): string | undefined {
  const at = latLngOf(place);
  if (!hasPagesFunction || !at) return undefined;
  return mediaUrl(MEDIA_ROUTES.map, { place: place.id, at });
}
