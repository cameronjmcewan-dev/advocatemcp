/**
 * Signed access token — Phase C cross-origin auth foundation.
 *
 * Short-lived (15-minute) stateless bearer token issued to customers on
 * successful login via `POST /api/auth/login` and on token refresh via
 * `POST /api/auth/refresh`. Verified by the worker's Bearer middleware
 * on every authenticated API call — stateless verification, no D1
 * lookup on the hot path.
 *
 * This is the THIRD in-house signed-token implementation in the worker:
 *
 *   - `worker/src/lib/tracked-url.ts` (Phase 1) — attribution tokens,
 *     90-day lifetime, TOKEN_SIGNING_KEY
 *   - `worker/src/lib/activation-token.ts` (Phase 3) — self-serve
 *     activation tokens, 24-hour lifetime, ACTIVATION_SIGNING_KEY
 *   - this file (Phase C) — access tokens, 15-minute lifetime,
 *     ACCESS_TOKEN_SIGNING_KEY
 *
 * All three share the same wire format and HMAC-over-ASCII-bytes rule.
 * All three are signed with HMAC-SHA256 via Web Crypto. Keys are
 * isolated by purpose — a leak of one must not compromise the others.
 *
 * Wire format is identical to `activation-token.ts` and `tracked-url.ts`:
 *
 *     <base64url(JSON payload)>.<base64url(HMAC-SHA256 digest)>
 *
 * HMAC is computed over the ASCII bytes of the base64url-encoded payload
 * string — NOT the original JSON, NOT the decoded bytes. Same rule as
 * the other two signed-token libraries. Base64url strings use only
 * ASCII characters, so UTF-8 bytes === ASCII bytes, but the rule is
 * explicit because cross-implementation drift on this point is the #1
 * source of silent token mismatches.
 *
 * Why not share tracked-url.ts or activation-token.ts:
 *
 *   - Different payload shape (sub/role/tenant_id/email/full_name/iat/exp
 *     vs slug/iat/exp vs dest/ref/slug/query_id/ts)
 *   - Different TTL (15 minutes vs 24 hours vs 90 days)
 *   - Different signing key (ACCESS_TOKEN_SIGNING_KEY vs the other two)
 *     — keys are isolated by purpose so a leak of one doesn't compromise
 *     the others
 *
 * The base64url helper is duplicated rather than imported so this file
 * has no internal dependencies beyond Web Crypto and TextEncoder.
 *
 * Refresh tokens are NOT handled in this file. Refresh tokens are opaque
 * random values stored in the D1 sessions table and verified by hash
 * lookup. See `worker/src/auth.ts` (`generateSessionToken`, `hashToken`)
 * and `worker/src/portalDb.ts` (`createSession`, `getSessionByToken`,
 * `deleteSession`) for the refresh token side.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  /** Subject — the user's D1 id from the users table. */
  sub: string;
  /** User role — "admin" or "client" today. */
  role: string;
  /**
   * Direct FK to businesses.id for customer users (role="client" typically).
   * NULL for admin users, who relate to businesses via user_business_access.
   */
  tenant_id: string | null;
  /** User email, cached so GET /api/client/me avoids a D1 lookup. */
  email: string;
  /** Full name, cached for display. NULL if the user has no full_name set. */
  full_name: string | null;
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Expires-at, Unix seconds. Verification rejects when `now > exp`. */
  exp: number;
}

export type AccessTokenError = "malformed" | "bad_signature" | "expired";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default access token lifetime — 15 minutes (900 seconds). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const enc = new TextEncoder();

// ── base64url codec ──────────────────────────────────────────────────────────

function bytesToBase64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]!);
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(s: string): Uint8Array {
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

// ── Sign ─────────────────────────────────────────────────────────────────────

/**
 * Mint a signed access token.
 *
 * @param claims      User claims to embed in the token payload. The `iat`
 *                    and `exp` fields are computed and added automatically;
 *                    pass everything else.
 * @param signingKey  HMAC-SHA256 signing key (env.ACCESS_TOKEN_SIGNING_KEY).
 * @param ttlSeconds  Token lifetime in seconds. Default 15 minutes. Pass a
 *                    negative value to mint an already-expired token for
 *                    testing.
 */
export async function signAccessToken(
  claims: Omit<AccessTokenPayload, "iat" | "exp">,
  signingKey: string,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const fullPayload: AccessTokenPayload = {
    sub:       claims.sub,
    role:      claims.role,
    tenant_id: claims.tenant_id,
    email:     claims.email,
    full_name: claims.full_name,
    iat,
    exp,
  };

  const jsonBytes = enc.encode(JSON.stringify(fullPayload));
  const encodedPayload = bytesToBase64url(jsonBytes);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    keyMaterial,
    enc.encode(encodedPayload),
  );
  const encodedSig = bytesToBase64url(new Uint8Array(sigBuf));

  return `${encodedPayload}.${encodedSig}`;
}

// ── Verify ───────────────────────────────────────────────────────────────────

/**
 * Verify a signed access token.
 * Returns the decoded payload on success.
 * Throws a typed `AccessTokenError` string on any failure — callers must
 * catch and map to HTTP 401 responses (or trigger the refresh flow for
 * "expired" errors on a client that has a refresh cookie).
 */
export async function verifyAccessToken(
  token: string,
  signingKey: string,
): Promise<AccessTokenPayload> {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    throw "malformed" satisfies AccessTokenError;
  }

  const encodedPayload = token.slice(0, dotIdx);
  const encodedSig = token.slice(dotIdx + 1);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // HMAC over the ASCII bytes of the encoded payload string (see file header).
  const expectedSigBuf = await crypto.subtle.sign(
    "HMAC",
    keyMaterial,
    enc.encode(encodedPayload),
  );

  let actualSigBytes: Uint8Array;
  try {
    actualSigBytes = base64urlToBytes(encodedSig);
  } catch {
    throw "malformed" satisfies AccessTokenError;
  }
  const expectedSigBytes = new Uint8Array(expectedSigBuf);

  if (actualSigBytes.length !== expectedSigBytes.length) {
    throw "bad_signature" satisfies AccessTokenError;
  }
  // Constant-time-ish comparison. Not defending against sophisticated timing
  // attacks, but avoids the obvious early-exit leak.
  let mismatch = 0;
  for (let i = 0; i < expectedSigBytes.length; i++) {
    mismatch |= (actualSigBytes[i]! ^ expectedSigBytes[i]!);
  }
  if (mismatch !== 0) {
    throw "bad_signature" satisfies AccessTokenError;
  }

  let payload: AccessTokenPayload;
  try {
    const jsonStr = new TextDecoder().decode(base64urlToBytes(encodedPayload));
    payload = JSON.parse(jsonStr) as AccessTokenPayload;
  } catch {
    throw "malformed" satisfies AccessTokenError;
  }

  // Shape validation — every required field must be present with the right type.
  // tenant_id and full_name are string-or-null; everything else is non-empty
  // string or number. Note typeof null === "object", so null checks are explicit.
  if (
    typeof payload.sub       !== "string" || payload.sub.length   === 0 ||
    typeof payload.role      !== "string" || payload.role.length  === 0 ||
    !(payload.tenant_id === null || typeof payload.tenant_id === "string") ||
    typeof payload.email     !== "string" || payload.email.length === 0 ||
    !(payload.full_name === null || typeof payload.full_name === "string") ||
    typeof payload.iat       !== "number" ||
    typeof payload.exp       !== "number"
  ) {
    throw "malformed" satisfies AccessTokenError;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds > payload.exp) {
    throw "expired" satisfies AccessTokenError;
  }

  return payload;
}
