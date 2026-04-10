// Domain management — Cloudflare for SaaS integration.
//
// Routes (all protected by X-Admin-Secret header):
//   POST /admin/domains/activate       — register a custom hostname in CF + KV
//   GET  /admin/domains/:slug/status   — poll verification/SSL status from CF API

import type { Env } from "../types";
import {
  getTenant,
  putTenant,
  extractCfData,
  type TenantRecord,
} from "./onboard";
import { discoverOriginUrl } from "../lib/origin-discovery.js";

const CNAME_TARGET = "customers.advocatemcp.com";

// ── DNS instructions ───────────────────────────────────────────────────────

export function generateDnsInstructions(
  domain: string,
  verificationTxt: { host: string; value: string } | null
): string {
  const txtSection = verificationTxt
    ? [
        `2. TXT record (verifies domain ownership):`,
        `   Host:  ${verificationTxt.host}`,
        `   Value: ${verificationTxt.value}`,
      ].join("\n")
    : `2. TXT record: pending — re-check /admin/domains/:slug/status once CNAME propagates.`;

  return [
    `To activate AdvocateMCP on ${domain}, add these two DNS records at your domain registrar:`,
    ``,
    `1. CNAME record (routes AI crawler traffic):`,
    `   Host:      ${domain}`,
    `   Points to: ${CNAME_TARGET}`,
    ``,
    txtSection,
    ``,
    `Once added, verification typically completes within 5–15 minutes.`,
    `You can check status at advocatemcp.com/dashboard.`,
  ].join("\n");
}

// ── Cloudflare API helper ──────────────────────────────────────────────────

interface CfResponse {
  ok: boolean;
  data: Record<string, unknown>;
}

