/**
 * Tests for server/src/lib/apiKeyHash.ts (SOC 2 CC6.1).
 *
 * Verifies:
 *   - hashApiKey round-trips: hash(k) -> verifyApiKeyHash(k, hash) === true
 *   - wrong key returns false
 *   - same input twice yields different hashes (fresh salt each call)
 *   - apiKeyPrefix returns the first 8 chars
 *   - encoded format follows pbkdf2-sha256$<iter>$<saltHex>$<hashHex>
 *   - verifyApiKeyHash returns false on every structurally invalid encoding,
 *     never throws
 *   - timing-safe path is exercised even when lengths differ (returns false)
 */

import { describe, it, expect } from "vitest";
import {
  hashApiKey,
  verifyApiKeyHash,
  apiKeyPrefix,
  API_KEY_HASH_CONFIG,
} from "./apiKeyHash.js";

describe("hashApiKey", () => {
  it("produces the encoded pbkdf2-sha256 format", () => {
    const { hash, prefix } = hashApiKey("abcdef0123456789-test-key");
    const parts = hash.split("$");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("pbkdf2-sha256");
    expect(Number.parseInt(parts[1], 10)).toBe(API_KEY_HASH_CONFIG.iterations);
    // salt is 16 bytes -> 32 hex chars
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
    // hash is 32 bytes -> 64 hex chars
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(prefix).toBe("abcdef01");
  });

  it("throws on empty input", () => {
    expect(() => hashApiKey("")).toThrow();
    // @ts-expect-error — intentional bad input
    expect(() => hashApiKey(null)).toThrow();
  });

  it("two calls with the same input produce different hashes (fresh salt)", () => {
    const a = hashApiKey("same-key").hash;
    const b = hashApiKey("same-key").hash;
    expect(a).not.toBe(b);
  });
});

describe("verifyApiKeyHash", () => {
  it("round-trip: hash(k) verifies against k", () => {
    const k = "uuid-like-1234-5678-90ab-cdef";
    const { hash } = hashApiKey(k);
    expect(verifyApiKeyHash(k, hash)).toBe(true);
  });

  it("wrong key returns false", () => {
    const { hash } = hashApiKey("correct-key");
    expect(verifyApiKeyHash("wrong-key", hash)).toBe(false);
  });

  it("returns false (does not throw) for null / undefined / empty stored", () => {
    expect(verifyApiKeyHash("k", null)).toBe(false);
    expect(verifyApiKeyHash("k", undefined)).toBe(false);
    expect(verifyApiKeyHash("k", "")).toBe(false);
  });

  it("returns false (does not throw) for empty rawKey", () => {
    const { hash } = hashApiKey("anything");
    expect(verifyApiKeyHash("", hash)).toBe(false);
  });

  it("returns false for wrong prefix", () => {
    const { hash } = hashApiKey("k");
    const malformed = hash.replace("pbkdf2-sha256", "argon2id");
    expect(verifyApiKeyHash("k", malformed)).toBe(false);
  });

  it("returns false for non-integer iteration count", () => {
    const { hash } = hashApiKey("k");
    const parts = hash.split("$");
    const malformed = `${parts[0]}$notanumber$${parts[2]}$${parts[3]}`;
    expect(verifyApiKeyHash("k", malformed)).toBe(false);
  });

  it("returns false for absurd iteration count (>10M)", () => {
    const { hash } = hashApiKey("k");
    const parts = hash.split("$");
    const malformed = `${parts[0]}$99999999$${parts[2]}$${parts[3]}`;
    expect(verifyApiKeyHash("k", malformed)).toBe(false);
  });

  it("returns false for wrong number of fields", () => {
    expect(verifyApiKeyHash("k", "pbkdf2-sha256$100000")).toBe(false);
    expect(verifyApiKeyHash("k", "pbkdf2-sha256$100000$aa$bb$cc")).toBe(false);
  });

  it("returns false for wrong salt length", () => {
    const { hash } = hashApiKey("k");
    const parts = hash.split("$");
    const malformed = `${parts[0]}$${parts[1]}$aabb$${parts[3]}`; // 4-byte salt
    expect(verifyApiKeyHash("k", malformed)).toBe(false);
  });

  it("returns false for wrong hash length", () => {
    const { hash } = hashApiKey("k");
    const parts = hash.split("$");
    const malformed = `${parts[0]}$${parts[1]}$${parts[2]}$aabbccdd`;
    expect(verifyApiKeyHash("k", malformed)).toBe(false);
  });

  it("returns false for non-hex salt or hash", () => {
    const { hash } = hashApiKey("k");
    const parts = hash.split("$");
    const malformed = `${parts[0]}$${parts[1]}$ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ$${parts[3]}`;
    expect(verifyApiKeyHash("k", malformed)).toBe(false);
  });
});

describe("apiKeyPrefix", () => {
  it("returns first 8 chars", () => {
    expect(apiKeyPrefix("abcdef0123456789-deadbeef")).toBe("abcdef01");
  });

  it("returns the entire string when shorter than 8 chars", () => {
    expect(apiKeyPrefix("abc")).toBe("abc");
  });

  it("returns empty for empty", () => {
    expect(apiKeyPrefix("")).toBe("");
  });
});
