/**
 * HubSpot CRM OAuth route handlers.
 *
 * Two entry points exported and wired in portal.ts:
 *   handleHubspotStart    — GET /oauth/hubspot/start?slug=<slug>
 *   handleHubspotCallback — GET /oauth/hubspot/callback?code=<code>&state=<state>
 *
 * Flow:
 *   1. handleHubspotStart generates a signed state token and redirects to
 *      HubSpot's OAuth consent screen.
 *   2. HubSpot redirects back with code + state.
 *   3. handleHubspotCallback verifies state (CSRF), exchanges code for
 *      refresh token, AES-GCM encrypts it, writes to crm_connections D1
 *      table with provider='hubspot', and redirects to Settings page.
 *
 * On any error the user lands on
 *   /Settings.html?crm=error&provider=hubspot&reason=<short-tag>
 * so the frontend can display a specific message.
 *
 * Domain separation: state tokens use prefix "hubspot-state:v1:" so a
 * HubSpot state token cannot be replayed against a GA4 or GSC callback
 * even though they share TOKEN_SIGNING_KEY.
 */

import type { Env } from "../types";
import { signState, verifyState } from "../lib/oauthState";
import { encryptToken } from "../lib/tokenCrypto";

const SETTINGS_URL = "/Settings.html";
const HUBSPOT_STATE_PREFIX = "hubspot-state:v1:";

// ── handleHubspotStart ────────────────────────────────────────────────────────

/**
 * GET /oauth/hubspot/start?slug=<slug>
 *
 * Generates a signed state token and redirects to HubSpot's OAuth consent
 * screen. Called via handleHubspotStartProtected in portal.ts, which
 * enforces session auth + ownership + Pro plan gate before delegating here.
 */
export async function handleHubspotStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");

  if (!slug) {
    return Response.json({ error: "slug is required" }, { status: 400 });
  }

  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");

  const state = await signState(
    { slug, nonce, ts: Math.floor(Date.now() / 1000) },
    env.TOKEN_SIGNING_KEY ?? "",
    HUBSPOT_STATE_PREFIX,
  );

  const authorizeUrl = new URL("https://app.hubspot.com/oauth/authorize");
  authorizeUrl.searchParams.set("client_id",     env.HUBSPOT_OAUTH_CLIENT_ID     ?? "");
  authorizeUrl.searchParams.set("redirect_uri",  env.HUBSPOT_OAUTH_REDIRECT_URI  ?? "");
  authorizeUrl.searchParams.set("scope",         "crm.objects.contacts.read crm.objects.deals.read");
  authorizeUrl.searchParams.set("state",         state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

// ── handleHubspotCallback ─────────────────────────────────────────────────────

/**
 * GET /oauth/hubspot/callback?code=<code>&state=<state>
 *
 * HubSpot redirects here after the user consents. Verifies the signed state
 * (CSRF protection), exchanges the code for tokens, encrypts the refresh
 * token with AES-256-GCM, persists to crm_connections with
 * provider='hubspot', and redirects to the Settings page.
 *
 * INSERT OR REPLACE so reconnecting a HubSpot account cleanly overwrites
 * the old row rather than leaving stale token state.
 */
export async function handleHubspotCallback(request: Request, env: Env): Promise<Response> {
  const url   = new URL(request.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return errorRedirect("missing_params");
  }

  // Verify the signed state — CSRF check
  let slug: string;
  try {
    const payload = await verifyState(state, env.TOKEN_SIGNING_KEY ?? "", HUBSPOT_STATE_PREFIX);
    slug = payload.slug;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("expired")) {
      return errorRedirect("state_expired");
    }
    return errorRedirect("state_invalid");
  }

  // Exchange the authorization code for access + refresh tokens
  const tokenRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      client_id:     env.HUBSPOT_OAUTH_CLIENT_ID     ?? "",
      client_secret: env.HUBSPOT_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri:  env.HUBSPOT_OAUTH_REDIRECT_URI  ?? "",
    }).toString(),
  });

  if (!tokenRes.ok) {
    return errorRedirect("token_exchange_failed");
  }

  const tokenJson = (await tokenRes.json()) as {
    refresh_token?: string;
    access_token?:  string;
    expires_in?:    number;
  };

  if (!tokenJson.refresh_token) {
    return errorRedirect("no_refresh_token");
  }

  // AES-256-GCM encrypt the refresh token before writing to D1.
  // Reuses GA4_TOKEN_ENCRYPTION_KEY — the lib (tokenCrypto.ts) is generic;
  // both tokens live in the same D1 instance and share the same threat model.
  const encryptedToken = await encryptToken(
    tokenJson.refresh_token,
    env.GA4_TOKEN_ENCRYPTION_KEY ?? "",
  );

  // INSERT OR REPLACE so reconnecting the HubSpot account overwrites cleanly.
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO crm_connections (slug, provider, refresh_token_enc, status, connected_at) VALUES (?, 'hubspot', ?, 'connected', datetime('now'))",
    )
    .bind(slug, encryptedToken)
    .run();

  return redirect302(`${SETTINGS_URL}?crm=connected&provider=hubspot`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function redirect302(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

function errorRedirect(reason: string): Response {
  return redirect302(`${SETTINGS_URL}?crm=error&provider=hubspot&reason=${reason}`);
}
