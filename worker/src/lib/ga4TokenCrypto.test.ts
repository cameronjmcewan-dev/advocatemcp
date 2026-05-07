/**
 * Tests for worker/src/lib/ga4TokenCrypto.ts
 *
 * Runs in Node via vitest. Node 18+ exposes globalThis.crypto.subtle
 * (the Web Crypto API) so AES-GCM operations work identically here to
 * the Cloudflare Workers runtime — no mocking needed.
 */

import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken } from "./ga4TokenCrypto.js";

// 64-char hex strings = 32 bytes = AES-256
const KEY_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("ga4TokenCrypto", () => {
  it("1. roundtrip: encrypt then decrypt returns original plaintext", async () => {
    const plaintext = "ya29.example-refresh-token-string";
    const ciphertext = await encryptToken(plaintext, KEY_A);
    const recovered = await decryptToken(ciphertext, KEY_A);
    expect(recovered).toBe(plaintext);
  });

  it("2. different ciphertext per call (random IV), but both decrypt", async () => {
    const plaintext = "ya29.same-token-encrypted-twice";
    const ct1 = await encryptToken(plaintext, KEY_A);
    const ct2 = await encryptToken(plaintext, KEY_A);
    // IVs are random, so outputs must differ
    expect(ct1).not.toBe(ct2);
    // Both must still decrypt correctly
    expect(await decryptToken(ct1, KEY_A)).toBe(plaintext);
    expect(await decryptToken(ct2, KEY_A)).toBe(plaintext);
  });

  it("3. wrong key throws", async () => {
    const ciphertext = await encryptToken("some-token", KEY_A);
    await expect(decryptToken(ciphertext, KEY_B)).rejects.toThrow();
  });

  it("4. malformed ciphertext throws", async () => {
    await expect(decryptToken("not-base64!!!!", KEY_A)).rejects.toThrow();
    await expect(decryptToken("", KEY_A)).rejects.toThrow();
  });

  it("5. truncated ciphertext throws", async () => {
    const ciphertext = await encryptToken("some-token", KEY_A);
    const truncated = ciphertext.slice(0, -4);
    await expect(decryptToken(truncated, KEY_A)).rejects.toThrow();
  });

  it("6. empty plaintext roundtrips", async () => {
    const ciphertext = await encryptToken("", KEY_A);
    const recovered = await decryptToken(ciphertext, KEY_A);
    expect(recovered).toBe("");
  });

  it("7. multi-byte UTF-8 plaintext roundtrips", async () => {
    const plaintext = "hello 🔐 world";
    const ciphertext = await encryptToken(plaintext, KEY_A);
    const recovered = await decryptToken(ciphertext, KEY_A);
    expect(recovered).toBe(plaintext);
  });

  it("8. long plaintext roundtrips (1KB)", async () => {
    // 1024 printable ASCII characters
    const plaintext = Array.from(
      { length: 1024 },
      (_, i) => String.fromCharCode(0x20 + (i % 95)),
    ).join("");
    const ciphertext = await encryptToken(plaintext, KEY_A);
    const recovered = await decryptToken(ciphertext, KEY_A);
    expect(recovered).toBe(plaintext);
  });

  it("9. invalid hex characters throw with prefixed error", async () => {
    // 64 chars long but contains non-hex 'g' — without a regex check, parseInt
    // would silently coerce to NaN→0 and quietly corrupt the key bytes.
    const badKey = "g".repeat(64);
    await expect(encryptToken("plaintext", badKey)).rejects.toThrow(/ga4TokenCrypto:/);
  });

  it("10. wrong-length hex key throws with prefixed error", async () => {
    await expect(encryptToken("plaintext", "deadbeef")).rejects.toThrow(/ga4TokenCrypto:/);
  });
});
