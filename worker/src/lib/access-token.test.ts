/**
 * Tests for worker/src/lib/access-token.ts
 *
 * No network mocking needed — sign + verify are pure Web Crypto +
 * TextEncoder operations. Same fetch-free pattern as
 * activation-token.test.ts and tracked-url.test.ts.
 *
 * The tampered-signature test uses the middle-character swap pattern
 * from activation-token.test.ts (fixed in commit 63f1e30). DO NOT
 * change this test to tamper with the last character — the last
 * character of an HMAC-SHA256 signature has 2 padding bits and A→B
 * swaps there are absorbed into the padding, producing a flaky test.
 * The full analysis is in the Phase C session notes under the Commit 0
 * sidetrack section.
 */

import { describe, it, expect } from "vitest";
import {
  signAccessToken,
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from "./access-token.js";

const KEY = "test-vector-key-access-phase-c";

/** Canonical claims used across multiple tests. Represents a customer user. */
const CUSTOMER_CLAIMS = {
  sub:       "user_abcdef123",
  role:      "client",
  tenant_id: "biz_example_tenant",
  email:     "customer@example.com",
  full_name: "Test Customer",
} as const;

/** Admin user shape — tenant_id and full_name are nullable. */
const ADMIN_CLAIMS = {
  sub:       "admin_user_1",
  role:      "admin",
  tenant_id: null,
  email:     "admin@advocatemcp.com",
  full_name: null,
} as const;

describe("access-token", () => {
  // 1. Round-trip
  it("round-trips sign and verify with the same key", async () => {
    const token = await signAccessToken(CUSTOMER_CLAIMS, KEY);
    const payload = await verifyAccessToken(token, KEY);
    expect(payload.sub).toBe(CUSTOMER_CLAIMS.sub);
    expect(payload.role).toBe(CUSTOMER_CLAIMS.role);
    expect(payload.tenant_id).toBe(CUSTOMER_CLAIMS.tenant_id);
    expect(payload.email).toBe(CUSTOMER_CLAIMS.email);
    expect(payload.full_name).toBe(CUSTOMER_CLAIMS.full_name);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
  });

  // 2. Wrong key → bad_signature
  it("rejects tokens verified with a different key", async () => {
    const token = await signAccessToken(CUSTOMER_CLAIMS, KEY);
    await expect(verifyAccessToken(token, "different-key")).rejects.toBe("bad_signature");
  });

  // 3. Tampered signature → bad_signature
  //
  // Middle-character swap with a top-4-bit-flipping swap table. See the
  // file header for why this pattern exists and the Phase C session notes
  // for the base64url padding-bit analysis that produced it. Under no
  // circumstances should this test be "simplified" to a last-character
  // A/B swap — that pattern is flaky because of the 2 padding bits on
  // the last base64 character of a 256-bit HMAC signature.
  it("rejects tokens with a tampered signature", async () => {
    const token = await signAccessToken(CUSTOMER_CLAIMS, KEY);
    const dotIdx = token.lastIndexOf(".");
    const sigStart = dotIdx + 1;
    const sigLength = token.length - sigStart;
    const tamperIdx = sigStart + Math.floor(sigLength / 2);
    const originalChar = token[tamperIdx]!;
    const swappedChar = originalChar >= "A" && originalChar <= "P" ? "Q" : "A";
    const tampered = token.slice(0, tamperIdx) + swappedChar + token.slice(tamperIdx + 1);
    await expect(verifyAccessToken(tampered, KEY)).rejects.toBe("bad_signature");
  });

  // 4. Malformed tokens (multiple shapes in one test)
  it("rejects malformed tokens", async () => {
    await expect(verifyAccessToken("no-dot", KEY)).rejects.toBe("malformed");
    await expect(verifyAccessToken("", KEY)).rejects.toBe("malformed");
    await expect(verifyAccessToken(".empty-payload", KEY)).rejects.toBe("malformed");
    await expect(verifyAccessToken("empty-sig.", KEY)).rejects.toBe("malformed");
  });

  // 5. Expired token → expired
  it("rejects tokens whose exp is in the past", async () => {
    // Negative TTL produces exp = iat - 1, which is immediately expired.
    const token = await signAccessToken(CUSTOMER_CLAIMS, KEY, -1);
    await expect(verifyAccessToken(token, KEY)).rejects.toBe("expired");
  });

  // 6. Missing payload fields → malformed
  //
  // Manually construct a valid-signature token whose payload is missing a
  // required field (sub in this case). The production sign function always
  // includes every field, so the only way to exercise the shape-check
  // branch is to bypass the sign API and construct the token by hand.
  it("rejects tokens whose payload is missing required fields", async () => {
    const enc = new TextEncoder();
    // Payload missing `sub` — all other required fields present with correct types.
    const badPayload = {
      role:      "client",
      tenant_id: null,
      email:     "test@example.com",
      full_name: null,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
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
    await expect(verifyAccessToken(badToken, KEY)).rejects.toBe("malformed");
  });

  // 7. iat and exp correctly set for default TTL
  it("sets iat to now and exp to now + default TTL", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(CUSTOMER_CLAIMS, KEY);
    const after = Math.floor(Date.now() / 1000);
    const payload = await verifyAccessToken(token, KEY);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  // 8. Default TTL is exactly 15 minutes (900 seconds)
  it("uses a default TTL of 15 minutes (900 seconds)", async () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  // 9. All payload fields round-trip correctly (richer shape than activation-token)
  it("carries sub/role/tenant_id/email/full_name through sign+verify", async () => {
    const claims = {
      sub:       "user_abcdef123",
      role:      "admin",
      tenant_id: "biz_example_tenant",
      email:     "admin@advocatemcp.com",
      full_name: "Admin User",
    };
    const token = await signAccessToken(claims, KEY);
    const payload = await verifyAccessToken(token, KEY);
    expect(payload.sub).toBe(claims.sub);
    expect(payload.role).toBe(claims.role);
    expect(payload.tenant_id).toBe(claims.tenant_id);
    expect(payload.email).toBe(claims.email);
    expect(payload.full_name).toBe(claims.full_name);
  });

  // 10. Null tenant_id and null full_name are accepted (admin user shape)
  it("accepts null tenant_id and null full_name for admin users", async () => {
    const token = await signAccessToken(ADMIN_CLAIMS, KEY);
    const payload = await verifyAccessToken(token, KEY);
    expect(payload.sub).toBe(ADMIN_CLAIMS.sub);
    expect(payload.role).toBe("admin");
    expect(payload.tenant_id).toBeNull();
    expect(payload.full_name).toBeNull();
    expect(payload.email).toBe(ADMIN_CLAIMS.email);
  });
});
