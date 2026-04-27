// Auth utilities: PBKDF2 password hashing, session tokens, cookie parsing.
// All crypto uses the Web Crypto API — available in all CF Workers environments.

const PBKDF2_ITERATIONS = 100_000;
const SESSION_COOKIE    = "amcp_session";
const SESSION_MAX_AGE   = 60 * 60 * 24 * 30; // 30 days in seconds

// ── Internal helpers ───────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Password hashing ───────────────────────────────────────────────────────

export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function verifyPassword(
  password: string,
  salt: string,
  storedHash: string
): Promise<boolean> {
  const computed = await hashPassword(password, salt);
  // Constant-time comparison to prevent timing attacks
  const enc = new TextEncoder();
  const a = enc.encode(computed);
  const b = enc.encode(storedHash);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

// ── Session tokens ─────────────────────────────────────────────────────────

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return bytesToHex(new Uint8Array(buf));
}

// ── Unique IDs ─────────────────────────────────────────────────────────────

export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// ── Cookie helpers ─────────────────────────────────────────────────────────

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function getSessionToken(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("Cookie"));
  return cookies[SESSION_COOKIE] ?? null;
}

// Cross-subdomain session cookie (Apr 27 2026). Domain=.advocatemcp.com
// makes the cookie visible on both customers.advocatemcp.com (the
// dashboard / portal) AND advocatemcp.com (the marketing site). When a
// logged-in user navigates to advocatemcp.com/Pricing the marketing
// site's auth-check fetch (site/js/marketing-auth.js) sends this cookie
// and gets back the user profile, swapping the nav from "Sign in" to
// the avatar dropdown.
//
// Migration note: the old cookies (Domain unset → host-only on
// customers.advocatemcp.com) are different cookies than the new ones
// (Domain=.advocatemcp.com). Existing sessions need one re-login after
// this deploys; acceptable pre-outreach.
const COOKIE_DOMAIN = ".advocatemcp.com";

export function sessionCookieHeader(token: string): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Domain=${COOKIE_DOMAIN}`,
    `Max-Age=${SESSION_MAX_AGE}`,
  ].join("; ");
}

export function clearSessionCookieHeader(): string {
  return [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Domain=${COOKIE_DOMAIN}`,
    "Max-Age=0",
  ].join("; ");
}

// ── Phase C refresh cookie helpers ─────────────────────────────────────────
// The Phase C hybrid auth design uses a separate cookie (amcp_refresh) for
// long-lived refresh tokens, distinct from the legacy amcp_session cookie
// above. The refresh cookie is:
//
//   - HttpOnly + Secure: inaccessible to JavaScript, TLS-only
//   - SameSite=Strict:   tightest cross-origin policy; the refresh cookie
//                        only rides on same-site requests. advocatemcp.com
//                        and customers.advocatemcp.com are same-site under
//                        the modern eTLD+1 definition so fetches from
//                        advocatemcp.com to customers.advocatemcp.com/api/auth/refresh
//                        DO send the cookie. Non-navigational cross-site
//                        requests and any unrelated third-party origins
//                        don't.
//   - Path=/api/auth/refresh: the cookie is ONLY sent to the refresh
//                        endpoint. Minimizes exposure — the refresh token
//                        never travels on any other API call.
//   - Max-Age=30 days:   matches SESSION_TTL_MS in portalDb.ts so the
//                        cookie lifetime and the sessions-table row
//                        lifetime stay in sync.
//
// The existing sessionCookieHeader above stays unchanged because it serves
// the legacy admin portal login at /auth/login, which uses a different
// SameSite policy (Lax) and a different path scope (/). Admin sessions and
// customer refresh tokens live in the same D1 sessions table but arrive
// via different cookies.

const REFRESH_COOKIE  = "amcp_refresh";
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds
const REFRESH_PATH    = "/api/auth/refresh";

export function refreshCookieHeader(token: string): string {
  return [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${REFRESH_PATH}`,
    `Domain=${COOKIE_DOMAIN}`,
    `Max-Age=${REFRESH_MAX_AGE}`,
  ].join("; ");
}

export function clearRefreshCookieHeader(): string {
  return [
    `${REFRESH_COOKIE}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${REFRESH_PATH}`,
    `Domain=${COOKIE_DOMAIN}`,
    "Max-Age=0",
  ].join("; ");
}

export function getRefreshToken(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("Cookie"));
  return cookies[REFRESH_COOKIE] ?? null;
}
