// Stripe integration for tenant onboarding — payment gating via Checkout Sessions.
//
// Routes:
//   POST /api/onboard/basic              — admin-auth'd DNS flow (worker /onboard wizard)
//   POST /api/onboard/public             — no-auth wizard flow (advocatemcp.com wizard, no DNS)
//   OPTIONS /api/onboard/public          — CORS preflight for the public endpoint
//   POST /api/stripe/webhook             — Stripe webhook (checkout.session.completed)
//   GET  /api/onboard/session/:session_id — poll payment status after Stripe redirect (CORS)

import type { Env } from "../types";
import {
  CNAME_TARGET,
  type TenantRecord,
  type TenantStatus,
  normalizeDomain,
  getTenant,
  putTenant,
  addStatusLog,
  transitionStatus,
  buildDnsInstructions,
  createCfHostnameForTenant,
  jsonOk,
  jsonErr,
  requireAdmin,
} from "./onboard";
import { ensureWorkerRouteForHostname } from "./domains";
import { deriveHostnameVariants } from "../lib/hostnameVariants";
import { signActivationToken } from "../lib/activation-token";
import { validateOnboardingPayload } from "../lib/validateOnboarding";
import { sendActivationEmail } from "../lib/resend";
import {
  getActivationRecord,
  setActivationTokenIfMissing,
  updateActivationStatus,
  updateBusinessApiKey,
  getBusinessBySlug,
  getActiveBusinesses,
  getUserBusinesses,
} from "../portalDb";
import { getSessionFromRequest } from "./authApi";

// ── CORS helper for the public wizard endpoint ───────────────────────────────
// Only the marketing site + Cloudflare Pages preview deploys are trusted.
// Every Pages preview gets a unique subdomain on *.advocatemcp-site.pages.dev
// (both commit-SHA deploys and branch aliases like design-preview.*) — so we
// allowlist the eTLD+1 suffix rather than enumerating every ephemeral deploy.
// Everything else gets the default origin so stray `fetch` from unknown
// origins cannot read the response.

const ALLOWED_ORIGINS = new Set<string>([
  "https://advocatemcp.com",
  "https://www.advocatemcp.com",
]);

const PREVIEW_HOST_SUFFIX = ".advocatemcp-site.pages.dev";

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && u.hostname.endsWith(PREVIEW_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = isAllowedOrigin(origin) ? origin : "https://advocatemcp.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function withCors(resp: Response, request: Request): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export function handlePublicOnboardPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

// ── Stripe API helpers ───────────────────────────────────────────────────────

async function stripeApi(
  secretKey: string,
  method: string,
  path: string,
  params?: Record<string, string>,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const url = `https://api.stripe.com/v1${path}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(secretKey + ":")}`,
  };

  let body: string | undefined;
  if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }

  const resp = await fetch(url, { method, headers, body });
  const data = (await resp.json()) as Record<string, unknown>;
  return { ok: resp.ok, data };
}

// ── Stripe webhook signature verification (Workers-compatible) ───────────────

async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Reject signatures older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return expected === signature;
}

// ── Beta cohort detection ────────────────────────────────────────────────────
//
// Looks at the discount applied to a Stripe subscription and decides
// whether the tenant should be flagged as beta. We only flag when the
// applied coupon is in the BETA_COUPON_IDS env var allowlist —
// prevents future "friends discount" coupons from accidentally tagging
// tenants as beta.
//
// Returns:
//   { is_beta: false }                        — no discount, or coupon
//                                                not on allowlist
//   { is_beta: true, started_at, ends_at,    — eligible
//     coupon_id, duration_months }
//
// duration_in_months from the coupon → ends_at = started_at + N months.
// "forever"-duration coupons get is_beta=false (those are perpetual
// discounts, not beta trials).
//
// Failure handling: any Stripe API error returns is_beta=false rather
// than throwing. The webhook caller wraps this in try/catch so a
// transient Stripe blip doesn't block tenant activation.

interface BetaDetection {
  is_beta:           boolean;
  started_at?:       string;
  ends_at?:          string;
  coupon_id?:        string;
  duration_months?:  number;
}

async function detectBetaCoupon(env: Env, subscriptionId: string): Promise<BetaDetection> {
  const allowlist = (env.BETA_COUPON_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // If no allowlist configured, no tenants ever get marked as beta.
  // Operator must set BETA_COUPON_IDS in worker secrets after creating
  // the coupon in Stripe Dashboard.
  if (allowlist.length === 0) return { is_beta: false };

  if (!env.STRIPE_SECRET_KEY) return { is_beta: false };

  // Stripe's modern subscription shape puts applied promotion codes /
  // coupons in `discounts[]` (array). The legacy `discount` (singular)
  // is null for any subscription created via Checkout w/ a promo code,
  // even when a discount is clearly applied. We read from `discounts[]`
  // first and fall back to `discount` only for accounts still on the
  // legacy shape. Each discount has shape:
  //   { id, promotion_code, source: { coupon: <id|expanded>, type } }
  // so we expand `discounts.source.coupon` to get duration_in_months.
  const r = await stripeApi(
    env.STRIPE_SECRET_KEY,
    "GET",
    `/subscriptions/${encodeURIComponent(subscriptionId)}` +
      `?expand[]=discounts.source.coupon&expand[]=discount.coupon`,
  );
  if (!r.ok) return { is_beta: false };

  const sub = r.data as Record<string, unknown>;

  // Collect all coupons applied to this subscription. Modern path is
  // discounts[].source.coupon; legacy path is discount.coupon.
  type StripeCoupon = {
    id?: string;
    duration?: string;
    duration_in_months?: number;
  };
  const coupons: StripeCoupon[] = [];

  const discounts = sub.discounts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(discounts)) {
    for (const d of discounts) {
      const source = d.source as Record<string, unknown> | undefined;
      const coupon = source?.coupon as StripeCoupon | undefined;
      if (coupon && typeof coupon === "object") coupons.push(coupon);
    }
  }
  const legacyDiscount = sub.discount as Record<string, unknown> | null | undefined;
  if (legacyDiscount) {
    const c = legacyDiscount.coupon as StripeCoupon | undefined;
    if (c && typeof c === "object") coupons.push(c);
  }

  // First coupon on the allowlist wins. In practice subscriptions
  // typically have one discount; if a tenant somehow stacked two,
  // beta wins over non-beta because we want them in the cohort.
  const matched = coupons.find(
    (c) => typeof c.id === "string" && allowlist.includes(c.id),
  );
  if (!matched) return { is_beta: false };

  // "forever" coupons aren't trials, they're perpetual discounts. Skip.
  if (matched.duration === "forever") return { is_beta: false };

  const months = matched.duration_in_months ?? 2;
  const startedAt = new Date();
  // Stripe billing happens at period boundaries. We approximate end as
  // start + N calendar months. Actual Stripe billing for the customer
  // resumes at the same moment regardless of our local calculation —
  // this column is only for our UI countdown.
  const endsAt = new Date(startedAt);
  endsAt.setMonth(endsAt.getMonth() + months);

  return {
    is_beta:           true,
    started_at:        startedAt.toISOString(),
    ends_at:           endsAt.toISOString(),
    coupon_id:         matched.id!,
    duration_months:   months,
  };
}

// ── POST /api/onboard/basic ──────────────────────────────────────────────────
// Accepts business info + plan choice. Creates tenant in KV, then either
// redirects to Stripe Checkout (base/pro) or kicks off free DNS flow.

