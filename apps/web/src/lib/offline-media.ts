import type { Place, TripBundle } from "@travel-companion/trip-schema";
import { collectStays } from "./lodging.js";
import { MEDIA_STATE_HEADER } from "./media.js";
import { hasNamedPhoto, placePhotoUrl, staticMapUrl } from "./place-photo.js";

/**
 * The trip's photos and street maps, kept on the phone, so cards aren't
 * blank in a subway or without roaming. The service worker answers these
 * from the same cache (vite.config.ts); filling it from the page as well
 * covers the first visit, before the service worker is in charge. About
 * 6 MB for a trip of ~100 places, fetched once and then only for new ones.
 *
 * Only what the cards show (PlacePhoto in ItemCards.tsx): the photo of each
 * stop and stay, and a street map only for a stay that has no photo. A place
 * the trip names no photo for costs the worker a Google lookup the first
 * time anyone asks, so those are fetched a few per app open; its map, if it
 * is a stay, only once the worker says it has no photo. An answer of "no
 * photo" is kept too, so it isn't asked again. One at a time, and the first
 * answer that is "unavailable" or fails ends this open's prefetch: Google
 * refusing would refuse the rest too.
 */

/** The cache the service worker reads photos and maps from. */
const MEDIA_CACHE = "media";

/** Photos found by place, at most, per app open. */
export const LOOKUPS_PER_OPEN = 12;

/** Each place a card shows, and whether its card falls back to a street map (a stay). */
export function shownPlaces(bundle: TripBundle): { place: Place; mapFallback: boolean }[] {
  const stayIds = new Set(collectStays(bundle).flatMap((stay) => (stay.placeId ? [stay.placeId] : [])));
  const shown = new Map<string, boolean>();
  for (const day of bundle.days) {
    for (const item of day.items) {
      if (item.type === "place") shown.set(item.placeId, stayIds.has(item.placeId));
    }
  }
  for (const id of stayIds) shown.set(id, true);
  return [...shown].flatMap(([id, mapFallback]) => {
    const place = bundle.places[id];
    return place ? [{ place, mapFallback }] : [];
  });
}

/** One photo or map to keep, and what to keep after it if the answer is "no photo". */
type Wanted = { url: string; lookup: boolean; ifNone?: string };

export function wantedMedia(bundle: TripBundle): Wanted[] {
  const named: Wanted[] = [];
  const looked: Wanted[] = [];
  const maps: Wanted[] = [];
  for (const { place, mapFallback } of shownPlaces(bundle)) {
    const photo = placePhotoUrl(place);
    const map = mapFallback ? staticMapUrl(place) : undefined;
    if (photo && hasNamedPhoto(place)) named.push({ url: photo, lookup: false });
    else if (photo) looked.push({ url: photo, lookup: true, ...(map ? { ifNone: map } : {}) });
    else if (map) maps.push({ url: map, lookup: false });
  }
  return [...named, ...looked, ...maps];
}

export async function keepMediaOffline(bundle: TripBundle): Promise<void> {
  if (!("caches" in window) || !navigator.onLine) return;
  // Data saver on: the phone fetches each picture when it's shown, as before.
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  // Ask the browser not to clear this storage under pressure (Safari may say no).
  void navigator.storage?.persist?.().catch(() => false);

  try {
    const cache = await caches.open(MEDIA_CACHE);
    /** "kept" (an image), "none" (no photo, kept too), or false: unavailable or failed, which ends the prefetch. */
    const keep = async (url: string): Promise<"kept" | "none" | false> => {
      const cached = await cache.match(url);
      if (cached) return cached.headers.get(MEDIA_STATE_HEADER) === "none" ? "none" : "kept";
      const response = await fetch(url).catch(() => undefined);
      const state = response?.headers.get(MEDIA_STATE_HEADER);
      if (!response?.ok || state === "unavailable") return false;
      await cache.put(url, response);
      return state === "none" ? "none" : "kept";
    };
    let lookups = 0;
    for (const wanted of wantedMedia(bundle)) {
      if (wanted.lookup) {
        if (!(await cache.match(wanted.url)) && (lookups += 1) > LOOKUPS_PER_OPEN) continue;
      }
      const answer = await keep(wanted.url);
      if (answer === false) return;
      if (answer === "none" && wanted.ifNone && (await keep(wanted.ifNone)) === false) return;
    }
  } catch {
    // Storage refused (private browsing, full disk): pictures still load online.
  }
}
