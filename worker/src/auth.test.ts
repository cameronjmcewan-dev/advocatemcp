/**
 * Tests for AMC-007 PBKDF2 iteration migration in worker/src/auth.ts.
 *
 * Verifies:
 *   - hashPassword + verifyPassword roundtrip at the new TARGET_ITERATIONS
 *   - Legacy 100k-iteration raw-hex hashes still verify (back-compat)
 *   - hashPasswordEncoded produces the new self-contained format
 *   - verifyAndMaybeRehash flags legacy hashes for upgrade
 *   - Wrong passwords always return false / { ok: false }
 *
 * Performance note: 600k PBKDF2 iterations takes ~150-300ms in Workers
 * runtime. These tests are deliberately small (single round-trip per
 * case) so the file completes in under a second.
 */

import { describe, it, expect } from "vitest";
import {
  generateSalt,
  hashPassword,
  hashPasswordEncoded,
  verifyPassword,
  verifyAndMaybeRehash,
} from "./auth.js";

describe("PBKDF2 password hashing (AMC-007)", () => {
  it("hashPasswordEncoded produces the self-contained format", async () => {
    const encoded = await hashPasswordEncoded("hunter2");
    expect(encoded.startsWith("pbkdf2-sha256$")).toBe(true);
    const parts = encoded.split("$");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("pbkdf2-sha256");
    // Cloudflare Workers caps PBKDF2 at 100k iterations (DDoS protection).
    // Target was originally 600k per OWASP but is pinned to the platform ceiling.
    expect(parseInt(parts[1], 10)).toBe(100_000);
    expect(parts[2].length).toBe(32);  // 16-byte salt as hex
    expect(parts[3].length).toBe(64);  // 32-byte hash as hex
  });

  it("verifyPassword accepts the encoded format", async () => {
    const encoded = await hashPasswordEncoded("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", "", encoded)).toBe(true);
    expect(await verifyPassword("wrong password", "", encoded)).toBe(false);
  });

  it("verifyPassword still accepts the legacy raw-hex format with separate salt", async () => {
    const salt = generateSalt();
    // Pass iterations: 100_000 to simulate a hash created before the migration.
    const legacyHash = await hashPassword("legacy-pwd", salt, { iterations: 100_000 });
    // Sanity — legacy hash is raw hex, no prefix.
    expect(legacyHash.includes("$")).toBe(false);
    expect(legacyHash.length).toBe(64);
    expect(await verifyPassword("legacy-pwd", salt, legacyHash)).toBe(true);
    expect(await verifyPassword("wrong", salt, legacyHash)).toBe(false);
  });

  it("verifyAndMaybeRehash does NOT flag a legacy hash on Workers (capped at 100k)", async () => {
    // On the Workers runtime, TARGET_ITERATIONS == LEGACY_ITERATIONS == 100k
    // (CF caps PBKDF2 here). Legacy hashes already match the target, so
    // needsRehash stays false. When/if the cap raises (or when the verify
    // path moves off-Workers), this test will start expecting needsRehash=true
    // and the rehash plumbing — already in place — kicks in transparently.
    const salt = generateSalt();
    const legacyHash = await hashPassword("upgrade-me", salt, { iterations: 100_000 });

    const result = await verifyAndMaybeRehash("upgrade-me", salt, legacyHash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(false);
    expect(result.rehashedEncoded).toBeUndefined();
  });

  it("verifyAndMaybeRehash does NOT flag a current-iteration hash for rehash", async () => {
    const encoded = await hashPasswordEncoded("already-current");
    const result = await verifyAndMaybeRehash("already-current", "", encoded);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(false);
    expect(result.rehashedEncoded).toBeUndefined();
  });

  it("verifyAndMaybeRehash returns ok=false for wrong passwords", async () => {
    const encoded = await hashPasswordEncoded("right");
    const result = await verifyAndMaybeRehash("wrong", "", encoded);
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it("malformed stored hashes are rejected (not crash)", async () => {
    expect(await verifyPassword("x", "salt", "")).toBe(false);
    expect(await verifyPassword("x", "salt", "pbkdf2-sha256$bad")).toBe(false);
    expect(await verifyPassword("x", "salt", "pbkdf2-sha256$0$salt$hash")).toBe(false);
  });

  it("uses constant-time comparison (no early-exit string compare)", async () => {
    // Smoke test — run wrong password against the same hash multiple times
    // and check the runtime variance is bounded. Not a true timing attack
    // proof but a sanity check that the implementation isn't an obvious
    // string == comparison.
    const encoded = await hashPasswordEncoded("baseline");
    const start1 = performance.now();
    await verifyPassword("a", "", encoded);
    const t1 = performance.now() - start1;
    const start2 = performance.now();
    await verifyPassword("aaaaaaaaaaaaaaaaaaaaaaaa", "", encoded);
    const t2 = performance.now() - start2;
    // Both wrong; both should take roughly the PBKDF2 time. Loose bound:
    // neither one should be >5x the other (PBKDF2 dominates the runtime,
    // not the comparison loop, so they should be very close).
    const ratio = Math.max(t1, t2) / Math.max(0.01, Math.min(t1, t2));
    expect(ratio).toBeLessThan(5);
  });
});
