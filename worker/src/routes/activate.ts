/**
 * Phase 3 — self-serve activation flow.
 *
 * Two endpoints live in this file:
 *
 *   POST /api/activate           — customer-facing. Token-authenticated.
 *                                  Wraps `activateDomain` from ./domains
 *                                  with customer-friendly error messages
 *                                  and a success framing string.
 *
 *   POST /admin/activation-token — admin helper for generating test tokens.
 *                                  X-Admin-Secret protected. TEMPORARY —
 *                                  will be replaced by the Stripe webhook
 *                                  in a future session. See inline TODO.
 *
 * Voice conventions for all customer-facing copy in this file:
 *   - Plain English, no internal jargon (no "fetch_failed", "self_loop").
 *   - Empathetic, action-oriented. Every message ends with what the
 *     customer can do next.
 *   - "We" and "you", not "the system" or "the user".
 *   - No exclamation marks. Quiet confidence, not cheerleading.
 *
 * Any wording change must preserve this voice. Copy is reviewed content,
 * not just code.
 */

import type { Env } from "../types";
import {
  signActivationToken,
  verifyActivationToken,
  type ActivationTokenError,
  type ActivationTokenPayload,
  base64urlToBytes,
} from "../lib/activation-token";
import {
  activateDomain,
  type ActivateFailReason,
} from "./domains";
import { withCors } from "../lib/cors";
import {
  getActivationRecord,
  updateActivationStatus,
  setActivationToken,
  getUserByEmail,
  createUser,
  updateUserPassword,
  getBusinessBySlug,
  grantAccess,
} from "../portalDb";
import { sendActivationEmail } from "../lib/resend";
import {
  generateSalt,
  hashPassword,
  generateSessionToken,
  hashToken,
  refreshCookieHeader,
} from "../auth";
import {
  signAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from "../lib/access-token";
import { getTenant } from "./onboard";
import { detectDnsProvider } from "../lib/dnsProvider";

// ── Customer message catalog ─────────────────────────────────────────────────
// Every customer-facing string that can appear in an /api/activate response.
// `${domain}` is interpolated server-side where present. Keep in sync with
// the error_code → message mapping in §7 of the Phase 3 proposal.

const CUSTOMER_MESSAGES: Record<string, string> = {
  missing_token:
    "This page needs a valid activation link to work. If you paid for AdvocateMCP recently, you should have received an email with your link. If you can't find it, please contact support.",
  token_invalid:
    "This activation link isn't valid. It may have been copied incorrectly, or it may have been replaced by a newer one. Please check the email we sent you and use the most recent link, or contact support for a fresh one.",
  token_expired:
    "This activation link has expired. Activation links are valid for 24 hours after they're issued. Please contact support and we'll send you a new one.",
  domain_required:
    "Please enter your website's domain to continue.",
  domain_invalid:
    "That doesn't look like a valid domain. Please enter it like 'yourdomain.com' — just the domain, no http:// prefix, no path, no port.",
  domain_owned_by_other:
    "This domain is already set up for another AdvocateMCP account. If this isn't right, please contact support.",
  domain_unreachable:
    "We couldn't reach ${domain}. Make sure your website is live and accessible, then try again. If you're still setting it up, come back once it's ready.",
  domain_slow:
    "We tried to reach ${domain} but it took too long to respond. Your website may be slow or temporarily unavailable. Please try again in a minute.",
  origin_unknown_need_host:
    "We need to know where ${domain} is actually hosted. Right now your domain looks like it's serving itself directly, with no redirect to a hosting platform like Squarespace, Wix, or Webflow. If your site is on one of those, please contact support and we'll help finish the setup. If your site uses Cloudflare protection (Under Attack Mode or a challenge page), that can also cause this — please contact support.",
  insecure_redirect:
    "${domain} redirects to a non-secure (HTTP) address. AdvocateMCP requires HTTPS for everything we set up. Please make sure your site uses HTTPS and try again.",
  origin_error:
    "${domain} is reachable but is returning errors right now. Please try again in a few minutes. If the problem persists, contact support.",
  platform_loop:
    "There's an unusual setup on your domain's DNS that we can't handle automatically. Please contact support and we'll sort it out with you.",
  account_not_ready:
    "Your account isn't quite set up yet. This sometimes takes a minute after payment. Please try again shortly, and if it still doesn't work, contact support.",
  platform_error:
    "We ran into a problem setting up your domain on our side. This isn't your fault — please try again in a moment. If the same error keeps happening, contact support.",
  network_error:
    "We couldn't reach our servers. Please check your internet connection and try again.",
  unknown:
    "Something went wrong. Please try again, or contact support if the problem keeps happening.",
};

/** Framing copy shown on the instructions state (State 3) after success. */
const SUCCESS_CUSTOMER_MESSAGE =
  "You're almost there. Add the two DNS records below at your domain registrar — that's the service you bought your domain from, like GoDaddy, Namecheap, or Squarespace. Changes usually take 5–15 minutes to go live. Once the records are in, come back and refresh this page to see your status.";

function renderCustomerMessage(code: string, domain?: string): string {
  const template = CUSTOMER_MESSAGES[code] ?? CUSTOMER_MESSAGES.unknown!;
  return domain ? template.replace(/\$\{domain\}/g, domain) : template;
}

// ── Internal error → customer code mapping ───────────────────────────────────

function mapActivateFailToCustomerCode(reason: ActivateFailReason | undefined): string {
  switch (reason) {
    case "fetch_failed":        return "domain_unreachable";
    case "fetch_timeout":       return "domain_slow";
    case "self_loop":           return "origin_unknown_need_host";
    case "worker_loop":         return "platform_loop";
    case "http_scheme":         return "insecure_redirect";
    case "origin_5xx":          return "origin_error";
    case "slug_not_registered": return "account_not_ready";
    case "cf_api_error":        return "platform_error";
    // These reasons only fire on the explicit origin_url path, which the
    // customer endpoint never uses. Fall through to unknown as a safety net.
    case "origin_url_invalid":
    case "origin_url_http":
    case "origin_url_unreachable":
    default:
      return "unknown";
  }
}

// ── Response helpers ─────────────────────────────────────────────────────────

function jsonErr(status: number, errorCode: string, domain?: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code: errorCode,
      customer_message: renderCustomerMessage(errorCode, domain),
    }, null, 2),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Domain normalization + validation ────────────────────────────────────────

