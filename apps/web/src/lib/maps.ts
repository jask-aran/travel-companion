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

/** Google's `travelmode` values. A ferry is closest to transit; a flight has none. */
const LEG_MODES: Record<string, MapsTravelMode | "bicycling" | undefined> = {
  walking: "walking",
  transit: "transit",
  driving: "driving",
  cycling: "bicycling",
  ferry: "transit",
};

function placeParam(place: Place): string {
  if (place.latitude != null && place.longitude != null) {
    return `${place.latitude},${place.longitude}`;
  }
  return place.address ?? place.name;
}

/**
 * Directions for one leg between two stops, in the leg's own mode. Unlike the
 * card title's link, the origin is the previous stop, not the device, so it
 * can be opened ahead of time to check the route.
 */
export function buildLegDirectionsUrl(
  from: Place,
  to: Place,
  travelMode: string,
): string | undefined {
  const mode = LEG_MODES[travelMode];
  if (!mode) return undefined;
  const params = new URLSearchParams({
    api: "1",
    origin: placeParam(from),
    destination: placeParam(to),
    travelmode: mode,
  });
  if (from.googlePlaceId) params.set("origin_place_id", from.googlePlaceId);
  if (to.googlePlaceId) params.set("destination_place_id", to.googlePlaceId);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
