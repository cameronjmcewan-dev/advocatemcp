/**
 * Signed activation token — Phase 3 self-serve onboarding flow.
 *
 * A customer-facing token that proves the holder is authorized to activate
 * a specific business slug. Minted by `POST /admin/activation-token` (today,
 * manually for testing) and eventually by the Stripe webhook on successful
 * payment (future session). Verified by `POST /api/activate` before running
 * `activateDomain`.
 *
 * Wire format is identical to `worker/src/lib/tracked-url.ts`:
 *
 *     <base64url(JSON payload)>.<base64url(HMAC-SHA256 digest)>
 *
 * HMAC is computed over the ASCII bytes of the base64url-encoded payload
 * string — NOT the original JSON, NOT the decoded bytes. Same rule as
 * tracked-url.ts. Base64url strings use only ASCII characters, so UTF-8
 * bytes === ASCII bytes, but the rule is explicit because cross-
 * implementation drift on this point is the #1 source of silent token
 * mismatches.
 *
 * Why not share tracked-url.ts:
 *
 *   - Different payload shape (slug/iat/exp vs dest/ref/slug/query_id/ts)
 *   - Different TTL semantics (explicit exp in payload vs fixed 90-day
 *     max-age read at verify time)
 *   - Different signing key (ACTIVATION_SIGNING_KEY vs TOKEN_SIGNING_KEY)
 *     — keys are isolated by purpose so a leak of one doesn't compromise
 *     the other
 *
 * The base64url helper is duplicated rather than imported so this file
 * has no internal dependencies beyond Web Crypto and TextEncoder.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActivationTokenPayload {
  /** Business slug this token authorizes activation for. */
  slug: string;
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Expires-at, Unix seconds. Verification rejects when `now > exp`. */
  exp: number;
}

export type ActivationTokenError = "malformed" | "bad_signature" | "expired";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default token lifetime — 24 hours. */
export const DEFAULT_TTL_SECONDS = 24 * 3600;

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
 * Mint a signed activation token.
 *
 * @param payload  Object with `slug` — the business this token authorizes.
 * @param signingKey  HMAC-SHA256 signing key (env.ACTIVATION_SIGNING_KEY).
 * @param ttlSeconds  Token lifetime in seconds. Default 24 hours. Pass a
 *                    negative value to mint an already-expired token for
 *                    testing.
 */
export async function signActivationToken(
  payload: { slug: string },
  signingKey: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const fullPayload: ActivationTokenPayload = { slug: payload.slug, iat, exp };

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
 * Verify a signed activation token.
 * Returns the decoded payload on success.
 * Throws a typed `ActivationTokenError` string on any failure — callers must
 * catch and map to customer-facing error codes.
 */
export async function verifyActivationToken(
  token: string,
  signingKey: string,
): Promise<ActivationTokenPayload> {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    throw "malformed" satisfies ActivationTokenError;
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
    throw "malformed" satisfies ActivationTokenError;
  }
  const expectedSigBytes = new Uint8Array(expectedSigBuf);

  if (actualSigBytes.length !== expectedSigBytes.length) {
    throw "bad_signature" satisfies ActivationTokenError;
  }
  // Constant-time-ish comparison. Not defending against sophisticated timing
  // attacks, but avoids the obvious early-exit leak.
  let mismatch = 0;
  for (let i = 0; i < expectedSigBytes.length; i++) {
    mismatch |= (actualSigBytes[i]! ^ expectedSigBytes[i]!);
  }
  if (mismatch !== 0) {
    throw "bad_signature" satisfies ActivationTokenError;
  }

  let payload: ActivationTokenPayload;
  try {
    const jsonStr = new TextDecoder().decode(base64urlToBytes(encodedPayload));
    payload = JSON.parse(jsonStr) as ActivationTokenPayload;
  } catch {
    throw "malformed" satisfies ActivationTokenError;
  }

  if (
    typeof payload.slug !== "string" ||
    payload.slug.length === 0 ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    throw "malformed" satisfies ActivationTokenError;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds > payload.exp) {
    throw "expired" satisfies ActivationTokenError;
  }

  return payload;
}
