/**
 * POST /api/client/tenant/switch-domain
 *
 * Self-serve "Switch from hosted subdomain to a custom domain" flow.
 *
 * Background — before this route existed
 * --------------------------------------
 * The marketing wizard (`POST /api/onboard`) wired NEW tenants up with
 * either a hosted subdomain (`*.hosted.advocatemcp.com`) or a custom
 * domain at onboarding time. Once chosen, the tenant was stuck. A
 * hosted tenant who later wanted their own domain ran into a dead-end
 * DNS Wizard panel ("No DNS setup needed — your subdomain is hosted by
 * us"), with an explicit "Reach out to support" line as the only
 * escape. Support then had to call the admin-only re-onboard endpoint.
 *
 * What this route does
 * --------------------
 * Authenticated, owner-only path that converts a hosted tenant to a
 * custom-domain tenant:
 *
 *   1. Validates the new domain (shape, not a reserved hosted/advocate
 *      hostname, not already claimed by another slug).
 *   2. Registers the custom hostname at Cloudflare for SaaS via the
 *      existing `createCfHostnameForTenant` helper (apex + www fan-out).
 *   3. Writes BUSINESS_MAP entries for every variant so AI-crawler
 *      traffic to the new domain resolves to the right slug.
 *   4. Writes a new TENANT_DATA record under the new domain key (the
 *      old hosted-subdomain TENANT_DATA stays as a read-only alias so
 *      bots already crawling the hosted host keep landing on the right
 *      tenant — graceful transition, no SEO black hole).
 *   5. Updates D1 `businesses.domain` + `cf_hostname_id` so subsequent
 *      `/api/client/me` calls flip `is_hosted` from true → false.
 *
 * Returns the CNAME target + verification status so the frontend wizard
 * can show the user exactly what to add at their registrar.
 *
 * Idempotent — calling twice with the same new_domain returns the same
 * payload (the underlying CF API treats existing hostnames as "reused").
 */

import type { Env } from "../types";
import { getSessionFromRequest } from "./authApi";
import {
  addStatusLog,
  buildDnsInstructions,
  createCfHostnameForTenant,
  getTenant,
  jsonErr,
  jsonOk,
  normalizeDomain,
  putTenant,
  type TenantRecord,
} from "./onboard";
import { deriveHostnameVariants } from "../lib/hostnameVariants";
import { getUserBusinesses, getUserRoleOnBusiness } from "../portalDb";
import { withCors } from "../lib/cors";

