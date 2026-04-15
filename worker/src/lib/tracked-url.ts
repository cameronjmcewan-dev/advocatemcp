/**
 * Signed attribution token — worker (Cloudflare Workers) side.
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
 *     // HMAC is computed over ASCII bytes of encodedPayload string
 *     const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(signingKey), ...);
 *     const digest = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(encodedPayload));
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

export interface TokenPayload {
  dest: string;      // destination URL
  ref: string;       // crawler name (e.g. "PerplexityBot")
  slug: string;      // business slug
  query_id: number;  // queries.id row that generated this token
  ts: number;        // Unix timestamp in seconds
  aid?: string;      // optional agent id (e.g. "claude-desktop") — legacy tokens
                     // have no aid field; verifyToken returns it as undefined.
}

/** Token rejection reasons — callers log these as structured metrics. */
export type TokenError = "malformed" | "bad_signature" | "expired";

const TOKEN_MAX_AGE_SECONDS = 90 * 24 * 3600; // 90 days
const enc = new TextEncoder();

export function base64urlToBytes(s: string): Uint8Array {
  // Restore standard base64 padding before decoding
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const b64 = padded + "=".repeat(pad);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Verify a signed attribution token.
 * Returns the decoded payload on success.
 * Throws a TokenError string on any failure — callers must catch and log.
 */
export async function verifyToken(
  token: string,
  signingKey: string
): Promise<TokenPayload> {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    throw "malformed" satisfies TokenError;
  }

  const encodedPayload = token.slice(0, dotIdx);
  const encodedSig = token.slice(dotIdx + 1);

  // Import key material once per verification
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // HMAC is computed over the ASCII bytes of the encoded payload string (see file header).
  const expectedSigBuf = await crypto.subtle.sign(
    "HMAC",
    keyMaterial,
    enc.encode(encodedPayload)
  );

  // Constant-time comparison via HMAC of both sigs with a fresh ephemeral key
  // is overkill here since tokens are not session secrets, but we do a
  // byte-by-byte comparison to avoid obvious early-exit leaks.
  const actualSigBytes = base64urlToBytes(encodedSig);
  const expectedSigBytes = new Uint8Array(expectedSigBuf);

  if (actualSigBytes.length !== expectedSigBytes.length) {
    throw "bad_signature" satisfies TokenError;
  }
  let mismatch = 0;
  for (let i = 0; i < expectedSigBytes.length; i++) {
    mismatch |= (actualSigBytes[i]! ^ expectedSigBytes[i]!);
  }
  if (mismatch !== 0) {
    throw "bad_signature" satisfies TokenError;
  }

  // Decode payload
  let payload: TokenPayload;
  try {
    const jsonStr = new TextDecoder().decode(base64urlToBytes(encodedPayload));
    payload = JSON.parse(jsonStr) as TokenPayload;
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
  // `aid` is optional — absent on legacy tokens. If present it must be a string.
  if (payload.aid !== undefined && typeof payload.aid !== "string") {
    throw "malformed" satisfies TokenError;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - payload.ts > TOKEN_MAX_AGE_SECONDS) {
    throw "expired" satisfies TokenError;
  }

  return payload;
}
