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

import type { TenantRecord } from "../routes/onboard";

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
