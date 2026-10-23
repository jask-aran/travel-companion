import { createSignal } from "solid-js";
import type { Place } from "@travel-companion/trip-schema";
import { MEDIA_ROUTES } from "./media.js";

/**
 * Photos and maps load through the app's own worker (see media.ts), which
 * holds the Google key. Place Photos may not be cached or re-hosted (ToS
 * 3.2.3(b)), so the worker forwards each request rather than storing images.
 */
declare const __TRIP_BASE__: string;
const base = typeof __TRIP_BASE__ === "string" ? __TRIP_BASE__ : "/";

/**
 * Set once the trip is open (App.tsx). Reactive, so photos rendered before
 * it lands pick it up. Dev serves without a token; its proxy doesn't check.
 */
const [token, setToken] = createSignal("");
export const setMediaToken = setToken;

const mediaUrl = (route: string, params: Record<string, string>) =>
  `${base}${route}?${new URLSearchParams({ ...params, t: token() }).toString()}`;

export function placePhotoUrl(place: Place): string | undefined {
  if (!place.photo?.name) return undefined;
  return mediaUrl(MEDIA_ROUTES.photo, { name: place.photo.name });
}

/** Google requires these to be shown wherever the photo is displayed. */
export function photoAttribution(place: Place): string | undefined {
  const names = place.photo?.attributions?.map((entry) => entry.displayName).filter(Boolean);
  return names?.length ? names.join(", ") : undefined;
}

/**
 * A street map of the place, for stays without a photo: the Airbnbs on this
 * trip are bare addresses, and the block they sit in is what you need to
 * recognise on arrival.
 */
export function staticMapUrl(place: Place): string | undefined {
  if (place.latitude == null || place.longitude == null) return undefined;
  return mediaUrl(MEDIA_ROUTES.map, { at: `${place.latitude},${place.longitude}` });
}