async function cfRequest(
  env: Env,
  method: string,
  path: string,
  body?: unknown
): Promise<CfResponse> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    return {
      ok: false,
      data: { error: "CF_API_TOKEN and CF_ZONE_ID secrets are not configured" },
    };
  }

  const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = (await resp.json()) as Record<string, unknown>;
  return { ok: resp.ok && data.success === true, data };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonErr(status: number, message: string, detail?: unknown): Response {
  return new Response(
    JSON.stringify({ error: message, ...(detail ? { detail } : {}) }, null, 2),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requireAdminSecret(request: Request, env: Env): boolean {
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  return !!env.ADMIN_SECRET && provided === env.ADMIN_SECRET;
}

// ── TENANT_DATA upsert helper ─────────────────────────────────────────────
// Called by both activation paths (CF success and KV-only fallback) so that
// any domain passing through handleActivateDomain always has a TENANT_DATA
// record the non-crawler passthrough branch in index.ts can read.

async function upsertTenantData(
  env: Env,
  domain: string,
  slug: string,
  cfResult: Record<string, unknown> | null,
  validatedOriginUrl: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getTenant(env, domain);
  const tenant: TenantRecord = existing ?? {
    domain,
    slug,
    name: "",
    phone: "",
    email: "",
    address: "",
    city: "",
    state: "",
    postalCode: "",
    country: "US",
    services: [],
    website: "",
    notes: "",
    // "active" because handleActivateDomain is admin-secret protected and the
    // caller is explicitly activating the domain. Contrast with handleOnboard
    // which uses "pending_verification" because it waits on CF verification.
    status: "active",
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

  if (validatedOriginUrl) tenant.origin_url = validatedOriginUrl;
  if (cfResult) extractCfData(tenant, cfResult);
  await putTenant(env, tenant);
}

// ── POST /admin/domains/activate ──────────────────────────────────────────

export async function handleActivateDomain(
  request: Request,
  env: Env
): Promise<Response> {
  if (!requireAdminSecret(request, env)) {
    return jsonErr(401, "Unauthorized — X-Admin-Secret header required");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "Invalid JSON body");
  }

  const domain = typeof body.domain === "string" ? body.domain.toLowerCase().trim() : "";
  const slug   = typeof body.slug   === "string" ? body.slug.toLowerCase().trim()   : "";

  if (!domain || !slug) {
    return jsonErr(400, "Both 'domain' and 'slug' are required");
  }

  // ── Slug validation ────────────────────────────────────────────────────────
  // Verify the slug is registered in Railway before writing any KV or CF
  // records. A 404 here means the business doesn't exist yet — the domain
  // would activate but every bot request would return a 502 from Railway.
  // Non-404 errors (network, 500) warn but don't block — Railway downtime
  // shouldn't prevent legitimate domain activation.
  const railwayBase = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const profileCheck = await fetch(
      `${railwayBase}/agents/${encodeURIComponent(slug)}/profile`,
      {
        headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
        signal: AbortSignal.timeout(5000),
      },
    );
    if (profileCheck.status === 404) {
      return jsonErr(
        404,
        `Slug "${slug}" is not registered in Railway. Run POST /register first, then retry activation.`,
      );
    }
  } catch {
    // Railway unreachable or timed out — log and continue rather than blocking.
    console.warn(JSON.stringify({
      domains: true,
      event: "slug_validation_skipped",
      slug,
      reason: "Railway profile check failed — proceeding with activation",
    }));
  }

  // ── origin_url: explicit validation (Phase 1) OR auto-discovery (Phase 2) ──
  // Two paths:
  //
  //   1. `origin_url` is present in the body — Phase 1 behavior, unchanged:
  //      parse as URL, require HTTPS, HEAD reachability check (2xx/3xx/4xx
  //      accepted, 5xx + connection failure rejected).
  //
  //   2. `origin_url` is absent — Phase 2 auto-discovery: fetch the domain
  //      with redirect following, use the final URL's origin. Rejects if
  //      the domain is its own origin (self_loop), if the final URL is a
  //      Worker hostname (worker_loop), if the redirect downgrades to HTTP,
  //      or if the origin is unreachable / 5xx / timing out.
  //
  // Known limitation on the auto-discovery path: if the domain is already
  // CNAMEd to customers.advocatemcp.com from a prior (possibly failed)
  // activation attempt, the discovery fetch will hit this Worker itself and
  // either return worker_loop (if the response URL resolves to our host) or
  // return an odd error from the non-bot info response. The CF "already
  // exists" short-circuit at the CF API call below catches the happy case
  // of a true double-activate on a working tenant, but an in-between
  // half-configured state may produce a confusing discovery error. We're
  // leaving ordering as-is intentionally — fixing this requires a Phase 1
  // flow change that's out of scope for Phase 2.
  const rawOriginUrl = typeof body.origin_url === "string" ? body.origin_url.trim() : null;
  let validatedOriginUrl: string | null = null;
  let originUrlSource: "explicit" | "discovered" | "none" = "none";

  if (rawOriginUrl) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(rawOriginUrl);
    } catch {
      return jsonErr(400, "origin_url is not a valid URL");
    }
    if (parsedOrigin.protocol !== "https:") {
      return jsonErr(400, "origin_url must use HTTPS");
    }

    try {
      const reach = await fetch(rawOriginUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if (reach.status >= 500) {
        return jsonErr(
          400,
          `origin_url returned HTTP ${reach.status} — origin appears to be down. Verify it is publicly accessible and retry.`,
        );
      }
      validatedOriginUrl = rawOriginUrl;
      originUrlSource = "explicit";
    } catch {
      return jsonErr(
        400,
        "origin_url is unreachable — verify the URL is publicly accessible over HTTPS and retry.",
      );
    }
  } else {
    // Phase 2 auto-discovery
    const discovery = await discoverOriginUrl(domain);
    if (!discovery.ok) {
      console.warn(JSON.stringify({
        domains: true,
        event: "origin_discovery_reject",
        domain,
        slug,
        reason: discovery.reason,
      }));
      return jsonErr(discovery.status, discovery.error, discovery.detail);
    }
    console.log(JSON.stringify({
      domains: true,
      event: "origin_discovery_success",
      domain,
      slug,
      finalHostname: discovery.finalHostname,
      originUrl: discovery.originUrl,
    }));
    validatedOriginUrl = discovery.originUrl;
    originUrlSource = "discovered";
  }

  // ── Call Cloudflare for SaaS API ───────────────────────────────────────────
  const { ok, data } = await cfRequest(env, "POST", "", {
    hostname: domain,
    ssl: {
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    },
  });

  if (!ok) {
    const errors = data.errors as Array<{ code: number; message: string }> | undefined;
    const alreadyExists = errors?.some((e) => e.code === 1406 || e.code === 1407);
    if (!alreadyExists) {
      // If CF creds are missing we still proceed with KV-only setup
      const cfMissing = (data.error as string | undefined)?.includes("CF_API_TOKEN");
      if (cfMissing) {
        await env.BUSINESS_MAP.put(domain, slug);
        await upsertTenantData(env, domain, slug, null, validatedOriginUrl);
        return jsonOk({
          ok: true,
          slug,
          domain,
          cf_hostname_id: null,
          origin_url: validatedOriginUrl,
          origin_url_source: originUrlSource,
          warning: "CF_API_TOKEN/CF_ZONE_ID not configured — KV entry created but Cloudflare for SaaS not activated. Set secrets then re-call this endpoint.",
          cname_record: { type: "CNAME", host: domain, target: CNAME_TARGET },
          txt_record: null,
          status: "kv_only",
          instructions: generateDnsInstructions(domain, null),
        });
      }
      return jsonErr(502, "Cloudflare API error", data);
    }
    // hostname already exists — look it up by hostname
    const listRes = await cfRequest(env, "GET", `?hostname=${encodeURIComponent(domain)}`);
    const results = listRes.data.result as Array<Record<string, unknown>> | undefined;
    const existing = results?.[0];
    if (!existing) return jsonErr(502, "Hostname already exists in CF but could not be retrieved", data);
    // continue with existing record data — idempotent success
    return buildActivateResponse(env, domain, slug, existing, validatedOriginUrl, originUrlSource, /* alreadyExisted */ true);
  }

  const result = data.result as Record<string, unknown>;
  return buildActivateResponse(env, domain, slug, result, validatedOriginUrl, originUrlSource);
}

