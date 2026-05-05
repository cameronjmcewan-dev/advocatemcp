// Tenant onboarding — single-endpoint flow that creates a Cloudflare custom
// hostname, writes KV tenant records, and returns DNS instructions.
//
// Routes (all protected by X-Admin-Secret or Bearer ADMIN_SECRET):
//   POST /api/onboard                 — full tenant onboarding
//   GET  /api/onboard/:domain/status  — inspect tenant onboarding state
//   POST /api/onboard/:domain/verify  — force re-check verification with CF
//   GET  /api/onboard/list            — list all tenants with status

import type { Env } from "../types";
import { deriveHostnameVariants } from "../lib/hostnameVariants.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const CNAME_TARGET = "customers.advocatemcp.com";

// ── Tenant status model ───────────────────────────────────────────────────────

export type TenantStatus =
  | "pending_payment"
  | "paid_pending_dns"
  | "free_pending_dns"
  | "pending_verification"
  | "active"
  | "disabled"
  | "failed"
  | "needs_manual_review";

export interface TenantRecord {
  domain: string;
  name: string;
  slug: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  services: string[];
  website: string;
  notes: string;
  status: TenantStatus;
  cloudflare: {
    /**
     * Primary CF custom_hostname id. Kept for backward compatibility
     * with code paths that read a single id off the tenant record.
     * Always equals variants[0].customHostnameId after the variant
     * fan-out (Apr 26 2026 change).
     */
    customHostnameId: string | null;
    verificationMethod: string;
    verificationStatus: string;
    sslStatus: string;
    txtName: string | null;
    txtValue: string | null;
    ownershipTxtName: string | null;
    ownershipTxtValue: string | null;
    /**
     * Per-variant Cloudflare state. One entry per hostname we registered
     * for this tenant — typically two for a `tenant.com` signup
     * (apex + www) so AI bots crawling either variant get the optimized
     * Advocate response instead of leaking through to the customer's
     * underlying origin.
     *
     * Optional for backward compatibility: tenants serialized before
     * Apr 26 2026 don't have this field. Reader code falls back to the
     * top-level `txtName`/`txtValue`/etc. fields when `variants` is
     * undefined or empty.
     */
    variants?: Array<{
      hostname: string;
      customHostnameId: string | null;
      verificationStatus: string;
      sslStatus: string;
      txtName: string | null;
      txtValue: string | null;
      ownershipTxtName: string | null;
      ownershipTxtValue: string | null;
    }>;
  };
  stripe?: {
    customerId: string | null;
    subscriptionId: string | null;
    checkoutSessionId: string | null;
    plan: "free" | "base" | "pro";
  };
  /**
   * When true, this tenant came from the marketing wizard on advocatemcp.com
   * and does NOT need a custom hostname or DNS setup — it's a hosted agent
   * profile published to Railway, billed via Stripe, living under the shared
   * advocatemcp.com apex. Webhook transitions skip-dns tenants straight to
   * `active` on payment confirmation.
   */
  skipDns?: boolean;
  /**
   * HTTPS URL of the customer's real origin server. When set, non-bot human
   * traffic is proxied here transparently by the Worker. Set via:
   *   - Phase 1: handleActivateDomain (admin API, caller provides the URL)
   *   - Phase 2: auto-discovery (system infers it from the domain)
   *   - handleOnboard (optional field, no reachability check — Phase 2 adds that)
   * The proxy code in worker/src/lib/proxy.ts reads this field and does not
   * care which path set it.
   */
  origin_url?: string;
  // 9-step wizard profile blobs (opaque JSON strings, validated at ingress)
  profile?: {
    hours_json?: unknown;
    services_json_v2?: unknown;
    pricing_json_v2?: unknown;
    credentials_json?: unknown;
    ratings_json?: unknown;
    differentiators_text?: string;
    customer_quotes_json?: unknown;
    guarantee_text?: string;
    case_stories_json?: unknown;
    lead_routing_json?: unknown;
    star_rating?: number;
    review_count?: number;
    category?: string;
    years_in_business?: number;
    certifications?: string;
    pricing_tier?: string;
    availability?: string;
    service_radius_miles?: number;
    service_area_keywords?: string;
    top_services?: string;
    differentiator?: string;
    tone?: string;
    pricing?: string;
    referral_url?: string;
    description?: string;
    // Legacy wizard fields present in old KV records — kept for Railway mapping
    location?: unknown;
    contact?: unknown;
    services?: unknown;
    differentiators?: unknown;
  };
  statusLog: Array<{ status: string; timestamp: string; detail: string }>;
  createdAt: string;
  updatedAt: string;
}

// ── Auth ───────────────────────────────────────────────────────────────────────

