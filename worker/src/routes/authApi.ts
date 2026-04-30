/**
 * Phase C — cross-origin auth endpoints.
 *
 * Implements the three auth endpoints for customer-facing Phase C/D:
 *
 *   POST /api/auth/login    — validate credentials, issue access token +
 *                             refresh cookie
 *   POST /api/auth/logout   — revoke the current session, clear refresh
 *                             cookie (idempotent)
 *   POST /api/auth/refresh  — exchange refresh cookie for a new access
 *                             token (rotates the refresh token)
 *
 * Plus the Bearer-first session middleware helper used by both the new
 * Phase C endpoints and the existing /api/client/* endpoints (once Commit 5
 * wires them up):
 *
 *   getSessionFromRequest(request, env) — resolves the authenticated user
 *                             from Authorization: Bearer (new path) or
 *                             amcp_session cookie (legacy admin path)
 *
 * This file does NOT register any routes in portal.ts. Route registration
 * for all three new endpoints is explicitly Commit 5's job. At Commit 4's
 * deploy, these handlers are unreachable — production behavior is byte-
 * for-byte unchanged.
 *
 * ── Design decisions carried over from the Phase C proposal
 *
 *   - Bearer tokens are stateless, short-lived (15 min), signed via
 *     worker/src/lib/access-token.ts with HMAC-SHA256 and
 *     env.ACCESS_TOKEN_SIGNING_KEY. No DB lookup on the happy auth path
 *     for Bearer requests.
 *   - Refresh tokens are opaque 32-byte random values, hashed (SHA-256),
 *     stored in the D1 sessions table via the existing createSession
 *     helper. 30-day lifetime matching SESSION_TTL_MS in portalDb.ts.
 *     Delivered to the browser as an HttpOnly Secure SameSite=Strict
 *     cookie scoped to /api/auth/refresh only.
 *   - Token rotation on /api/auth/refresh: create new session FIRST,
 *     then delete old. Creating-first ensures a failure between create
 *     and delete still leaves the user with a valid new refresh token.
 *     Deleting-first would create a window where a failure leaves the
 *     user unable to refresh at all.
 *   - Login uses constant-time dummy password verification when the
 *     email is not found, to prevent timing-based email enumeration.
 *     The existing authLogin at portal.ts:143 has a timing leak (early
 *     return on "user not found") — this new handler fixes the leak
 *     for the Phase C path; the existing admin path still has the leak
 *     and should be hardened in a future session. Logged in the Phase C
 *     session notes as a found-during-reading item.
 *   - Logout is idempotent: returns 200 {ok:true} regardless of whether
 *     the refresh cookie was present, whether the session row existed,
 *     or whether the delete succeeded. Never leaks whether a session
 *     existed.
 *   - All endpoints wrap their responses with withCors({credentials: true})
 *     because the refresh cookie needs Access-Control-Allow-Credentials
 *     to be set on the response for the browser to accept the Set-Cookie
 *     header across origins.
 *
 * ── tenant_id sourcing
 *
 * handleAuthLogin does a direct D1 SELECT that includes tenant_id in the
 * column list, rather than calling portalDb.ts's getUserByEmail (which
 * returns the existing User interface without tenant_id). This preserves
 * the Phase C Commit 4 constraint of not modifying portalDb.ts while
 * still producing correct access tokens for customer users once Phase F's
 * Stripe webhook starts minting them with non-null tenant_id. Admin users
 * have tenant_id = NULL in the DB, which round-trips cleanly through
 * AccessTokenPayload.tenant_id (typed as string | null).
 *
 * The cookie-path in getSessionFromRequest always returns tenant_id = null
 * because (a) the existing getSessionByToken in portalDb.ts only returns
 * the legacy User fields without tenant_id, (b) all users who currently
 * authenticate via the legacy cookie path are admins (tenant_id IS null
 * for them), and (c) customer users will always use the Bearer path which
 * reads tenant_id from the access token payload. If a future customer
 * user ever ends up with a legacy session cookie, the cookie-path will
 * need to be extended to fetch tenant_id separately — flagged as a future
 * followup.
 */

