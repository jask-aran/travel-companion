import { parseTripBundle, type TripBundle } from "@travel-companion/trip-schema";
import { decryptTrip, type EncryptedPayload } from "./trip-crypto.js";
import { mediaToken } from "./media.js";
import { setMediaToken } from "./place-photo.js";

/**
 * True when the build published an encrypted payload. Dev always serves
 * plaintext, so the passphrase is only in the way where it earns its keep.
 */
declare const __TRIP_ENCRYPTED__: boolean;
export const tripIsEncrypted =
  typeof __TRIP_ENCRYPTED__ === "boolean" ? __TRIP_ENCRYPTED__ : false;

/** Injected at build time; `import.meta.env` is unavailable to the Node typecheck. */
declare const __TRIP_BASE__: string;
const base = typeof __TRIP_BASE__ === "string" ? __TRIP_BASE__ : "/";
const tripUrl = `${base}${tripIsEncrypted ? "trip.enc" : "trip.json"}`;

/**
 * The service worker's copy of the trip (vite.config.ts). On a first visit
 * it isn't in charge until after this fetch, so without the page's own copy
 * the trip only opened offline from the second visit on.
 */
const TRIP_CACHE = "trip-bundle";

async function fetchPayload(): Promise<unknown> {
  const response = await fetch(tripUrl, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Could not load trip data (${response.status})`);
  }
  if ("caches" in globalThis) {
    const copy = response.clone();
    void caches.open(TRIP_CACHE).then((cache) => cache.put(tripUrl, copy)).catch(() => undefined);
  }
  return response.json();
}

/**
 * Load the trip payload, decrypting it when the build is encrypted. The
 * passphrase itself is never sent anywhere; only a hash of it rides along
 * on photo requests (media.ts).
 */
export async function loadTripBundle(passphrase?: string): Promise<TripBundle> {
  const payload = await fetchPayload();

  if (!tripIsEncrypted) return parseTripBundle(payload);

  if (!passphrase) throw new Error("A passphrase is required to open this trip.");
  const plaintext = await decryptTrip(payload as EncryptedPayload, passphrase);
  // Whoever can open the trip may load its photos through the worker.
  setMediaToken(await mediaToken(passphrase));
  return parseTripBundle(JSON.parse(plaintext));
}