/**
 * Strict hostname regex. Rejects ports, paths, schemes, IP addresses,
 * single-label domains, and IDN/punycode edge cases. Customers making
 * typos are more common than legitimate edge cases in this field.
 */
const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, "");
}

export function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  return DOMAIN_REGEX.test(domain);
}

// ── POST /api/activate ───────────────────────────────────────────────────────
// Customer-facing activation endpoint. Signed-token authenticated. Accepts
// JSON body (from the /activate page's fetch call) or form-encoded body
// (from the no-JS fallback form). Token may arrive via X-Activation-Token
// header, JSON/form body field `token`, or query param `t=`.

/**
 * Exported entry point. Wraps the inner worker's response with CORS headers
 * (non-credentials mode) so the advocatemcp.com frontend can receive the
 * response on a cross-origin fetch. Phase C Commit 5 introduced this outer
 * wrapper; prior to Commit 5, `handleActivate` was the inner function
 * directly and `/api/activate` was same-origin-only. The self-contained
 * wrapping pattern means any future caller of `handleActivate` automatically
 * gets CORS without needing to remember to wrap at the dispatch site.
 */
export async function handleActivate(request: Request, env: Env): Promise<Response> {
  const response = await handleActivateInner(request, env);
  return withCors(response, request);
}

async function handleActivateInner(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return jsonErr(405, "unknown");
  if (!env.ACTIVATION_SIGNING_KEY) {
    // Secret missing entirely — treat as a platform error, not a token error,
    // because the customer did nothing wrong.
    console.error(JSON.stringify({
      activate: true,
      event: "activation_reject",
      error_code: "platform_error",
      reason: "ACTIVATION_SIGNING_KEY missing from env",
    }));
    return jsonErr(500, "platform_error");
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  const contentType = request.headers.get("Content-Type") ?? "";
  let body: Record<string, unknown> = {};
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      const params = new URLSearchParams(text);
      for (const [k, v] of params) body[k] = v;
    } else {
      // JSON or unspecified — try JSON parse.
      const text = await request.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text) as Record<string, unknown>;
      }
    }
  } catch {
    return jsonErr(400, "domain_required");
  }

  // ── Extract token (header → body → query param) ────────────────────────────
  const url = new URL(request.url);
  const token =
    request.headers.get("X-Activation-Token") ??
    (typeof body.token === "string" ? body.token : null) ??
    url.searchParams.get("t");

  if (!token) {
    return jsonErr(401, "missing_token");
  }

  // ── Verify token ────────────────────────────────────────────────────────────
  let payload: ActivationTokenPayload;
  try {
    payload = await verifyActivationToken(token, env.ACTIVATION_SIGNING_KEY);
  } catch (err) {
    const reason = err as ActivationTokenError;
    const code = reason === "expired" ? "token_expired" : "token_invalid";
    console.warn(JSON.stringify({
      activate: true,
      event: "activation_reject",
      error_code: code,
      reason,
    }));
    return jsonErr(401, code);
  }
  const slug = payload.slug;

  // ── Extract and normalize domain ────────────────────────────────────────────
  const rawDomain = typeof body.domain === "string" ? body.domain : "";
  if (!rawDomain.trim()) return jsonErr(400, "domain_required");
  const domain = normalizeDomain(rawDomain);
  if (!isValidDomain(domain)) return jsonErr(400, "domain_invalid", domain);

  // ── Cross-tenant guard ──────────────────────────────────────────────────────
  // If BUSINESS_MAP already maps this domain to a DIFFERENT slug, reject.
  // If it maps to the SAME slug, continue — activateDomain is idempotent
  // and will return the existing CF hostname state.
  const existingSlug = await env.BUSINESS_MAP.get(domain);
  if (existingSlug && existingSlug !== slug) {
    console.warn(JSON.stringify({
      activate: true,
      event: "activation_reject",
      error_code: "domain_owned_by_other",
      slug,
      existing_slug: existingSlug,
    }));
    return jsonErr(409, "domain_owned_by_other", domain);
  }

  // ── Delegate to the extracted core ──────────────────────────────────────────
  const result = await activateDomain(env, { domain, slug });

  if (!result.ok) {
    const customerCode = mapActivateFailToCustomerCode(result.reason);
    console.warn(JSON.stringify({
      activate: true,
      event: "activation_reject",
      error_code: customerCode,
      reason: result.reason,
      slug,
    }));
    return jsonErr(400, customerCode, domain);
  }

  // ── Success — wrap the core response with the framing message ──────────────
  console.log(JSON.stringify({
    activate: true,
    event: "activation_success",
    slug,
    domain,
    origin_url_source: result.body.origin_url_source,
  }));

  // Enrich the response with per-variant DCV records from the tenant
  // record. The Stripe webhook fans out across apex+www variants and
  // populates `tenant.cloudflare.variants[]`; activateDomain only
  // re-registers the single typed hostname, so its result body has
  // just one CNAME + TXT pair. To show the customer DNS records for
  // BOTH variants, we look up the tenant after activateDomain succeeds
  // and merge variants[] into the response. (Apr 26 2026.)
  //
  // Tenant lookup is by typed domain first; if customer typed the
  // non-signup variant (apex when they signed up with www, or vice
  // versa), fall back to D1 to find the canonical signup domain.
  let tenant = await getTenant(env, domain);
  if (!tenant) {
    try {
      const row = await env.DB
        .prepare("SELECT domain FROM businesses WHERE slug = ? LIMIT 1")
        .bind(slug)
        .first<{ domain: string | null }>();
      if (row?.domain) tenant = await getTenant(env, row.domain.toLowerCase());
    } catch (err) {
      // D1 lookup is best-effort. Failing here just means the response
      // omits variants[]; the legacy cname_record + txt_record stay
      // populated from activateDomain, so the page still renders.
      console.warn(JSON.stringify({
        activate: true,
        event: "tenant_canonical_lookup_failed",
        slug,
        error: String(err),
      }));
    }
  }

  // Per-variant DCV records (apex + www). When variants[] is absent
  // (older tenants, or tenant lookup failed) we omit the field; the
  // dashboard-activate.js renderer falls back to cname_record +
  // txt_record in that case.
  const variants = tenant?.cloudflare.variants
    ? tenant.cloudflare.variants.map((v) => ({
        hostname: v.hostname,
        is_apex: !v.hostname.startsWith("www.")
                  && v.hostname.split(".").length <= 3
                  && !v.hostname.endsWith(".hosted.advocatemcp.com"),
        verification_status: v.verificationStatus,
        ssl_status: v.sslStatus,
        records: [
          // SSL DCV TXT (CF-issued, customer-added).
          ...(v.txtName && v.txtValue
            ? [{ type: "TXT", host: v.txtName, value: v.txtValue, purpose: "SSL validation" }]
            : []),
          // Domain ownership TXT (CF-issued, customer-added).
          ...(v.ownershipTxtName && v.ownershipTxtValue
            ? [{ type: "TXT", host: v.ownershipTxtName, value: v.ownershipTxtValue, purpose: "Domain ownership" }]
            : []),
        ],
      }))
    : undefined;

  return jsonOk({
    ...result.body,
    ...(variants ? { variants } : {}),
    skip_dns: tenant?.skipDns === true,
    customer_message: SUCCESS_CUSTOMER_MESSAGE,
  });
}

