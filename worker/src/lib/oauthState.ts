/**
 * HMAC-signed state token for OAuth flows. Generic version of the
 * pattern introduced for GA4 in lib/ga4State.ts; extracted here so
 * Google Search Console (Phase 3 PR 2), Stripe (Phase 4 PR 1), and
 * any future OAuth integration can reuse the same anti-CSRF state
 * machinery without copy-pasting.
 *
 * Domain separation: each caller passes a unique domain prefix (e.g.
 * "ga4-state:v1:" or "gsc-state:v1:"). The HMAC input is
 * `<domain-prefix><base64url-encoded-payload>`, so a state signed for
 * one OAuth flow CANNOT verify against another flow even though they
 * share the signing key (TOKEN_SIGNING_KEY).
 *
 * Token format: <base64url(JSON payload)>.<base64url(HMAC digest)>
 * Payload shape: { slug, nonce, ts } — extensible per-domain via
 * generic param.
 *
 * Expiry: MAX_AGE_SECONDS=600. Future-dated tokens beyond
 * SKEW_TOLERANCE=60s are also rejected (defense against forged
 * far-future ts values).
 */

export interface OAuthStateBase {
  slug:  string;
  nonce: string;
  ts:    number;
}

const MAX_AGE_SECONDS = 600;
const SKEW_TOLERANCE  = 60;
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
    throw new Error("oauthState: malformed");
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

export async function signState<T extends OAuthStateBase>(
  payload: T,
  signingKey: string,
  domainPrefix: string,
): Promise<string> {
  const encodedPayload = strToBase64url(JSON.stringify(payload));
  const hmacInput = enc.encode(domainPrefix + encodedPayload);
  const key = await importHmacKey(signingKey, "sign");
  const sigBuf = await crypto.subtle.sign("HMAC", key, hmacInput);
  const encodedSig = toBase64url(new Uint8Array(sigBuf));
  return `${encodedPayload}.${encodedSig}`;
}

/**
 * Verify a signed OAuth state token.
 *
 * Throws:
 *   Error("oauthState: malformed")         — can't parse token structure or JSON
 *   Error("oauthState: invalid signature") — HMAC mismatch (wrong key or tampering)
 *   Error("oauthState: expired")           — ts older than MAX_AGE_SECONDS or beyond skew
 */
export async function verifyState<T extends OAuthStateBase = OAuthStateBase>(
  token: string,
  signingKey: string,
  domainPrefix: string,
): Promise<T> {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    throw new Error("oauthState: malformed");
  }

  const encodedPayload = token.slice(0, dotIdx);
  const encodedSig     = token.slice(dotIdx + 1);

  // Decode the claimed signature bytes first — malformed base64url = malformed token
  let claimedSigBytes: Uint8Array;
  try {
    claimedSigBytes = base64urlToBytes(encodedSig);
  } catch {
    throw new Error("oauthState: malformed");
  }

  // Constant-time HMAC verify using Web Crypto (spec-guaranteed constant time)
  const hmacInput = enc.encode(domainPrefix + encodedPayload);
  const key = await importHmacKey(signingKey, "verify");
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", key, claimedSigBytes as BufferSource, hmacInput);
  } catch {
    throw new Error("oauthState: malformed");
  }
  if (!valid) {
    throw new Error("oauthState: invalid signature");
  }

  // Parse payload JSON — valid signature guarantees it came from us, but
  // still guard against structural corruption.
  let payload: T;
  try {
    const jsonStr = new TextDecoder().decode(base64urlToBytes(encodedPayload));
    payload = JSON.parse(jsonStr) as T;
  } catch {
    throw new Error("oauthState: malformed");
  }

  if (
    typeof payload.slug  !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.ts    !== "number"
  ) {
    throw new Error("oauthState: malformed");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  // Reject both stale tokens AND future-dated tokens (allow SKEW_TOLERANCE of
  // clock drift for legitimate small drift between issuer and verifier). Without
  // the upper bound, a forged future-ts token would extend the validity window.
  const drift = nowSeconds - payload.ts;
  if (drift > MAX_AGE_SECONDS) {
    throw new Error("oauthState: expired");
  }
  if (drift < -SKEW_TOLERANCE) {
    throw new Error("oauthState: expired");
  }

  return payload;
}
