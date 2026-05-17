/**
 * Pure mapping from the rich, nested `TenantRecord` shape stored in
 * `TENANT_DATA` KV to the flat `Record<string, unknown>` shape consumed by
 * `buildWellKnownResponse` (/.well-known/ai-agent.json) and
 * `buildLlmsTxtResponse` (/llms.txt).
 *
 * Why a KV-direct read instead of HTTP fetch
 * ------------------------------------------
 * The Worker previously fetched `${publicApiBase}/agents/{slug}/profile` to
 * populate these surfaces. That endpoint is served by the same Worker (the
 * `api.advocatemcp.com` route proxies to Railway with the API key added),
 * so when the Worker itself fetches its own bound hostname, Cloudflare's
 * loop-prevention bypasses the Worker — the request lands on Railway
 * directly, no API key, response is `401`. The profile silently stays
 * `null` and AI clients see only the slug.
 *
 * Reading TENANT_DATA directly is faster (1–5ms vs ~150ms HTTP), avoids the
 * auth round-trip entirely, and works in every environment (test, preview,
 * production) without needing a special-case fallback.
 *
 * Mapping rules (single source of truth)
 * --------------------------------------
 * - Top-level `TenantRecord` fields (`name`, `phone`, `email`, `services`,
 *   `website`) are canonical — they're set at onboarding and present on
 *   every tenant.
 * - `tenant.profile?.*` fields are populated by the 9-step wizard and may
 *   be absent on older tenants; we read them defensively with optional
 *   chaining.
 * - `location` is composed from `tenant.city` + `tenant.state` (the shape
 *   Railway emits) so AI clients quoting the field get a clean
 *   `"Austin, TX"` rather than two separate pieces.
 * - `referral_url` falls back to `tenant.website` so even tenants who
 *   skipped the referral-URL wizard step still expose a working link.
 * - `differentiator` falls back to `differentiators_text` because two
 *   wizard versions wrote to different keys; readers downstream only know
 *   one name.
 *
 * The returned object intentionally OMITS keys whose source value is
 * absent or empty — downstream code uses optional access (`p.foo`) and an
 * undefined `foo` is equivalent to "skip this section."
 */

import type { Env } from "../types";
import { getTenant, type TenantRecord } from "../routes/onboard";

/**
 * Mirror of `apiBase()` in `worker/src/index.ts`. Duplicated rather than
 * exported from there to keep this module dependency-free of the entry
 * point (avoids a circular import: index.ts already imports from here).
 */
function apiBase(env: Env): string {
  return env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
}

export function tenantToProfileObject(
  tenant: TenantRecord | null,
): Record<string, unknown> | null {
  if (!tenant) return null;

  const profile = tenant.profile ?? {};
  const out: Record<string, unknown> = {};

  // ── Canonical top-level fields (always set at onboarding) ────────────
  if (tenant.name)    out.name    = tenant.name;
  if (tenant.phone)   out.phone   = tenant.phone;
  if (tenant.email)   out.email   = tenant.email;
  if (Array.isArray(tenant.services) && tenant.services.length > 0) {
    out.services = tenant.services;
  }

  // ── Composed location: "City, ST" if both present ─────────────────────
  // Falls back to whatever the wizard stored in profile.location (legacy
  // free-form string) when city/state aren't both set. AI tools quote
  // this verbatim, so a clean "Austin, TX" beats either part alone.
  const composed = [tenant.city, tenant.state].filter(Boolean).join(", ");
  if (composed) {
    out.location = composed;
  } else if (typeof profile.location === "string" && profile.location.trim()) {
    out.location = profile.location.trim();
  }

  // ── Wizard-populated profile fields ──────────────────────────────────
  if (profile.description) out.description = profile.description;
  if (profile.category)    out.category    = profile.category;
  if (profile.availability) out.availability = profile.availability;
  if (profile.service_area_keywords) out.service_area_keywords = profile.service_area_keywords;
  if (typeof profile.service_radius_miles === "number") {
    out.service_radius_miles = profile.service_radius_miles;
  }
  if (typeof profile.star_rating === "number")        out.star_rating = profile.star_rating;
  if (typeof profile.review_count === "number")       out.review_count = profile.review_count;
  if (typeof profile.years_in_business === "number")  out.years_in_business = profile.years_in_business;
  if (profile.top_services) out.top_services = profile.top_services;

  // ── Differentiator key migration: two wizard versions, one consumer ─
  const diff = profile.differentiator ?? profile.differentiators_text;
  if (diff) out.differentiator = diff;

  // ── Referral URL with website fallback ───────────────────────────────
  const referral = profile.referral_url ?? tenant.website;
  if (referral) out.referral_url = referral;

  return out;
}

/**
 * Read the profile object that powers /.well-known/ai-agent.json and
 * /llms.txt for `domain`, with a two-tier source strategy:
 *
 *   1. TENANT_DATA KV — onboarded customer tenants land here in ~1–5ms with
 *      no network round-trip and no auth. This is the dominant path going
 *      forward; every new customer's record is written here at signup.
 *
 *   2. Railway-direct HTTP fallback — covers tenants whose `TENANT_DATA`
 *      record is missing or has no profile fields. The platform's own
 *      `advocatemcp.com` tenant is in this bucket: it was wired into
 *      `BUSINESS_MAP` before the onboarding flow existed, so its slug
 *      resolves but the rich profile lives only in Railway D1.
 *
 * Why apiBase (NOT publicApiBase) on the fallback
 * ----------------------------------------------
 * `publicApiBase` (`api.advocatemcp.com`) is a hostname bound to THIS
 * Worker. When a Worker fetches its own bound hostname, Cloudflare's
 * same-zone loop-prevention bypasses the Worker entirely — the request
 * goes straight to Railway with no `X-API-Key` proxy in the middle, and
 * the server returns 401. That's exactly the silent failure PR #225
 * shipped. Using `apiBase` (raw Railway hostname) avoids the
 * loop-prevention entirely, and we attach the API key ourselves.
 *
 * Why fall back to KV result on HTTP failure
 * ------------------------------------------
 * If the KV record exists but is sparse (e.g. only `name` set), the
 * KV-derived object still beats null for the renderer — at minimum the
 * tenant gets a per-tenant H1 instead of slug-only fallback. We don't
 * want a transient Railway hiccup to delete data we already have.
 */
export async function readProfileForDomain(
  env: Env,
  domain: string,
  slug: string | null,
): Promise<Record<string, unknown> | null> {
  const fromKv = tenantToProfileObject(await getTenant(env, domain));

  // KV has enough to render — short-circuit. `name || description` is the
  // minimum signal a useful profile has; anything less and the renderer
  // would just fall back to the slug anyway.
  if (fromKv && (fromKv.name || fromKv.description)) {
    return fromKv;
  }

  // No slug → no HTTP URL we can build; return whatever KV had (likely null).
  if (!slug) return fromKv;

  try {
    const res = await Promise.race([
      fetch(`${apiBase(env)}/agents/${slug}/profile`, {
        headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2000),
      ),
    ]) as Response;
    if (res.ok) {
      return (await res.json()) as Record<string, unknown>;
    }
  } catch { /* best-effort — fall through to KV result */ }

  return fromKv;
}