export function requireAdmin(request: Request, env: Env): boolean {
  const secret = env.ADMIN_SECRET ?? "";
  if (!secret) return false;

  // Accept either X-Admin-Secret header or Bearer token
  const xAdmin = request.headers.get("X-Admin-Secret") ?? "";
  if (xAdmin === secret) return true;

  const auth = request.headers.get("Authorization") ?? "";
  if (auth === `Bearer ${secret}`) return true;

  return false;
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

export function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export function jsonErr(status: number, code: string, message: string, detail?: unknown): Response {
  return new Response(
    JSON.stringify({ error: code, message, ...(detail !== undefined ? { detail } : {}) }, null, 2),
    { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
  );
}

// ── Domain validation ─────────────────────────────────────────────────────────

export function normalizeDomain(raw: string): string | null {
  let d = raw.toLowerCase().trim();
  // Strip protocol if provided
  d = d.replace(/^https?:\/\//, "");
  // Strip trailing path/slash
  d = d.split("/")[0];
  // Strip port
  d = d.split(":")[0];

  // Basic DNS label validation
  if (!d || d.length > 253) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!label || label.length > 63) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  // Block our own domains
  if (d.endsWith(".advocatemcp.com") || d === "advocatemcp.com") return null;
  if (d.endsWith(".workers.dev")) return null;

  return d;
}

// ── Cloudflare API ────────────────────────────────────────────────────────────

interface CfApiResult {
  ok: boolean;
  data: Record<string, unknown>;
}

export async function cfApi(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfApiResult> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    return { ok: false, data: { error: "CF_API_TOKEN and CF_ZONE_ID are not configured" } };
  }

  const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames${path}`;

  console.log(JSON.stringify({
    onboarding: true,
    event: "cf_api_request",
    method,
    url,
    hasBody: body !== undefined,
  }));

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = (await resp.json()) as Record<string, unknown>;
  const ok = resp.ok && data.success === true;

  console.log(JSON.stringify({
    onboarding: true,
    event: "cf_api_response",
    method,
    url,
    httpStatus: resp.status,
    cfSuccess: ok,
    errors: data.errors ?? null,
  }));

  return { ok, data };
}

// ── Tenant KV operations ──────────────────────────────────────────────────────

export async function getTenant(env: Env, domain: string): Promise<TenantRecord | null> {
  const raw = await env.TENANT_DATA.get(domain);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TenantRecord;
  } catch {
    return null;
  }
}

export async function putTenant(env: Env, tenant: TenantRecord): Promise<void> {
  tenant.updatedAt = new Date().toISOString();
  await env.TENANT_DATA.put(tenant.domain, JSON.stringify(tenant));
}

export function addStatusLog(tenant: TenantRecord, status: string, detail: string): void {
  tenant.statusLog.push({
    status,
    timestamp: new Date().toISOString(),
    detail,
  });
  // Keep last 50 entries to avoid KV value bloat
  if (tenant.statusLog.length > 50) {
    tenant.statusLog = tenant.statusLog.slice(-50);
  }
}

export function transitionStatus(tenant: TenantRecord, newStatus: TenantStatus, detail: string): void {
  const oldStatus = tenant.status;
  tenant.status = newStatus;
  addStatusLog(tenant, newStatus, `${oldStatus} → ${newStatus}: ${detail}`);
  console.log(JSON.stringify({
    onboarding: true,
    event: "status_transition",
    domain: tenant.domain,
    from: oldStatus,
    to: newStatus,
    detail,
  }));
}

// ── DNS instructions builder ──────────────────────────────────────────────────

export interface DnsInstructions {
  summary: string;
  records: Array<{ type: string; host: string; value: string; purpose: string }>;
  troubleshooting: string[];
}

export function buildDnsInstructions(tenant: TenantRecord): DnsInstructions {
  const records: DnsInstructions["records"] = [];

  // Pull the per-variant array (Apr 26 2026+ tenants) or synthesize a
  // single-variant array from the legacy top-level fields so older
  // tenant records still produce instructions.
  const variants =
    tenant.cloudflare.variants && tenant.cloudflare.variants.length > 0
      ? tenant.cloudflare.variants
      : [
          {
            hostname: tenant.domain,
            customHostnameId: tenant.cloudflare.customHostnameId,
            verificationStatus: tenant.cloudflare.verificationStatus,
            sslStatus: tenant.cloudflare.sslStatus,
            txtName: tenant.cloudflare.txtName,
            txtValue: tenant.cloudflare.txtValue,
            ownershipTxtName: tenant.cloudflare.ownershipTxtName,
            ownershipTxtValue: tenant.cloudflare.ownershipTxtValue,
          },
        ];

  for (const v of variants) {
    const isApex = !v.hostname.startsWith("www.") &&
      v.hostname.split(".").length <= 3;
    if (isApex && !v.hostname.endsWith(".hosted.advocatemcp.com")) {
      // Apex hostnames can't be CNAMEd (DNS spec forbids CNAME at the
      // zone apex). Tell the customer their three options. Most modern
      // DNS providers support ANAME / ALIAS / CNAME-flattening at the
      // apex which is the simplest path; otherwise switching the apex
      // to Cloudflare nameservers is the most reliable fix; otherwise
      // they can use static A records pointing at our edge IPs (less
      // future-proof).
      records.push({
        type: "ANAME/ALIAS (or CNAME-flattening)",
        host: v.hostname,
        value: CNAME_TARGET,
        purpose: `Routes apex AI traffic to AdvocateMCP. If your DNS provider doesn't support ANAME/ALIAS, use Cloudflare nameservers or A records — see troubleshooting below.`,
      });
    } else {
      records.push({
        type: "CNAME",
        host: v.hostname,
        value: CNAME_TARGET,
        purpose: `Routes ${v.hostname === tenant.domain ? "AI" : "AI (variant)"} traffic to AdvocateMCP`,
      });
    }

    if (v.txtName && v.txtValue) {
      records.push({
        type: "TXT",
        host: v.txtName,
        value: v.txtValue,
        purpose: `SSL certificate validation (DCV) for ${v.hostname}`,
      });
    }
    if (v.ownershipTxtName && v.ownershipTxtValue) {
      records.push({
        type: "TXT",
        host: v.ownershipTxtName,
        value: v.ownershipTxtValue,
        purpose: `Domain ownership verification for ${v.hostname}`,
      });
    }
  }

  const variantList =
    variants.length === 1
      ? tenant.domain
      : variants.map((v) => v.hostname).join(" + ");

  return {
    summary: [
      `Add the DNS records listed below at your domain registrar for ${variantList}.`,
      variants.length > 1
        ? `Both ${variants[0]!.hostname} and ${variants[1]!.hostname} need DNS records so AI bots crawling either variant get the optimized response.`
        : "",
      `DNS changes can take 5–15 minutes to propagate, occasionally up to 24 hours.`,
      `Once propagated, Cloudflare will automatically verify ownership and issue an SSL certificate.`,
    ].filter(Boolean).join(" "),
    records,
    troubleshooting: [
      "Verify records are set at the correct DNS provider (check your domain's NS records).",
      "Ensure CNAME host matches exactly — some providers auto-append the apex domain.",
      "Apex (root) records: if your DNS provider doesn't support ANAME / ALIAS, switch your apex to Cloudflare nameservers (free) or contact support for static A-record values.",
      "Wait at least 15 minutes before assuming verification failed.",
      "Use 'dig CNAME " + tenant.domain + "' and 'dig TXT <host>' to check propagation.",
      "If verification is stuck, call POST /api/onboard/" + tenant.domain + "/verify to force a re-check.",
      "Contact support if the domain remains in pending_verification after 24 hours.",
    ],
  };
}