/* GET /api/activate/status
 *
 * Token-authenticated polling endpoint. The activate page polls this
 * every ~10s while waiting for the customer's DNS records to propagate
 * and for Cloudflare to issue SSL. Returns just enough per-variant
 * state for the UI to flip the live status pills (apex pending → apex
 * active; www pending → www active) and decide when to auto-redirect
 * to /dashboard.
 *
 * Same auth model as /api/activate/preview: the activation token gates
 * the response, so anyone hitting the URL without a valid token gets
 * a 401, not tenant state.
 *
 * Cheap: one D1 read (slug → canonical domain) + one KV read (tenant
 * record). Sub-50ms typical. Safe to poll at 10s intervals from many
 * concurrent customers.
 */
export async function handleActivateStatus(request: Request, env: Env): Promise<Response> {
  return withCors(await handleActivateStatusInner(request, env), request);
}
async function handleActivateStatusInner(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = request.headers.get("X-Activation-Token") ?? url.searchParams.get("t");
  if (!token) return jsonErr(401, "missing_token");
  if (!env.ACTIVATION_SIGNING_KEY) return jsonErr(500, "platform_error");

  let payload: ActivationTokenPayload;
  try {
    payload = await verifyActivationToken(token, env.ACTIVATION_SIGNING_KEY);
  } catch (err) {
    const reason = err as ActivationTokenError;
    return jsonErr(401, reason === "expired" ? "token_expired" : "token_invalid");
  }

  const slug = payload.slug;
  let canonicalDomain: string | null = null;
  try {
    const row = await env.DB
      .prepare("SELECT domain FROM businesses WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ domain: string | null }>();
    canonicalDomain = row?.domain?.toLowerCase() ?? null;
  } catch {
    /* fall through */
  }
  if (!canonicalDomain) {
    return jsonOk({ slug, variants: [], all_active: false, skip_dns: false });
  }

  const tenant = await getTenant(env, canonicalDomain);
  if (!tenant) {
    return jsonOk({ slug, variants: [], all_active: false, skip_dns: false });
  }

  // Use per-variant state when present; fall back to legacy single-
  // hostname state for pre-Apr-26 tenants.
  const variantSrc = tenant.cloudflare.variants && tenant.cloudflare.variants.length > 0
    ? tenant.cloudflare.variants
    : [{
        hostname: tenant.domain,
        customHostnameId: tenant.cloudflare.customHostnameId,
        verificationStatus: tenant.cloudflare.verificationStatus,
        sslStatus: tenant.cloudflare.sslStatus,
        txtName: tenant.cloudflare.txtName,
        txtValue: tenant.cloudflare.txtValue,
        ownershipTxtName: tenant.cloudflare.ownershipTxtName,
        ownershipTxtValue: tenant.cloudflare.ownershipTxtValue,
      }];

  const variants = variantSrc.map((v) => ({
    hostname: v.hostname,
    is_apex: !v.hostname.startsWith("www.")
              && v.hostname.split(".").length <= 3
              && !v.hostname.endsWith(".hosted.advocatemcp.com"),
    verification_status: v.verificationStatus,
    ssl_status: v.sslStatus,
    active: v.verificationStatus === "active" && v.sslStatus === "active",
  }));

  const allActive = variants.length > 0 && variants.every((v) => v.active);

  return jsonOk({
    slug,
    domain: tenant.domain,
    skip_dns: tenant.skipDns === true,
    variants,
    all_active: allActive,
  });
}

/* Detect the customer's DNS provider for the activate page. Wraps the
 * generic detector with the activate-token gate so we don't expose
 * "what DNS provider does this domain use?" to anyone who knows a
 * domain — it's cheap public info via dig but the gate keeps the
 * worker endpoint scoped. */
export async function handleActivateDnsProvider(request: Request, env: Env): Promise<Response> {
  return withCors(await handleActivateDnsProviderInner(request, env), request);
}
async function handleActivateDnsProviderInner(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = request.headers.get("X-Activation-Token") ?? url.searchParams.get("t");
  if (!token) return jsonErr(401, "missing_token");
  if (!env.ACTIVATION_SIGNING_KEY) return jsonErr(500, "platform_error");

  let payload: ActivationTokenPayload;
  try {
    payload = await verifyActivationToken(token, env.ACTIVATION_SIGNING_KEY);
  } catch (err) {
    const reason = err as ActivationTokenError;
    return jsonErr(401, reason === "expired" ? "token_expired" : "token_invalid");
  }

  const slug = payload.slug;
  let canonicalDomain: string | null = null;
  try {
    const row = await env.DB
      .prepare("SELECT domain FROM businesses WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ domain: string | null }>();
    canonicalDomain = row?.domain?.toLowerCase() ?? null;
  } catch {
    /* swallow */
  }

  if (!canonicalDomain) {
    return jsonOk({ provider: "other", nameservers: [] });
  }

  // Strip leading "www." for the NS lookup — we want the apex's NS.
  const apex = canonicalDomain.replace(/^www\./, "");
  const detection = await detectDnsProvider(apex);
  return jsonOk(detection);
}

/* GET /api/activate/preview
 *
 * Lightweight pre-flight for the activate page. Verifies the activation
 * token (so we don't leak tenant state to anyone who hits the URL) and
 * returns just enough to decide which UI state to render:
 *
 *   - skipDns tenants (free tier / hosted-subdomain wizard signups) get
 *     `skip_dns: true` + their hosted_domain so the activate page can
 *     auto-redirect to /dashboard without ever showing the "enter your
 *     domain" form. Pre-Apr-26-2026, every tenant landed on the same
 *     domain-entry form, including hosted tenants who don't own a
 *     custom domain.
 *
 *   - Custom-domain tenants get `skip_dns: false`, and the page renders
 *     the regular domain-entry flow.
 *
 * No state mutation. Read-only. Failures fall back to skip_dns: false
 * so the customer at least sees the manual form rather than a blank
 * page.
 */
export async function handleActivatePreview(request: Request, env: Env): Promise<Response> {
  return withCors(await handleActivatePreviewInner(request, env), request);
}
async function handleActivatePreviewInner(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = request.headers.get("X-Activation-Token") ?? url.searchParams.get("t");

  if (!token) return jsonErr(401, "missing_token");
  if (!env.ACTIVATION_SIGNING_KEY) return jsonErr(500, "platform_error");

  let payload: ActivationTokenPayload;
  try {
    payload = await verifyActivationToken(token, env.ACTIVATION_SIGNING_KEY);
  } catch (err) {
    const reason = err as ActivationTokenError;
    const code = reason === "expired" ? "token_expired" : "token_invalid";
    return jsonErr(401, code);
  }

  const slug = payload.slug;
  // Look up the canonical signup domain via D1 → tenant via KV.
  let skipDns = false;
  let hostedDomain: string | null = null;
  try {
    const row = await env.DB
      .prepare("SELECT domain FROM businesses WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ domain: string | null }>();
    if (row?.domain) {
      const tenant = await getTenant(env, row.domain.toLowerCase());
      if (tenant?.skipDns === true) {
        skipDns = true;
        hostedDomain = tenant.domain;
      }
    }
  } catch {
    // Fail-open: best path is the customer seeing the manual domain
    // form even if our preview lookup fails. They can still proceed.
  }

  return jsonOk({
    slug,
    skip_dns: skipDns,
    ...(hostedDomain ? { hosted_domain: hostedDomain } : {}),
  });
}

// ── POST /admin/activation-token ─────────────────────────────────────────────
// TODO(stripe-webhook): this endpoint exists so Phase 3 can be tested
// end-to-end tonight without Stripe integration. Once the Stripe webhook
// lands and automatically mints activation tokens on successful payment,
// this endpoint should be removed or re-scoped to ops-only testing.
//
// Does NOT validate that the slug exists in Railway — admin tools fail open.
// A token for a nonexistent slug will hit the `slug_not_registered` branch
// on the customer-facing /api/activate call, which maps to the
// "account isn't quite set up yet" customer message.

function requireAdminSecret(request: Request, env: Env): boolean {
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  return !!env.ADMIN_SECRET && provided === env.ADMIN_SECRET;
}

export async function handleActivationToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }
  if (!requireAdminSecret(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized — X-Admin-Secret header required" }), { status: 401 });
  }
  if (!env.ACTIVATION_SIGNING_KEY) {
    return new Response(
      JSON.stringify({ error: "ACTIVATION_SIGNING_KEY secret is not configured on this worker. Run `wrangler secret put ACTIVATION_SIGNING_KEY` and retry." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug.toLowerCase().trim() : "";
  if (!slug) {
    return new Response(JSON.stringify({ error: "Missing required field: slug" }), { status: 400 });
  }

  const token = await signActivationToken({ slug }, env.ACTIVATION_SIGNING_KEY);
  const iat = Math.floor(Date.now() / 1000);
  const expSeconds = iat + 24 * 3600;
  const url = new URL(request.url);
  const activateUrl = `${url.origin}/activate?t=${encodeURIComponent(token)}`;

  return new Response(
    JSON.stringify({
      ok: true,
      token,
      activate_url: activateUrl,
      expires_at: new Date(expSeconds * 1000).toISOString(),
      note: "This endpoint is temporary — it will be replaced by the Stripe webhook in a future session.",
    }, null, 2),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── GET /admin/businesses/:slug/activation ───────────────────────────────────
//
// Operator-facing retrieval endpoint for the activation token minted by
// the Stripe webhook in Phase F Part 1. Reads the stored token from D1
// without minting a new one (contrast with POST /admin/activation-token
// above, which mints on every call). X-Admin-Secret protected.
//
// Response shape:
//   200 { slug, activation_token, activation_status, activation_issued_at }
//   401 { error }   — X-Admin-Secret missing or invalid
//   404 { error }   — slug does not exist in the businesses table
//
// The token field may be null on a 200 when the businesses row exists
// but the webhook has not yet fired (or the webhook fired without
// ACTIVATION_SIGNING_KEY configured). The operator can tell which case
// they are in from the activation_status field: 'none' means no mint
// has happened; 'pending_send' means the webhook has minted and the
// token is ready to deliver.

export async function handleGetActivation(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!requireAdminSecret(request, env)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized — X-Admin-Secret header required" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const record = await getActivationRecord(env.DB, slug);
  if (record === null) {
    return new Response(
      JSON.stringify({ error: `No business found for slug '${slug}'` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      slug,
      activation_token:     record.token,
      activation_status:    record.status,
      activation_issued_at: record.issued_at,
    }, null, 2),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── POST /admin/businesses/:slug/resend-activation ───────────────────────
//
// Operator backstop for failed or missed activation emails. Reads the
// stored activation token from D1, sends (or re-sends) the email via
// Resend, and updates activation_status to 'sent' on success. Requires
// the customer email address in the JSON body because D1's businesses
// table does not store email.
//
// Response shape:
//   200 { ok, email_id, slug, email }  — email sent successfully
//   400 { error }   — bad body, missing email, or no token minted yet
//   401 { error }   — X-Admin-Secret missing or invalid
//   404 { error }   — slug does not exist in the businesses table
//   405 { error }   — method not POST
//   500 { error }   — RESEND_API_KEY missing or Resend API failure

export async function handleResendActivation(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!requireAdminSecret(request, env)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized — X-Admin-Secret header required" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // Parse body — expect { "email": "customer@example.com" }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify({ error: "Request body must be valid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) {
    return new Response(
      JSON.stringify({ error: "Missing required field: email (string)" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Look up the business — the row must exist, but we no longer require
  // a pre-existing activation token. Resend always mints a fresh one.
  const record = await getActivationRecord(env.DB, slug);
  if (record === null) {
    return new Response(
      JSON.stringify({ error: `No business found for slug '${slug}'` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // Check secrets — both required.
  if (!env.RESEND_API_KEY) {
    return new Response(
      JSON.stringify({ error: "RESEND_API_KEY is not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!env.ACTIVATION_SIGNING_KEY) {
    return new Response(
      JSON.stringify({ error: "ACTIVATION_SIGNING_KEY is not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Mint a fresh 7-day token and overwrite the existing one. The prior
  // implementation re-mailed `record.token` verbatim, which silently
  // sent expired links once the original 7-day window had elapsed —
  // exactly the failure mode the user hit on the advocate tenant. Now
  // every resend gets a usable link.
  const SEVEN_DAYS = 7 * 24 * 3600;
  const freshToken = await signActivationToken({ slug }, env.ACTIVATION_SIGNING_KEY, SEVEN_DAYS);
  const wrote = await setActivationToken(env.DB, slug, freshToken, new Date().toISOString());
  if (!wrote) {
    // This shouldn't happen — getActivationRecord just confirmed the
    // row exists. But fail closed if the UPDATE somehow doesn't land.
    return new Response(
      JSON.stringify({ error: "Failed to persist fresh activation token" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Determine tenant type for email template branching
  const biz = await getBusinessBySlug(env.DB, slug);
  const isHosted = biz?.domain?.endsWith(".hosted.advocatemcp.com") === true;
  const emailTenantType = isHosted ? "hosted" as const : "dns" as const;
  const emailHostedUrl = isHosted ? `https://${slug}.hosted.advocatemcp.com` : undefined;

  // Send the email with the fresh token
  const activateUrl = `https://customers.advocatemcp.com/activate?t=${encodeURIComponent(freshToken)}`;
  const result = await sendActivationEmail(env.RESEND_API_KEY, email, activateUrl, emailTenantType, emailHostedUrl);

  if (result.ok) {
    await updateActivationStatus(env.DB, slug, "sent");
    console.log(JSON.stringify({
      admin: true,
      event: "admin_resend_activation_sent",
      slug,
      email_to_length: email.length,
      email_id: result.id,
    }));
    return new Response(
      JSON.stringify({ ok: true, email_id: result.id, slug, email }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  console.warn(JSON.stringify({
    admin: true,
    event: "admin_resend_activation_failed",
    slug,
    email_to_length: email.length,
    error: result.error,
    retryable: result.retryable,
  }));
  return new Response(
    JSON.stringify({ error: result.error, retryable: result.retryable, slug }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
}

// ── POST /api/activate/hosted ────────────────────────────────────────────────
//
// Hosted-tenant activation endpoint. Token-authenticated. Accepts a
// password from the customer, creates (or updates) their user account
// in D1, links them to the business via user_business_access, mints an
// access token, sets the amcp_refresh cookie, and returns the redirect
// URL for the dashboard.
//
// This is the hosted-tenant counterpart to POST /api/activate, which
// handles DNS-based tenants. Hosted tenants don't need domain entry or
// DNS setup — they just need a password to access the dashboard.
//
// Response shape:
//   200 { ok, access_token, expires_in, redirect, hosted_url }
//       + Set-Cookie: amcp_refresh=...
//   400 { error }   — not hosted, no token, password too short, etc
//   401 { error }   — token invalid or expired
//   500 { error }   — platform error (missing signing key, etc)

export async function handleActivateHosted(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return withCors(jsonErr(405, "unknown"), request);
  }
  if (!env.ACTIVATION_SIGNING_KEY) {
    console.error(JSON.stringify({
      activate: true,
      event: "hosted_activation_reject",
      error_code: "platform_error",
      reason: "ACTIVATION_SIGNING_KEY missing from env",
    }));
    return withCors(jsonErr(500, "platform_error"), request);
  }
  if (!env.ACCESS_TOKEN_SIGNING_KEY) {
    console.error(JSON.stringify({
      activate: true,
      event: "hosted_activation_reject",
      error_code: "platform_error",
      reason: "ACCESS_TOKEN_SIGNING_KEY missing from env",
    }));
    return withCors(jsonErr(500, "platform_error"), request);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    return withCors(jsonErr(400, "domain_required"), request);
  }

  // ── Extract and verify token ──────────────────────────────────────────
  const token =
    request.headers.get("X-Activation-Token") ??
    (typeof body.token === "string" ? body.token : null) ??
    new URL(request.url).searchParams.get("t");

  if (!token) {
    return withCors(jsonErr(401, "missing_token"), request);
  }

  let payload: ActivationTokenPayload;
  try {
    payload = await verifyActivationToken(token, env.ACTIVATION_SIGNING_KEY);
  } catch (err) {
    const reason = err as ActivationTokenError;
    const code = reason === "expired" ? "token_expired" : "token_invalid";
    console.warn(JSON.stringify({
      activate: true,
      event: "hosted_activation_reject",
      error_code: code,
      reason,
    }));
    return withCors(jsonErr(401, code), request);
  }
  const slug = payload.slug;

  // ── Verify this is a hosted tenant ──────────────────────────────────────
  const tenantDomain = `${slug}.hosted.advocatemcp.com`;
  const tenant = await getTenant(env, tenantDomain);
  if (!tenant || tenant.skipDns !== true) {
    return withCors(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: "not_hosted",
          customer_message: "This activation link is for a domain-based account. Please use the domain activation page instead.",
        }, null, 2),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
      request,
    );
  }

  // ── Verify business exists in D1 ────────────────────────────────────────
  const biz = await getBusinessBySlug(env.DB, slug);
  if (!biz) {
    console.warn(JSON.stringify({
      activate: true,
      event: "hosted_activation_reject",
      error_code: "account_not_ready",
      slug,
    }));
    return withCors(jsonErr(400, "account_not_ready"), request);
  }

  // ── Validate password ──────────────────────────────────────────────────
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) {
    return withCors(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: "password_too_short",
          customer_message: "Password must be at least 8 characters.",
        }, null, 2),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
      request,
    );
  }

  // ── Create or update user ──────────────────────────────────────────────
  const email = tenant.email.toLowerCase().trim();
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);

  let user = await getUserByEmail(env.DB, email);
  if (user) {
    await updateUserPassword(env.DB, user.id, passwordHash, salt);
  } else {
    user = await createUser(env.DB, email, passwordHash, salt, tenant.name, "client");
  }

  // ── Link user to business (idempotent via INSERT OR IGNORE) ────────────
  await grantAccess(env.DB, user.id, biz.id);

  // ── Mint session + access token ────────────────────────────────────────
  // Inline session creation — same pattern as handleAuthLogin in authApi.ts.
  // We need control over the raw refresh token to set the cookie, which
  // portalDb.createSession doesn't expose (see authApi.ts:340-345).
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
    .bind(sessionId, user.id, refreshTokenHash, expiresIso, nowIso, nowIso)
    .run();

  const accessToken = await signAccessToken(
    {
      sub:       user.id,
      role:      user.role,
      tenant_id: null,
      email:     user.email,
      full_name: user.full_name,
    },
    env.ACCESS_TOKEN_SIGNING_KEY,
  );

  console.log(JSON.stringify({
    activate: true,
    event: "hosted_activation_success",
    slug,
    user_id: user.id,
    is_new_user: !await getUserByEmail(env.DB, email), // always false here, but documents intent
  }));

  const responseBody = {
    ok: true,
    access_token: accessToken,
    expires_in:   ACCESS_TOKEN_TTL_SECONDS,
    redirect:     "https://advocatemcp.com/dashboard.html",
    hosted_url:   `https://${tenantDomain}`,
  };

  const resp = new Response(JSON.stringify(responseBody, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie":   refreshCookieHeader(refreshRawToken),
    },
  });
  return withCors(resp, request, { credentials: true });
}