import type { Env } from "../types";
import {
  verifyPassword,
  verifyAndMaybeRehash,
  generateSessionToken,
  hashToken,
  getSessionToken,
  refreshCookieHeader,
  clearRefreshCookieHeader,
  getRefreshToken,
} from "../auth";
import {
  getSessionByToken,
  deleteSession,
  checkRateLimit,
  recordLoginAttempt,
} from "../portalDb";
import {
  signAccessToken,
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenError,
} from "../lib/access-token";
import { withCors, handleCorsPreflight } from "../lib/cors";

// ── AuthContext — the unified shape produced by getSessionFromRequest ──────

/**
 * The authenticated-user context produced by getSessionFromRequest.
 * Flat shape so consumers don't need to know whether the context came
 * from a Bearer access token (stateless) or from a legacy session cookie
 * (DB lookup).
 *
 * Field names match SessionWithUser's Session.user_id + User.{email,
 * full_name, role} so Commit 5's replacement of requireSession in
 * portal.ts is a mechanical rename: `session.user.email` → `ctx.email`,
 * `session.user_id` → `ctx.user_id`, `session.user.role` → `ctx.role`.
 */
export interface AuthContext {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  tenant_id: string | null;
  /** Which auth mechanism produced this context. Useful for logging. */
  auth_method: "bearer" | "cookie";
}

// ── getSessionFromRequest — Bearer-first, cookie-fallback ──────────────────

/**
 * Resolve the authenticated user from a request. Checks Authorization
 * Bearer first (new Phase C path, stateless), then falls back to the
 * amcp_session cookie (legacy admin path, DB lookup).
 *
 * Returns null if neither produces a valid authenticated context.
 *
 * Bearer path: pure crypto verification, no DB hit on the happy path.
 * Invalid or expired access tokens return null — consumers should not
 * distinguish between "no Bearer" and "bad Bearer" in their responses
 * (to minimize information leakage) but MAY want to log the error type
 * for debugging.
 *
 * Cookie path: byte-for-byte compatible with the existing requireSession
 * helper in portal.ts. Sets tenant_id = null because getSessionByToken
 * doesn't return tenant_id — see the file header for why this is
 * currently safe (all cookie-path users are admins).
 */
export async function getSessionFromRequest(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  // ── Bearer path ────────────────────────────────────────────────────────
  const authHeader = request.headers.get("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ") && env.ACCESS_TOKEN_SIGNING_KEY) {
    const accessToken = authHeader.slice(7).trim();
    if (accessToken.length > 0) {
      try {
        const payload = await verifyAccessToken(accessToken, env.ACCESS_TOKEN_SIGNING_KEY);
        return {
          user_id:     payload.sub,
          email:       payload.email,
          full_name:   payload.full_name,
          role:        payload.role,
          tenant_id:   payload.tenant_id,
          auth_method: "bearer",
        };
      } catch (err) {
        // verifyAccessToken throws AccessTokenError strings
        // ("malformed" | "bad_signature" | "expired"). Fall through
        // to the cookie path — an admin with both a Bearer header
        // (e.g. from Postman) and an amcp_session cookie should still
        // be able to authenticate via the cookie.
        void (err as AccessTokenError);
      }
    }
  }

  // ── Cookie path (legacy admin session) ─────────────────────────────────
  const cookieToken = getSessionToken(request);
  if (!cookieToken) return null;
  const session = await getSessionByToken(env.DB, cookieToken);
  if (!session) return null;

  return {
    user_id:     session.user_id,
    email:       session.user.email,
    full_name:   session.user.full_name,
    role:        session.user.role,
    // Cookie path is admin-only in practice today. See file header for
    // the full rationale and the deferred followup if this ever changes.
    tenant_id:   null,
    auth_method: "cookie",
  };
}

// ── JSON helpers (Phase C scoped — not shared with portal.ts's helpers) ──

function jsonOk(body: unknown, request: Request, status = 200): Response {
  const resp = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  return withCors(resp, request, { credentials: true });
}

