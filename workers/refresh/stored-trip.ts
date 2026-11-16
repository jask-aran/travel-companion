import type { TripBundle } from "../../packages/trip-schema/src/index.js";
import { openTrip } from "./mcp.js";

/**
 * The trip the function serves: the one it pulled, in KV, else the
 * `trip.enc` the last ship put beside the app. Pages answers a missing file
 * with the index page, so the static one counts only if it is the payload.
 * Shared by the connector, the pull (what to carry forward) and the photo,
 * map and board routes (which places and legs may be fetched).
 */

export const OBJECT_KEY = "trip.enc";

export type TripSource = {
  TRIP: { get(key: string): Promise<string | null> };
  ASSETS: { fetch(request: Request): Promise<Response> };
};

/** The stored ciphertext, or undefined. One KV read, plus one static-file read when KV has none. */
export async function storedCiphertext(env: TripSource, assetUrl: string): Promise<string | undefined> {
  const kept = await env.TRIP.get(OBJECT_KEY);
  if (kept) return kept;
  const asset = await env.ASSETS.fetch(new Request(assetUrl));
  const text = asset.ok ? await asset.text() : "";
  return text.trimStart().startsWith("{") ? text : undefined;
}

/** The stored trip, decrypted (memoised per isolate), or undefined if there is none or it won't open. */
export async function storedTrip(env: TripSource, assetUrl: string, passphrase: string): Promise<TripBundle | undefined> {
  try {
    const ciphertext = await storedCiphertext(env, assetUrl);
    // Memoised and shared with the connector: read it, never change it.
    return ciphertext ? await openTrip(ciphertext, passphrase) : undefined;
  } catch (error) {
    console.warn(JSON.stringify({ message: "stored trip unreadable", error: String(error) }));
    return undefined;
  }
}

/** How long a request waits on another request's fetch before giving up (without asking anyone). */
export const SHARED_WAIT_MS = 30_000;
const inFlight = new Map<string, Promise<unknown>>();

/**
 * One fetch per key at a time in this isolate: travellers opening the same
 * card together share the first one's request. `work` must resolve to plain
 * data (never a Response or stream). A sharer that waits too long gets
 * `fallback`, so it never asks a provider itself.
 */
export function shared<T>(key: string, work: () => Promise<T>, fallback: T): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (!running) {
    const started = work().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), SHARED_WAIT_MS);
  });
  return Promise.race([running, late]).finally(() => clearTimeout(timer));
}
