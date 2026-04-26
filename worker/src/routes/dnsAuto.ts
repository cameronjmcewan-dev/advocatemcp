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
import {
  validateGoDaddyCredential,
  applyGoDaddyRecords,
} from "../lib/dnsClients/godaddy";
import {
  validateNamecheapCredential,
  applyNamecheapRecords,
} from "../lib/dnsClients/namecheap";
import {
  validateRoute53Credential,
  applyRoute53Records,
  ROUTE53_APEX_A_IPS,
} from "../lib/dnsClients/route53";
import {
  validateIonosCredential,
  applyIonosRecords,
  IONOS_APEX_A_IPS,
} from "../lib/dnsClients/ionos";

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

// ── GoDaddy ─────────────────────────────────────────────────────────────────
//
// Same shape as the Cloudflare endpoints but using the GoDaddy
// API key + secret pair. Body shape on both endpoints is
// { key: string, secret: string }.

async function parseGoDaddyBody(request: Request): Promise<{ key: string; secret: string } | Response> {
  let body: { key?: unknown; secret?: unknown };
  try {
    body = (await request.json()) as { key?: unknown; secret?: unknown };
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  if (!key || !secret) return jsonErr(400, "missing_provider_credentials");
  return { key, secret };
}

/* GoDaddy expects "www" or "@" in the record name slot, NOT a FQDN.
 * Translate from the variants[]-style hostnames our worker stores. */
function godaddyRecordsForTenant(
  tenant: NonNullable<Awaited<ReturnType<typeof getTenant>>>,
  apex: string,
) {
  const records: Array<{ type: "CNAME" | "TXT"; name: string; data: string; ttl?: number }> = [];
  const variants = tenant.cloudflare.variants ?? [];

  for (const v of variants) {
    if (!v.hostname) continue;
    const isApex = v.hostname === apex;
    // CNAME at apex isn't supported on GoDaddy DNS — apex routing
    // happens via Domain Forwarding, set up separately below in
    // applyGoDaddyRecords. So we only emit a CNAME for the www
    // variant here.
    if (!isApex) {
      const sub = v.hostname.replace(`.${apex}`, "");
      records.push({ type: "CNAME", name: sub, data: CNAME_TARGET, ttl: 600 });
    }
    // TXT records are added under the apex zone for both variants.
    // Strip the trailing apex suffix so GoDaddy gets the relative name.
    if (v.txtName && v.txtValue) {
      const relName = v.txtName.endsWith(`.${apex}`)
        ? v.txtName.slice(0, -(`.${apex}`.length))
        : v.txtName;
      records.push({ type: "TXT", name: relName, data: v.txtValue, ttl: 600 });
    }
    if (v.ownershipTxtName && v.ownershipTxtValue) {
      const relName = v.ownershipTxtName.endsWith(`.${apex}`)
        ? v.ownershipTxtName.slice(0, -(`.${apex}`.length))
        : v.ownershipTxtName;
      records.push({ type: "TXT", name: relName, data: v.ownershipTxtValue, ttl: 600 });
    }
  }
  return records;
}

export async function handleGoDaddyValidate(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await parseGoDaddyBody(request);
  if (parsed instanceof Response) return parsed;

  const result = await validateGoDaddyCredential(parsed, auth.canonicalDomain);
  if (!result.ok) return jsonErr(400, result.reason ?? "credential_validation_failed");
  return jsonOk({
    ok: true,
    domain: result.domain,
    forwarding_supported: result.forwarding_supported ?? false,
  });
}

export async function handleGoDaddyApply(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await parseGoDaddyBody(request);
  if (parsed instanceof Response) return parsed;

  // Re-validate to confirm the credentials are still good and pull
  // canonical domain spelling from GoDaddy.
  const info = await validateGoDaddyCredential(parsed, auth.canonicalDomain);
  if (!info.ok || !info.domain) {
    return jsonErr(400, info.reason ?? "credential_validation_failed");
  }
  const apex = info.domain.toLowerCase();

  if (!auth.tenant) return jsonErr(404, "tenant_not_found");
  const records = godaddyRecordsForTenant(auth.tenant, apex);

  // Apex routing on GoDaddy goes through Domain Forwarding (HTTP 301
  // to https://www.<domain>) — bots follow the redirect to the www
  // variant which goes through Advocate's intercept. Same outcome as
  // ANAME/ALIAS, just one HTTP hop earlier.
  const forwardingTarget = `https://www.${apex}`;

  const result = await applyGoDaddyRecords(parsed, apex, records, forwardingTarget);

  console.log(JSON.stringify({
    dns_auto: true,
    provider: "godaddy",
    slug: auth.slug,
    domain: auth.canonicalDomain,
    overall_ok: result.overall_ok,
    record_count: result.results.length,
    success_count: result.results.filter((r) => r.ok).length,
    forwarding_set: result.forwarding?.ok ?? false,
    failure_reasons: result.results.filter((r) => !r.ok).map((r) => r.reason),
    forwarding_reason: result.forwarding && !result.forwarding.ok ? result.forwarding.reason : undefined,
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
    forwarding: result.forwarding,
  });
}

// ── Namecheap ───────────────────────────────────────────────────────────────
//
// Body shape on both endpoints: { username, apikey }. Namecheap requires
// ALSO that the source IP (CF Worker egress) be on the customer's API
// IP whitelist — surfaced as `ip_not_whitelisted` reason if they
// haven't done that yet. Activate-page UI tells customer to whitelist
// 0.0.0.0/0 for the duration of setup, then lock it back down after.

async function parseNamecheapBody(request: Request): Promise<{ username: string; apikey: string } | Response> {
  let body: { username?: unknown; apikey?: unknown };
  try {
    body = (await request.json()) as { username?: unknown; apikey?: unknown };
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const apikey = typeof body.apikey === "string" ? body.apikey.trim() : "";
  if (!username || !apikey) return jsonErr(400, "missing_provider_credentials");
  return { username, apikey };
}

/* Namecheap expects relative names ("@", "www", "_cf-custom-hostname")
 * and ALIAS for apex routing (their FreeDNS supports it natively). */
function namecheapRecordsForTenant(
  tenant: NonNullable<Awaited<ReturnType<typeof getTenant>>>,
  apex: string,
) {
  const records: Array<{ type: "CNAME" | "TXT" | "ALIAS"; host: string; address: string; ttl?: number }> = [];
  const variants = tenant.cloudflare.variants ?? [];

  for (const v of variants) {
    if (!v.hostname) continue;
    const isApex = v.hostname === apex;
    if (isApex) {
      // Native ALIAS at apex on Namecheap FreeDNS.
      records.push({ type: "ALIAS", host: "@", address: CNAME_TARGET, ttl: 1800 });
    } else {
      const sub = v.hostname.replace(`.${apex}`, "");
      records.push({ type: "CNAME", host: sub, address: CNAME_TARGET, ttl: 1800 });
    }
    if (v.txtName && v.txtValue) {
      const relName = v.txtName.endsWith(`.${apex}`)
        ? v.txtName.slice(0, -(`.${apex}`.length))
        : v.txtName;
      records.push({ type: "TXT", host: relName, address: v.txtValue, ttl: 1800 });
    }
    if (v.ownershipTxtName && v.ownershipTxtValue) {
      const relName = v.ownershipTxtName.endsWith(`.${apex}`)
        ? v.ownershipTxtName.slice(0, -(`.${apex}`.length))
        : v.ownershipTxtName;
      records.push({ type: "TXT", host: relName, address: v.ownershipTxtValue, ttl: 1800 });
    }
  }
  return records;
}

export async function handleNamecheapValidate(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await parseNamecheapBody(request);
  if (parsed instanceof Response) return parsed;

  const result = await validateNamecheapCredential(parsed, auth.canonicalDomain);
  if (!result.ok) return jsonErr(400, result.reason ?? "credential_validation_failed");
  return jsonOk({ ok: true, domain: result.domain });
}

export async function handleNamecheapApply(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await parseNamecheapBody(request);
  if (parsed instanceof Response) return parsed;

  const info = await validateNamecheapCredential(parsed, auth.canonicalDomain);
  if (!info.ok || !info.domain) {
    return jsonErr(400, info.reason ?? "credential_validation_failed");
  }
  const apex = info.domain.toLowerCase();

  if (!auth.tenant) return jsonErr(404, "tenant_not_found");
  const records = namecheapRecordsForTenant(auth.tenant, apex);

  const result = await applyNamecheapRecords(parsed, apex, records);

  console.log(JSON.stringify({
    dns_auto: true,
    provider: "namecheap",
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
      name: r.spec.host,
      ok: r.ok,
      already_exists: r.already_exists ?? false,
      reason: r.reason,
    })),
  });
}

// ── Route 53 ────────────────────────────────────────────────────────────────
//
// Body shape: { accessKeyId, secretAccessKey }. Customer creates an
// IAM user with `Route53:ChangeResourceRecordSets` +
// `Route53:ListHostedZonesByName` scoped to their hosted zone, copies
// the access key pair, pastes here.
//
// Apex strategy: Route 53 ALIAS records require an AWS-resource target
// (CloudFront/ELB/etc), not arbitrary hostnames like ours. So apex on
// Route53 routes via static A records pointing at our anycast IPs.
// The IPs can theoretically rotate; we surface that in the customer
// status message so they know to re-run apply if AI traffic ever
// stops on the apex.

async function parseAwsBody(request: Request): Promise<{ accessKeyId: string; secretAccessKey: string } | Response> {
  let body: { accessKeyId?: unknown; secretAccessKey?: unknown };
  try {
    body = (await request.json()) as { accessKeyId?: unknown; secretAccessKey?: unknown };
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const accessKeyId = typeof body.accessKeyId === "string" ? body.accessKeyId.trim() : "";
  const secretAccessKey = typeof body.secretAccessKey === "string" ? body.secretAccessKey.trim() : "";
  if (!accessKeyId || !secretAccessKey) return jsonErr(400, "missing_provider_credentials");
  return { accessKeyId, secretAccessKey };
}

/* Route 53 expects FQDN names with trailing dots ("www.acme.com."
 * not "www") — different from CF/GoDaddy/Namecheap which use relative
 * names. Translate variants[] state into Route53's shape. */
function route53RecordsForTenant(
  tenant: NonNullable<Awaited<ReturnType<typeof getTenant>>>,
  apex: string,
) {
  const records: Array<{ type: "CNAME" | "TXT" | "A"; name: string; values: string[]; ttl?: number }> = [];
  const variants = tenant.cloudflare.variants ?? [];

  for (const v of variants) {
    if (!v.hostname) continue;
    const fqdn = `${v.hostname}.`;
    const isApex = v.hostname === apex;
    if (isApex) {
      // Static A records pointing at our anycast IPs (Route53 ALIAS
      // can't target a non-AWS hostname).
      records.push({ type: "A", name: fqdn, values: ROUTE53_APEX_A_IPS, ttl: 300 });
    } else {
      records.push({ type: "CNAME", name: fqdn, values: [CNAME_TARGET], ttl: 300 });
    }
    if (v.txtName && v.txtValue) {
      records.push({ type: "TXT", name: `${v.txtName}.`, values: [v.txtValue], ttl: 300 });
    }
    if (v.ownershipTxtName && v.ownershipTxtValue) {
      records.push({ type: "TXT", name: `${v.ownershipTxtName}.`, values: [v.ownershipTxtValue], ttl: 300 });
    }
  }
  return records;
}

export async function handleRoute53Validate(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await parseAwsBody(request);
  if (parsed instanceof Response) return parsed;

  const result = await validateRoute53Credential(parsed, auth.canonicalDomain);
  if (!result.ok) return jsonErr(400, result.reason ?? "credential_validation_failed");
  return jsonOk({
    ok: true,
    hosted_zone_id: result.hosted_zone_id,
    zone_name: result.zone_name,
  });
}

export async function handleRoute53Apply(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await parseAwsBody(request);
  if (parsed instanceof Response) return parsed;

  const info = await validateRoute53Credential(parsed, auth.canonicalDomain);
  if (!info.ok || !info.hosted_zone_id || !info.zone_name) {
    return jsonErr(400, info.reason ?? "credential_validation_failed");
  }
  const apex = info.zone_name.toLowerCase();

  if (!auth.tenant) return jsonErr(404, "tenant_not_found");
  const records = route53RecordsForTenant(auth.tenant, apex);

  const result = await applyRoute53Records(parsed, info.hosted_zone_id, records);

  console.log(JSON.stringify({
    dns_auto: true,
    provider: "route53",
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
      reason: r.reason,
    })),
  });
}