function jsonErr(
  status: number,
  errorCode: string,
  request: Request,
): Response {
  const resp = new Response(
    JSON.stringify({ ok: false, error_code: errorCode }),
    { status, headers: { "Content-Type": "application/json" } },
  );
  return withCors(resp, request, { credentials: true });
}

// ── Dummy PBKDF2 constants for constant-time "user not found" path ─────────
//
// When handleAuthLogin is called with an email that doesn't exist, we
// still run verifyPassword against these dummy values to keep the
// overall timing indistinguishable from a real "user exists, wrong
// password" outcome. Without this, an attacker could enumerate valid
// emails by measuring response time — real emails take ~100k PBKDF2
// iterations, fake emails return instantly.
//
// The dummy salt and hash are arbitrary 64-char hex strings. They do
// not correspond to any real password. The verifyPassword call will
// always return false for any input password because we pass a zero
// hash that no real password hashes to.
const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// ── User DB row shape including tenant_id ──────────────────────────────────
//
// Direct shape for the authApi login lookup. Includes tenant_id, which
// portalDb.ts's User interface does not (see file header for why we
// don't modify portalDb.ts). Phase C Commit 4 does a direct D1 SELECT
// with this explicit column list instead of calling getUserByEmail.

interface UserRowWithTenant {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  full_name: string | null;
  role: string;
  tenant_id: string | null;
}

async function getUserByEmailWithTenant(
  db: D1Database,
  email: string,
): Promise<UserRowWithTenant | null> {
  const row = await db
    .prepare(
      `SELECT id, email, password_hash, salt, full_name, role, tenant_id
       FROM users WHERE email = ? LIMIT 1`,
    )
    .bind(email.toLowerCase().trim())
    .first<UserRowWithTenant>();
  return row ?? null;
}

// ── POST /api/auth/login ──────────────────────────────────────────────────
//
// Request: {email, password} as JSON
// Success: 200 {access_token, expires_in, user: {...}} + Set-Cookie amcp_refresh
// Errors:
//   400 invalid_body          — missing or malformed JSON
//   401 invalid_credentials   — wrong email or password (never leaks which)
//   429 rate_limited          — 5 failed attempts in 15 minutes
//   500 platform_error        — signing key not configured