export async function handleBasicOnboard(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required — provide X-Admin-Secret header");
  }

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    return jsonErr(415, "invalid_content_type", "Content-Type must be application/json");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json", "Request body must be valid JSON");
  }

  // Validate required fields
  const required = ["name", "domain", "slug", "phone", "email"] as const;
  const missing: string[] = [];
  for (const field of required) {
    const val = body[field];
    if (typeof val !== "string" || val.trim().length === 0) missing.push(field);
  }
  if (typeof body.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    missing.push("email (invalid format)");
  }
  if (missing.length > 0) {
    return jsonErr(400, "validation_error", `Missing or invalid fields: ${missing.join(", ")}`);
  }

  // Validate plan
  const plan = (body.plan as string ?? "base").toLowerCase();
  if (!["free", "base", "pro"].includes(plan)) {
    return jsonErr(400, "invalid_plan", "Plan must be 'free', 'base', or 'pro'");
  }

  // Normalize domain
  const domain = normalizeDomain(body.domain as string);
  if (!domain) {
    return jsonErr(400, "invalid_domain", "Domain is invalid or belongs to a reserved namespace");
  }

  const slug = (body.slug as string).toLowerCase().trim();
  const now = new Date().toISOString();

  // Check for existing tenant
  const existing = await getTenant(env, domain);
  if (existing && existing.status === "active") {
    return jsonOk({
      ok: true,
      action: "already_active",
      domain,
      slug: existing.slug,
      status: existing.status,
      message: `Tenant ${domain} is already active.`,
    });
  }

  // Build tenant record
  const tenant: TenantRecord = existing ?? {
    domain,
    name: (body.name as string).trim(),
    slug,
    phone: (body.phone as string ?? "").trim(),
    email: (body.email as string).trim().toLowerCase(),
    address: (body.address as string ?? "").trim(),
    city: (body.city as string ?? "").trim(),
    state: (body.state as string ?? "").trim(),
    postalCode: (body.postalCode as string ?? "").trim(),
    country: (body.country as string ?? "US").trim().toUpperCase(),
    services: [],
    website: (body.website as string ?? "").trim(),
    notes: "",
    status: "pending_payment" as TenantStatus,
    cloudflare: {
      customHostnameId: null,
      verificationMethod: "txt",
      verificationStatus: "pending",
      sslStatus: "pending",
      txtName: null,
      txtValue: null,
      ownershipTxtName: null,
      ownershipTxtValue: null,
    },
    stripe: {
      customerId: null,
      subscriptionId: null,
      checkoutSessionId: null,
      plan: plan as "free" | "base" | "pro",
    },
    statusLog: [],
    createdAt: now,
    updatedAt: now,
  };

  // Update mutable fields if re-onboarding
  if (existing) {
    tenant.name = (body.name as string).trim();
    tenant.phone = (body.phone as string ?? "").trim();
    tenant.email = (body.email as string).trim().toLowerCase();
    if (!tenant.stripe) {
      tenant.stripe = { customerId: null, subscriptionId: null, checkoutSessionId: null, plan: plan as "free" | "base" | "pro" };
    }
    tenant.stripe.plan = plan as "free" | "base" | "pro";
  }

  // ── Free path ──────────────────────────────────────────────────────────────
  if (plan === "free") {
    transitionStatus(tenant, "free_pending_dns", "Free plan selected — skipping payment");

    // Create CF hostname for every variant (apex + www, or just the
    // typed input for custom subdomains / hosted-tenant slugs).
    await createCfHostnameForTenant(env, tenant);

    // Write KV — one entry per variant so the worker's hostname-based
    // slug lookup hits regardless of which variant a bot crawled.
    for (const variant of deriveHostnameVariants(domain)) {
      await env.BUSINESS_MAP.put(variant, slug);
    }
    await putTenant(env, tenant);

    // Register in D1
    await registerBusinessInD1(env, tenant, plan, now);

    return jsonOk({
      ok: true,
      domain,
      slug,
      status: tenant.status,
      plan: "free",
      dns: buildDnsInstructions(tenant),
    }, 201);
  }

  // ── Paid path (base or pro) ────────────────────────────────────────────────
  if (!env.STRIPE_SECRET_KEY) {
    return jsonErr(500, "stripe_not_configured", "STRIPE_SECRET_KEY is not set");
  }

  const priceId = plan === "pro" ? env.STRIPE_PRICE_ID_PRO : env.STRIPE_PRICE_ID_BASE;
  if (!priceId) {
    return jsonErr(500, "stripe_price_missing", `STRIPE_PRICE_ID_${plan.toUpperCase()} is not set`);
  }

  // Determine success/cancel URLs from request origin
  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/onboard?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/onboard?cancelled=true`;

  // Create Stripe Checkout Session
  // allow_promotion_codes adds an "Add promotion code" link to Stripe's
  // hosted checkout UI. Beta testers paste a Stripe Promotion Code
  // (created in the Stripe Dashboard, attached to a 100%-off-for-N-months
  // coupon) to get free trial pricing. The webhook below detects the
  // applied coupon and flags the tenant as beta so we can:
  //   - render a beta banner with countdown
  //   - send beta-specific weekly digests
  //   - track conversion at trial end
  const stripeResult = await stripeApi(env.STRIPE_SECRET_KEY, "POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: domain,
    "metadata[domain]": domain,
    "metadata[slug]": slug,
    "metadata[plan]": plan,
    customer_email: tenant.email,
    allow_promotion_codes: "true",
  });

  if (!stripeResult.ok) {
    console.log(JSON.stringify({
      onboarding: true,
      event: "stripe_checkout_error",
      domain,
      error: stripeResult.data,
    }));
    return jsonErr(502, "stripe_error", "Failed to create Stripe Checkout Session", stripeResult.data);
  }

  const checkoutUrl = stripeResult.data.url as string;
  const sessionId = stripeResult.data.id as string;

  // Update tenant with Stripe session info
  tenant.stripe!.checkoutSessionId = sessionId;
  transitionStatus(tenant, "pending_payment", `Stripe Checkout created: ${sessionId}`);

  // Write KV (routing not active yet — just storing the record)
  await putTenant(env, tenant);

  // Register in D1 (with pending status)
  await registerBusinessInD1(env, tenant, plan, now);

  console.log(JSON.stringify({
    onboarding: true,
    event: "stripe_checkout_created",
    domain,
    slug,
    plan,
    sessionId,
  }));

  return jsonOk({
    ok: true,
    domain,
    slug,
    status: "pending_payment",
    plan,
    checkoutUrl,
  }, 201);
}

// ── POST /api/onboard/public ─────────────────────────────────────────────────
// Public, no-auth onboarding used by the marketing wizard on advocatemcp.com.
//
// Accepts a small payload: { slug, name, email, plan, referral_url? }
// Does NOT require/accept a domain — it synthesizes one in our own namespace
// for tenant keying only. Does NOT create a Cloudflare custom hostname. On
// payment success, webhook transitions skip-dns tenants straight to `active`.

export async function handlePublicOnboard(
  request: Request,
  env: Env,
): Promise<Response> {
  // Content-Type guard
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    return withCors(
      jsonErr(415, "invalid_content_type", "Content-Type must be application/json"),
      request,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return withCors(jsonErr(400, "invalid_json", "Request body must be valid JSON"), request);
  }

  // Validate + sanitize required fields. PAID-ONLY: free is not accepted.
  const rawSlug = (body.slug as string ?? "").toLowerCase().trim();
  const name = (body.name as string ?? "").trim();
  const email = (body.email as string ?? "").trim().toLowerCase();
  const plan = ((body.plan as string ?? "base").toLowerCase()) as "base" | "pro";
  const referralUrl = (body.referral_url as string ?? "").trim();
  // Optional full business profile — validated at ingress, then persisted on
  // the tenant and pushed to Railway server-side (best-effort, non-blocking).
  // Keeps the browser on a single origin so Railway's CORS preflight cannot
  // break checkout. Legacy minimal onboard (no profile) still works.
  let profilePayload: Record<string, unknown> | null = null;
  if (body.profile !== undefined && body.profile !== null) {
    const validation = validateOnboardingPayload(body.profile);
    if (!validation.ok) {
      return withCors(
        jsonErr(400, "validation_error", validation.errors.join("; ")),
        request,
      );
    }
    profilePayload = validation.value;
  }

  const errors: string[] = [];
  if (!rawSlug || !/^[a-z0-9][a-z0-9-]*[a-z0-9]?$/.test(rawSlug) || rawSlug.length > 60) {
    errors.push("slug (lowercase alphanumeric + hyphens, 2-60 chars)");
  }
  if (!name) errors.push("name");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("email (invalid format)");
  if (!["base", "pro"].includes(plan)) errors.push("plan (must be 'base' or 'pro' — free tier removed)");
  if (errors.length > 0) {
    return withCors(
      jsonErr(400, "validation_error", `Missing or invalid fields: ${errors.join(", ")}`),
      request,
    );
  }

  // Synthesize a tenant key under our own namespace. This is NEVER used for DNS.
  // The skipDns flag prevents any custom hostname creation path from running.
  const slug = rawSlug;
  const domain = `${slug}.hosted.advocatemcp.com`;
  const now = new Date().toISOString();

  // ── TEMPORARY DIAGNOSTIC: Stripe key mode probe ────────────────────────────
  // Logs only the first ~12 chars of each key. Stripe treats the `sk_test_` /
  // `sk_live_` / `whsec_test_` / `price_` prefixes as non-secret mode
  // indicators, and 12 chars is not enough entropy to compromise the secret.
  // This log exists to definitively answer "is the deployed worker in test
  // mode or live mode?" — watch via `wrangler tail`. Remove in a follow-up
  // deploy once the test-mode flow is verified end-to-end.
  console.log(JSON.stringify({
    onboarding: true,
    event: "stripe_key_probe",
    slug,
    plan,
    secret_prefix:         env.STRIPE_SECRET_KEY?.slice(0, 12)     ?? "MISSING",
    base_price_prefix:     env.STRIPE_PRICE_ID_BASE?.slice(0, 10)  ?? "MISSING",
    pro_price_prefix:      env.STRIPE_PRICE_ID_PRO?.slice(0, 10)   ?? "MISSING",
    webhook_secret_prefix: env.STRIPE_WEBHOOK_SECRET?.slice(0, 10) ?? "MISSING",
  }));

  // Idempotent lookup — if already paid + active, short-circuit. Otherwise
  // we always re-issue a fresh Stripe Checkout session (safer than reusing
  // an expired one).
  const existing = await getTenant(env, domain);
  if (existing && existing.status === "active" && existing.stripe?.subscriptionId) {
    return withCors(
      jsonOk({
        ok: true,
        action: "already_active",
        slug: existing.slug,
        status: existing.status,
        plan: existing.stripe?.plan ?? plan,
        message: `${slug} already has an active subscription.`,
      }),
      request,
    );
  }

  // Build tenant record
  const tenant: TenantRecord = existing ?? {
    domain,
    name,
    slug,
    phone: "",
    email,
    address: "",
    city: "",
    state: "",
    postalCode: "",
    country: "US",
    services: [],
    website: referralUrl,
    notes: "Created via marketing wizard (advocatemcp.com/onboarding)",
    status: "pending_payment" as TenantStatus,
    cloudflare: {
      customHostnameId: null,
      verificationMethod: "none",
      verificationStatus: "not_applicable",
      sslStatus: "not_applicable",
      txtName: null,
      txtValue: null,
      ownershipTxtName: null,
      ownershipTxtValue: null,
    },
    stripe: {
      customerId: null,
      subscriptionId: null,
      checkoutSessionId: null,
      plan,
    },
    skipDns: true,
    statusLog: [],
    createdAt: now,
    updatedAt: now,
  };

  if (existing) {
    tenant.name = name;
    tenant.email = email;
    tenant.website = referralUrl || tenant.website;
    tenant.skipDns = true;
    if (!tenant.stripe) {
      tenant.stripe = { customerId: null, subscriptionId: null, checkoutSessionId: null, plan };
    }
    tenant.stripe.plan = plan;
  }

  // Attach the validated profile to the tenant so the webhook handler has
  // everything it needs to push to Railway once payment succeeds.
  if (profilePayload) {
    tenant.profile = profilePayload;
  }

  console.log(JSON.stringify({
    onboarding: true,
    event: "public_onboard_started",
    slug,
    plan,
    hasExisting: !!existing,
    hasProfile: !!profilePayload,
  }));

  // ── Paid path (base or pro only — free tier removed) ──────────────────────
  if (!env.STRIPE_SECRET_KEY) {
    return withCors(
      jsonErr(500, "stripe_not_configured", "STRIPE_SECRET_KEY is not set"),
      request,
    );
  }

  const priceId = plan === "pro" ? env.STRIPE_PRICE_ID_PRO : env.STRIPE_PRICE_ID_BASE;
  if (!priceId) {
    return withCors(
      jsonErr(500, "stripe_price_missing", `STRIPE_PRICE_ID_${plan.toUpperCase()} is not set`),
      request,
    );
  }

  // Fixed success/cancel URLs — always land back on the marketing brand.
  // success_url ⇒ site/onboarding/complete.html (static page that polls
  // GET /api/onboard/session/:session_id and renders confirmation/CTA).
  // cancel_url ⇒ site/onboarding.html (re-entry into the wizard with a banner).
  const successUrl = "https://advocatemcp.com/onboarding/complete.html?session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl  = "https://advocatemcp.com/onboarding.html?cancelled=true";

  const stripeResult = await stripeApi(env.STRIPE_SECRET_KEY, "POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: domain,
    "metadata[domain]": domain,
    "metadata[slug]": slug,
    "metadata[plan]": plan,
    "metadata[skip_dns]": "true",
    customer_email: email,
    // Beta testers paste a Stripe Promotion Code (BETA → coupon TAuIQlgr,
    // 100% off for 2 months) at checkout. Without this flag the "Add
    // promotion code" link is hidden in Stripe's hosted UI, so the wizard
    // path silently breaks beta onboarding even though the coupon exists.
    // The webhook below detects the applied coupon ID against
    // BETA_COUPON_IDS and stamps beta_started_at / beta_ends_at on D1.
    allow_promotion_codes: "true",
  });

  if (!stripeResult.ok) {
    console.log(JSON.stringify({
      onboarding: true,
      event: "public_checkout_error",
      slug,
      error: stripeResult.data,
    }));
    return withCors(
      jsonErr(502, "stripe_error", "Failed to create Stripe Checkout Session", stripeResult.data),
      request,
    );
  }

  const checkoutUrl = stripeResult.data.url as string;
  const sessionId = stripeResult.data.id as string;

  tenant.stripe!.checkoutSessionId = sessionId;
  transitionStatus(tenant, "pending_payment", `Stripe Checkout created via wizard: ${sessionId}`);
  await putTenant(env, tenant);
  await registerBusinessInD1(env, tenant, plan, now);

  console.log(JSON.stringify({
    onboarding: true,
    event: "public_checkout_created",
    slug,
    plan,
    sessionId,
  }));

  return withCors(
    jsonOk({
      ok: true,
      slug,
      status: "pending_payment",
      plan,
      checkoutUrl,
      sessionId,
    }, 201),
    request,
  );
}

// ── D1 business registration helper ──────────────────────────────────────────

export async function registerBusinessInD1(
  env: Env,
  tenant: TenantRecord,
  plan: string,
  now: string,
): Promise<void> {
  try {
    const existingBiz = await env.DB
      .prepare("SELECT slug FROM businesses WHERE slug = ? LIMIT 1")
      .bind(tenant.slug)
      .first<{ slug: string }>();

    // Helper: JSON-stringify objects/arrays, pass null for missing values.
    // TEXT columns (differentiators_text, guarantee_text) must NOT be stringified.
    const j = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
    const p = tenant.profile ?? {};

    if (!existingBiz) {
      const bizId = crypto.randomUUID().replace(/-/g, "");
      await env.DB
        .prepare(
          `INSERT INTO businesses
             (id, slug, business_name, api_key, created_at, plan, domain,
              hours_json, services_json_v2, pricing_json_v2, credentials_json,
              ratings_json, differentiators_text, customer_quotes_json,
              guarantee_text, case_stories_json, lead_routing_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          bizId, tenant.slug, tenant.name, "pending", now, plan, tenant.domain,
          j(p.hours_json), j(p.services_json_v2), j(p.pricing_json_v2), j(p.credentials_json),
          j(p.ratings_json), p.differentiators_text ?? null, j(p.customer_quotes_json),
          p.guarantee_text ?? null, j(p.case_stories_json), j(p.lead_routing_json),
        )
        .run();
    } else {
      // COALESCE(?, col) means re-onboard can only ADD or OVERWRITE values, never CLEAR them.
      // An explicit clear must go through a separate admin path — prevents a partial re-onboard payload from wiping fields set on a richer previous onboard.
      await env.DB
        .prepare(
          `UPDATE businesses
           SET plan = ?, domain = ?,
               hours_json = COALESCE(?, hours_json),
               services_json_v2 = COALESCE(?, services_json_v2),
               pricing_json_v2 = COALESCE(?, pricing_json_v2),
               credentials_json = COALESCE(?, credentials_json),
               ratings_json = COALESCE(?, ratings_json),
               differentiators_text = COALESCE(?, differentiators_text),
               customer_quotes_json = COALESCE(?, customer_quotes_json),
               guarantee_text = COALESCE(?, guarantee_text),
               case_stories_json = COALESCE(?, case_stories_json),
               lead_routing_json = COALESCE(?, lead_routing_json)
           WHERE slug = ?`,
        )
        .bind(
          plan, tenant.domain,
          j(p.hours_json), j(p.services_json_v2), j(p.pricing_json_v2), j(p.credentials_json),
          j(p.ratings_json), p.differentiators_text ?? null, j(p.customer_quotes_json),
          p.guarantee_text ?? null, j(p.case_stories_json), j(p.lead_routing_json),
          tenant.slug,
        )
        .run();
    }
  } catch (err) {
    console.log(JSON.stringify({
      onboarding: true,
      event: "d1_write_warning",
      domain: tenant.domain,
      error: String(err),
    }));
    addStatusLog(tenant, "d1_write_warning", String(err));
  }
}