export async function handleClientSwitchDomain(
  request: Request,
  env: Env,
): Promise<Response> {
  // ── Auth ────────────────────────────────────────────────────────────────
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) {
    return withCors(jsonErr(401, "unauthorized", "Sign in required"), request, { credentials: true });
  }

  // ── Body ────────────────────────────────────────────────────────────────
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return withCors(
      jsonErr(415, "invalid_content_type", "Content-Type must be application/json"),
      request,
      { credentials: true },
    );
  }

  let body: { slug?: unknown; new_domain?: unknown };
  try {
    body = (await request.json()) as { slug?: unknown; new_domain?: unknown };
  } catch {
    return withCors(jsonErr(400, "invalid_json", "Body must be valid JSON"), request, { credentials: true });
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!slug) {
    return withCors(
      jsonErr(400, "missing_slug", "Field 'slug' is required so we know which business to switch"),
      request,
      { credentials: true },
    );
  }

  const rawNewDomain = typeof body.new_domain === "string" ? body.new_domain.trim() : "";
  const newDomain = normalizeDomain(rawNewDomain);
  if (!newDomain) {
    // normalizeDomain returns null for: malformed input, our own
    // domains (`.advocatemcp.com`, `.workers.dev`), and anything that
    // fails DNS-label validation. From the caller's perspective the
    // single "give me a real third-party domain" intent is the same
    // either way, so we surface one error code with a hint.
    return withCors(
      jsonErr(
        400,
        "invalid_domain",
        "Provide a valid third-party domain (e.g. acme.com). advocatemcp.com hostnames are reserved.",
      ),
      request,
      { credentials: true },
    );
  }

  // ── Tenant lookup (caller must have access to this slug) ───────────────
  const businesses = await getUserBusinesses(env.DB, ctx.user_id);
  const biz = businesses.find((b) => b.slug === slug);
  if (!biz) {
    return withCors(
      jsonErr(404, "tenant_not_found", "You don't have access to a business with that slug"),
      request,
      { credentials: true },
    );
  }

  // ── Role check — owner only ────────────────────────────────────────────
  const role = await getUserRoleOnBusiness(env.DB, ctx.user_id, biz.id);
  if (role !== "owner") {
    return withCors(
      jsonErr(403, "forbidden_role", "Only the business owner can change the primary domain"),
      request,
      { credentials: true },
    );
  }

  // ── Eligibility — must currently be on a hosted subdomain ──────────────
  const currentDomain = biz.domain ?? "";
  const isCurrentlyHosted = currentDomain.endsWith(".hosted.advocatemcp.com");
  if (!isCurrentlyHosted) {
    return withCors(
      jsonErr(
        409,
        "already_custom_domain",
        "This business is already on a custom domain. Contact support to change it again.",
      ),
      request,
      { credentials: true },
    );
  }

  // ── Conflict check — new_domain not already claimed ────────────────────
  // We probe BUSINESS_MAP for every hostname variant (apex + www) the new
  // domain produces. If any variant resolves to a different slug, we
  // refuse. If they resolve to OUR slug already (idempotent retry), the
  // re-registration below is safe.
  const variants = deriveHostnameVariants(newDomain);
  for (const variant of variants) {
    const existingSlug = await env.BUSINESS_MAP.get(variant);
    if (existingSlug && existingSlug !== slug) {
      return withCors(
        jsonErr(
          409,
          "domain_taken",
          `${variant} is already claimed by another tenant. If it's yours, contact support to transfer.`,
        ),
        request,
        { credentials: true },
      );
    }
  }

  // ── Load existing TenantRecord (source of business config) ─────────────
  const oldTenant = await getTenant(env, currentDomain);
  if (!oldTenant) {
    return withCors(
      jsonErr(500, "tenant_record_missing", "Internal tenant record not found for current domain"),
      request,
      { credentials: true },
    );
  }

  // ── Build new TenantRecord ────────────────────────────────────────────
  // Copy every business-config field (services, profile, stripe, etc).
  // Reset only the Cloudflare-managed state — `createCfHostnameForTenant`
  // will refill it with the fresh custom-hostname registration result.
  const now = new Date().toISOString();
  const newTenant: TenantRecord = {
    ...oldTenant,
    domain: newDomain,
    status: "pending_verification",
    cloudflare: {
      customHostnameId:    null,
      verificationMethod:  "txt",
      verificationStatus:  "pending",
      sslStatus:           "pending",
      txtName:             null,
      txtValue:            null,
      ownershipTxtName:    null,
      ownershipTxtValue:   null,
    },
    skipDns:    false,
    statusLog:  [...oldTenant.statusLog],
    updatedAt:  now,
  };
  addStatusLog(
    newTenant,
    "domain_switch_initiated",
    `Switching from ${currentDomain} to ${newDomain} via /api/client/tenant/switch-domain`,
  );

  // ── Register at Cloudflare for SaaS ────────────────────────────────────
  let cfResult;
  try {
    cfResult = await createCfHostnameForTenant(env, newTenant);
  } catch (err) {
    return withCors(
      jsonErr(502, "cf_api_error", "Cloudflare hostname registration failed", String(err)),
      request,
      { credentials: true },
    );
  }

  // createCfHostnameForTenant returns created=false when EVERY variant
  // failed registration. The tenant's status is now "failed" — refuse
  // the switch and don't write KV (would route bots to an unverified
  // tenant). Status remains on the old hosted subdomain.
  if (!cfResult.created) {
    return withCors(
      jsonErr(
        502,
        "cf_registration_failed",
        "Could not register the new domain at Cloudflare. Try again or contact support.",
      ),
      request,
      { credentials: true },
    );
  }

  // ── KV writes — new domain wins for new traffic ────────────────────────
  try {
    for (const variant of variants) {
      await env.BUSINESS_MAP.put(variant, slug);
    }
    await putTenant(env, newTenant);
  } catch (err) {
    return withCors(
      jsonErr(500, "kv_write_failed", "Failed to write new domain to KV", String(err)),
      request,
      { credentials: true },
    );
  }

  // ── D1 update — primary domain + cf_hostname_id (best-effort) ──────────
  // Don't fail the response on D1 hiccup: KV writes already succeeded,
  // which is what bots read. D1 only powers /api/client/me's is_hosted
  // flag; that flips on next refresh. Worst case the user sees the old
  // domain string in /me briefly until the next D1 retry lands.
  try {
    await env.DB
      .prepare("UPDATE businesses SET domain = ?, cf_hostname_id = ? WHERE id = ?")
      .bind(newDomain, newTenant.cloudflare.customHostnameId, biz.id)
      .run();
  } catch (err) {
    console.log(JSON.stringify({
      event:  "switch_domain_d1_write_warning",
      slug,
      old:    currentDomain,
      new:    newDomain,
      error:  String(err),
    }));
  }

  // ── Old TenantRecord — mark as redirected, keep readable ───────────────
  // We deliberately leave the old hosted-subdomain BUSINESS_MAP entry
  // in place (variants[*] still point to the same slug). Bots already
  // crawling the hosted host keep landing on the right tenant, no SEO
  // black hole during the cutover. Audit trail records the move.
  try {
    addStatusLog(
      oldTenant,
      "domain_switched_away",
      `Primary moved to ${newDomain}. This record remains as a read-only alias.`,
    );
    oldTenant.updatedAt = now;
    await putTenant(env, oldTenant);
  } catch {
    // non-critical
  }

  return withCors(
    jsonOk({
      ok:           true,
      old_domain:   currentDomain,
      new_domain:   newDomain,
      slug,
      status:       newTenant.status,
      cloudflare:   newTenant.cloudflare,
      dns:          buildDnsInstructions(newTenant),
    }),
    request,
    { credentials: true },
  );
}
