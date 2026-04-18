/**
 * Signed attribution token — server (Node.js) side.
 *
 * Token format:
 *   <base64url(JSON payload)>.<base64url(HMAC-SHA256 digest)>
 *
 * ── CRITICAL: What gets HMAC'd ──────────────────────────────────────────────
 *
 *   The HMAC input is the ASCII bytes of the base64url-encoded payload string.
 *   NOT the original JSON bytes.
 *   NOT the decoded-from-base64 bytes.
 *
 *   Concretely:
 *     const encodedPayload = base64url(JSON.stringify(payload));
 *     hmac.update(encodedPayload);          // ← ASCII bytes of the encoded string
 *
 *   A base64url string uses only ASCII characters (A–Z, a–z, 0–9, -, _), so
 *   UTF-8 bytes === ASCII bytes here — but the comment is explicit because this
 *   is the most common cross-implementation drift point: one side hashes the
 *   encoded string, the other hashes the raw JSON or the decoded bytes, and
 *   every token silently mismatches.
 *
 * ── Test vector ──────────────────────────────────────────────────────────────
 *
 *   key     : "test-vector-key-advocatemcp-2026"
 *   payload : {"dest":"https://example.com/order","ref":"PerplexityBot",
 *               "slug":"joes-pizza","query_id":42,"ts":1744000000}
 *
 *   HMAC input (ASCII bytes of the base64url payload string — 176 bytes):
 *     eyJkZXN0IjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9vcmRlciIsInJlZiI6IlBlcnBsZXhpdHlCb3QiLCJzbHVnIjoiam9lcy1waXp6YSIsInF1ZXJ5X2lkIjo0MiwidHMiOjE3NDQwMDAwMDB9
 *
 *   base64url signature : Nk5vjYKNQRuvt9SkFWhKZoonHQymMRje0E28TiYbxd0
 *
 *   full token:
 *     eyJkZXN0IjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9vcmRlciIsInJlZiI6IlBlcnBsZXhpdHlCb3QiLCJzbHVnIjoiam9lcy1waXp6YSIsInF1ZXJ5X2lkIjo0MiwidHMiOjE3NDQwMDAwMDB9.Nk5vjYKNQRuvt9SkFWhKZoonHQymMRje0E28TiYbxd0
 */

import crypto from "crypto";

export interface TokenPayload {
  dest: string;      // destination URL
  ref: string;       // crawler name (e.g. "PerplexityBot")
  slug: string;      // business slug
  query_id: number;  // queries.id row that generated this token
  ts: number;        // Unix timestamp in seconds (Math.floor(Date.now() / 1000))
  aid?: string;      // optional agent id (e.g. "claude-desktop") — omitted from
                     // the serialized JSON when undefined so legacy tokens remain
                     // byte-identical. JSON.stringify drops undefined properties.
}

function base64urlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build a signed attribution token for the given payload.
 * Uses Node crypto (synchronous HMAC-SHA256).
 */
export function buildToken(payload: TokenPayload, signingKey: string): string {
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  // HMAC is computed over the ASCII bytes of the encoded payload string (see file header).
  const digest = crypto.createHmac("sha256", signingKey).update(encodedPayload).digest();
  const encodedSig = base64urlEncode(digest);
  return `${encodedPayload}.${encodedSig}`;
}

/** Token rejection reasons — callers log these as structured metrics. */
export type TokenError = "malformed" | "bad_signature" | "expired";

const TOKEN_MAX_AGE_SECONDS = 90 * 24 * 3600; // 90 days, mirrors worker/src/lib/tracked-url.ts

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

/**
 * Verify a signed attribution token.
 *
 * Returns the decoded payload on success; throws a `TokenError` string on any
 * failure. Mirrors the worker-side `verifyToken` in `worker/src/lib/tracked-url.ts`
 * exactly — the HMAC input is the ASCII bytes of the encoded payload string,
 * and the 90-day expiry is identical. Used by the `/r/:token/decode` endpoint
 * so customer sites can read `{ intent, ref, slug }` from an AI-referred
 * visitor's arrival token (Session 5).
 */
export function verifyToken(token: string, signingKey: string): TokenPayload {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    throw "malformed" satisfies TokenError;
  }
  const encodedPayload = token.slice(0, dotIdx);
  const encodedSig = token.slice(dotIdx + 1);

  const expected = crypto.createHmac("sha256", signingKey).update(encodedPayload).digest();
  const actual = base64urlDecode(encodedSig);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw "bad_signature" satisfies TokenError;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload).toString("utf8")) as TokenPayload;
  } catch {
    throw "malformed" satisfies TokenError;
  }
  if (
    typeof payload.dest !== "string" ||
    typeof payload.ref !== "string" ||
    typeof payload.slug !== "string" ||
    typeof payload.query_id !== "number" ||
    typeof payload.ts !== "number"
  ) {
    throw "malformed" satisfies TokenError;
  }
  if (payload.aid !== undefined && typeof payload.aid !== "string") {
    throw "malformed" satisfies TokenError;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - payload.ts > TOKEN_MAX_AGE_SECONDS) {
    throw "expired" satisfies TokenError;
  }
  return payload;
}