// ── Required fields ───────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ["domain", "name", "slug", "phone", "email"] as const;

function validateBody(body: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const val = body[field];
    if (typeof val !== "string" || val.trim().length === 0) {
      missing.push(field);
    }
  }
  // Validate email format loosely
  if (typeof body.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    missing.push("email (invalid format)");
  }
  // Validate slug format
  if (typeof body.slug === "string" && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.slug) && body.slug.length > 1) {
    missing.push("slug (must be lowercase alphanumeric with hyphens)");
  }
  return missing;
}

// ── Shared CF hostname creation ───────────────────────────────────────────────
// Extracted so stripe.ts can reuse the same logic after payment succeeds.
//
// Apr 26 2026 change: fans out across `deriveHostnameVariants(tenant.domain)`
// so we register both apex and www (or just the typed input for custom
// subdomains and hosted-tenant slugs). Without this, an AI bot crawling
// the URL variant we DIDN'T register hits the customer's underlying
// origin directly with no Advocate intercept — silently losing roughly
// half of every tenant's bot traffic. See worker/src/lib/hostnameVariants.ts
// for the variant-derivation rules.

interface VariantResult {
  hostname: string;
  customHostnameId: string | null;
  verificationStatus: string;
  sslStatus: string;
  txtName: string | null;
  txtValue: string | null;
  ownershipTxtName: string | null;
  ownershipTxtValue: string | null;
  /** "created" = newly registered; "reused" = pre-existing in CF; "failed" = error path. */
  outcome: "created" | "reused" | "failed";
  /** Set when outcome === "failed". */
  errorReason?: string;
}

