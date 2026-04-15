/**
 * Tests for the optional `aid` (agent id) claim on signed attribution tokens.
 *
 * Back-compat requirements:
 *   - A token minted without `aid` must be byte-identical to what today's
 *     code produces (so pre-aid tokens continue to verify on the worker).
 *   - A token minted WITH `aid` must carry the claim through the JSON payload.
 */

import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { buildToken, type TokenPayload } from "./tracked-url.js";

const KEY = "test-vector-key-advocatemcp-2026";

const BASE_PAYLOAD: TokenPayload = {
  dest: "https://example.com/order",
  ref: "PerplexityBot",
  slug: "joes-pizza",
  query_id: 42,
  ts: 1744000000,
};

const KNOWN_TOKEN_WITHOUT_AID =
  "eyJkZXN0IjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9vcmRlciIsInJlZiI6IlBlcnBsZXhpdHlCb3QiLCJzbHVnIjoiam9lcy1waXp6YSIsInF1ZXJ5X2lkIjo0MiwidHMiOjE3NDQwMDAwMDB9.Nk5vjYKNQRuvt9SkFWhKZoonHQymMRje0E28TiYbxd0";

function base64urlDecodeJson(b64: string): unknown {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const binary = Buffer.from(padded + "=".repeat(pad), "base64").toString("utf8");
  return JSON.parse(binary);
}

describe("buildToken — aid claim", () => {
  it("back-compat: payload WITHOUT aid produces the legacy reference token byte-for-byte", () => {
    expect(buildToken(BASE_PAYLOAD, KEY)).toBe(KNOWN_TOKEN_WITHOUT_AID);
  });

  it("back-compat: payload with explicit aid=undefined produces the legacy token (no null serialization)", () => {
    const p: TokenPayload = { ...BASE_PAYLOAD, aid: undefined };
    expect(buildToken(p, KEY)).toBe(KNOWN_TOKEN_WITHOUT_AID);
    // Decoded payload must not contain "aid" at all
    const encodedPayload = buildToken(p, KEY).split(".")[0]!;
    const decoded = base64urlDecodeJson(encodedPayload) as Record<string, unknown>;
    expect("aid" in decoded).toBe(false);
  });

  it("mints a token carrying aid when provided and signature verifies", () => {
    const p: TokenPayload = { ...BASE_PAYLOAD, aid: "claude-desktop" };
    const token = buildToken(p, KEY);
    const [encodedPayload, encodedSig] = token.split(".");
    expect(encodedPayload).toBeTruthy();
    expect(encodedSig).toBeTruthy();

    const decoded = base64urlDecodeJson(encodedPayload!) as TokenPayload;
    expect(decoded.aid).toBe("claude-desktop");
    expect(decoded.dest).toBe(BASE_PAYLOAD.dest);

    // Signature is HMAC-SHA256 over the ASCII bytes of the encoded payload
    const expected = crypto
      .createHmac("sha256", KEY)
      .update(encodedPayload!)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(encodedSig).toBe(expected);
  });

  it("different aid values produce different tokens", () => {
    const t1 = buildToken({ ...BASE_PAYLOAD, aid: "claude-desktop" }, KEY);
    const t2 = buildToken({ ...BASE_PAYLOAD, aid: "cursor" }, KEY);
    expect(t1).not.toBe(t2);
  });
});
