/**
 * HMAC-signed state token for the GA4 OAuth flow.
 *
 * The OAuth state param prevents CSRF — a malicious site can't bounce a
 * user through Google's consent screen and capture their refresh token,
 * because they can't forge a valid state that returns to OUR callback
 * URL bound to the user's slug.
 *
 * Reuses TOKEN_SIGNING_KEY (already a deployed worker secret) but with a
 * domain-separation prefix `"ga4-state:v1:"` HMAC'd in front of the payload.
 * That makes ga4 state tokens and tracked-url tokens mutually unforgeable
 * even though they share signing material.
 *
 * ── What gets HMAC'd ────────────────────────────────────────────────────────
 *
 *   The HMAC input is the ASCII bytes of the string:
 *     "ga4-state:v1:" + base64url(JSON.stringify(payload))
 *
 *   The domain prefix is a plain ASCII string prepended before the
 *   base64url-encoded payload. Both are ASCII-safe, so:
 *     hmacInput = enc.encode("ga4-state:v1:" + encodedPayload)
 *
 *   This makes it impossible for a tracked-url token (whose HMAC input is
 *   only enc.encode(encodedPayload), no prefix) to satisfy the GA4 state
 *   check, even with the same key.
 *
 * Token format: <base64url(JSON {slug, nonce, ts})>.<base64url(HMAC)>
 *
 * Expiry: 600 seconds (10 minutes) — enough for the OAuth consent screen.
 */

export interface GA4State {
  slug:  string;
  nonce: string;  // 16-byte random hex, prevents replay across users
  ts:    number;  // unix seconds, used to expire after 10 min
}

const DOMAIN_PREFIX = "ga4-state:v1:";
const MAX_AGE_SECONDS = 600;
const enc = new TextEncoder();

// ── Internal helpers ──────────────────────────────────────────────────────────

function toBase64url(bytes: Uint8Array): string {
  return btoa(
    Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
  ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToBase64url(s: string): string {
  // Encode the UTF-8 bytes of s, not the JavaScript char codes. Naïve btoa(s)
  // throws on any code point > 0xFF, which surfaces as a runtime error rather
  // than the intended "malformed" path. Slug/nonce are ASCII in practice, but
  // routing through TextEncoder makes this binary-safe regardless.
  return toBase64url(enc.encode(s));
}

function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  let binary: string;
  try {
    binary = atob(padded + "=".repeat(pad));
  } catch {
    throw new Error("ga4State: malformed");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(
  signingKey: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function signGA4State(
  payload: GA4State,
  signingKey: string,
): Promise<string> {
  const encodedPayload = strToBase64url(JSON.stringify(payload));
  const hmacInput = enc.encode(DOMAIN_PREFIX + encodedPayload);
  const key = await importHmacKey(signingKey, "sign");
  const sigBuf = await crypto.subtle.sign("HMAC", key, hmacInput);
  const encodedSig = toBase64url(new Uint8Array(sigBuf));
  return `${encodedPayload}.${encodedSig}`;
}

/**
 * Verify a signed GA4 state token.
 *
 * Throws:
 *   Error("ga4State: malformed")         — can't parse token structure or JSON
 *   Error("ga4State: invalid signature") — HMAC mismatch (wrong key or tampering)
 *   Error("ga4State: expired")           — ts older than MAX_AGE_SECONDS
 */
export async function verifyGA4State(
  token: string,
  signingKey: string,
): Promise<GA4State> {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    throw new Error("ga4State: malformed");
  }

  const encodedPayload = token.slice(0, dotIdx);
  const encodedSig     = token.slice(dotIdx + 1);

  // Decode the claimed signature bytes first — malformed base64url = malformed token
  let claimedSigBytes: Uint8Array;
  try {
    claimedSigBytes = base64urlToBytes(encodedSig);
  } catch {
    throw new Error("ga4State: malformed");
  }

  // Constant-time HMAC verify using Web Crypto (spec-guaranteed constant time)
  const hmacInput = enc.encode(DOMAIN_PREFIX + encodedPayload);
  const key = await importHmacKey(signingKey, "verify");
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", key, claimedSigBytes as BufferSource, hmacInput);
  } catch {
    throw new Error("ga4State: malformed");
  }
  if (!valid) {
    throw new Error("ga4State: invalid signature");
  }

  // Parse payload JSON — valid signature guarantees it came from us, but
  // still guard against structural corruption.
  let payload: GA4State;
  try {
    const jsonStr = new TextDecoder().decode(base64urlToBytes(encodedPayload));
    payload = JSON.parse(jsonStr) as GA4State;
  } catch {
    throw new Error("ga4State: malformed");
  }

  if (
    typeof payload.slug  !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.ts    !== "number"
  ) {
    throw new Error("ga4State: malformed");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  // Reject both stale tokens AND future-dated tokens (allow 60s of clock skew
  // for legitimate small drift between issuer and verifier). Without the upper
  // bound, a forged future-ts token would extend the validity window.
  const SKEW_TOLERANCE = 60;
  const drift = nowSeconds - payload.ts;
  if (drift > MAX_AGE_SECONDS) {
    throw new Error("ga4State: expired");
  }
  if (drift < -SKEW_TOLERANCE) {
    throw new Error("ga4State: expired");
  }

  return payload;
}
