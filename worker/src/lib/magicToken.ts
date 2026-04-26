/* HMAC-signed short-lived tokens for admin magic-login.
 *
 * Why this exists: admins need to log in AS a tenant to verify the
 * data isolation actually works (i.e. confirm tenants only see their
 * own data, not the admin view). The standard impersonation path
 * (?as=<slug>) keeps the admin's session role, so admin UI still
 * leaks through. A magic-login token, redeemed at /auth/magic, swaps
 * the cookie for a real tenant-role session — exactly what the
 * tenant gets when they log in normally.
 *
 * Same HMAC-SHA256 + base64url scheme as worker/src/lib/tracked-url.ts,
 * but a different payload + a much shorter TTL (5 minutes). Tokens
 * are NOT single-use today (we rely on the short window); single-use
 * enforcement would need a one-shot table in D1, can be added if a
 * threat model demands it.
 *
 * Threat model:
 *   - Admin already has full access to all tenant data via admin role,
 *     so a leaked magic token gives no additional capability vs the
 *     admin's own session.
 *   - 5-minute TTL means a leaked URL stops working quickly.
 *   - The cookie set on redemption is the standard amcp_session — same
 *     auth as if the tenant logged in themselves.
 */

const enc = new TextEncoder();
const MAGIC_TOKEN_TTL_SECONDS = 5 * 60;

export interface MagicTokenPayload {
  /** D1 users.id of the user we're authenticating AS. */
  user_id: string;
  /** Unix epoch seconds when this token was issued. */
  ts: number;
}

export type MagicTokenError = "malformed" | "bad_signature" | "expired";

/* base64url helpers — duplicated from tracked-url.ts so this module
 * is self-contained. Two helpers won't drift unless someone changes
 * the base64url spec, which would be a larger change anyway. */
function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const b64 = padded + "=".repeat(pad);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(signingKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/* Sign a magic-login token. */
export async function signMagicToken(
  payload: MagicTokenPayload,
  signingKey: string,
): Promise<string> {
  const encodedPayload = bytesToBase64url(enc.encode(JSON.stringify(payload)));
  const key = await importKey(signingKey);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(encodedPayload));
  const encodedSig = bytesToBase64url(new Uint8Array(sigBuf));
  return `${encodedPayload}.${encodedSig}`;
}

/* Verify a magic-login token. Returns the payload on success. Throws
 * a MagicTokenError string on any failure — callers must catch and
 * log structured. */
export async function verifyMagicToken(
  token: string,
  signingKey: string,
): Promise<MagicTokenPayload> {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    throw "malformed" satisfies MagicTokenError;
  }
  const encodedPayload = token.slice(0, dotIdx);
  const encodedSig     = token.slice(dotIdx + 1);

  const key = await importKey(signingKey);
  const expectedBuf = await crypto.subtle.sign("HMAC", key, enc.encode(encodedPayload));
  const expected = new Uint8Array(expectedBuf);
  let provided: Uint8Array;
  try { provided = base64urlToBytes(encodedSig); } catch { throw "malformed" satisfies MagicTokenError; }
  if (provided.length !== expected.length) throw "bad_signature" satisfies MagicTokenError;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided[i] ^ expected[i];
  if (diff !== 0) throw "bad_signature" satisfies MagicTokenError;

  let payload: MagicTokenPayload;
  try {
    const json = new TextDecoder().decode(base64urlToBytes(encodedPayload));
    payload = JSON.parse(json) as MagicTokenPayload;
  } catch { throw "malformed" satisfies MagicTokenError; }

  if (typeof payload.user_id !== "string" || typeof payload.ts !== "number") {
    throw "malformed" satisfies MagicTokenError;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - payload.ts > MAGIC_TOKEN_TTL_SECONDS) {
    throw "expired" satisfies MagicTokenError;
  }

  return payload;
}
