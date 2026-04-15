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
