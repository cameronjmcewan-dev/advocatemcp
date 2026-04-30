// Auth utilities: PBKDF2 password hashing, session tokens, cookie parsing.
// All crypto uses the Web Crypto API — available in all CF Workers environments.

// AMC-007: PBKDF2 iteration count migration.
//
// 2023 OWASP recommendation for PBKDF2-SHA256 is 600_000 iterations,
// BUT Cloudflare Workers' Web Crypto implementation hard-caps PBKDF2
// at 100_000 iterations as a DDoS-protection measure (any higher value
// throws NotSupportedError at runtime). See:
//   https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
//
// So while the encoded-hash format and the rehash-on-login plumbing
// stay (for future-proofing if we move auth to Railway / Argon2), the
// actual TARGET_ITERATIONS on the Workers runtime is pinned to the
// platform ceiling. Documented in docs/followups.md as
// "auth iteration count blocked on Workers PBKDF2 cap — consider
// argon2 via Railway for the verify path".
//
// Hash format on disk:
//   pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>
//
// Legacy rows (raw hex hash, no prefix) verify the same way — both
// formats now use 100k iterations, but the encoded form remains
// useful so a future iteration bump (e.g. when CF raises the cap or
// when we move verify off-Workers) doesn't require a second migration.
const TARGET_ITERATIONS = 100_000;
const LEGACY_ITERATIONS = 100_000;
const HASH_PREFIX = "pbkdf2-sha256";
const SESSION_COOKIE    = "amcp_session";
const SESSION_MAX_AGE   = 60 * 60 * 24 * 30; // 30 days in seconds

// ── Internal helpers ───────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Run PBKDF2 with the supplied iteration count. Internal — public APIs
 *  use hashPassword (defaults to TARGET_ITERATIONS) and verifyPassword
 *  (uses the count embedded in the stored hash). */
async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

// ── Password hashing ───────────────────────────────────────────────────────

export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Hash a password at the current target iteration count and return the
 * full encoded hash including iterations and salt:
 *   pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>
 *
 * The salt parameter remains for backward compat with callers that
 * generate the salt out-of-band (e.g. registration flow that persists
 * the salt to a separate column). When called with that legacy shape
 * it returns just the raw hash hex (no prefix) so the existing column
 * layout works unchanged. Pass `encoded: true` to opt into the new
 * self-contained format.
 *
 * NEW callers should use `hashPasswordEncoded(password)` which generates
 * a fresh salt and returns the full encoded string in one call.
 */
export async function hashPassword(
  password: string,
  salt: string,
  opts: { iterations?: number } = {},
): Promise<string> {
  return pbkdf2(password, salt, opts.iterations ?? TARGET_ITERATIONS);
}

/** Hash a password and return the self-contained encoded form. */
export async function hashPasswordEncoded(password: string): Promise<string> {
  const salt = generateSalt();
  const hash = await pbkdf2(password, salt, TARGET_ITERATIONS);
  return `${HASH_PREFIX}$${TARGET_ITERATIONS}$${salt}$${hash}`;
}

interface ParsedStoredHash {
  iterations: number;
  salt: string | null;     // null = legacy raw-hash format, caller supplies salt separately
  hashHex: string;
}

function parseStoredHash(stored: string, legacySalt: string | null): ParsedStoredHash | null {
  if (stored.startsWith(`${HASH_PREFIX}$`)) {
    const parts = stored.split("$");
    if (parts.length !== 4) return null;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1000) return null;
    return { iterations, salt: parts[2], hashHex: parts[3] };
  }
  // Legacy format: raw hex hash, salt comes from the column it was
  // stored in originally. 100k iterations was the only count ever used
  // in this format.
  if (!legacySalt) return null;
  return { iterations: LEGACY_ITERATIONS, salt: null, hashHex: stored };
}

/** Constant-time-ish hex string equality used internally. */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Verify a password against the stored hash. Returns a plain boolean
 * for backward compat with all existing callers. The stored hash MAY
 * use the legacy raw-hex format (with `salt` from the column) OR the
 * new self-contained encoded format (in which case `salt` is ignored).
 *
 * To opt into rehash-on-login, callers should call
 * `verifyAndMaybeRehash` instead — that function returns the rehash
 * payload alongside the boolean.
 */
export async function verifyPassword(
  password: string,
  salt: string,
  storedHash: string,
): Promise<boolean> {
  const parsed = parseStoredHash(storedHash, salt);
  if (!parsed) return false;
  const effectiveSalt = parsed.salt ?? salt;
  const computed = await pbkdf2(password, effectiveSalt, parsed.iterations);
  return constantTimeHexEqual(computed, parsed.hashHex);
}

export interface VerifyAndRehashResult {
  ok: boolean;
  /** True iff the stored hash uses an iteration count below
   *  TARGET_ITERATIONS AND the password was correct. Caller should
   *  persist `rehashedEncoded` to the password column and (if storing
   *  in the legacy 2-column format) clear / migrate the salt column. */
  needsRehash: boolean;
  /** When `ok && needsRehash`, this is the new self-contained encoded
   *  hash that supersedes the legacy stored value. */
  rehashedEncoded?: string;
}

/**
 * Verify with rehash hint. Use from new login flows to transparently
 * upgrade legacy 100k-iteration hashes to TARGET_ITERATIONS without
 * disturbing the user. Existing callers that just need a yes/no should
 * keep using `verifyPassword`.
 */
export async function verifyAndMaybeRehash(
  password: string,
  salt: string,
  storedHash: string,
): Promise<VerifyAndRehashResult> {
  const parsed = parseStoredHash(storedHash, salt);
  if (!parsed) return { ok: false, needsRehash: false };
  const effectiveSalt = parsed.salt ?? salt;
  const computed = await pbkdf2(password, effectiveSalt, parsed.iterations);
  if (!constantTimeHexEqual(computed, parsed.hashHex)) {
    return { ok: false, needsRehash: false };
  }
  if (parsed.iterations < TARGET_ITERATIONS) {
    return {
      ok: true,
      needsRehash: true,
      rehashedEncoded: await hashPasswordEncoded(password),
    };
  }
  return { ok: true, needsRehash: false };
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

// AMC-003: SameSite=Strict on the portal session cookie. Both the
// dashboard origin (customers.advocatemcp.com) and the marketing site
// origin (advocatemcp.com / www.advocatemcp.com) are same-site under
// the modern eTLD+1 definition (.advocatemcp.com), so user-initiated
// navigation between them DOES send the cookie. What Strict blocks is
// cross-site requests from any other origin — exactly the CSRF surface
// the prior Lax policy left open. The Origin allowlist on
// /api/client/* (see assertSafeOrigin) is the second defense layer.
const SESSION_SAMESITE = "SameSite=Strict";

export function sessionCookieHeader(token: string): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Secure",
    SESSION_SAMESITE,
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
    SESSION_SAMESITE,
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
