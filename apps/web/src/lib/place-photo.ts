import type { Place } from "@travel-companion/trip-schema";

/**
 * Google's browser key, injected at build time from GOOGLE_MAPS_API_KEY.
 *
 * It is necessarily visible in the built app: Place Photos may not be cached
 * or re-hosted (ToS 3.2.3(b)), so the image is fetched straight from Google by
 * the browser. Restrict the key by HTTP referrer in the Cloud console.
 */
declare const __GOOGLE_MAPS_KEY__: string;

const apiKey = typeof __GOOGLE_MAPS_KEY__ === "string" ? __GOOGLE_MAPS_KEY__ : "";

export const placePhotosEnabled = apiKey.length > 0;

/**
 * Generous relative to the slot width: the photo is full-bleed and stretches
 * to the card height, so an expanded card can be far taller than it is wide.
 * Billing is per request, not per pixel.
 */
const MAX_WIDTH_PX = 800;

export function placePhotoUrl(place: Place): string | undefined {
  if (!apiKey || !place.photo?.name) return undefined;
  const params = new URLSearchParams({
    maxWidthPx: String(MAX_WIDTH_PX),
    key: apiKey,
  });
  return `https://places.googleapis.com/v1/${place.photo.name}/media?${params.toString()}`;
}

/** Google requires these to be shown wherever the photo is displayed. */
export function photoAttribution(place: Place): string | undefined {
  const names = place.photo?.attributions?.map((entry) => entry.displayName).filter(Boolean);
  return names?.length ? names.join(", ") : undefined;
}

/**
 * A street map of the place, for stays without a photo: the Airbnbs on this
 * trip are bare addresses, and the block they sit in is what you need to
 * recognise on arrival. Maps Static API, fetched by the browser like photos
 * (the same no-caching terms). Portrait to fit the card's photo column.
 */
export function staticMapUrl(place: Place): string | undefined {
  if (!apiKey || place.latitude == null || place.longitude == null) return undefined;
  const at = `${place.latitude},${place.longitude}`;
  const params = new URLSearchParams({
    center: at,
    zoom: "16",
    size: "180x320",
    scale: "2",
    markers: `color:0xc8432b|${at}`,
    key: apiKey,
  });
  // Quieter base map: the marker and the streets around it are the point.
  for (const style of ["feature:poi|visibility:off", "feature:transit|element:labels.icon|visibility:simplified"]) {
    params.append("style", style);
  }
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}
