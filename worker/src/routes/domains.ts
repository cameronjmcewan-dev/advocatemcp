// Domain management — Cloudflare for SaaS integration.
//
// Routes (all protected by X-Admin-Secret header):
//   POST /admin/domains/activate       — register a custom hostname in CF + KV
//   GET  /admin/domains/:slug/status   — poll verification/SSL status from CF API

import type { Env } from "../types";

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

  // Call Cloudflare for SaaS API
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
        return jsonOk({
          ok: true,
          slug,
          domain,
          cf_hostname_id: null,
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
    return buildActivateResponse(env, domain, slug, existing, true);
  }

  const result = data.result as Record<string, unknown>;
  return buildActivateResponse(env, domain, slug, result);
}

async function buildActivateResponse(
  env: Env,
  domain: string,
  slug: string,
  cfResult: Record<string, unknown>,
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

  return jsonOk({
    ok: true,
    slug,
    domain,
    cf_hostname_id: cfHostnameId,
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
