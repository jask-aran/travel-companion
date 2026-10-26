import type { TripBundle } from "@travel-companion/trip-schema";
import { placePhotoUrl, staticMapUrl } from "./place-photo.js";

/**
 * Every photo and street map of the trip, kept on the phone, so cards aren't
 * blank in a subway or without roaming. The service worker answers these
 * from the same cache (vite.config.ts); filling it from the page as well
 * covers the first visit, before the service worker is in charge. About
 * 6 MB for a trip of ~100 places, fetched once and then only for new ones.
 */

/** The cache the service worker reads photos and maps from. */
const MEDIA_CACHE = "media";

const AT_ONCE = 4;

export async function keepMediaOffline(bundle: TripBundle): Promise<void> {
  if (!("caches" in window) || !navigator.onLine) return;
  // Data saver on: the phone fetches each picture when it's shown, as before.
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  // Ask the browser not to clear this storage under pressure (Safari may say no).
  void navigator.storage?.persist?.().catch(() => false);

  const urls = Object.values(bundle.places).flatMap((place) => {
    const url = placePhotoUrl(place) ?? staticMapUrl(place);
    return url ? [url] : [];
  });
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const missing: string[] = [];
    for (const url of urls) if (!(await cache.match(url))) missing.push(url);
    for (let index = 0; index < missing.length; index += AT_ONCE) {
      await Promise.all(missing.slice(index, index + AT_ONCE).map((url) => cache.add(url).catch(() => undefined)));
    }
  } catch {
    // Storage refused (private browsing, full disk): pictures still load online.
  }
}