async function buildActivateResponse(
  env: Env,
  domain: string,
  slug: string,
  cfResult: Record<string, unknown>,
  validatedOriginUrl: string | null,
  originUrlSource: "explicit" | "discovered" | "none",
  alreadyExisted = false
): Promise<Response> {
  const cfHostnameId = cfResult.id as string | null;

  // Persist cf_hostname_id to D1
  if (cfHostnameId) {
    await env.DB
      .prepare("UPDATE businesses SET cf_hostname_id = ? WHERE slug = ?")
      .bind(cfHostnameId, slug)
      .run();
  }

  // Ensure KV entry exists (idempotent)
  await env.BUSINESS_MAP.put(domain, slug);

  // Extract TXT verification details from SSL object
  const ssl = cfResult.ssl as Record<string, unknown> | null;
  const ownershipVerification = cfResult.ownership_verification as Record<string, unknown> | null;

  let verificationTxt: { host: string; value: string } | null = null;

  if (ssl?.txt_name && ssl?.txt_value) {
    verificationTxt = {
      host:  ssl.txt_name  as string,
      value: ssl.txt_value as string,
    };
  } else if (ownershipVerification?.name && ownershipVerification?.value) {
    verificationTxt = {
      host:  ownershipVerification.name  as string,
      value: ownershipVerification.value as string,
    };
  }

  await upsertTenantData(env, domain, slug, cfResult, validatedOriginUrl);

  return jsonOk({
    ok: true,
    slug,
    domain,
    cf_hostname_id: cfHostnameId,
    origin_url: validatedOriginUrl,
    origin_url_source: originUrlSource,
    cname_record: {
      type: "CNAME",
      host: domain,
      target: CNAME_TARGET,
    },
    txt_record: verificationTxt
      ? { type: "TXT", host: verificationTxt.host, value: verificationTxt.value }
      : null,
    status: alreadyExisted ? "already_exists" : "pending_verification",
    instructions: generateDnsInstructions(domain, verificationTxt),
  });
}

// ── GET /admin/domains/:slug/status ───────────────────────────────────────

export async function handleDomainStatus(
  request: Request,
  env: Env,
  slug: string
): Promise<Response> {
  if (!requireAdminSecret(request, env)) {
    return jsonErr(401, "Unauthorized — X-Admin-Secret header required");
  }

  const biz = await env.DB
    .prepare("SELECT slug, cf_hostname_id FROM businesses WHERE slug = ? LIMIT 1")
    .bind(slug)
    .first<{ slug: string; cf_hostname_id: string | null }>();

  if (!biz) return jsonErr(404, `No business found: ${slug}`);
  if (!biz.cf_hostname_id) {
    return jsonErr(404, "No Cloudflare custom hostname registered — call POST /admin/domains/activate first");
  }

  const { ok, data } = await cfRequest(env, "GET", `/${biz.cf_hostname_id}`);
  if (!ok) return jsonErr(502, "Cloudflare API error", data);

  const result = data.result as Record<string, unknown>;
  const ssl    = result?.ssl as Record<string, unknown> | null;
  const ownershipStatus = result?.ownership_verification_status as string | undefined;

  return jsonOk({
    slug,
    hostname:           result?.hostname,
    cf_hostname_id:     biz.cf_hostname_id,
    status:             result?.status,
    ssl_status:         ssl?.status ?? "unknown",
    ownership_verified: ownershipStatus === "success",
    active:             result?.status === "active",
    created_at:         result?.created_at,
  });
}