export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  if (!env.ACCESS_TOKEN_SIGNING_KEY) {
    console.error(JSON.stringify({
      auth: true,
      event: "login_platform_error",
      reason: "ACCESS_TOKEN_SIGNING_KEY missing from env",
    }));
    return jsonErr(500, "platform_error", request);
  }

  // Parse JSON body
  let email = "";
  let password = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    email    = typeof body.email    === "string" ? body.email    : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return jsonErr(400, "invalid_body", request);
  }
  if (!email || !password) {
    return jsonErr(400, "invalid_body", request);
  }

  const identifier = email.toLowerCase().trim();

  // Rate limit BEFORE any DB lookup — prevents brute-force and
  // enumeration. Cheap DB read-only call that counts failed attempts
  // in the last 15 minutes.
  const allowed = await checkRateLimit(env.DB, identifier);
  if (!allowed) {
    console.warn(JSON.stringify({
      auth: true,
      event: "login_rate_limited",
      identifier,
    }));
    return jsonErr(429, "rate_limited", request);
  }

  // Fetch the user — may return null if no such email.
  const userRow = await getUserByEmailWithTenant(env.DB, identifier);

  // Constant-time password verification: ALWAYS call verify*, either
  // with the real salt/hash or with the dummy constants. This prevents
  // timing-based email enumeration.
  //
  // AMC-007: verifyAndMaybeRehash returns a rehash payload alongside
  // the boolean so legacy 100k-iteration hashes upgrade transparently
  // on the next login.
  const salt = userRow?.salt          ?? DUMMY_SALT;
  const hash = userRow?.password_hash ?? DUMMY_HASH;
  const verify = await verifyAndMaybeRehash(password, salt, hash);
  const passwordOk = verify.ok;

  if (!userRow || !passwordOk) {
    // Record the failed attempt for rate limiting. Best-effort: if the
    // write fails, we still return the same error — we don't want the
    // attempt-logging failure to leak timing.
    try {
      await recordLoginAttempt(env.DB, identifier);
    } catch (err) {
      console.warn(JSON.stringify({
        auth: true,
        event: "login_attempt_log_warning",
        error: String(err),
      }));
    }
    return jsonErr(401, "invalid_credentials", request);
  }

  // AMC-007: Best-effort upgrade legacy 100k-iteration hashes. Salt
  // column is set to "" since the new encoded format is self-contained.
  // Failure here is non-fatal — login still proceeds; next login will
  // retry the upgrade.
  if (verify.needsRehash && verify.rehashedEncoded) {
    try {
      await env.DB
        .prepare("UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?")
        .bind(verify.rehashedEncoded, "", new Date().toISOString(), userRow.id)
        .run();
    } catch (err) {
      console.warn(JSON.stringify({
        auth: true, event: "pbkdf2_rehash_failed", user_id: userRow.id, error: String(err),
      }));
    }
  }

  // Success path — mint a new refresh session row and a new access token.
  //
  // Inlining the INSERT instead of using portalDb's createSession because
  // createSession generates its own opaque token internally and we need
  // to control the raw token so we can set it on the response cookie.
  // createSession returns {session, token} but doesn't let us supply the
  // raw token — its token is randomly generated inside the function.
  const refreshRawToken = generateSessionToken();
  const refreshTokenHash = await hashToken(refreshRawToken);
  const sessionId = crypto.randomUUID().replace(/-/g, "");
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, userRow.id, refreshTokenHash, expiresIso, nowIso, nowIso)
    .run();

  const accessToken = await signAccessToken(
    {
      sub:       userRow.id,
      role:      userRow.role,
      tenant_id: userRow.tenant_id,
      email:     userRow.email,
      full_name: userRow.full_name,
    },
    env.ACCESS_TOKEN_SIGNING_KEY,
  );

  console.log(JSON.stringify({
    auth: true,
    event: "login_success",
    user_id: userRow.id,
    role: userRow.role,
  }));

  const body = {
    access_token: accessToken,
    expires_in:   ACCESS_TOKEN_TTL_SECONDS,
    user: {
      id:        userRow.id,
      email:     userRow.email,
      full_name: userRow.full_name,
      role:      userRow.role,
      tenant_id: userRow.tenant_id,
    },
  };
  const resp = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie":   refreshCookieHeader(refreshRawToken),
    },
  });
  return withCors(resp, request, { credentials: true });
}

// ── POST /api/auth/logout ─────────────────────────────────────────────────
//
// Idempotent. Best-effort delete of the session row matching the refresh
// cookie. Always returns 200 with the cookie-clearing Set-Cookie header.
// Never distinguishes "session existed" from "session didn't exist" —
// would leak information about whether the client had a valid session.

export async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
  const refreshRaw = getRefreshToken(request);
  if (refreshRaw) {
    try {
      await deleteSession(env.DB, refreshRaw);
    } catch (err) {
      // Best-effort — ignore errors. Logging for observability.
      console.warn(JSON.stringify({
        auth: true,
        event: "logout_delete_warning",
        error: String(err),
      }));
    }
  }
  console.log(JSON.stringify({ auth: true, event: "logout" }));

  const resp = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie":   clearRefreshCookieHeader(),
    },
  });
  return withCors(resp, request, { credentials: true });
}

// ── POST /api/auth/refresh ────────────────────────────────────────────────
//
// Reads amcp_refresh cookie → looks up session → CREATES NEW session row
// FIRST → deletes old session row → mints new access token → returns
// {access_token, expires_in} + new refresh cookie.
//
// The create-before-delete ordering is intentional. If delete fails after
// create succeeds, the user has a valid new refresh token in their cookie
// and the old row lingers harmlessly (it'll be cleaned up on its own
// expiry). If we deleted first and the create failed, the user would be
// logged out with no valid cookie — worse UX.

