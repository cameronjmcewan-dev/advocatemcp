/**
 * Programmatic DNS endpoints. Customers paste a scoped API token from
 * their DNS provider; we use it once to create the records they'd
 * otherwise have to add by hand. Token never persists — held in memory
 * during the request only.
 *
 * Two endpoints per provider:
 *
 *   POST /api/dns-auto/cloudflare/validate
 *     Body: { token: string }
 *     Auth: activation token (X-Activation-Token header or ?t=)
 *     Returns: { ok: true, zone_id, zone_name, permission_summary }
 *              or { ok: false, reason }
 *     Purpose: pre-flight before the customer commits — UI shows them
 *     "✓ valid token for acme.com" before they click "Add records".
 *
 *   POST /api/dns-auto/cloudflare/apply
 *     Body: { token: string }
 *     Auth: activation token (X-Activation-Token header or ?t=)
 *     Returns: { ok: true, results: [...] } or { ok: false, reason }
 *     Purpose: actually create the records. Records list is built on
 *     the worker side from the tenant's variants[] state — caller
 *     never sees raw record specs, prevents abuse where someone could
 *     ask the worker to create arbitrary records via this endpoint.
 *
 * GoDaddy and other providers will follow the same shape once added.
 */

import type { Env } from "../types";
import {
  verifyActivationToken,
  type ActivationTokenError,
  type ActivationTokenPayload,
} from "../lib/activation-token";
import { getTenant } from "./onboard";
import {
  validateCloudflareToken,
  applyCloudflareRecords,
} from "../lib/dnsClients/cloudflare";

const CNAME_TARGET = "customers.advocatemcp.com";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonErr(status: number, reason: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: false, reason, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface AuthedContext {
  payload: ActivationTokenPayload;
  slug: string;
  /** Customer's canonical signup domain. Lowercased. */
  canonicalDomain: string;
  /** Tenant record from KV. */
  tenant: Awaited<ReturnType<typeof getTenant>>;
}

/** Verify activation token + load tenant. Reusable across both endpoints. */
async function authenticate(request: Request, env: Env): Promise<AuthedContext | Response> {
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
  if (!canonicalDomain) return jsonErr(404, "tenant_not_found");

  const tenant = await getTenant(env, canonicalDomain);
  if (!tenant) return jsonErr(404, "tenant_not_found");

  // Hosted tenants don't need DNS auto-management — they're already
  // active on our subdomain. Reject so a confused customer can't burn
  // their token here.
  if (tenant.skipDns === true) {
    return jsonErr(400, "hosted_tenant_no_dns_needed");
  }

  return { payload, slug, canonicalDomain, tenant };
}

/* Parse + validate the body's `token` field. Centralized so both
 * endpoints reject malformed payloads with the same message and we
 * never accidentally print the body to logs. */
async function parseTokenBody(request: Request): Promise<{ token: string } | Response> {
  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return jsonErr(400, "missing_provider_token");
  return { token };
}

/* Build the list of records we want CF to create for this tenant. We
 * only ask for records that aren't already in place per the tenant's
 * cloudflare.variants[] state (the customer might have already added
 * SOME records manually before deciding to try auto-DNS). */
function specsForTenant(tenant: NonNullable<Awaited<ReturnType<typeof getTenant>>>) {
  const variants = tenant.cloudflare.variants ?? [];
  const specs: Array<{
    type: "CNAME" | "TXT";
    name: string;
    content: string;
    ttl?: number;
  }> = [];
  for (const v of variants) {
    if (!v.hostname) continue;
    // Routing record. CF's CNAME flattening at apex removes the need
    // for ANAME/ALIAS — we just CNAME @ to customers.advocatemcp.com.
    const isApex = !v.hostname.startsWith("www.")
      && !v.hostname.endsWith(".hosted.advocatemcp.com")
      && v.hostname.split(".").length <= 3;
    specs.push({
      type: "CNAME",
      name: isApex ? "@" : v.hostname,
      content: CNAME_TARGET,
      ttl: 1,
    });
    // DCV TXT (CF's per-hostname SSL validation record). Always add
    // when present in variants[]. CF will re-issue if we ever need
    // to rotate.
    if (v.txtName && v.txtValue) {
      specs.push({ type: "TXT", name: v.txtName, content: v.txtValue, ttl: 1 });
    }
    if (v.ownershipTxtName && v.ownershipTxtValue) {
      specs.push({ type: "TXT", name: v.ownershipTxtName, content: v.ownershipTxtValue, ttl: 1 });
    }
  }
  return specs;
}

// ── POST /api/dns-auto/cloudflare/validate ───────────────────────────────────

export async function handleCloudflareValidate(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;

  const parsed = await parseTokenBody(request);
  if (parsed instanceof Response) return parsed;

  const result = await validateCloudflareToken(parsed.token, auth.canonicalDomain);
  if (!result.ok) {
    return jsonErr(400, result.reason ?? "token_validation_failed");
  }
  return jsonOk({
    ok: true,
    zone_id: result.zone_id,
    zone_name: result.zone_name,
    permission_summary: result.permission_summary,
  });
}

// ── POST /api/dns-auto/cloudflare/apply ──────────────────────────────────────

export async function handleCloudflareApply(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;

  const parsed = await parseTokenBody(request);
  if (parsed instanceof Response) return parsed;

  // Re-validate the token before applying — minor extra latency, but
  // it gives us the zone_id without trusting any client-supplied id.
  const tokenInfo = await validateCloudflareToken(parsed.token, auth.canonicalDomain);
  if (!tokenInfo.ok || !tokenInfo.zone_id) {
    return jsonErr(400, tokenInfo.reason ?? "token_validation_failed");
  }

  if (!auth.tenant) {
    return jsonErr(404, "tenant_not_found");
  }
  const specs = specsForTenant(auth.tenant);
  if (specs.length === 0) {
    return jsonErr(400, "no_records_to_add");
  }

  const result = await applyCloudflareRecords(parsed.token, tokenInfo.zone_id, specs);

  console.log(JSON.stringify({
    dns_auto: true,
    provider: "cloudflare",
    slug: auth.slug,
    domain: auth.canonicalDomain,
    overall_ok: result.overall_ok,
    record_count: result.results.length,
    success_count: result.results.filter((r) => r.ok).length,
    failure_reasons: result.results.filter((r) => !r.ok).map((r) => r.reason),
  }));

  return jsonOk({
    ok: result.overall_ok,
    results: result.results.map((r) => ({
      type: r.spec.type,
      name: r.spec.name,
      ok: r.ok,
      already_exists: r.already_exists ?? false,
      reason: r.reason,
    })),
  });
}
