import { describe, expect, it } from "vitest";
import {
  decryptTrip,
  encryptTrip,
  InsecureContextError,
  WrongPassphraseError,
} from "../apps/web/src/lib/trip-crypto.js";

// Low iteration count keeps the suite fast; production uses the default.
const FAST = 1000;

describe("trip payload encryption", () => {
  // Fixture only — never use a real booking reference in a committed test.
  const secret = JSON.stringify({ confirmationNumber: "XXXXXX", pax: ["A Traveller"] });

  it("round-trips the payload", async () => {
    const encrypted = await encryptTrip(secret, "correct horse", FAST);
    await expect(decryptTrip(encrypted, "correct horse")).resolves.toBe(secret);
  });

  it("rejects a wrong passphrase rather than returning garbage", async () => {
    const encrypted = await encryptTrip(secret, "correct horse", FAST);
    await expect(decryptTrip(encrypted, "wrong horse")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it("leaks no plaintext into the encrypted payload", async () => {
    const encrypted = await encryptTrip(secret, "correct horse", FAST);
    const serialised = JSON.stringify(encrypted);
    expect(serialised).not.toContain("XXXXXX");
    expect(serialised).not.toContain("A Traveller");
    expect(serialised).not.toContain("confirmationNumber");
  });

  it("uses a fresh salt and iv each time, so identical input differs", async () => {
    const a = await encryptTrip(secret, "correct horse", FAST);
    const b = await encryptTrip(secret, "correct horse", FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("detects tampering with the ciphertext", async () => {
    const encrypted = await encryptTrip(secret, "correct horse", FAST);
    const bytes = atob(encrypted.data).split("");
    bytes[0] = String.fromCharCode(bytes[0]!.charCodeAt(0) ^ 0xff);
    const tampered = { ...encrypted, data: btoa(bytes.join("")) };
    await expect(decryptTrip(tampered, "correct horse")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });
});

describe("insecure context", () => {
  // Browsers withhold crypto.subtle on plain http:// unless the host is
  // localhost, so a LAN or Tailscale IP has no Web Crypto at all.
  it("reports a missing secure context instead of failing obscurely", async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      await expect(encryptTrip("x", "y", 1000)).rejects.toBeInstanceOf(InsecureContextError);
    } finally {
      if (real) Object.defineProperty(globalThis, "crypto", real);
    }
  });

  it("does not mistake a missing secure context for a wrong passphrase", async () => {
    const encrypted = await encryptTrip("payload", "phrase", 1000);
    const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      await expect(decryptTrip(encrypted, "phrase")).rejects.toBeInstanceOf(
        InsecureContextError,
      );
    } finally {
      if (real) Object.defineProperty(globalThis, "crypto", real);
    }
  });
});
