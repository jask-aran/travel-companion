/**
 * Remembers the trip passphrase on this device so it is asked for once.
 *
 * Storing it locally is deliberate: the threat model is a link that leaks, not
 * someone holding an unlocked phone that already has the itinerary on it.
 */
const STORAGE_KEY = "travel-companion:passphrase";

export function readPassphrase(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    // Private browsing and blocked site data both throw on access.
    return undefined;
  }
}

export function rememberPassphrase(passphrase: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, passphrase);
  } catch {
    // Remembering is a convenience; the session still works without it.
  }
}

export function forgetPassphrase(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do if storage is unavailable.
  }
}
