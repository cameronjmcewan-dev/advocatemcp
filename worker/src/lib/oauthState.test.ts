/**
 * Tests for worker/src/lib/oauthState.ts
 *
 * Runs in Node via vitest. Node 18+ exposes globalThis.crypto.subtle so
 * HMAC-SHA256 operations work identically to the Cloudflare Workers runtime.
 */

import { describe, it, expect } from "vitest";
import { signState, verifyState, type OAuthStateBase } from "./oauthState.js";

const KEY     = "test-signing-key-oauth-state-2026";
const ALT_KEY = "different-key-should-fail-verification";

const GA4_PREFIX = "ga4-state:v1:";
const GSC_PREFIX = "gsc-state:v1:";

const basePayload: OAuthStateBase = {
  slug:  "joes-pizza",
  nonce: "a1b2c3d4e5f6a1b2",
  ts:    Math.floor(Date.now() / 1000),
};

describe("oauthState", () => {
  it("1. roundtrip: sign then verify recovers exact payload", async () => {
    const token = await signState(basePayload, KEY, GA4_PREFIX);
    const result = await verifyState(token, KEY, GA4_PREFIX);
    expect(result.slug).toBe(basePayload.slug);
    expect(result.nonce).toBe(basePayload.nonce);
    expect(result.ts).toBe(basePayload.ts);
  });

  it("2. domain separation: ga4 token rejected when verified with gsc prefix", async () => {
    // A token signed with "ga4-state:v1:" must NOT verify when the verifier
    // expects "gsc-state:v1:", even with identical payload and signing key.
    const ga4Token = await signState(basePayload, KEY, GA4_PREFIX);
    await expect(verifyState(ga4Token, KEY, GSC_PREFIX)).rejects.toThrow("oauthState: invalid signature");
  });

  it("3. wrong key fails verify", async () => {
    const token = await signState(basePayload, KEY, GA4_PREFIX);
    await expect(verifyState(token, ALT_KEY, GA4_PREFIX)).rejects.toThrow("oauthState: invalid signature");
  });

  it("4. tampered payload fails verify", async () => {
    const token = await signState(basePayload, KEY, GA4_PREFIX);
    const [, sig] = token.split(".");
    // Replace the payload part with a modified slug
    const tamperedPayload = btoa(JSON.stringify({ ...basePayload, slug: "evil-corp" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tampered = `${tamperedPayload}.${sig}`;
    await expect(verifyState(tampered, KEY, GA4_PREFIX)).rejects.toThrow("oauthState: invalid signature");
  });

  it("5. expired token (ts older than 600s) throws", async () => {
    const expired: OAuthStateBase = {
      slug:  "acme",
      nonce: "deadbeef12345678",
      ts:    Math.floor(Date.now() / 1000) - 700,
    };
    const token = await signState(expired, KEY, GA4_PREFIX);
    await expect(verifyState(token, KEY, GA4_PREFIX)).rejects.toThrow("oauthState: expired");
  });

  it("6. future-dated token beyond skew tolerance throws", async () => {
    // 5 minutes ahead is well beyond the 60s skew tolerance
    const future: OAuthStateBase = {
      slug:  "acme",
      nonce: "future-attack-01",
      ts:    Math.floor(Date.now() / 1000) + 300,
    };
    const token = await signState(future, KEY, GA4_PREFIX);
    await expect(verifyState(token, KEY, GA4_PREFIX)).rejects.toThrow("oauthState: expired");
  });

  it("7. roundtrip with gsc prefix works independently", async () => {
    const token = await signState(basePayload, KEY, GSC_PREFIX);
    const result = await verifyState(token, KEY, GSC_PREFIX);
    expect(result.slug).toBe(basePayload.slug);
    expect(result.nonce).toBe(basePayload.nonce);
  });

  it("8. domain separation: gsc token rejected when verified with ga4 prefix", async () => {
    const gscToken = await signState(basePayload, KEY, GSC_PREFIX);
    await expect(verifyState(gscToken, KEY, GA4_PREFIX)).rejects.toThrow("oauthState: invalid signature");
  });

  it("9. malformed token (no dot) throws", async () => {
    await expect(verifyState("nodothere", KEY, GA4_PREFIX)).rejects.toThrow("oauthState: malformed");
  });

  it("10. token just under 600s old still passes (boundary check)", async () => {
    const recent: OAuthStateBase = {
      slug:  "boundary-biz",
      nonce: "boundary-test-99",
      ts:    Math.floor(Date.now() / 1000) - 599,
    };
    const token = await signState(recent, KEY, GA4_PREFIX);
    const result = await verifyState(token, KEY, GA4_PREFIX);
    expect(result.slug).toBe("boundary-biz");
  });

  it("11. small future drift (under skew tolerance) still passes", async () => {
    // 30 seconds ahead — within the 60s SKEW_TOLERANCE
    const drifted: OAuthStateBase = {
      slug:  "skew-biz",
      nonce: "skew-test-30s",
      ts:    Math.floor(Date.now() / 1000) + 30,
    };
    const token = await signState(drifted, KEY, GA4_PREFIX);
    const result = await verifyState(token, KEY, GA4_PREFIX);
    expect(result.slug).toBe("skew-biz");
  });

  it("12. generic type parameter works with extended payload", async () => {
    interface MyState extends OAuthStateBase {
      extra: string;
    }
    const extended: MyState = {
      slug:  "extended-biz",
      nonce: "ext-nonce-123",
      ts:    Math.floor(Date.now() / 1000),
      extra: "some-extra-field",
    };
    const token = await signState<MyState>(extended, KEY, "custom-prefix:v1:");
    const result = await verifyState<MyState>(token, KEY, "custom-prefix:v1:");
    expect(result.extra).toBe("some-extra-field");
    expect(result.slug).toBe("extended-biz");
  });
});
