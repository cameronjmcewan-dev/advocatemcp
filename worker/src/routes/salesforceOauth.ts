/**
 * Salesforce CRM OAuth route handlers.
 *
 * Two entry points exported and wired in portal.ts:
 *   handleSalesforceStart    — GET /oauth/salesforce/start?slug=<slug>
 *   handleSalesforceCallback — GET /oauth/salesforce/callback?code=<code>&state=<state>
 *
 * Flow:
 *   1. handleSalesforceStart generates a signed state token and redirects to
 *      Salesforce's OAuth consent screen (login.salesforce.com).
 *   2. Salesforce redirects back with code + state.
 *   3. handleSalesforceCallback verifies state (CSRF), exchanges code for
 *      tokens, AES-GCM encrypts the refresh token, writes to crm_connections
 *      D1 table with provider='salesforce', and redirects to Settings page.
 *      The token response also includes instance_url — stored in account_id
 *      so subsequent API calls route to the correct Salesforce org.
 *
 * On any error the user lands on
 *   /Settings.html?crm=error&provider=salesforce&reason=<short-tag>
 * so the frontend can display a specific message.
 *
 * Domain separation: state tokens use prefix "salesforce-state:v1:" so a
 * Salesforce state token cannot be replayed against a HubSpot, GA4, or GSC
 * callback even though they share TOKEN_SIGNING_KEY.
 */

import type { Env } from "../types";
import { signState, verifyState } from "../lib/oauthState";
import { encryptToken } from "../lib/tokenCrypto";

const SETTINGS_URL = "/Settings.html";
const SALESFORCE_STATE_PREFIX = "salesforce-state:v1:";

// ── handleSalesforceStart ─────────────────────────────────────────────────────

/**
 * GET /oauth/salesforce/start?slug=<slug>
 *
 * Generates a signed state token and redirects to Salesforce's OAuth consent
 * screen. Called via handleSalesforceStartProtected in portal.ts, which
 * enforces session auth + ownership + Pro plan gate before delegating here.
 */
export async function handleSalesforceStart(request: Request, env: Env): Promise<Response> {
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
    SALESFORCE_STATE_PREFIX,
  );

  const authorizeUrl = new URL("https://login.salesforce.com/services/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id",     env.SALESFORCE_OAUTH_CLIENT_ID     ?? "");
  authorizeUrl.searchParams.set("redirect_uri",  env.SALESFORCE_OAUTH_REDIRECT_URI  ?? "");
  authorizeUrl.searchParams.set("scope",         "api refresh_token offline_access");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state",         state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

// ── handleSalesforceCallback ──────────────────────────────────────────────────

/**
 * GET /oauth/salesforce/callback?code=<code>&state=<state>
 *
 * Salesforce redirects here after the user consents. Verifies the signed state
 * (CSRF protection), exchanges the code for tokens, encrypts the refresh token
 * with AES-256-GCM, persists to crm_connections with provider='salesforce' and
 * the org's instance_url in account_id, then redirects to the Settings page.
 *
 * INSERT OR REPLACE so reconnecting a Salesforce org cleanly overwrites
 * the old row rather than leaving stale token state.
 *
 * instance_url from the token response is stored in account_id because
 * Salesforce API calls go to the per-org instance (e.g.
 * https://acme.my.salesforce.com), NOT login.salesforce.com. The instance_url
 * may change if the customer's org migrates — each token refresh returns the
 * freshest value, but we seed account_id here so the first API call has a
 * starting point without needing a second refresh.
 */
export async function handleSalesforceCallback(request: Request, env: Env): Promise<Response> {
  const url   = new URL(request.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return errorRedirect("missing_params");
  }

  // Verify the signed state — CSRF check
  let slug: string;
  try {
    const payload = await verifyState(state, env.TOKEN_SIGNING_KEY ?? "", SALESFORCE_STATE_PREFIX);
    slug = payload.slug;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("expired")) {
      return errorRedirect("state_expired");
    }
    return errorRedirect("state_invalid");
  }

  // Exchange the authorization code for access + refresh tokens
  const tokenRes = await fetch("https://login.salesforce.com/services/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      client_id:     env.SALESFORCE_OAUTH_CLIENT_ID     ?? "",
      client_secret: env.SALESFORCE_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri:  env.SALESFORCE_OAUTH_REDIRECT_URI  ?? "",
    }).toString(),
  });

  if (!tokenRes.ok) {
    return errorRedirect("token_exchange_failed");
  }

  const tokenJson = (await tokenRes.json()) as {
    refresh_token?: string;
    access_token?:  string;
    instance_url?:  string;
    expires_in?:    number;
  };

  if (!tokenJson.refresh_token) {
    return errorRedirect("no_refresh_token");
  }

  // instance_url is required for subsequent API calls — Salesforce routes all
  // data API traffic to the per-org instance, not login.salesforce.com.
  const instanceUrl = tokenJson.instance_url ?? "";

  // AES-256-GCM encrypt the refresh token before writing to D1.
  // Reuses GA4_TOKEN_ENCRYPTION_KEY — same D1 instance, same threat model.
  const encryptedToken = await encryptToken(
    tokenJson.refresh_token,
    env.GA4_TOKEN_ENCRYPTION_KEY ?? "",
  );

  // INSERT OR REPLACE so reconnecting the Salesforce org overwrites cleanly.
  // account_id stores instance_url so apiTrafficImpactLtv can route API calls
  // to the correct Salesforce org without a redundant token refresh.
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO crm_connections (slug, provider, refresh_token_enc, account_id, status, connected_at) VALUES (?, 'salesforce', ?, ?, 'connected', datetime('now'))",
    )
    .bind(slug, encryptedToken, instanceUrl)
    .run();

  return redirect302(`${SETTINGS_URL}?crm=connected&provider=salesforce`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function redirect302(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

function errorRedirect(reason: string): Response {
  return redirect302(`${SETTINGS_URL}?crm=error&provider=salesforce&reason=${reason}`);
}
