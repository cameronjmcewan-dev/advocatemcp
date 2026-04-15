/**
 * Tests for the optional `aid` (agent id) claim on signed attribution tokens
 * from the verifier (worker) side.
 *
 * Back-compat requirements:
 *   - A legacy token (no aid field) must verify and produce a payload with
 *     `aid` undefined / absent.
 *   - A new token carrying aid must verify and expose the claim.
 */

import { describe, it, expect } from "vitest";
import { verifyToken, type TokenPayload } from "./tracked-url.js";

const KEY = "test-vector-key-advocatemcp-2026";

async function mintToken(payload: TokenPayload, key: string): Promise<string> {
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

function basePayload(): TokenPayload {
  return {
    dest: "https://example.com/order",
    ref: "PerplexityBot",
    slug: "joes-pizza",
    query_id: 42,
    ts: Math.floor(Date.now() / 1000),
  };
}

describe("verifyToken — aid claim", () => {
  it("verifies a new token carrying aid and exposes it on the returned payload", async () => {
    const p: TokenPayload = { ...basePayload(), aid: "claude-desktop" };
    const token = await mintToken(p, KEY);
    const result = await verifyToken(token, KEY);
    expect(result.aid).toBe("claude-desktop");
    expect(result.slug).toBe("joes-pizza");
  });

  it("back-compat: verifies a legacy token minted without aid and returns undefined aid", async () => {
    // Mint a token whose JSON has no "aid" key at all — simulates pre-aid mint path
    const p = basePayload();
    const token = await mintToken(p, KEY);
    const result = await verifyToken(token, KEY);
    expect(result.aid).toBeUndefined();
    expect(result.dest).toBe(p.dest);
  });

  it("back-compat: legacy on-wire shape (no aid field in JSON) has no 'aid' in the serialized payload", async () => {
    const p = basePayload();
    const token = await mintToken(p, KEY);
    const encodedPayload = token.split(".")[0]!;
    const padded = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
    const jsonStr = atob(padded + "=".repeat(pad));
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    expect("aid" in parsed).toBe(false);
  });
});
