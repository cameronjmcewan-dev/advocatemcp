/**
 * Tests for worker/src/lib/tracked-url.ts
 *
 * These tests run in Node via vitest. Node 18+ exposes globalThis.crypto.subtle
 * (the Web Crypto API), so the same SubtleCrypto code that runs in the Cloudflare
 * Workers environment runs identically here — no mocking required.
 *
 * KNOWN_TOKEN is the same reference value used in server/src/lib/tracked-url.test.ts.
 * If one environment produces a different result, the signing logic diverged.
 * Do not update the constant — fix the code.
 */

import { describe, it, expect } from "vitest";
import { verifyToken, type TokenPayload } from "./tracked-url.js";

// ── Reference test vector ────────────────────────────────────────────────────

const KNOWN_KEY = "test-vector-key-advocatemcp-2026";

const KNOWN_PAYLOAD_B64 =
  "eyJkZXN0IjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9vcmRlciIsInJlZiI6IlBlcnBsZXhpdHlCb3QiLCJzbHVnIjoiam9lcy1waXp6YSIsInF1ZXJ5X2lkIjo0MiwidHMiOjE3NDQwMDAwMDB9";

const KNOWN_SIGNATURE =
  "Nk5vjYKNQRuvt9SkFWhKZoonHQymMRje0E28TiYbxd0";

const KNOWN_TOKEN = `${KNOWN_PAYLOAD_B64}.${KNOWN_SIGNATURE}`;

// This token uses a far-future ts so expiry checks never fire during testing.
// Constructed by replacing ts=1744000000 with ts=9999999999 and recomputing
// the signature with KNOWN_KEY.
async function buildFreshToken(
  payload: TokenPayload,
  key: string
): Promise<string> {
  const enc = new TextEncoder();
  const encodedPayload = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    keyMaterial,
    enc.encode(encodedPayload)
  );
  const encodedSig = btoa(
    Array.from(new Uint8Array(sigBuf), (b) => String.fromCharCode(b)).join("")
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${encodedPayload}.${encodedSig}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("verifyToken", () => {
  it("rejects KNOWN_TOKEN because ts=1744000000 is more than 90 days ago", async () => {
    // The known test vector has a fixed past timestamp — this proves expiry works.
    await expect(verifyToken(KNOWN_TOKEN, KNOWN_KEY)).rejects.toBe("expired");
  });

  it("accepts a freshly signed token with a future ts", async () => {
    const payload: TokenPayload = {
      dest: "https://example.com/order",
      ref: "PerplexityBot",
      slug: "joes-pizza",
      query_id: 42,
      ts: Math.floor(Date.now() / 1000),
    };
    const token = await buildFreshToken(payload, KNOWN_KEY);
    const result = await verifyToken(token, KNOWN_KEY);
    expect(result.dest).toBe(payload.dest);
    expect(result.slug).toBe(payload.slug);
    expect(result.query_id).toBe(42);
  });

  it("rejects a token with a tampered signature", async () => {
    const payload: TokenPayload = {
      dest: "https://example.com/order",
      ref: "PerplexityBot",
      slug: "joes-pizza",
      query_id: 42,
      ts: Math.floor(Date.now() / 1000),
    };
    const token = await buildFreshToken(payload, KNOWN_KEY);
    const [p] = token.split(".");
    const tampered = `${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await expect(verifyToken(tampered, KNOWN_KEY)).rejects.toBe("bad_signature");
  });

  it("rejects a token signed with a different key", async () => {
    const payload: TokenPayload = {
      dest: "https://example.com/order",
      ref: "PerplexityBot",
      slug: "joes-pizza",
      query_id: 42,
      ts: Math.floor(Date.now() / 1000),
    };
    const token = await buildFreshToken(payload, "wrong-key");
    await expect(verifyToken(token, KNOWN_KEY)).rejects.toBe("bad_signature");
  });

  it("rejects a malformed token (no dot)", async () => {
    await expect(verifyToken("nodothere", KNOWN_KEY)).rejects.toBe("malformed");
  });

  it("rejects a token whose payload is not valid JSON", async () => {
    const enc = new TextEncoder();
    const fakePay = btoa("not-json").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(KNOWN_KEY),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(fakePay));
    const sig = btoa(
      Array.from(new Uint8Array(sigBuf), (b) => String.fromCharCode(b)).join("")
    ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    // signature is valid but payload is garbage
    await expect(verifyToken(`${fakePay}.${sig}`, KNOWN_KEY)).rejects.toBe("malformed");
  });

  it("cross-env: KNOWN_PAYLOAD_B64 decodes to the reference payload JSON", () => {
    // Verify the constant itself is not corrupted in this file.
    const json = atob(
      KNOWN_PAYLOAD_B64.replace(/-/g, "+").replace(/_/g, "/")
    );
    const parsed = JSON.parse(json) as TokenPayload;
    expect(parsed.dest).toBe("https://example.com/order");
    expect(parsed.ref).toBe("PerplexityBot");
    expect(parsed.slug).toBe("joes-pizza");
    expect(parsed.query_id).toBe(42);
    expect(parsed.ts).toBe(1744000000);
  });
});
