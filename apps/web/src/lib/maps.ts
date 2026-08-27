import type { Place } from "@travel-companion/trip-schema";

export type MapsTravelMode = "transit" | "walking" | "driving";

/**
 * Build a Google Maps directions URL that leaves origin empty so the device
 * supplies the current location. Destination priority matches the project spec.
 */
export function buildGoogleMapsUrl(
  place: Place,
  mode: MapsTravelMode = "transit",
): string {
  const params = new URLSearchParams({
    api: "1",
    travelmode: mode,
  });

  if (place.googlePlaceId) {
    const query =
      place.latitude != null && place.longitude != null
        ? `${place.latitude},${place.longitude}`
        : place.name;
    params.set("destination", query);
    params.set("destination_place_id", place.googlePlaceId);
  } else if (place.latitude != null && place.longitude != null) {
    params.set("destination", `${place.latitude},${place.longitude}`);
  } else if (place.address) {
    params.set("destination", place.address);
  } else {
    params.set("destination", place.name);
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Build a Google Maps *place* URL — the POI's own page, not a route to it.
 * Used by the photo, where the intent is "show me this place", distinct from
 * the card title's directions link.
 */
export function buildGooglePlaceUrl(place: Place): string {
  const params = new URLSearchParams({ api: "1" });

  // `query` is required even when a place id is given; Google uses it as the
  // label and as the fallback if the id ever stops resolving.
  const query =
    place.latitude != null && place.longitude != null
      ? `${place.latitude},${place.longitude}`
      : (place.address ?? place.name);
  params.set("query", query);

  if (place.googlePlaceId) params.set("query_place_id", place.googlePlaceId);

  return `https://www.google.com/maps/search/?${params.toString()}`;
}
