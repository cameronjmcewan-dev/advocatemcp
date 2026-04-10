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
} from "../lib/activation-token";
import {
  activateDomain,
  type ActivateFailReason,
} from "./domains";

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

export async function handleActivate(request: Request, env: Env): Promise<Response> {
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

  return jsonOk({
    ...result.body,
    customer_message: SUCCESS_CUSTOMER_MESSAGE,
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
