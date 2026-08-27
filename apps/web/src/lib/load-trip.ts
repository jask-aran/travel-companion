import { parseTripBundle, type TripBundle } from "@travel-companion/trip-schema";
import { decryptTrip, type EncryptedPayload } from "./trip-crypto.js";

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

async function fetchPayload(): Promise<unknown> {
  const response = await fetch(tripUrl, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Could not load trip data (${response.status})`);
  }
  return response.json();
}

/**
 * Load the trip payload, decrypting it when the build is encrypted. The
 * passphrase is required only to read the data — it is never sent anywhere.
 */
export async function loadTripBundle(passphrase?: string): Promise<TripBundle> {
  const payload = await fetchPayload();

  if (!tripIsEncrypted) return parseTripBundle(payload);

  if (!passphrase) throw new Error("A passphrase is required to open this trip.");
  const plaintext = await decryptTrip(payload as EncryptedPayload, passphrase);
  return parseTripBundle(JSON.parse(plaintext));
}