// ── IONOS ───────────────────────────────────────────────────────────────────

async function parseIonosBody(request: Request): Promise<{ apiKey: string } | Response> {
  let body: { apiKey?: unknown };
  try {
    body = (await request.json()) as { apiKey?: unknown };
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return jsonErr(400, "missing_provider_token");
  return { apiKey };
}

function ionosRecordsForTenant(
  tenant: NonNullable<Awaited<ReturnType<typeof getTenant>>>,
  apex: string,
) {
  const records: Array<{ type: "CNAME" | "TXT" | "A"; name: string; content: string; ttl?: number }> = [];
  const variants = tenant.cloudflare.variants ?? [];

  for (const v of variants) {
    if (!v.hostname) continue;
    const isApex = v.hostname === apex;
    if (isApex) {
      // Static A records — IONOS doesn't natively support ANAME at apex.
      for (const ip of IONOS_APEX_A_IPS) {
        records.push({ type: "A", name: v.hostname, content: ip, ttl: 3600 });
      }
    } else {
      records.push({ type: "CNAME", name: v.hostname, content: CNAME_TARGET, ttl: 3600 });
    }
    if (v.txtName && v.txtValue) {
      records.push({ type: "TXT", name: v.txtName, content: v.txtValue, ttl: 3600 });
    }
    if (v.ownershipTxtName && v.ownershipTxtValue) {
      records.push({ type: "TXT", name: v.ownershipTxtName, content: v.ownershipTxtValue, ttl: 3600 });
    }
  }
  return records;
}

export async function handleIonosValidate(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await parseIonosBody(request);
  if (parsed instanceof Response) return parsed;

  const result = await validateIonosCredential(parsed, auth.canonicalDomain);
  if (!result.ok) return jsonErr(400, result.reason ?? "credential_validation_failed");
  return jsonOk({ ok: true, zone_id: result.zone_id, zone_name: result.zone_name });
}

export async function handleIonosApply(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await parseIonosBody(request);
  if (parsed instanceof Response) return parsed;

  const info = await validateIonosCredential(parsed, auth.canonicalDomain);
  if (!info.ok || !info.zone_id || !info.zone_name) {
    return jsonErr(400, info.reason ?? "credential_validation_failed");
  }
  const apex = info.zone_name.toLowerCase();

  if (!auth.tenant) return jsonErr(404, "tenant_not_found");
  const records = ionosRecordsForTenant(auth.tenant, apex);

  const result = await applyIonosRecords(parsed, info.zone_id, records);

  console.log(JSON.stringify({
    dns_auto: true,
    provider: "ionos",
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
