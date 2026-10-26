/**
 * Place photos and street maps come from Google, which needs the API key.
 * The key never reaches the browser: the app asks its own worker
 * (`api/photo`, `api/map`), and the worker, or the dev server, adds the key
 * and forwards the request. Shared by the app, the Pages worker and Vite's
 * dev middleware so all three agree on paths and parameters.
 *
 * The worker would otherwise be an open proxy spending the key, so each
 * request carries a token derived from the trip passphrase: anyone who can
 * open the trip can see its photos, and nobody else can use the key.
 */

export const MEDIA_ROUTES = { photo: "api/photo", map: "api/map" } as const;

/**
 * The photo column is at most 9rem × 1.6 (its fade) on a wide phone: 480px
 * covers that on a 2x screen. Larger images only cost decode time while a
 * day opens; an opened card dims its photo to a backdrop anyway.
 */
export const PHOTO_WIDTH_PX = 480;

/** A Places photo resource name, as the trip stores it. */
const PHOTO_NAME = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;
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

/**
 * The Google URL for a proxied request, or undefined if it asks for
 * anything but a photo or a map of a point. Callers check the token first.
 */
export function mediaUpstream(route: string, params: URLSearchParams, apiKey: string): string | undefined {
  if (route === MEDIA_ROUTES.photo) {
    const name = params.get("name") ?? "";
    if (!PHOTO_NAME.test(name)) return undefined;
    const query = new URLSearchParams({ maxWidthPx: String(PHOTO_WIDTH_PX), key: apiKey });
    return `https://places.googleapis.com/v1/${name}/media?${query.toString()}`;
  }
  if (route === MEDIA_ROUTES.map) {
    const at = params.get("at") ?? "";
    if (!LAT_LNG.test(at)) return undefined;
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
  return undefined;
}