/**
 * Register one Cloudflare custom_hostname. Pure helper — does not
 * mutate the tenant record. Caller decides which variant's data
 * to surface as "primary" and which to put into variants[].
 */
async function registerOneCfHostname(env: Env, hostname: string): Promise<VariantResult> {
  const empty: Omit<VariantResult, "outcome"> = {
    hostname,
    customHostnameId: null,
    verificationStatus: "pending",
    sslStatus: "pending",
    txtName: null,
    txtValue: null,
    ownershipTxtName: null,
    ownershipTxtValue: null,
  };

  const cfResult = await cfApi(env, "POST", "", {
    hostname,
    ssl: {
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    },
  });

  if (cfResult.ok) {
    const result = cfResult.data.result as Record<string, unknown>;
    return { ...readVariantFromCf(hostname, result), outcome: "created" };
  }

  // 1406/1407 = "hostname already exists" — fetch + reuse.
  const errors = cfResult.data.errors as Array<{ code: number; message: string }> | undefined;
  const alreadyExists = errors?.some((e) => e.code === 1406 || e.code === 1407);
  if (alreadyExists) {
    const listRes = await cfApi(env, "GET", `?hostname=${encodeURIComponent(hostname)}`);
    const results = listRes.data.result as Array<Record<string, unknown>> | undefined;
    const existingCf = results?.[0];
    if (existingCf) {
      return { ...readVariantFromCf(hostname, existingCf), outcome: "reused" };
    }
    return { ...empty, outcome: "failed", errorReason: "exists_but_not_retrievable" };
  }

  const cfMissing = (cfResult.data.error as string | undefined)?.includes("CF_API_TOKEN");
  if (cfMissing) {
    return { ...empty, outcome: "failed", errorReason: "cf_not_configured" };
  }

  return {
    ...empty,
    outcome: "failed",
    errorReason: `cf_api_error: ${JSON.stringify(cfResult.data.errors ?? cfResult.data).slice(0, 240)}`,
  };
}

function readVariantFromCf(hostname: string, cfResult: Record<string, unknown>): Omit<VariantResult, "outcome"> {
  const ssl = cfResult.ssl as Record<string, unknown> | null;
  const ownershipVerification = cfResult.ownership_verification as Record<string, unknown> | null;
  return {
    hostname,
    customHostnameId: (cfResult.id as string) ?? null,
    verificationStatus: (cfResult.status as string) ?? "pending",
    sslStatus: (ssl?.status as string) ?? "pending",
    txtName: (ssl?.txt_name as string) ?? null,
    txtValue: (ssl?.txt_value as string) ?? null,
    ownershipTxtName: (ownershipVerification?.name as string) ?? null,
    ownershipTxtValue: (ownershipVerification?.value as string) ?? null,
  };
}