// ── Railway registration helper ──────────────────────────────────────────────
//
// Called from handleStripeWebhook to create the business profile on the
// Railway Express backend so the agent can serve AI crawler queries.
// Without this registration, GET /agents/:slug/profile returns 404 and
// the activation handler's profile check rejects with slug_not_registered.
//
// Reads the wizard-collected profile from the tenant KV record (the
// `profile` field attached at stripe.ts:479) and maps it to Railway's
// POST /register expected shape. Uses safe defaults for required fields
// the wizard doesn't collect (description, star_rating, review_count).

type RailwayRegisterResult =
  | { ok: true; api_key: string; slug: string }
  | { ok: false; error: string };

export async function registerBusinessOnRailway(
  env: Env,
  tenant: TenantRecord,
  beta?: BetaDetection & { cohort?: string },
): Promise<RailwayRegisterResult> {
  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";

  // Read the wizard profile defensively — may be undefined for legacy tenants.
  const profile = tenant.profile ?? {};
  const loc = (profile.location as Record<string, unknown>) ?? {};
  const contact = (profile.contact as Record<string, unknown>) ?? {};
  const rawServices = Array.isArray(profile.services) ? profile.services : [];

  // Map wizard fields → Railway's POST /register shape
  const services = rawServices
    .map((s: unknown) => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object" && "name" in s) return String((s as { name: unknown }).name);
      return null;
    })
    .filter((s): s is string => s !== null);

  const city = typeof loc.city === "string" ? loc.city : "";
  const state = typeof loc.state === "string" ? loc.state : "";
  const location = [city, state].filter(Boolean).join(", ") || "Not specified";

  // Map wizard pricing_tier → Railway's expected values
  const pricingMap: Record<string, string> = {
    under_500: "budget",
    "500_2000": "mid-range",
    over_2000: "premium",
  };
  const rawPricingTier = typeof profile.pricing_tier === "string" ? profile.pricing_tier : "";
  // `pricingMap[...]` returns undefined when there's no mapping. We must NOT
  // coalesce to null — Railway's zod schema (server/src/schemas/business.ts:
  // OnboardingPayloadSchema) uses `pricing_tier: z.enum([...]).optional()`,
  // which accepts undefined but REJECTS null with a validation_error. Setting
  // the key to `undefined` below means JSON.stringify omits it entirely,
  // which is what zod's .optional() actually wants.
  const pricingTier: string | undefined = pricingMap[rawPricingTier];

  const differentiators = Array.isArray(profile.differentiators) ? profile.differentiators : [];

  // Build base body — always present
  const body: Record<string, unknown> = {
    name: tenant.name,
    description: typeof profile.description === "string" ? profile.description : `${tenant.name} — managed by AdvocateMCP`,
    services: services.length > 0 ? services : ["General services"],
    category: typeof profile.category === "string" ? profile.category : "general",
    location,
    star_rating: typeof profile.star_rating === "number" ? profile.star_rating : 0,
    review_count: typeof profile.review_count === "number" ? profile.review_count : 0,
    phone: (typeof contact.phone === "string" ? contact.phone : tenant.phone) || undefined,
    website: (typeof contact.website === "string" ? contact.website : tenant.website) || undefined,
    referral_url: (typeof profile.referral_url === "string" ? profile.referral_url : tenant.website) || undefined,
    tone: typeof profile.tone === "string" ? profile.tone : "friendly",
    pricing_tier: pricingTier,
    availability: typeof profile.availability === "string" ? profile.availability : undefined,
    differentiator: typeof profile.differentiator === "string"
      ? profile.differentiator
      : (typeof differentiators[0] === "string" ? differentiators[0] : undefined),
    // P5 radar digest recipient — forwarded so Railway's businesses.email
    // gets populated at registration. If absent, Railway defaults the column
    // to NULL and the digest job silently skips the tenant.
    email: tenant.email || undefined,
  };

  // Forward 9-step wizard JSON blobs — only when present so undefined keys
  // are omitted from the serialized body and zod .optional() does not reject.
  if (profile.hours_json !== undefined) body.hours_json = profile.hours_json;
  if (profile.services_json_v2 !== undefined) body.services_json_v2 = profile.services_json_v2;
  if (profile.pricing_json_v2 !== undefined) body.pricing_json_v2 = profile.pricing_json_v2;
  if (profile.credentials_json !== undefined) body.credentials_json = profile.credentials_json;
  if (profile.ratings_json !== undefined) body.ratings_json = profile.ratings_json;
  if (typeof profile.differentiators_text === "string") body.differentiators_text = profile.differentiators_text;
  if (profile.customer_quotes_json !== undefined) body.customer_quotes_json = profile.customer_quotes_json;
  if (typeof profile.guarantee_text === "string") body.guarantee_text = profile.guarantee_text;
  if (profile.case_stories_json !== undefined) body.case_stories_json = profile.case_stories_json;
  if (profile.lead_routing_json !== undefined) body.lead_routing_json = profile.lead_routing_json;
  // Scalar fields accepted by OnboardingPayloadSchema
  if (typeof profile.years_in_business === "number") body.years_in_business = profile.years_in_business;
  if (typeof profile.certifications === "string") body.certifications = profile.certifications;
  if (typeof profile.service_radius_miles === "number") body.service_radius_miles = profile.service_radius_miles;
  if (typeof profile.service_area_keywords === "string") body.service_area_keywords = profile.service_area_keywords;
  if (typeof profile.top_services === "string") body.top_services = profile.top_services;

  // Session 4 followup: forward the Stripe-side plan tier so Railway's
  // businesses.plan column matches what the customer is paying for. Only
  // 'base' and 'pro' are valid values on the wire (the server's zod schema
  // rejects anything else); 'free' (or no stripe block at all) means we
  // intentionally omit the field and let the server's column default ('base')
  // apply, so the on-wire body stays back-compat for non-Stripe register paths.
  const stripePlan = tenant.stripe?.plan;
  if (stripePlan === "base" || stripePlan === "pro") {
    body.plan = stripePlan;
  }

  // Forward beta cohort fields when this tenant signed up with a beta
  // promotion code. Server-side weeklyDigest + trial-ending email cron
  // read these to pick the right copy. Server's /register zod schema
  // accepts these as optional; absent values are simply ignored.
  if (beta?.is_beta) {
    body.beta_started_at = beta.started_at;
    body.beta_ends_at    = beta.ends_at;
    body.beta_coupon_id  = beta.coupon_id;
    body.beta_cohort     = beta.cohort;
  }

  try {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      let errMsg = `Railway /register ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: string; message?: string };
        if (errBody.error) errMsg += `: ${errBody.error}`;
        else if (errBody.message) errMsg += `: ${errBody.message}`;
      } catch { /* non-JSON response */ }
      return { ok: false, error: errMsg };
    }

    const data = (await res.json()) as { slug?: string; api_key?: string };
    if (!data.api_key) {
      return { ok: false, error: "Railway /register returned 2xx but no api_key in response" };
    }
    return { ok: true, api_key: data.api_key, slug: data.slug ?? tenant.slug };
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      error: isTimeout ? "Railway /register timed out after 10s" : `Network error: ${String(err)}`,
    };
  }
}

// ── Phase F Part 1: activation token provisioning ───────────────────────────
//
// Mint an activation token for a business and persist it to D1 with
// status 'pending_send'. Called from handleStripeWebhook after a
// successful checkout.session.completed event.
//
// Idempotent. First call mints + writes + returns "minted". Subsequent
// calls (Stripe retry, concurrent webhook) short-circuit on the SELECT
// and return "existing" without invoking signActivationToken at all —
// the short-circuit avoids wasted HMAC work on every retry and is
// explicitly asserted by stripe.test.ts. The underlying write is still
// atomic (UPDATE ... WHERE activation_token IS NULL) so two calls that
// both pass the short-circuit concurrently are still safe: one UPDATE
// wins with meta.changes=1 and the other falls through with
// meta.changes=0 returning "existing".
//
// Returns:
//   - "minted"   on successful mint-and-write
//   - "existing" when the row already has an activation_token
//   - "no_key"   when ACTIVATION_SIGNING_KEY is not configured
//   - "no_row"   when no businesses row exists for the slug (defensive;
//                the webhook path guarantees the row was created at
//                checkout-session creation time, so this branch is for
//                safety and for logging observability)

export type ProvisionActivationResult =
  | "minted"
  | "existing"
  | "no_key"
  | "no_row";

export async function provisionActivationToken(
  env: Env,
  slug: string,
  now: string,
): Promise<ProvisionActivationResult> {
  if (!env.ACTIVATION_SIGNING_KEY) return "no_key";

  // Short-circuit read — avoids signing a token that would be thrown
  // away on the no-op path. The race-safe guarantee still comes from
  // setActivationTokenIfMissing's atomic WHERE IS NULL; this SELECT
  // is a pure optimization plus the source of the no_row signal.
  const existing = await getActivationRecord(env.DB, slug);
  if (existing === null) return "no_row";
  if (existing.token !== null) return "existing";

  const SEVEN_DAYS = 7 * 24 * 3600;
  const token = await signActivationToken({ slug }, env.ACTIVATION_SIGNING_KEY, SEVEN_DAYS);
  const wrote = await setActivationTokenIfMissing(env.DB, slug, token, now);
  // If wrote is false here, another concurrent invocation won the race
  // between our SELECT and UPDATE. The token we just minted is
  // discarded; the already-stored token is left untouched.
  return wrote ? "minted" : "existing";
}

// ── POST /api/stripe/webhook ─────────────────────────────────────────────────
// Stripe calls this when checkout.session.completed fires.

export async function handleStripeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const rawBody = await request.text();
  const sigHeader = request.headers.get("Stripe-Signature") ?? "";

  const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.log(JSON.stringify({ onboarding: true, event: "stripe_webhook_invalid_sig" }));
    return new Response("Invalid signature", { status: 400 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType = event.type as string;

  console.log(JSON.stringify({
    onboarding: true,
    event: "stripe_webhook_received",
    type: eventType,
  }));

  // We only care about checkout.session.completed
  if (eventType !== "checkout.session.completed") {
    return new Response("OK", { status: 200 });
  }

  const session = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;
  if (!session) {
    return new Response("OK", { status: 200 });
  }

  const domain = session.client_reference_id as string;
  if (!domain) {
    console.log(JSON.stringify({
      onboarding: true,
      event: "stripe_webhook_no_domain",
      sessionId: session.id,
    }));
    return new Response("OK", { status: 200 });
  }

  const tenant = await getTenant(env, domain);
  if (!tenant) {
    // Bumped from console.log → console.warn in Phase F Part 1 so this
    // operational failure surfaces in wrangler tail filters that only
    // subscribe to warn/error levels. Still returns 200 so Stripe does
    // not retry against a situation that will not self-heal.
    console.warn(JSON.stringify({
      onboarding: true,
      event: "stripe_webhook_tenant_not_found",
      domain,
    }));
    return new Response("OK", { status: 200 });
  }

  // Update Stripe fields
  if (!tenant.stripe) {
    tenant.stripe = { customerId: null, subscriptionId: null, checkoutSessionId: null, plan: "base" };
  }
  tenant.stripe.customerId = (session.customer as string) ?? null;
  tenant.stripe.subscriptionId = (session.subscription as string) ?? null;
  tenant.stripe.checkoutSessionId = (session.id as string) ?? null;

  // Detect plan from metadata or line items
  const metadata = session.metadata as Record<string, string> | undefined;
  if (metadata?.plan) {
    tenant.stripe.plan = metadata.plan as "free" | "base" | "pro";
  }

  // Transition status based on whether this tenant needs a DNS step.
  //
  // Wizard flow (skipDns) → we own the `{slug}.hosted.advocatemcp.com`
  //   namespace, so we create a CF SaaS custom hostname ourselves + a
  //   Workers Route so bot traffic to that subdomain hits our Worker.
  //   Status goes straight to "active" since there's no customer DNS step.
  //
  // Admin/Pro flow (default) → tenant owns a custom domain; we still
  //   create the CF SaaS hostname on our zone + a Workers Route here,
  //   but status stays "paid_pending_dns" until the customer points their
  //   DNS at us in the /onboard wizard (the Worker Route is harmless
  //   until that happens — pattern matches but no requests arrive).
  //
  // Both CF calls are NON-FATAL by design. If CF is flaky or the token is
  // under-scoped, the tenant still activates in D1/KV and the customer can
  // reach their dashboard. Routing will self-heal on the next call via the
  // admin `/admin/domains/*` endpoints or a subsequent webhook retry. The
  // failure is logged so the operator can see what happened.
  let cfHostnameCreated = false;
  let cfFailureReason: string | null = null;

  if (tenant.skipDns === true) {
    // Wizard flow: we provision the CF hostname for the *.hosted.advocatemcp.com
    // subdomain and flip the tenant active. CF failures don't block activation
    // — log + continue; the customer is paid and deserves a working dashboard.
    try {
      const hostnameRes = await createCfHostnameForTenant(env, tenant);
      cfHostnameCreated = hostnameRes.created;
    } catch (err) {
      cfFailureReason = `createCfHostnameForTenant threw: ${String(err)}`;
    }
    transitionStatus(tenant, "active", "Payment received — wizard flow");
    console.log(JSON.stringify({
      onboarding: true,
      event: "public_onboard_paid_active",
      domain,
      slug: tenant.slug,
      cf_hostname_created: cfHostnameCreated,
      cf_failure_reason: cfFailureReason,
    }));
  } else {
    transitionStatus(tenant, "paid_pending_dns", "Payment received via Stripe Checkout");
    try {
      const hostnameRes = await createCfHostnameForTenant(env, tenant);
      cfHostnameCreated = hostnameRes.created;
    } catch (err) {
      cfFailureReason = `createCfHostnameForTenant threw: ${String(err)}`;
    }
  }

  // Workers Route creation is the final routing primitive — without this,
  // CF SaaS has a hostname configured but no Worker to dispatch to (the
  // 522 we saw in the WCC smoke test). Create one route AND one KV
  // entry per hostname variant so a bot crawling any variant gets the
  // Advocate intercept. Pre-Apr-26-2026 we registered just the primary
  // hostname here, which left the other variant (apex if signup was on
  // www, or vice versa) hitting the customer's underlying origin
  // directly — silently bypassing Advocate for ~half of bot traffic.
  // Same non-fatal semantics as the hostname step above: failures are
  // logged but don't block tenant activation. (Variants list is the
  // same one createCfHostnameForTenant fanned out over.)
  const routeVariants = deriveHostnameVariants(domain);
  for (const variant of routeVariants) {
    try {
      const routeRes = await ensureWorkerRouteForHostname(env, variant);
      if (!routeRes.ok) {
        console.log(JSON.stringify({
          onboarding: true,
          event: "stripe_webhook_worker_route_failed",
          domain,
          variant,
          slug: tenant.slug,
          error: routeRes.error,
          details: routeRes.details,
        }));
      } else {
        console.log(JSON.stringify({
          onboarding: true,
          event: "stripe_webhook_worker_route_ok",
          domain,
          variant,
          slug: tenant.slug,
          created: routeRes.created,
          route_id: routeRes.route_id,
          note: routeRes.note,
        }));
      }
    } catch (err) {
      console.log(JSON.stringify({
        onboarding: true,
        event: "stripe_webhook_worker_route_threw",
        domain,
        variant,
        slug: tenant.slug,
        error: String(err),
      }));
    }
  }

  // Write KV — routing slug for BUSINESS_MAP. One KV entry per variant
  // so the worker's hostname-based slug lookup hits regardless of which
  // variant the bot crawled.
  for (const variant of routeVariants) {
    await env.BUSINESS_MAP.put(variant, tenant.slug);
  }
  await putTenant(env, tenant);

  // Update D1 with Stripe IDs
  try {
    await env.DB
      .prepare(
        `UPDATE businesses
         SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?
         WHERE slug = ?`,
      )
      .bind(
        tenant.stripe.customerId,
        tenant.stripe.subscriptionId,
        tenant.stripe.plan,
        tenant.slug,
      )
      .run();
  } catch (err) {
    console.log(JSON.stringify({
      onboarding: true,
      event: "d1_stripe_update_warning",
      domain,
      error: String(err),
    }));
  }

  // ── Beta cohort detection ────────────────────────────────────────────────
  //
  // Fetch the subscription with discount expanded to see if a beta
  // promotion code was applied. If so, mark the tenant as beta in D1
  // so the dashboard banner / admin list / weekly digest variant can
  // pick it up. Beta coupons are explicit allowlist via env var so
  // a future "10% off forever for friends" coupon doesn't accidentally
  // mark a tenant as beta.
  //
  // Result is captured into `betaInfo` so it can flow into the Railway
  // /register call below (server-side digest + trial-ending email cron
  // need the same data).
  let betaInfo: BetaDetection = { is_beta: false };
  if (tenant.stripe.subscriptionId) {
    try {
      betaInfo = await detectBetaCoupon(env, tenant.stripe.subscriptionId);
      if (betaInfo.is_beta) {
        const cohort = `beta_${new Date().toISOString().slice(0, 7).replace("-", "_")}`;
        await env.DB
          .prepare(
            `UPDATE businesses
                SET beta_started_at = ?,
                    beta_ends_at    = ?,
                    beta_coupon_id  = ?,
                    beta_cohort     = ?
              WHERE slug = ?`,
          )
          .bind(betaInfo.started_at, betaInfo.ends_at, betaInfo.coupon_id, cohort, tenant.slug)
          .run();
        // Stamp the cohort onto the in-memory detection so we forward
        // the same value to Railway below.
        (betaInfo as BetaDetection & { cohort: string }).cohort = cohort;
        console.log(JSON.stringify({
          onboarding: true,
          event: "stripe_webhook_beta_tenant_flagged",
          slug: tenant.slug,
          coupon_id: betaInfo.coupon_id,
          cohort,
          beta_ends_at: betaInfo.ends_at,
        }));
      }
    } catch (err) {
      // Non-fatal: a Stripe API hiccup shouldn't block tenant activation.
      // The tenant just won't get the beta banner / variant digest. We
      // can backfill manually from /admin/beta-tenants if needed.
      console.warn(JSON.stringify({
        onboarding: true,
        event: "beta_detection_failed",
        slug: tenant.slug,
        error: String(err),
      }));
    }
  }

  // Register the business on Railway so the agent can serve AI crawler
  // queries and the activation handler's profile check passes. Non-fatal
  // — if Railway is down, the token still gets minted and the email gets
  // sent, but the customer's activation will fail until Railway recovers
  // and the operator manually registers.
  let railwayResult: "registered" | "failed" | "skipped" = "skipped";
  if (!env.API_BASE_URL || !env.API_KEY) {
    console.warn(JSON.stringify({
      onboarding: true,
      event: "stripe_webhook_railway_skipped",
      domain,
      slug: tenant.slug,
      reason: !env.API_BASE_URL ? "API_BASE_URL not set" : "API_KEY not set",
    }));
  } else {
    try {
      const regResult = await registerBusinessOnRailway(env, tenant, betaInfo);
      if (regResult.ok) {
        railwayResult = "registered";
        await updateBusinessApiKey(env.DB, tenant.slug, regResult.api_key);
        console.log(JSON.stringify({
          onboarding: true,
          event: "stripe_webhook_railway_register_success",
          domain,
          slug: tenant.slug,
          api_key_length: regResult.api_key.length,
        }));
      } else {
        railwayResult = "failed";
        console.warn(JSON.stringify({
          onboarding: true,
          event: "stripe_webhook_railway_register_failed",
          domain,
          slug: tenant.slug,
          error: regResult.error,
        }));
      }
    } catch (err) {
      railwayResult = "failed";
      console.warn(JSON.stringify({
        onboarding: true,
        event: "stripe_webhook_railway_register_error",
        domain,
        slug: tenant.slug,
        error: String(err),
      }));
    }
  }

  // Phase F Part 1: mint and store the activation token. Non-fatal on
  // error — a failure here does not revert the Stripe IDs write above
  // and does not trigger a Stripe retry. The operator can manually
  // issue a token via POST /admin/activation-token as a backstop.
  let activationResult: ProvisionActivationResult = "no_key";
  const nowIso = new Date().toISOString();
  try {
    activationResult = await provisionActivationToken(env, tenant.slug, nowIso);
    if (activationResult === "no_key") {
      console.warn(JSON.stringify({
        onboarding: true,
        event: "stripe_webhook_activation_no_key",
        domain,
        slug: tenant.slug,
      }));
    } else if (activationResult === "no_row") {
      console.warn(JSON.stringify({
        onboarding: true,
        event: "stripe_webhook_activation_no_row",
        domain,
        slug: tenant.slug,
      }));
    } else if (activationResult === "existing") {
      console.log(JSON.stringify({
        onboarding: true,
        event: "stripe_webhook_activation_existing",
        domain,
        slug: tenant.slug,
      }));
    } else {
      console.log(JSON.stringify({
        onboarding: true,
        event: "stripe_webhook_activation_minted",
        domain,
        slug: tenant.slug,
      }));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      onboarding: true,
      event: "stripe_webhook_activation_error",
      domain,
      slug: tenant.slug,
      error: String(err),
    }));
  }

  // Phase F Part 2: send the activation email via Resend. Non-fatal —
  // a failure leaves activation_status as 'pending_send' so the
  // operator can use POST /admin/businesses/:slug/resend-activation.
  let emailResult: "sent" | "failed" | "skipped" | "no_key" | "no_token" = "skipped";
  if (activationResult === "minted") {
    try {
      if (!env.RESEND_API_KEY) {
        emailResult = "no_key";
        console.warn(JSON.stringify({
          onboarding: true,
          event: "stripe_webhook_activation_email_no_key",
          domain,
          slug: tenant.slug,
        }));
      } else {
        const record = await getActivationRecord(env.DB, tenant.slug);
        if (!record || !record.token) {
          emailResult = "no_token";
          console.warn(JSON.stringify({
            onboarding: true,
            event: "stripe_webhook_activation_email_no_token",
            domain,
            slug: tenant.slug,
          }));
        } else {
          const activateUrl = `https://customers.advocatemcp.com/activate?t=${encodeURIComponent(record.token)}`;
          const emailTenantType = tenant.skipDns === true ? "hosted" as const : "dns" as const;
          const emailHostedUrl = tenant.skipDns === true ? `https://${tenant.slug}.hosted.advocatemcp.com` : undefined;
          const sendResult = await sendActivationEmail(env.RESEND_API_KEY, tenant.email, activateUrl, emailTenantType, emailHostedUrl);

          if (sendResult.ok) {
            await updateActivationStatus(env.DB, tenant.slug, "sent");
            emailResult = "sent";
            console.log(JSON.stringify({
              onboarding: true,
              event: "stripe_webhook_activation_email_sent",
              domain,
              slug: tenant.slug,
              email_to_length: tenant.email.length,
              email_id: sendResult.id,
            }));
          } else {
            emailResult = "failed";
            console.warn(JSON.stringify({
              onboarding: true,
              event: "stripe_webhook_activation_email_failed",
              domain,
              slug: tenant.slug,
              error: sendResult.error,
              retryable: sendResult.retryable,
            }));
          }
        }
      }
    } catch (err) {
      emailResult = "failed";
      console.warn(JSON.stringify({
        onboarding: true,
        event: "stripe_webhook_activation_email_error",
        domain,
        slug: tenant.slug,
        error: String(err),
      }));
    }
  }

  console.log(JSON.stringify({
    onboarding: true,
    event: "stripe_webhook_processed",
    domain,
    slug: tenant.slug,
    plan: tenant.stripe.plan,
    status: tenant.status,
    railway: railwayResult,
    activation: activationResult,
    email: emailResult,
  }));

  return new Response("OK", { status: 200 });
}

// ── GET /api/onboard/session/:session_id ─────────────────────────────────────
// Frontend polls this after returning from Stripe Checkout to detect when
// the webhook has fired and the tenant status has progressed.

export async function handleSessionStatus(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) {
    return withCors(
      jsonErr(500, "stripe_not_configured", "STRIPE_SECRET_KEY is not set"),
      request,
    );
  }

  // Fetch session from Stripe to get the domain
  const stripeResult = await stripeApi(
    env.STRIPE_SECRET_KEY,
    "GET",
    `/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );

  if (!stripeResult.ok) {
    return withCors(
      jsonErr(404, "session_not_found", "Stripe session not found", stripeResult.data),
      request,
    );
  }

  const domain = stripeResult.data.client_reference_id as string;
  if (!domain) {
    return withCors(
      jsonErr(404, "no_domain", "No domain associated with this session"),
      request,
    );
  }

  const tenant = await getTenant(env, domain);
  if (!tenant) {
    return withCors(
      jsonErr(404, "tenant_not_found", `No tenant record for ${domain}`),
      request,
    );
  }

  const paymentStatus = stripeResult.data.payment_status as string;

  // Wizard (skipDns) tenants: return a minimal public shape. No DNS, no PII.
  if (tenant.skipDns === true) {
    return withCors(
      jsonOk({
        sessionId,
        slug: tenant.slug,
        status: tenant.status,
        plan: tenant.stripe?.plan ?? "base",
        paymentStatus,
      }),
      request,
    );
  }

  // Admin/Pro (DNS) tenants: require X-Admin-Secret for the full response.
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required");
  }

  return jsonOk({
    sessionId,
    domain,
    slug: tenant.slug,
    status: tenant.status,
    plan: tenant.stripe?.plan ?? "base",
    paymentStatus,
    dns: tenant.status === "paid_pending_dns" || tenant.status === "free_pending_dns"
      ? buildDnsInstructions(tenant)
      : undefined,
  });
}

// ── POST /admin/onboard/retry-railway ────────────────────────────────────
// Operator recovery path. When the Stripe webhook succeeded (Stripe IDs
// are in D1, tenant record exists in KV) but `registerBusinessOnRailway`
// silently failed — network blip, zod rejection, Railway down — the
// tenant's D1 `api_key` is stuck as the placeholder set by the wizard
// and the agent doesn't exist on the Railway side. Previously the only
// fix was a manual SQL session. This endpoint replays the Railway call
// using the tenant profile already in KV and, on success, updates the
// D1 api_key the same way the webhook would have.
//
// Body: { slug: string }
// Auth: X-Admin-Secret or Bearer ADMIN_SECRET (requireAdmin accepts both).

export async function handleRetryRailwayRegistration(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required");
  }

  let slug: string;
  try {
    const body = await request.json<{ slug?: string }>();
    if (typeof body.slug !== "string" || !body.slug.trim()) {
      return jsonErr(400, "bad_request", "Missing required field: slug");
    }
    slug = body.slug.trim();
  } catch {
    return jsonErr(400, "bad_request", "Invalid JSON body");
  }

  const biz = await getBusinessBySlug(env.DB, slug);
  if (!biz) return jsonErr(404, "not_found", `No D1 business row for slug=${slug}`);

  const domain = biz.domain ?? "";
  if (!domain) {
    return jsonErr(
      422,
      "missing_domain",
      `D1 business row for slug=${slug} has no domain; cannot locate KV tenant record`,
    );
  }

  const tenant = await getTenant(env, domain);
  if (!tenant) {
    return jsonErr(404, "tenant_not_found", `No KV tenant record for domain=${domain}`);
  }
  if (!tenant.profile) {
    return jsonErr(
      422,
      "missing_profile",
      "Tenant KV record has no wizard profile; re-register manually with a full payload",
    );
  }

  // Bail out early if Railway credentials aren't configured — same guard the
  // Stripe webhook uses so the caller gets an honest 5xx rather than a
  // spurious registration that can't actually succeed.
  if (!env.API_BASE_URL || !env.API_KEY) {
    return jsonErr(
      500,
      "railway_not_configured",
      !env.API_BASE_URL ? "API_BASE_URL not set" : "API_KEY not set",
    );
  }

  const regResult = await registerBusinessOnRailway(env, tenant);
  if (!regResult.ok) {
    console.warn(JSON.stringify({
      onboarding: true,
      event: "admin_retry_railway_failed",
      slug,
      domain,
      error: regResult.error,
    }));
    return jsonErr(502, "railway_register_failed", regResult.error);
  }

  await updateBusinessApiKey(env.DB, slug, regResult.api_key);
  console.log(JSON.stringify({
    onboarding: true,
    event: "admin_retry_railway_success",
    slug,
    domain,
    api_key_length: regResult.api_key.length,
  }));

  return jsonOk({
    ok: true,
    slug,
    domain,
    action: "railway_registered_and_d1_api_key_updated",
  });
}

// ── POST /api/client/billing-portal ──────────────────────────────────────────
//
// Self-serve plan switching + cancellation via Stripe's hosted Customer
// Portal. Replaces the previous mailto:hello@... fallback on the Billing
// page. Customer clicks "Switch to Pro" / "Switch to Base" / "Cancel" →
// frontend POSTs here → we create a billing_portal session for that
// tenant's stripe_customer_id → redirect them to the Stripe-hosted UI →
// Stripe handles the price change, prorations, cancellation flows
// natively → webhook fires (existing handler) → we update the tenant's
// plan in D1.
//
// Requires:
//   - tenant has stripe_customer_id (set during initial checkout)
//   - STRIPE_SECRET_KEY env var
//   - (One-time) admin sets up the Customer Portal config in Stripe
//     dashboard: dashboard.stripe.com → Settings → Customer Portal →
//     enable "Customers can switch plans" + select Base/Pro prices.
//     Without that config, the portal still loads but won't show plan
//     options — the request to Stripe succeeds either way.
//
// Auth: customer session via getSessionFromRequest. Tenant role must
// match (or admin impersonating ?slug=). Cross-tenant access blocked
// by the same getUserBusinesses pattern used everywhere else.
//
// Cost: ~$0/call (Stripe billing_portal sessions are free; pricing
// changes happen on Stripe's side).

export async function handleBillingPortal(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) {
    return withCors(
      jsonErr(500, "stripe_not_configured", "STRIPE_SECRET_KEY is not set"),
      request,
    );
  }

  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "unauthorized", "Not signed in"), request);

  // Resolve which business the request is for. Admin can pick via
  // ?slug=, regular users get their first owned business.
  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "no_business", "No business found for this account"), request);
  }

  if (!biz.stripe_customer_id) {
    return withCors(
      jsonErr(
        409,
        "no_stripe_customer",
        "This tenant doesn't have a Stripe customer_id yet. " +
        "Plan changes via the portal require a completed initial checkout. " +
        "If you signed up before Stripe integration was wired in, email hello@advocatemcp.com.",
      ),
      request,
    );
  }

  // Stripe billing_portal session. return_url brings the customer back
  // to the dashboard's Billing page after they're done in Stripe's UI.
  // We use the request's Origin so the return URL matches whichever
  // surface they came from (advocatemcp.com vs preview vs local).
  const origin = request.headers.get("Origin")
              ?? "https://advocatemcp.com";
  const returnUrl = `${origin}/Billing.html`;

  const stripeResult = await stripeApi(
    env.STRIPE_SECRET_KEY,
    "POST",
    "/billing_portal/sessions",
    {
      customer:   biz.stripe_customer_id,
      return_url: returnUrl,
    },
  );

  if (!stripeResult.ok) {
    // Most common failure: Customer Portal not configured in the
    // Stripe dashboard. Log Stripe's full response body server-side
    // for ops debugging — but DO NOT pass stripeResult.data into the
    // HTTP response. That data leaks Stripe API internals (request
    // metadata, error codes, sometimes customer/account hints) to
    // the client. The user-facing message stays generic; ops finds
    // the detail in the worker tail.
    console.log(JSON.stringify({
      metric:   "billing_portal_failed",
      slug:     biz.slug,
      stripe:   stripeResult.data,
    }));
    return withCors(
      jsonErr(
        502,
        "stripe_portal_failed",
        "Could not create billing portal session. " +
        "If this persists, check the Customer Portal config in your Stripe dashboard " +
        "(Settings, Billing, Customer Portal — must be activated).",
      ),
      request,
    );
  }

  const portalUrl = stripeResult.data.url as string;
  if (!portalUrl) {
    console.log(JSON.stringify({
      metric:   "billing_portal_no_url",
      slug:     biz.slug,
      stripe:   stripeResult.data,
    }));
    return withCors(
      jsonErr(502, "stripe_portal_no_url", "Stripe returned no portal URL"),
      request,
    );
  }

  return withCors(
    jsonOk({
      ok:   true,
      url:  portalUrl,
      slug: biz.slug,
    }),
    request,
  );
}
