/**
 * GA4 OAuth route handlers.
 *
 * Two entry points are exported and wired up in portal.ts (Task 1.6):
 *   handleGA4Start    — GET /oauth/ga4/start?slug=<slug>
 *   handleGA4Callback — GET /oauth/ga4/callback?code=<code>&state=<state>
 *
 * Flow:
 *   1. handleGA4Start generates a signed state token and redirects to Google.
 *   2. Google redirects back with code + state.
 *   3. handleGA4Callback verifies state (CSRF), exchanges code for refresh token,
 *      AES-GCM encrypts it, writes to ga4_connections D1 table, and redirects
 *      to /Settings.html?ga4=connected.
 *
 * On any error the user lands on /Settings.html?ga4=error&reason=<short-tag>
 * so the frontend can display a specific message.
 */

import type { Env } from "../types";
import { signGA4State, verifyGA4State } from "../lib/ga4State";
import { encryptToken } from "../lib/ga4TokenCrypto";

const SETTINGS_URL = "/Settings.html";

// ── handleGA4Start ────────────────────────────────────────────────────────────

/**
 * GET /oauth/ga4/start?slug=<slug>
 *
 * Generates a signed state token and redirects to Google's OAuth consent
 * screen. Called directly by the customer portal (Task 1.6 adds the POST
 * /api/client/ga4/start-link wrapper that sets the session slug and then
 * redirects here or returns the URL).
 */
export async function handleGA4Start(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");

  if (!slug) {
    return Response.json({ error: "slug is required" }, { status: 400 });
  }

  // 16 random bytes as hex = 32 hex chars — collision probability ~= 1/2^128
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");

  const state = await signGA4State(
    { slug, nonce, ts: Math.floor(Date.now() / 1000) },
    env.TOKEN_SIGNING_KEY ?? "",
  );

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("client_id",     env.GA4_OAUTH_CLIENT_ID     ?? "");
  authorizeUrl.searchParams.set("redirect_uri",  env.GA4_OAUTH_REDIRECT_URI  ?? "");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope",         "https://www.googleapis.com/auth/analytics.readonly");
  authorizeUrl.searchParams.set("access_type",   "offline");
  authorizeUrl.searchParams.set("prompt",        "consent");
  authorizeUrl.searchParams.set("state",         state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

// ── handleGA4Callback ─────────────────────────────────────────────────────────

/**
 * GET /oauth/ga4/callback?code=<code>&state=<state>
 *
 * Google redirects here after the user consents. Verifies the signed state
 * (CSRF protection), exchanges the code for tokens, encrypts the refresh
 * token with AES-256-GCM, persists it to D1, and redirects to the Settings
 * page.
 */
export async function handleGA4Callback(request: Request, env: Env): Promise<Response> {
  const url   = new URL(request.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return errorRedirect("missing_params");
  }

  // Verify the signed state — this is the CSRF check
  let slug: string;
  try {
    const payload = await verifyGA4State(state, env.TOKEN_SIGNING_KEY ?? "");
    slug = payload.slug;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("expired")) {
      return errorRedirect("state_expired");
    }
    return errorRedirect("state_invalid");
  }

  // Exchange the authorization code for access + refresh tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      client_id:     env.GA4_OAUTH_CLIENT_ID     ?? "",
      client_secret: env.GA4_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri:  env.GA4_OAUTH_REDIRECT_URI  ?? "",
    }).toString(),
  });

  if (!tokenRes.ok) {
    return errorRedirect("token_exchange_failed");
  }

  // Typed inline — avoids `any` without a schema library
  const tokenJson = (await tokenRes.json()) as {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
  };

  if (!tokenJson.refresh_token) {
    // Google only issues a refresh_token when prompt=consent is used AND the
    // user hasn't already granted offline access. We always request prompt=consent
    // in handleGA4Start, so this is only hit on a re-consent where Google already
    // holds a refresh token. The caller should instruct the user to disconnect and
    // reconnect if they genuinely need a new token.
    return errorRedirect("no_refresh_token");
  }

  // AES-256-GCM encrypt the refresh token before writing to D1
  const encryptedToken = await encryptToken(
    tokenJson.refresh_token,
    env.GA4_TOKEN_ENCRYPTION_KEY ?? "",
  );

  // Upsert: if the tenant re-connects GA4, replace the old row
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO ga4_connections (slug, refresh_token_enc, status, connected_at) VALUES (?, ?, 'connected', datetime('now'))",
    )
    .bind(slug, encryptedToken)
    .run();

  return redirect302(`${SETTINGS_URL}?ga4=connected`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a 302 redirect with a relative Location header.
 *
 * Response.redirect() requires an absolute URL in Node (undici) but the
 * Cloudflare Workers runtime accepts relative paths. Using a manual Response
 * with a Location header works in both environments.
 */
function redirect302(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

function errorRedirect(reason: string): Response {
  return redirect302(`${SETTINGS_URL}?ga4=error&reason=${reason}`);
}