export async function handleAuthRefresh(request: Request, env: Env): Promise<Response> {
  if (!env.ACCESS_TOKEN_SIGNING_KEY) {
    console.error(JSON.stringify({
      auth: true,
      event: "refresh_platform_error",
      reason: "ACCESS_TOKEN_SIGNING_KEY missing from env",
    }));
    return jsonErr(500, "platform_error", request);
  }

  const refreshRaw = getRefreshToken(request);
  if (!refreshRaw) {
    return jsonErr(401, "no_refresh_cookie", request);
  }

  // Look up the session by the raw refresh token. getSessionByToken hashes
  // internally and joins against the users table so the returned session
  // includes the user's fields.
  const session = await getSessionByToken(env.DB, refreshRaw);
  if (!session) {
    console.warn(JSON.stringify({
      auth: true,
      event: "refresh_invalid",
      reason: "session not found or expired",
    }));
    return jsonErr(401, "invalid_refresh", request);
  }

  // Fetch tenant_id separately. getSessionByToken doesn't return it
  // (per the Phase C constraint of not modifying portalDb.ts). For admin
  // users tenant_id will be null; for customer users it will be their
  // business id.
  const tenantRow = await env.DB
    .prepare("SELECT tenant_id FROM users WHERE id = ? LIMIT 1")
    .bind(session.user_id)
    .first<{ tenant_id: string | null }>();
  const tenant_id = tenantRow?.tenant_id ?? null;

  // Rotate: create the new session row FIRST, then delete the old one.
  //
  // Create-first-then-delete ordering is intentional. If the delete
  // fails after the create succeeds, the user has a valid new refresh
  // token in their cookie and the old row lingers harmlessly (it'll
  // expire on its own). If we deleted first and the create failed,
  // the user would be logged out with no valid cookie — worse UX.
  //
  // Inlining the INSERT instead of using portalDb's createSession for
  // the same reason as handleAuthLogin: createSession generates its
  // own raw token internally and doesn't let us supply the raw token
  // we need to put on the response cookie.
  const newRefreshRaw = generateSessionToken();
  const newTokenHash = await hashToken(newRefreshRaw);
  const newSessionId = crypto.randomUUID().replace(/-/g, "");
  const refreshNow = new Date();
  const newExpiresIso = new Date(refreshNow.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const refreshNowIso = refreshNow.toISOString();
  await env.DB
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(newSessionId, session.user_id, newTokenHash, newExpiresIso, refreshNowIso, refreshNowIso)
    .run();

  // Now delete the old session row (create-first-then-delete ordering).
  try {
    await deleteSession(env.DB, refreshRaw);
  } catch (err) {
    // Best-effort. Leaving the old row in place is safe — it'll expire
    // on its own. The user has a valid new refresh token either way.
    console.warn(JSON.stringify({
      auth: true,
      event: "refresh_old_delete_warning",
      error: String(err),
    }));
  }

  // Mint the new access token with the up-to-date claims.
  const accessToken = await signAccessToken(
    {
      sub:       session.user_id,
      role:      session.user.role,
      tenant_id,
      email:     session.user.email,
      full_name: session.user.full_name,
    },
    env.ACCESS_TOKEN_SIGNING_KEY,
  );

  console.log(JSON.stringify({
    auth: true,
    event: "refresh_success",
    user_id: session.user_id,
  }));

  const body = { access_token: accessToken, expires_in: ACCESS_TOKEN_TTL_SECONDS };
  const resp = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie":   refreshCookieHeader(newRefreshRaw),
    },
  });
  return withCors(resp, request, { credentials: true });
}

// ── CORS preflight handler re-export ──────────────────────────────────────
//
// The Commit 5 dispatch lines in portal.ts will call this for OPTIONS
// requests on /api/auth/login, /api/auth/logout, and /api/auth/refresh.
// Re-exported here so portal.ts only needs one import from authApi.
//
// credentials: true because all three auth endpoints need to send the
// refresh cookie on responses, which requires Access-Control-Allow-
// Credentials: true on preflight.

export function handleAuthPreflight(request: Request): Response {
  return handleCorsPreflight(request, { credentials: true });
}
