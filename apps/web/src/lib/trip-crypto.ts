/**
 * Passphrase encryption for the trip payload.
 *
 * A password checked in JavaScript would protect nothing: `trip.json` is a
 * separate request, so anyone could fetch it directly and read every booking
 * reference without running our code. So the payload itself is encrypted at
 * build time and decrypted in the browser — what crosses the network is
 * ciphertext, and the passphrase never leaves the device.
 *
 * AES-GCM for authenticated encryption (a wrong passphrase fails loudly rather
 * than yielding garbage), keyed by PBKDF2-SHA256. Runs unmodified in Node and
 * the browser, so the build and the app share exactly this code.
 */

export type EncryptedPayload = {
  v: 1;
  /** PBKDF2 iterations, recorded so old payloads stay readable if this changes. */
  iterations: number;
  salt: string;
  iv: string;
  data: string;
};

/** High enough to make offline guessing expensive; ~0.3 s on a phone. */
export const DEFAULT_ITERATIONS = 310_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptTrip(
  plaintext: string,
  passphrase: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoder.encode(plaintext),
  );

  return {
    v: 1,
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(data)),
  };
}

/** Thrown for a wrong passphrase, so callers can distinguish it from a network fault. */
export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase does not unlock this trip.");
    this.name = "WrongPassphraseError";
  }
}

export async function decryptTrip(
  payload: EncryptedPayload,
  passphrase: string,
): Promise<string> {
  const key = await deriveKey(
    passphrase,
    fromBase64(payload.salt),
    payload.iterations ?? DEFAULT_ITERATIONS,
  );
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(payload.iv) as BufferSource },
      key,
      fromBase64(payload.data) as BufferSource,
    );
    return decoder.decode(plaintext);
  } catch {
    // AES-GCM authentication failure is indistinguishable from a bad key.
    throw new WrongPassphraseError();
  }
}
