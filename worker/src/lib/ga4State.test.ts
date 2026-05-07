/**
 * Tests for worker/src/lib/ga4State.ts
 *
 * Runs in Node via vitest. Node 18+ exposes globalThis.crypto.subtle so
 * HMAC-SHA256 operations work identically to the Cloudflare Workers runtime.
 */

import { describe, it, expect } from "vitest";
import { signGA4State, verifyGA4State, type GA4State } from "./ga4State.js";

const KEY = "test-signing-key-ga4-state-2026";
const ALT_KEY = "different-key-should-fail-verify";

const basePayload: GA4State = {
  slug: "joes-pizza",
  nonce: "a1b2c3d4e5f6a1b2",
  ts: Math.floor(Date.now() / 1000),
};

describe("ga4State", () => {
  it("1. roundtrip: sign then verify recovers exact payload", async () => {
    const token = await signGA4State(basePayload, KEY);
    const result = await verifyGA4State(token, KEY);
    expect(result.slug).toBe(basePayload.slug);
    expect(result.nonce).toBe(basePayload.nonce);
    expect(result.ts).toBe(basePayload.ts);
  });

  it("2. wrong key fails verify with 'invalid signature'", async () => {
    const token = await signGA4State(basePayload, KEY);
    await expect(verifyGA4State(token, ALT_KEY)).rejects.toThrow("ga4State: invalid signature");
  });

  it("3. tampered payload fails verify", async () => {
    const token = await signGA4State(basePayload, KEY);
    const [, sig] = token.split(".");
    // Replace the payload with a modified one
    const tamperedPayload = btoa(JSON.stringify({ ...basePayload, slug: "evil-corp" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tampered = `${tamperedPayload}.${sig}`;
    await expect(verifyGA4State(tampered, KEY)).rejects.toThrow("ga4State: invalid signature");
  });

  it("4. tampered signature fails verify", async () => {
    const token = await signGA4State(basePayload, KEY);
    const [payload] = token.split(".");
    const tampered = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await expect(verifyGA4State(tampered, KEY)).rejects.toThrow("ga4State: invalid signature");
  });

  it("5. expired token (ts older than 600s) fails with 'expired'", async () => {
    const expiredPayload: GA4State = {
      slug: "joes-pizza",
      nonce: "deadbeef12345678",
      ts: Math.floor(Date.now() / 1000) - 700, // 700s ago = expired
    };
    const token = await signGA4State(expiredPayload, KEY);
    await expect(verifyGA4State(token, KEY)).rejects.toThrow("ga4State: expired");
  });

  it("6. malformed token fails with 'malformed' (no dot)", async () => {
    await expect(verifyGA4State("nodothere", KEY)).rejects.toThrow("ga4State: malformed");
  });

  it("6b. malformed token fails with 'malformed' (non-base64)", async () => {
    await expect(verifyGA4State("not valid!!!!.also not valid!!!!!", KEY)).rejects.toThrow("ga4State: malformed");
  });

  it("7. domain separation: raw-HMAC token (no domain prefix) rejected by verifyGA4State", async () => {
    // Manually build a token that HMAC's only the encoded payload bytes —
    // no "ga4-state:v1:" prefix. This mimics a tracked-url-style token and
    // must be rejected even though the payload shape is valid.
    const payload = basePayload;
    const enc = new TextEncoder();
    const encodedPayload = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    // Sign raw encodedPayload bytes — no domain prefix
    const sigBuf = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(encodedPayload));
    const sig = btoa(Array.from(new Uint8Array(sigBuf), (b) => String.fromCharCode(b)).join(""))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const rawHmacToken = `${encodedPayload}.${sig}`;

    // verifyGA4State includes the domain prefix in the HMAC, so this must fail
    await expect(verifyGA4State(rawHmacToken, KEY)).rejects.toThrow("ga4State: invalid signature");
  });

  it("8. different nonces produce different signatures for same slug+ts", async () => {
    const p1: GA4State = { slug: "acme", nonce: "nonce-aaa", ts: 1744000000 };
    const p2: GA4State = { slug: "acme", nonce: "nonce-bbb", ts: 1744000000 };
    const t1 = await signGA4State(p1, KEY);
    const t2 = await signGA4State(p2, KEY);
    const sig1 = t1.split(".")[1];
    const sig2 = t2.split(".")[1];
    expect(sig1).not.toBe(sig2);
  });

  it("9. token just under 600s old still passes (boundary check)", async () => {
    const recentPayload: GA4State = {
      slug: "joes-pizza",
      nonce: "boundary-test-99",
      ts: Math.floor(Date.now() / 1000) - 599, // 1s under the limit
    };
    const token = await signGA4State(recentPayload, KEY);
    const result = await verifyGA4State(token, KEY);
    expect(result.slug).toBe("joes-pizza");
  });

  it("10. future-dated token beyond skew tolerance is rejected as expired", async () => {
    // A forged or clock-mangled token with ts in the far future should not
    // be accepted just because (now - ts) is negative. 5 minutes ahead is
    // well beyond the 60s skew tolerance.
    const futurePayload: GA4State = {
      slug: "joes-pizza",
      nonce: "future-attack-01",
      ts: Math.floor(Date.now() / 1000) + 300,
    };
    const token = await signGA4State(futurePayload, KEY);
    await expect(verifyGA4State(token, KEY)).rejects.toThrow(/ga4State: expired/);
  });

  it("11. small future drift (under skew tolerance) still passes", async () => {
    // 30 seconds ahead — within the 60s SKEW_TOLERANCE. Real-world clock
    // drift between worker and Google's token issuer can land here.
    const driftPayload: GA4State = {
      slug: "joes-pizza",
      nonce: "skew-test-30s",
      ts: Math.floor(Date.now() / 1000) + 30,
    };
    const token = await signGA4State(driftPayload, KEY);
    const result = await verifyGA4State(token, KEY);
    expect(result.slug).toBe("joes-pizza");
  });
});