export async function createCfHostnameForTenant(
  env: Env,
  tenant: TenantRecord,
): Promise<{ created: boolean; variants: VariantResult[] }> {
  // Fan out across every hostname variant we should claim for this
  // tenant. For "acme.com" or "www.acme.com" that's both apex and www.
  // For "shop.acme.com" or "*.hosted.advocatemcp.com" it's just the
  // single typed value. Callers (Stripe webhook + free-plan path)
  // separately fan out Worker Routes and KV writes across the same
  // variant list so a bot hitting any of them gets the optimized
  // response.
  const variants = deriveHostnameVariants(tenant.domain);
  if (variants.length === 0) {
    addStatusLog(tenant, "cf_invalid_domain", `Could not derive hostname variants from "${tenant.domain}"`);
    transitionStatus(tenant, "failed", "Invalid tenant domain");
    return { created: false, variants: [] };
  }

  const results: VariantResult[] = [];
  for (const v of variants) {
    results.push(await registerOneCfHostname(env, v));
  }

  // Choose the canonical variant to populate the legacy single-hostname
  // fields. Prefer the one that matches `tenant.domain` exactly so old
  // code paths reading `tenant.cloudflare.txtName` keep showing the
  // primary record. If the tenant typed "acme.com" we promote the apex;
  // if they typed "www.acme.com" we promote www.
  const primary =
    results.find((r) => r.hostname === tenant.domain) ?? results[0]!;

  if (primary.outcome === "failed" && primary.errorReason === "cf_not_configured") {
    addStatusLog(tenant, "cf_not_configured", "CF_API_TOKEN/CF_ZONE_ID not set — KV-only mode");
    transitionStatus(tenant, "needs_manual_review", "Cloudflare credentials not configured");
    tenant.cloudflare.variants = results;
    return { created: false, variants: results };
  }

  // Mirror primary into the legacy fields for backward-compatibility.
  tenant.cloudflare.customHostnameId = primary.customHostnameId;
  tenant.cloudflare.verificationStatus = primary.verificationStatus;
  tenant.cloudflare.sslStatus = primary.sslStatus;
  tenant.cloudflare.txtName = primary.txtName;
  tenant.cloudflare.txtValue = primary.txtValue;
  tenant.cloudflare.ownershipTxtName = primary.ownershipTxtName;
  tenant.cloudflare.ownershipTxtValue = primary.ownershipTxtValue;
  tenant.cloudflare.variants = results;

  // Status log + transition based on aggregate result. We treat the
  // tenant as "created" if AT LEAST ONE variant was created or reused;
  // a pure-failure variant (e.g., apex registration error while www
  // succeeded) is logged but doesn't mark the whole tenant failed,
  // because the customer's site can still be served via the working
  // variant.
  const successCount = results.filter((r) => r.outcome !== "failed").length;
  const failures = results.filter((r) => r.outcome === "failed");

  for (const r of results) {
    if (r.outcome === "created") {
      addStatusLog(tenant, "cf_hostname_created", `Custom hostname created: ${r.hostname} (${r.customHostnameId})`);
    } else if (r.outcome === "reused") {
      addStatusLog(tenant, "cf_hostname_reused", `Custom hostname reused: ${r.hostname}`);
    } else {
      addStatusLog(tenant, "cf_hostname_failed", `Variant registration failed: ${r.hostname} (${r.errorReason})`);
    }
  }

  if (successCount === 0) {
    transitionStatus(tenant, "failed", "Every hostname variant failed to register");
    return { created: false, variants: results };
  }

  if (failures.length > 0) {
    addStatusLog(
      tenant,
      "cf_partial_variant_failure",
      `${successCount}/${results.length} variants registered; failed: ${failures.map((f) => f.hostname).join(", ")}`,
    );
  }

  // If the primary CF hostname is already active (re-registration of an
  // existing tenant) we surface that to the status machine, matching
  // the pre-fan-out behavior.
  const primaryCfIsActive =
    primary.outcome === "reused" && primary.verificationStatus === "active";
  if (primaryCfIsActive) {
    transitionStatus(tenant, "active", "Custom hostname is already active in Cloudflare");
  }

  return { created: true, variants: results };
}

// ── POST /api/onboard ─────────────────────────────────────────────────────────

