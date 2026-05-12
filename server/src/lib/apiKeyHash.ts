/**
 * API key hashing — SOC 2 CC6.1.
 *
 * Encoded format: `pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>`
 * Matches the password-hash format in worker/src/auth.ts for visual
 * familiarity. The salt is embedded per-row so iteration count can be
 * raised over time without a schema change.
 *
 * Iteration count: 100_000 — matches the Workers PBKDF2 cap so a future
 * worker-side hash of the same key (e.g. for portal-side dual-storage)
 * can use an identical encoding. PBKDF2-SHA256 at 100k is well above the
 * OWASP 2023 minimum for low-entropy passwords; API keys are 128-bit
 * UUIDs already (high entropy) so 100k is comfortable for those too.
 *
 * Timing-safety: verifyApiKeyHash uses crypto.timingSafeEqual on raw
 * Buffers of equal length. The length check is performed AFTER decoding
 * the stored hash so a structurally invalid stored encoding returns
 * false without leaking timing about the legitimate hash length.
 */

import crypto from "node:crypto";

const HASH_PREFIX = "pbkdf2-sha256";
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const PREFIX_LEN = 8;

export interface ApiKeyHashRecord {
  /** Encoded hash. Store in `businesses.api_key_hash`. */
  hash: string;
  /** First 8 chars of the raw key, lookup-indexed. Store in `businesses.api_key_prefix`. */
  prefix: string;
}

/**
 * Hash an API key for storage. Returns the encoded hash + lookup prefix.
 * Each call uses a fresh random salt, so the same input produces a
 * different hash each call — this is intentional. Verification works
 * regardless because the salt is embedded in the stored encoding.
 */
export function hashApiKey(rawKey: string): ApiKeyHashRecord {
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    throw new Error("hashApiKey: rawKey must be a non-empty string");
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.pbkdf2Sync(rawKey, salt, ITERATIONS, HASH_BYTES, "sha256");
  const encoded =
    `${HASH_PREFIX}$${ITERATIONS}$${salt.toString("hex")}$${derived.toString("hex")}`;
  return {
    hash: encoded,
    prefix: rawKey.slice(0, PREFIX_LEN),
  };
}

/**
 * Verify a raw API key against a stored encoded hash. Returns false on
 * any structural problem with the stored encoding (no exception).
 *
 * Constant-time on the actual byte comparison via crypto.timingSafeEqual.
 * Returns false for: null/undefined stored, wrong-prefix encoding,
 * non-integer iteration count, malformed hex, length mismatch.
 */
export function verifyApiKeyHash(
  rawKey: string,
  storedEncoded: string | null | undefined,
): boolean {
  if (!storedEncoded || typeof storedEncoded !== "string") return false;
  if (typeof rawKey !== "string" || rawKey.length === 0) return false;

  const parts = storedEncoded.split("$");
  if (parts.length !== 4) return false;
  if (parts[0] !== HASH_PREFIX) return false;

  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) {
    return false;
  }

  let salt: Buffer;
  let stored: Buffer;
  try {
    salt = Buffer.from(parts[2], "hex");
    stored = Buffer.from(parts[3], "hex");
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES) return false;
  if (stored.length !== HASH_BYTES) return false;

  const derived = crypto.pbkdf2Sync(rawKey, salt, iterations, HASH_BYTES, "sha256");
  if (derived.length !== stored.length) return false;
  return crypto.timingSafeEqual(derived, stored);
}

/**
 * Convenience: the lookup prefix for a raw key. Splitting this out so
 * call sites that only need the prefix (e.g. logging, audit metadata)
 * don't pay the PBKDF2 cost of hashApiKey.
 */
export function apiKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, PREFIX_LEN);
}

export const API_KEY_HASH_CONFIG = Object.freeze({
  iterations: ITERATIONS,
  saltBytes: SALT_BYTES,
  hashBytes: HASH_BYTES,
  prefixLen: PREFIX_LEN,
});
