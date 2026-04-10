/**
 * Tests for worker/src/lib/activation-token.ts
 *
 * No network mocking needed — sign + verify are pure Web Crypto + TextEncoder
 * operations. Same fetch-free pattern as tracked-url.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  signActivationToken,
  verifyActivationToken,
  DEFAULT_TTL_SECONDS,
} from "./activation-token.js";

const KEY = "test-vector-key-activation-phase-3";

describe("activation-token", () => {
  // 1. Round-trip
  it("round-trips sign and verify with the same key", async () => {
    const token = await signActivationToken({ slug: "dmre" }, KEY);
    const payload = await verifyActivationToken(token, KEY);
    expect(payload.slug).toBe("dmre");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
  });

  // 2. Wrong key → bad_signature
  it("rejects tokens verified with a different key", async () => {
    const token = await signActivationToken({ slug: "dmre" }, KEY);
    await expect(verifyActivationToken(token, "different-key")).rejects.toBe("bad_signature");
  });

  // 3. Tampered signature → bad_signature
  it("rejects tokens with a tampered signature", async () => {
    const token = await signActivationToken({ slug: "dmre" }, KEY);
    const lastChar = token.slice(-1);
    const swap = lastChar === "A" ? "B" : "A";
    const tampered = token.slice(0, -1) + swap;
    await expect(verifyActivationToken(tampered, KEY)).rejects.toBe("bad_signature");
  });

  // 4. Malformed tokens (multiple shapes in one test)
  it("rejects malformed tokens", async () => {
    await expect(verifyActivationToken("no-dot", KEY)).rejects.toBe("malformed");
    await expect(verifyActivationToken("", KEY)).rejects.toBe("malformed");
    await expect(verifyActivationToken(".empty-payload", KEY)).rejects.toBe("malformed");
    await expect(verifyActivationToken("empty-sig.", KEY)).rejects.toBe("malformed");
  });

  // 5. Expired token → expired
  it("rejects tokens whose exp is in the past", async () => {
    // Negative TTL produces exp = iat - 1, which is immediately expired.
    const token = await signActivationToken({ slug: "dmre" }, KEY, -1);
    await expect(verifyActivationToken(token, KEY)).rejects.toBe("expired");
  });

  // 6. Missing payload fields → malformed
  // Manually construct a valid-signature token whose payload is missing
  // required fields. The production sign function always includes slug/iat/exp,
  // so the only way to test the shape-check branch is to bypass the sign API.
  it("rejects tokens whose payload is missing required fields", async () => {
    const enc = new TextEncoder();
    // Payload missing `slug` — only iat and exp present.
    const badPayload = {
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const jsonBytes = enc.encode(JSON.stringify(badPayload));
    const b64 = btoa(String.fromCharCode(...jsonBytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(b64));
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const badToken = `${b64}.${sig}`;
    await expect(verifyActivationToken(badToken, KEY)).rejects.toBe("malformed");
  });

  // 7. iat and exp correctly set for default TTL
  it("sets iat to now and exp to now + default TTL", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signActivationToken({ slug: "dmre" }, KEY);
    const after = Math.floor(Date.now() / 1000);
    const payload = await verifyActivationToken(token, KEY);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(payload.exp - payload.iat).toBe(DEFAULT_TTL_SECONDS);
  });

  // 8. Default TTL is exactly 24 hours
  it("uses a default TTL of 24 hours (86400 seconds)", async () => {
    expect(DEFAULT_TTL_SECONDS).toBe(24 * 3600);
    expect(DEFAULT_TTL_SECONDS).toBe(86400);
  });
});