export async function handleOnboard(request: Request, env: Env): Promise<Response> {
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required — provide X-Admin-Secret header or Bearer token");
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
  const errors = validateBody(body);
  if (errors.length > 0) {
    return jsonErr(400, "validation_error", `Missing or invalid fields: ${errors.join(", ")}`);
  }

  // Normalize domain
  const domain = normalizeDomain(body.domain as string);
  if (!domain) {
    return jsonErr(400, "invalid_domain", "Domain is invalid, unreachable format, or belongs to a reserved namespace");
  }

  const slug = (body.slug as string).toLowerCase().trim();
  const now = new Date().toISOString();

  // Optional origin_url — accepted here so Phase 2 auto-discovery can call
  // handleOnboard with it already set without a second code change. No
  // reachability check at this layer; validation lives in handleActivateDomain
  // (admin path) and will be added to the auto-discovery path in Phase 2.
  const originUrl = typeof body.origin_url === "string" && body.origin_url.trim().startsWith("https://")
    ? body.origin_url.trim()
    : undefined;

  console.log(JSON.stringify({
    onboarding: true,
    event: "onboard_start",
    domain,
    slug,
    timestamp: now,
  }));

  // Check for existing tenant — idempotent
  const existing = await getTenant(env, domain);
  if (existing) {
    // If tenant exists and is active, return current state
    if (existing.status === "active") {
      return jsonOk({
        ok: true,
        action: "already_active",
        domain,
        slug: existing.slug,
        status: existing.status,
        message: `Tenant ${domain} is already active and serving traffic.`,
        dns: buildDnsInstructions(existing),
        tenant: existing,
      });
    }

    // If tenant exists in a non-active state, allow re-onboarding by
    // updating the record and re-triggering CF hostname creation
    console.log(JSON.stringify({
      onboarding: true,
      event: "re_onboard",
      domain,
      existingStatus: existing.status,
    }));
  }

  // Build the tenant record
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
    services: Array.isArray(body.services) ? body.services.filter((s): s is string => typeof s === "string") : [],
    website: (body.website as string ?? "").trim(),
    notes: (body.notes as string ?? "").trim(),
    status: "pending_verification",
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
    statusLog: [],
    createdAt: now,
    updatedAt: now,
  };

  // If re-onboarding, update mutable fields from the request body
  if (existing) {
    tenant.name = (body.name as string).trim();
    tenant.phone = (body.phone as string ?? "").trim();
    tenant.email = (body.email as string).trim().toLowerCase();
    tenant.address = (body.address as string ?? "").trim();
    tenant.city = (body.city as string ?? "").trim();
    tenant.state = (body.state as string ?? "").trim();
    tenant.postalCode = (body.postalCode as string ?? "").trim();
    tenant.country = (body.country as string ?? "US").trim().toUpperCase();
    tenant.services = Array.isArray(body.services) ? body.services.filter((s): s is string => typeof s === "string") : existing.services;
    tenant.website = (body.website as string ?? "").trim();
    tenant.notes = (body.notes as string ?? existing.notes).trim();
  }

  // Thread origin_url through for both new and re-onboard paths. Only set if
  // provided — a re-onboard without origin_url preserves the existing value.
  if (originUrl) tenant.origin_url = originUrl;

  addStatusLog(tenant, "onboard_started", `Onboarding initiated for ${domain}`);

  // ── Create Cloudflare custom hostname ─────────────────────────────────────

  const { created: cfCreated } = await createCfHostnameForTenant(env, tenant);

  // ── Write KV records ──────────────────────────────────────────────────────

  try {
    // BUSINESS_MAP: hostname → slug for every variant we registered
    // (apex + www, or the typed input for custom subdomains). One
    // KV entry per variant so the worker's hostname-based slug
    // lookup succeeds regardless of which variant a bot crawled.
    for (const variant of deriveHostnameVariants(domain)) {
      await env.BUSINESS_MAP.put(variant, slug);
    }
    // TENANT_DATA: domain → full JSON record (single key, primary domain).
    await putTenant(env, tenant);

    console.log(JSON.stringify({
      onboarding: true,
      event: "kv_write_success",
      domain,
      slug,
      variants: deriveHostnameVariants(domain),
    }));
  } catch (err) {
    console.log(JSON.stringify({
      onboarding: true,
      event: "kv_write_error",
      domain,
      error: String(err),
    }));
    return jsonErr(500, "kv_write_failed", "Failed to write tenant records to KV", String(err));
  }

  // ── Also register in D1 if business doesn't exist ─────────────────────────

  try {
    const existingBiz = await env.DB
      .prepare("SELECT slug FROM businesses WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ slug: string }>();

    if (!existingBiz) {
      const bizId = crypto.randomUUID().replace(/-/g, "");
      await env.DB
        .prepare(
          `INSERT INTO businesses (id, slug, business_name, api_key, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(bizId, slug, tenant.name, "pending", now)
        .run();
      // NOTE: no user is created here — this is an admin-only shell record.
      // grantAccess() fires in handleActivateHosted (activate.ts) when the
      // tenant clicks their activation email link and sets their password.
      addStatusLog(tenant, "d1_business_created", `Business record created in D1: ${slug}`);
    }

    // Update cf_hostname_id in D1
    if (tenant.cloudflare.customHostnameId) {
      await env.DB
        .prepare("UPDATE businesses SET cf_hostname_id = ? WHERE slug = ?")
        .bind(tenant.cloudflare.customHostnameId, slug)
        .run();
    }
  } catch (err) {
    // D1 write is best-effort — log but don't fail the onboarding
    console.log(JSON.stringify({
      onboarding: true,
      event: "d1_write_warning",
      domain,
      error: String(err),
    }));
    addStatusLog(tenant, "d1_write_warning", String(err));
  }

  // Final save with all status log entries
  await putTenant(env, tenant);

  console.log(JSON.stringify({
    onboarding: true,
    event: "onboard_complete",
    domain,
    slug,
    status: tenant.status,
    cfCreated,
  }));

  return jsonOk({
    ok: true,
    action: cfCreated ? "created" : "reused_or_fallback",
    domain: tenant.domain,
    slug: tenant.slug,
    status: tenant.status,
    cloudflare: tenant.cloudflare,
    dns: buildDnsInstructions(tenant),
    tenant,
  }, 201);
}

// ── Extract CF data into tenant record ────────────────────────────────────────

export function extractCfData(tenant: TenantRecord, cfResult: Record<string, unknown>): void {
  tenant.cloudflare.customHostnameId = (cfResult.id as string) ?? null;

  const ssl = cfResult.ssl as Record<string, unknown> | null;
  const ownershipVerification = cfResult.ownership_verification as Record<string, unknown> | null;
  const ownershipStatus = cfResult.ownership_verification_status as Record<string, unknown> | undefined;

  tenant.cloudflare.verificationStatus = (cfResult.status as string) ?? "pending";
  tenant.cloudflare.sslStatus = (ssl?.status as string) ?? "pending";

  // SSL DCV TXT record
  if (ssl?.txt_name && ssl?.txt_value) {
    tenant.cloudflare.txtName = ssl.txt_name as string;
    tenant.cloudflare.txtValue = ssl.txt_value as string;
  }

  // Ownership verification TXT record
  if (ownershipVerification?.name && ownershipVerification?.value) {
    tenant.cloudflare.ownershipTxtName = ownershipVerification.name as string;
    tenant.cloudflare.ownershipTxtValue = ownershipVerification.value as string;
  }
}

// ── GET /api/onboard/:domain/status ───────────────────────────────────────────

export async function handleOnboardStatus(
  request: Request,
  env: Env,
  rawDomain: string,
): Promise<Response> {
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required");
  }

  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    return jsonErr(400, "invalid_domain", "Invalid domain format");
  }

  const tenant = await getTenant(env, domain);
  if (!tenant) {
    return jsonErr(404, "not_found", `No tenant record found for ${domain}`);
  }

  return jsonOk({
    domain: tenant.domain,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    cloudflare: tenant.cloudflare,
    dns: buildDnsInstructions(tenant),
    statusLog: tenant.statusLog.slice(-10),
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  });
}

// ── POST /api/onboard/:domain/verify ──────────────────────────────────────────

export async function handleVerifyDomain(
  request: Request,
  env: Env,
  rawDomain: string,
): Promise<Response> {
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required");
  }

  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    return jsonErr(400, "invalid_domain", "Invalid domain format");
  }

  const tenant = await getTenant(env, domain);
  if (!tenant) {
    return jsonErr(404, "not_found", `No tenant record found for ${domain}`);
  }

  if (!tenant.cloudflare.customHostnameId) {
    return jsonErr(400, "no_cf_hostname", "No Cloudflare custom hostname ID — re-run POST /api/onboard");
  }

  console.log(JSON.stringify({
    onboarding: true,
    event: "verify_start",
    domain,
    cfHostnameId: tenant.cloudflare.customHostnameId,
  }));

  // Poll Cloudflare for current status
  const { ok, data } = await cfApi(env, "GET", `/${tenant.cloudflare.customHostnameId}`);
  if (!ok) {
    addStatusLog(tenant, "verify_cf_error", JSON.stringify(data.errors ?? data));
    await putTenant(env, tenant);
    return jsonErr(502, "cf_api_error", "Cloudflare API returned an error", data);
  }

  const result = data.result as Record<string, unknown>;
  const cfStatus = result.status as string;
  const ssl = result.ssl as Record<string, unknown> | null;
  const sslStatus = (ssl?.status as string) ?? "unknown";
  const ownershipStatus = result.ownership_verification_status as string | undefined;

  // Update CF data in tenant (may have new TXT values)
  extractCfData(tenant, result);

  const previousStatus = tenant.status;

  if (cfStatus === "active") {
    transitionStatus(tenant, "active", `CF hostname active, SSL: ${sslStatus}`);
    // Ensure KV routing is in place
    await env.BUSINESS_MAP.put(domain, tenant.slug);
  } else if (cfStatus === "pending") {
    if (tenant.status !== "pending_verification") {
      transitionStatus(tenant, "pending_verification", `CF hostname pending, SSL: ${sslStatus}, ownership: ${ownershipStatus ?? "unknown"}`);
    } else {
      addStatusLog(tenant, "verify_still_pending", `CF: ${cfStatus}, SSL: ${sslStatus}, ownership: ${ownershipStatus ?? "unknown"}`);
    }
  } else if (cfStatus === "moved" || cfStatus === "deleted") {
    transitionStatus(tenant, "failed", `CF hostname is ${cfStatus}`);
  } else {
    addStatusLog(tenant, "verify_unknown_status", `CF status: ${cfStatus}, SSL: ${sslStatus}`);
  }

  await putTenant(env, tenant);

  console.log(JSON.stringify({
    onboarding: true,
    event: "verify_complete",
    domain,
    cfStatus,
    sslStatus,
    tenantStatus: tenant.status,
    changed: previousStatus !== tenant.status,
  }));

  return jsonOk({
    domain: tenant.domain,
    slug: tenant.slug,
    previousStatus,
    currentStatus: tenant.status,
    cloudflare: {
      hostname_status: cfStatus,
      ssl_status: sslStatus,
      ownership_verified: ownershipStatus === "success",
      customHostnameId: tenant.cloudflare.customHostnameId,
    },
    dns: buildDnsInstructions(tenant),
    message: tenant.status === "active"
      ? `${domain} is now active and serving traffic.`
      : `${domain} is still ${tenant.status}. Ensure DNS records are configured correctly.`,
  });
}

// ── GET /api/onboard/list ─────────────────────────────────────────────────────

export async function handleOnboardList(request: Request, env: Env): Promise<Response> {
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required");
  }

  // KV list is eventually consistent and paginated
  const tenants: Array<{
    domain: string;
    slug: string;
    name: string;
    status: TenantStatus;
    cloudflare: { verificationStatus: string; sslStatus: string };
    createdAt: string;
    updatedAt: string;
  }> = [];

  let cursor: string | undefined;
  const limit = 100;

  do {
    const listResult = await env.TENANT_DATA.list({ limit, cursor });
    for (const key of listResult.keys) {
      const tenant = await getTenant(env, key.name);
      if (tenant) {
        tenants.push({
          domain: tenant.domain,
          slug: tenant.slug,
          name: tenant.name,
          status: tenant.status,
          cloudflare: {
            verificationStatus: tenant.cloudflare.verificationStatus,
            sslStatus: tenant.cloudflare.sslStatus,
          },
          createdAt: tenant.createdAt,
          updatedAt: tenant.updatedAt,
        });
      }
    }
    cursor = listResult.list_complete ? undefined : listResult.cursor;
  } while (cursor);

  return jsonOk({
    count: tenants.length,
    tenants,
  });
}

// ── POST /api/onboard/verify-all ──────────────────────────────────────────────
// Batch re-check all pending tenants. Designed to be called from a cron trigger.

export async function handleVerifyAll(request: Request, env: Env): Promise<Response> {
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required");
  }

  const results: Array<{ domain: string; previousStatus: string; currentStatus: string }> = [];
  let cursor: string | undefined;

  do {
    const listResult = await env.TENANT_DATA.list({ limit: 100, cursor });
    for (const key of listResult.keys) {
      const tenant = await getTenant(env, key.name);
      if (!tenant) continue;
      if (tenant.status !== "pending_verification") continue;
      if (!tenant.cloudflare.customHostnameId) continue;

      const previousStatus = tenant.status;

      // Check with Cloudflare
      const { ok, data } = await cfApi(env, "GET", `/${tenant.cloudflare.customHostnameId}`);
      if (!ok) {
        addStatusLog(tenant, "batch_verify_cf_error", JSON.stringify(data.errors ?? data));
        await putTenant(env, tenant);
        results.push({ domain: tenant.domain, previousStatus, currentStatus: tenant.status });
        continue;
      }

      const result = data.result as Record<string, unknown>;
      const cfStatus = result.status as string;
      const ssl = result.ssl as Record<string, unknown> | null;
      const sslStatus = (ssl?.status as string) ?? "unknown";

      extractCfData(tenant, result);

      if (cfStatus === "active") {
        transitionStatus(tenant, "active", `Batch verify: CF active, SSL: ${sslStatus}`);
        await env.BUSINESS_MAP.put(tenant.domain, tenant.slug);
      } else if (cfStatus === "moved" || cfStatus === "deleted") {
        transitionStatus(tenant, "failed", `Batch verify: CF hostname ${cfStatus}`);
      } else {
        addStatusLog(tenant, "batch_verify_pending", `CF: ${cfStatus}, SSL: ${sslStatus}`);
      }

      await putTenant(env, tenant);
      results.push({ domain: tenant.domain, previousStatus, currentStatus: tenant.status });
    }
    cursor = listResult.list_complete ? undefined : listResult.cursor;
  } while (cursor);

  console.log(JSON.stringify({
    onboarding: true,
    event: "verify_all_complete",
    checked: results.length,
    activated: results.filter((r) => r.currentStatus === "active").length,
  }));

  return jsonOk({
    checked: results.length,
    activated: results.filter((r) => r.currentStatus === "active").length,
    results,
  });
}

// ── POST /api/onboard/:domain/disable ─────────────────────────────────────────

export async function handleDisableTenant(
  request: Request,
  env: Env,
  rawDomain: string,
): Promise<Response> {
  if (!requireAdmin(request, env)) {
    return jsonErr(401, "unauthorized", "Authentication required");
  }

  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    return jsonErr(400, "invalid_domain", "Invalid domain format");
  }

  const tenant = await getTenant(env, domain);
  if (!tenant) {
    return jsonErr(404, "not_found", `No tenant record found for ${domain}`);
  }

  transitionStatus(tenant, "disabled", "Disabled by admin");
  await putTenant(env, tenant);

  // Remove from routing KV so traffic stops
  await env.BUSINESS_MAP.delete(domain);

  console.log(JSON.stringify({
    onboarding: true,
    event: "tenant_disabled",
    domain,
    slug: tenant.slug,
  }));

  return jsonOk({
    ok: true,
    domain,
    slug: tenant.slug,
    status: "disabled",
    message: `Tenant ${domain} has been disabled. KV routing entry removed.`,
  });
}
