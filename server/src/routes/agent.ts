import { Router } from "express";
import type { Request, Response } from "express";
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";
// AMC-004: every route in this router is slug-scoped (/agents/:slug/*),
// so we use requireSlugOrAdminKey — server admin key works for everything,
// tenant Bearer key works ONLY for its own slug. The previous requireApiKey
// allowed any tenant's key to authenticate against any other tenant's
// endpoints (privilege escalation surface). Now scoped.
import { requireSlugOrAdminKey } from "../middleware/auth.js";
import {
  listLocations,
  addLocation,
  updateLocation,
  removeLocation,
  setPrimary,
  getLocationCap,
  type Plan as LocationPlan,
} from "../repos/locations.js";
import { buildToken } from "../lib/tracked-url.js";
import { resolveAgentId } from "../lib/agentIdentity.js";
import { verifyGoogleRating } from "../lib/googlePlaces.js";
import { invalidateBotCache } from "../lib/botCacheInvalidation.js";
import { checkLimit } from "../middleware/costRateLimit.js";
import {
  reserve as budgetReserve,
  record as budgetRecord,
  release as budgetRelease,
} from "../middleware/budgetKillSwitch.js";
import {
  reserveForSlug,
  recordForSlug,
  releaseForSlug,
} from "../middleware/tenantBudget.js";
import crypto from "crypto";
import { z } from "zod";
import { scanForPromptInjection } from "../lib/promptInjectionScanner.js";
import {
  HoursSchema,
  PricingV2Schema,
  LeadRoutingSchema,
  RatingsSchema,
  CustomerQuoteSchema,
  CredentialsSchema,
  CaseStorySchema,
} from "../schemas/business.js";

const QueryBodySchema = z.object({
  query: z.string().trim().min(1, "query must be a non-empty string").max(2000),
  crawler: z.string().max(200).optional(),
  // Phase A (per-bot HTML rendering): when format === "html" we wrap
  // the agent's answer in HTML+JSON-LD using the renderer matched to
  // `crawler`. Default (omitted or "json") returns the legacy envelope.
  format: z.enum(["json", "html"]).optional(),
});

/** Coerce an Express header (which can be string | string[] | undefined)
 *  to a single string, trimmed, or null. Shared by the X-Geo-* lookups on
 *  POST /agents/:slug/query. */
function headerValue(h: string | string[] | undefined): string | null {
  if (!h) return null;
  const s = Array.isArray(h) ? h[0] : h;
  const trimmed = String(s).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Lenient IANA timezone check — real resolution happens at use-site via
// Intl.DateTimeFormat. Block obviously malformed inputs only.
const TimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z_+-]+(\/[A-Za-z_+\-0-9]+){0,2}$/, "must be an IANA zone like 'America/Chicago'");

export const agentRouter = Router();

/**
 * POST /agents/:slug/query
 *
 * Body: { query: string, crawler?: string }
 *
 * Looks up the business, calls Claude with the business system prompt,
 * logs the exchange, and returns a structured response.
 */
/**
 * GET /agents/:slug/profile
 *
 * Public structured profile for a registered business.
 * Consumed by the Cloudflare Worker and MCP clients.
 */
agentRouter.get("/agents/:slug/profile", requireSlugOrAdminKey, (req: Request, res: Response) => {
  const { slug } = req.params;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT slug, name, description, services, pricing, location, phone, website,
              referral_url, tone, created_at, category, star_rating, review_count,
              years_in_business, top_services, availability, differentiator,
              service_radius_miles, certifications, pricing_tier, service_area_keywords,
              hours_json, pricing_json_v2, lead_routing_json, timezone,
              availability_webhook_url, competitors
       FROM businesses WHERE slug = ?`
    )
    .get(slug) as (BusinessRow & {
      hours_json: string | null;
      pricing_json_v2: string | null;
      lead_routing_json: string | null;
      timezone: string | null;
      availability_webhook_url: string | null;
      competitors: string | null;
    }) | undefined;

  if (!row) {
    res.status(404).json({ error: `No business registered with slug: ${slug}` });
    return;
  }

  const parseCSV = (v: string | null): string[] =>
    v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const parseJSON = (v: string): string[] => {
    try { return JSON.parse(v); } catch { return [v]; }
  };

  const parseObj = (v: string | null): unknown => {
    if (!v) return null;
    try { return JSON.parse(v); } catch { return null; }
  };

  res.json({
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    services: parseJSON(row.services),
    top_services: parseCSV(row.top_services),
    pricing: row.pricing,
    pricing_tier: row.pricing_tier,
    location: row.location,
    phone: row.phone,
    website: row.website,
    referral_url: row.referral_url,
    tone: row.tone,
    star_rating: row.star_rating,
    review_count: row.review_count,
    years_in_business: row.years_in_business,
    availability: row.availability,
    differentiator: row.differentiator,
    service_radius_miles: row.service_radius_miles,
    certifications: parseCSV(row.certifications),
    service_area_keywords: parseCSV(row.service_area_keywords),
    hours_json: parseObj(row.hours_json),
    pricing_json_v2: parseObj(row.pricing_json_v2),
    lead_routing_json: parseObj(row.lead_routing_json),
    timezone: row.timezone,
    availability_webhook_url: row.availability_webhook_url,
    competitors: parseCSV(row.competitors),
    created_at: row.created_at,
  });
});

/**
 * PATCH /agents/:slug/profile
 *
 * Update mutable profile fields for an existing business.
 * Requires `Authorization: Bearer <api_key>` for the slug.
 * Only fields explicitly provided in the body are updated.
 */
agentRouter.patch("/agents/:slug/profile", (req: Request, res: Response) => {
  const { slug } = req.params;
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const apiKey = authHeader.slice(7).trim();
  const db = getDb();
  const biz = db
    .prepare("SELECT id FROM businesses WHERE slug = ? AND api_key = ?")
    .get(slug, apiKey) as { id: number } | undefined;
  if (!biz) {
    res.status(401).json({ error: "Invalid API key for this slug" });
    return;
  }

  const allowed = [
    "description","services","pricing","location","phone","website","referral_url","tone",
    "category","star_rating","review_count","years_in_business","top_services","availability",
    "differentiator","service_radius_miles","certifications","pricing_tier","service_area_keywords",
    "hours_json","pricing_json_v2","lead_routing_json","timezone","availability_webhook_url",
    "competitors",
    // Phase A iter8: third-party verification data. Without these
    // fields, the per-bot HTML renderer can't emit publisher-attributed
    // Review JSON-LD blocks (the universal "no third-party verification"
    // deduction in the format-judge harness).
    "ratings_json","customer_quotes_json","credentials_json","case_stories_json",
    "differentiators_text","guarantee_text",
    // Apr 30 2026 — Phase 1 tool surface expansion. Edited via the
    // existing wizard / Settings UI surfaces; surfaced to AI agents
    // via the new get_cancellation_policy MCP tool.
    "cancellation_policy_text",
  ] as const;

  const jsonValidators: Record<string, z.ZodTypeAny> = {
    hours_json: HoursSchema.nullable(),
    pricing_json_v2: PricingV2Schema.nullable(),
    lead_routing_json: LeadRoutingSchema.nullable(),
    ratings_json: RatingsSchema.nullable(),
    customer_quotes_json: z.array(CustomerQuoteSchema).max(20).nullable(),
    credentials_json: CredentialsSchema.nullable(),
    case_stories_json: z.array(CaseStorySchema).max(10).nullable(),
  };

  const updates: string[] = [];
  const values: unknown[] = [];

  // AMC-006: Free-text fields land directly in the system prompt, so
  // we scan them on save for known prompt-injection grammars. Catching
  // at input gives us a clear UX (rejected with a specific error)
  // rather than letting the bad string ship to every subsequent prompt
  // build and depending on the in-prompt delimiter wrap to neutralize
  // it. The two layers compose — scanner is the gate, delimiter is the
  // failsafe.
  const PROMPT_TEXT_FIELDS = new Set([
    "description", "differentiator", "differentiators_text",
    "guarantee_text", "tone", "pricing",
    // Apr 30 2026 — get_cancellation_policy surfaces this field
    // verbatim to AI agents. Same prompt-injection scan as the rest
    // of the free-text fields.
    "cancellation_policy_text",
  ]);

  for (const field of allowed) {
    if (!(field in req.body)) continue;
    let val = (req.body as Record<string, unknown>)[field];

    // Normalise arrays → CSV for columns that store CSV.
    if (field === "services" && Array.isArray(val)) val = JSON.stringify(val);
    if (field === "top_services" && Array.isArray(val)) val = (val as string[]).join(", ");
    if (field === "certifications" && Array.isArray(val)) val = (val as string[]).join(", ");
    if (field === "service_area_keywords" && Array.isArray(val)) val = (val as string[]).join(", ");
    if (field === "competitors" && Array.isArray(val)) val = (val as string[]).join(", ");

    if (PROMPT_TEXT_FIELDS.has(field) && typeof val === "string") {
      const scan = scanForPromptInjection(val);
      if (!scan.ok) {
        res.status(400).json({
          error: "prompt_injection_detected",
          field,
          matched_pattern: scan.matched_pattern,
          message:
            "This field contains text that looks like an instruction directive. " +
            "Tenant profiles must be plain descriptive content. Please remove the " +
            "instruction-style language and resubmit.",
        });
        return;
      }
    }

    // JSON columns: validate shape, then stringify (or null).
    if (field in jsonValidators) {
      const parsed = jsonValidators[field].safeParse(val);
      if (!parsed.success) {
        res.status(400).json({
          error: `Invalid ${field}`,
          details: parsed.error.flatten(),
        });
        return;
      }
      val = parsed.data === null ? null : JSON.stringify(parsed.data);
    }

    // Lenient timezone shape check.
    if (field === "timezone" && val !== null && val !== "") {
      const parsed = TimezoneSchema.safeParse(val);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid timezone", details: parsed.error.flatten() });
        return;
      }
      val = parsed.data;
    }

    // availability_webhook_url: allow empty string / null; if present, require URL.
    if (field === "availability_webhook_url" && val !== null && val !== "") {
      const parsed = z.string().url().safeParse(val);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid availability_webhook_url" });
        return;
      }
      val = parsed.data;
    }

    updates.push(`${field} = ?`);
    values.push(val);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No updatable fields provided" });
    return;
  }

  values.push(slug);
  db.prepare(`UPDATE businesses SET ${updates.join(", ")} WHERE slug = ?`).run(...values);

  // Bump the worker's cache version for this slug so the bot-HTML
  // edge cache (rendered JSON-LD + system-prompt-derived prose) is
  // INSTANTLY invalidated. Without this, AI crawlers can serve stale
  // schema for up to 600s after a profile edit. Best-effort: a 2s
  // timeout + caught fetch error means a worker outage doesn't block
  // the customer's profile save; the cache will age out via TTL
  // anyway. See worker/src/routes/portal.ts apiBumpCacheVersion.
  // Apr 30 2026.
  void invalidateBotCache(slug);

  // Audit trail: every PATCH to a tenant profile is logged with the
  // caller's identity (Bearer key prefix), the fields touched, and
  // request metadata. Critical for detecting compromised admin keys
  // or anomalous mass-mutation patterns. Best-effort write — if the
  // audit_logs table is missing the request still succeeds.
  try {
    const dbAudit = getDb();
    dbAudit.prepare(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        action TEXT NOT NULL,
        slug TEXT,
        actor_hint TEXT,
        ip TEXT,
        fields TEXT,
        meta TEXT
      )
    `).run();
    dbAudit.prepare(
      `INSERT INTO audit_logs (ts, action, slug, actor_hint, ip, fields, meta) VALUES (?,?,?,?,?,?,?)`,
    ).run(
      new Date().toISOString(),
      "profile.patch",
      slug,
      apiKey.slice(0, 12) + "…",
      String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "—"),
      JSON.stringify(updates.map((u) => u.split(" ")[0])),
      JSON.stringify({ ua: String(req.headers["user-agent"] ?? "") }),
    );
  } catch (auditErr) {
    console.warn("[agent.PATCH] audit insert failed (non-fatal):", auditErr);
  }

  res.json({ ok: true, slug, updated: updates.map((u) => u.split(" ")[0]) });
});

/**
 * POST /agents/:slug/rotate-key
 *
 * Generates a new api_key for the business, immediately invalidating the old one.
 * Protected by server-level API key only (not business key — caller cannot auth
 * with the key they are trying to invalidate).
 */
agentRouter.post("/agents/:slug/rotate-key", (req: Request, res: Response) => {
  const serverKey = process.env.API_KEY;
  const provided =
    req.headers["x-api-key"] ??
    req.headers.authorization?.replace(/^Bearer\s+/, "");
  if (!serverKey || provided !== serverKey) {
    res.status(401).json({ error: "Server API key required" });
    return;
  }

  const { slug } = req.params;
  const db = getDb();
  const exists = db.prepare("SELECT id FROM businesses WHERE slug = ?").get(slug);
  if (!exists) {
    res.status(404).json({ error: `No business registered with slug: ${slug}` });
    return;
  }

  const newKey = crypto.randomUUID();
  db.prepare("UPDATE businesses SET api_key = ? WHERE slug = ?").run(newKey, slug);
  res.json({ ok: true, slug, new_api_key: newKey });
});

/* Per-slug rate limit on POST /agents/:slug/profile/verify-rating.
 *
 * Each verify call costs us a real Places API charge ($0.005-$0.02
 * depending on field mask SKU). Tenants pasting the same URL repeatedly
 * (or a misbehaving frontend retry loop) can rack up cost without
 * adding any product value. Cap to:
 *   - burst:  3 calls per minute   (allows accidental double-clicks)
 *   - daily: 24 calls per 24 hours (a tenant doesn't need to verify
 *           more than once a day per platform)
 *
 * Bucket key is the slug so each tenant has its own quota — admin
 * impersonation uses the tenant's key here too. */
const VERIFY_RATING_LIMITS = [
  { label: "verify-rating:burst", cfg: { max: 3,  windowMs: 60_000 } },
  { label: "verify-rating:daily", cfg: { max: 24, windowMs: 24 * 60 * 60_000 } },
];

const VerifyRatingBody = z.object({
  platform: z.enum(["google"]),
  url: z.string().trim().min(1).max(2000),
});

/**
 * POST /agents/:slug/profile/verify-rating
 *
 * Body: { platform: "google", url: <maps URL or place_id> }
 * Auth: Bearer api_key for the slug.
 *
 * Returns the live Google rating + count + recent review snippets so
 * the BusinessProfile UI can populate ratings_json.google.{value,count,
 * url,verified_at} and offer to import customer_quotes_json.
 *
 * Cost: ~$0.005-$0.02 per call (Places API New, Atomic field mask).
 * Daily budget kill-switch reserves $0.05 per call (5x headroom for
 * SKU upgrades). Per-slug rate limit caps abuse. Read-only — the
 * endpoint never writes to businesses; the frontend separately PATCHes
 * once the user confirms the values.
 */
agentRouter.post("/agents/:slug/profile/verify-rating", async (req: Request, res: Response) => {
  const { slug } = req.params;

  // Bearer auth against the slug's api_key. Same shape as PATCH profile
  // so admin impersonation (worker forwards the impersonated tenant's
  // key) works without further code.
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const apiKey = authHeader.slice(7).trim();
  const db = getDb();
  const biz = db
    .prepare("SELECT id FROM businesses WHERE slug = ? AND api_key = ?")
    .get(slug, apiKey) as { id: number } | undefined;
  if (!biz) {
    res.status(401).json({ error: "Invalid API key for this slug" });
    return;
  }

  // Validate body shape before touching the limit/budget gates so a
  // malformed request doesn't burn through the per-tenant bucket.
  const parsed = VerifyRatingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const { platform, url } = parsed.data;

  // Per-slug rate limit (defense-in-depth).
  const gate = checkLimit({ key: `verify-rating:${slug}`, limits: VERIFY_RATING_LIMITS });
  if (!gate.allowed) {
    const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "rate_limited",
      message: `Too many verify attempts (${gate.label}). Try again in ${retryAfterSec}s.`,
      retry_after_seconds: retryAfterSec,
    });
    return;
  }

  // Two-tier budget reserve. Per-tenant first (cheaper to fail-fast
  // and the more common limiter for actively-running tenants); then
  // global. $0.05 reservation gives 5x headroom over actual Places
  // API atomic-tier cost (~$0.005/call).
  const VERIFY_MAX_USD = 0.05;
  const tenantBudget = reserveForSlug(slug, VERIFY_MAX_USD);
  if (!tenantBudget.allowed) {
    res.status(503).json({
      error: "tenant_budget_exhausted",
      message: `Per-tenant daily AI budget exhausted for ${slug} ($${tenantBudget.capUsd.toFixed(2)} cap, $${tenantBudget.remainingUsd.toFixed(2)} left). Try again after UTC midnight or contact support to raise.`,
      remaining_usd: tenantBudget.remainingUsd,
      cap_usd: tenantBudget.capUsd,
      scope: "tenant",
    });
    return;
  }
  const budget = budgetReserve(VERIFY_MAX_USD);
  if (!budget.allowed) {
    // Roll back per-tenant reservation since we're not running.
    releaseForSlug(slug, VERIFY_MAX_USD);
    res.status(503).json({
      error: "budget_exhausted",
      message: `Daily AI budget exhausted ($${budget.capUsd.toFixed(2)} cap, $${budget.remainingUsd.toFixed(2)} left). Try again after UTC midnight.`,
      remaining_usd: budget.remainingUsd,
      cap_usd: budget.capUsd,
      scope: "global",
    });
    return;
  }

  if (platform !== "google") {
    // Defensive — zod already enforces this, but in case the enum gains
    // values later, fail closed rather than silently no-op.
    budgetRelease(VERIFY_MAX_USD);
    releaseForSlug(slug, VERIFY_MAX_USD);
    res.status(400).json({ error: "unsupported_platform", platform });
    return;
  }

  const apiKeyEnv = process.env.GOOGLE_PLACES_API_KEY ?? "";
  try {
    const result = await verifyGoogleRating(url, apiKeyEnv);
    if (!result.ok) {
      // No spend incurred when our own pre-checks reject; only count
      // budget when we actually hit Places API. The lib distinguishes
      // these by reason — invalid_url and no_api_key never call out.
      const incurredSpend =
        result.reason === "place_not_found" || result.reason === "places_api_error";
      if (incurredSpend) {
        // Estimate atomic-tier cost ($0.005); Places New atomic SKU.
        budgetRecord(VERIFY_MAX_USD, 0.005);
        recordForSlug(slug, VERIFY_MAX_USD, 0.005);
      } else {
        budgetRelease(VERIFY_MAX_USD);
        releaseForSlug(slug, VERIFY_MAX_USD);
      }
      const status =
        result.reason === "no_api_key" ? 503 :
        result.reason === "place_not_found" ? 404 :
        result.reason === "redirect_failed" || result.reason === "invalid_url" ? 422 :
        502;
      res.status(status).json({
        ok: false,
        reason: result.reason,
        message: result.message,
      });
      return;
    }

    // Successful Places call — record the actual atomic-tier spend
    // against both budgets.
    budgetRecord(VERIFY_MAX_USD, 0.005);
    recordForSlug(slug, VERIFY_MAX_USD, 0.005);

    // Audit-log the verification (separately from PATCH writes since
    // verify is read-only — but we still want a forensic trail of who
    // queried what URL when).
    try {
      const dbAudit = getDb();
      dbAudit.prepare(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          action TEXT NOT NULL,
          slug TEXT,
          actor_hint TEXT,
          ip TEXT,
          fields TEXT,
          meta TEXT
        )
      `).run();
      dbAudit.prepare(
        `INSERT INTO audit_logs (ts, action, slug, actor_hint, ip, fields, meta) VALUES (?,?,?,?,?,?,?)`,
      ).run(
        new Date().toISOString(),
        "profile.verify-rating",
        slug,
        apiKey.slice(0, 12) + "…",
        String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "—"),
        JSON.stringify(["google"]),
        JSON.stringify({ place_id: result.placeId, url_pasted: url.slice(0, 200) }),
      );
    } catch (auditErr) {
      console.warn("[verify-rating] audit insert failed (non-fatal):", auditErr);
    }

    // Shape the response for the UI: rating + count for the platform
    // row, plus quotes[] the user can import into customer_quotes_json.
    const verifiedAt = new Date().toISOString();
    res.json({
      ok: true,
      platform,
      place_id: result.placeId,
      verified_at: verifiedAt,
      rating: result.details.rating,
      count: result.details.userRatingCount,
      url: result.details.googleMapsUri,
      display_name: result.details.displayName,
      formatted_address: result.details.formattedAddress,
      quotes: result.details.reviews.map((r) => ({
        platform: "google",
        rating: r.rating,
        text: r.text,
        author: r.author,
        date: r.publishTime,
        relative_time: r.relativeTime,
      })),
    });
  } catch (err) {
    budgetRelease(VERIFY_MAX_USD);
    releaseForSlug(slug, VERIFY_MAX_USD);
    console.error("[verify-rating] unexpected error:", err);
    res.status(500).json({ error: "internal_error", message: err instanceof Error ? err.message : String(err) });
  }
});

/* AMC-005: Per-tenant rate limit on /agents/:slug/query.
 *
 * Two stacked windows enforce a defense in depth:
 *   - burst (60 req/min) catches a leaked api_key on a fast-loop script
 *   - sustained (1000 req/hour) catches slow-drip exfil
 *
 * Using a rate limit (req/min) instead of a cost cap because a viral
 * legitimate tenant should NOT 503 mid-traffic. The req/min ceiling is
 * 100x the realistic peak we've seen on the busiest tenant (~0.5 RPM
 * at peak), so honest traffic never hits it. Leaked-key abuse —
 * thousands of concurrent requests — does.
 *
 * Plan-aware ceilings can layer on top later (free=tighter, pro=looser);
 * v1 ships one ceiling for everyone. */
const AGENT_QUERY_LIMITS = [
  { label: "agent-query:burst",     cfg: { max: 60,   windowMs: 60_000 } },
  { label: "agent-query:sustained", cfg: { max: 1000, windowMs: 60 * 60_000 } },
];

agentRouter.post("/agents/:slug/query", requireSlugOrAdminKey, async (req: Request, res: Response) => {
  const { slug } = req.params;

  const parsed = QueryBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      details: parsed.error.flatten(),
    });
    return;
  }
  const { query, crawler, format } = parsed.data;

  // Per-tenant rate gate — runs BEFORE the budget reserve so a runaway
  // attacker can't drain the global budget by exhausting a single
  // tenant's cap.
  const gate = checkLimit({ key: `agent-query:${slug}`, limits: AGENT_QUERY_LIMITS });
  if (!gate.allowed) {
    const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "rate_limited",
      message: `Too many queries (${gate.label}). Try again in ${retryAfterSec}s.`,
      retry_after_seconds: retryAfterSec,
    });
    return;
  }

  const db = getDb();
  const business = db
    .prepare("SELECT * FROM businesses WHERE slug = ?")
    .get(slug) as BusinessRow | undefined;

  if (!business) {
    res.status(404).json({
      error: `No business registered with slug: ${slug}`,
      hint: "Register a business first at POST /register",
    });
    return;
  }

  // Global daily budget kill-switch on bot queries — the production
  // hot path. ~$0.005-0.02 per Claude call after prompt caching. Reserve
  // $0.05/call (5x headroom over typical actual). When the global $25/day
  // cap is exceeded we 503 — a tenant in that state would still want
  // SOMETHING served (graceful degrade), but graceful degrade is a
  // product call that needs explicit design (see docs/followups.md
  // "bot-query graceful degrade"). For now, fail-closed protects the
  // billing relationship; the alternative is unbounded spend.
  //
  // Per-tenant cap intentionally NOT applied to bot queries here —
  // applying it would 503 individual tenants who get viral traffic at
  // the worst possible time. Per-tenant tracking on bot queries is
  // visibility-only (recordForSlug after the call succeeds) so we can
  // see in /admin/budget which tenant is driving spend, without
  // gating the route.
  const QUERY_RESERVATION_USD = 0.05;
  const queryBudget = budgetReserve(QUERY_RESERVATION_USD);
  if (!queryBudget.allowed) {
    res.status(503).json({
      error: "budget_exhausted",
      message: `Daily AI budget exhausted ($${queryBudget.capUsd.toFixed(2)} cap, $${queryBudget.remainingUsd.toFixed(2)} left). Try again after UTC midnight.`,
      remaining_usd: queryBudget.remainingUsd,
      cap_usd: queryBudget.capUsd,
      scope: "global",
    });
    return;
  }

  try {
    const requestId = res.locals.requestId as string | undefined;
    // Session 11.5: REST callers may self-identify via x-agent-identity. The
    // MCP path already does this (Session 10) — without it here, every direct
    // API caller looks anonymous to the reputation system. Header-only on the
    // REST surface (no tool-arg equivalent on this endpoint).
    const agentId = resolveAgentId(req, null);

    // Migration 020 / Layer 1: Worker forwards cf.country/region/city via
    // X-Geo-* headers on this POST. If headers are absent (direct curl,
    // legacy Worker, unit tests) we stamp null and the row still inserts.
    const geo = {
      country: headerValue(req.headers["x-geo-country"]),
      region:  headerValue(req.headers["x-geo-region"]),
      city:    headerValue(req.headers["x-geo-city"]),
    };

    const result = await queryAgent(
      business,
      query,
      crawler,
      requestId,
      agentId,
      undefined,
      geo,
    );

    // Build signed attribution token if TOKEN_SIGNING_KEY is configured.
    // Additive — omitted gracefully when key is absent so existing callers
    // are unaffected until the Worker is updated to consume it.
    //
    // `aid` is undefined when the caller didn't self-identify; JSON.stringify
    // drops the key, so legacy tokens stay byte-identical (see
    // tracked-url.aid.test.ts back-compat assertions).
    const signingKey = process.env.TOKEN_SIGNING_KEY;
    const attributionToken = signingKey && result.referral_url
      ? buildToken(
          {
            dest: result.referral_url,
            ref: crawler ?? "unknown",
            slug: result.business_slug,
            query_id: result.query_id,
            ts: Math.floor(Date.now() / 1000),
            aid: agentId,
          },
          signingKey
        )
      : undefined;

    // Close the budget reservation. queryAgent doesn't currently
    // surface per-call Claude cost, so we estimate $0.01 — the rough
    // average across the WCC profile size + prompt-caching uplift on
    // repeat calls. Refining this to use actual Anthropic-reported
    // cost (which queryAgent could expose via response.usage) is a
    // follow-up. Per-tenant tracking is visibility-only here — recorded
    // so the /admin/budget top_spenders view stays accurate without
    // gating the bot path on per-tenant cap (a viral tenant should not
    // 503 mid-traffic).
    const ESTIMATED_QUERY_COST_USD = 0.01;
    budgetRecord(QUERY_RESERVATION_USD, ESTIMATED_QUERY_COST_USD);
    recordForSlug(slug, QUERY_RESERVATION_USD, ESTIMATED_QUERY_COST_USD);

    // Phase A: per-bot HTML rendering. When format === "html", wrap the
    // agent's answer in HTML+JSON-LD using the renderer matched to the
    // bot's canonical name (passed in `crawler`). Drops in as a parallel
    // response shape; the JSON envelope path is unchanged when
    // format === "json" (default).
    if (format === "html") {
      try {
        const { renderForBot } = await import("../agent/renderers/dispatcher.js");
        const { html, renderer_id } = renderForBot({
          business,
          result,
          query,
          botType: crawler,
        });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("X-Renderer-Variant", renderer_id);
        if (attributionToken) res.setHeader("X-Attribution-Token", attributionToken);
        // Surface the referral URL so the worker can rewrite the
        // body's bare href links to the tracking redirect endpoint.
        // Without this, AI bots cite the bare URL and clicks bypass
        // the attribution loop entirely. (Apr 28 2026.)
        if (result.referral_url) res.setHeader("X-Referral-Url", result.referral_url);
        res.send(html);
        return;
      } catch (renderErr) {
        // Renderer crash → fall back to JSON so the bot still gets
        // SOMETHING. Logged for follow-up.
        console.error(`[agent] HTML render failed for ${slug}, falling back to JSON:`, renderErr);
      }
    }

    res.json({
      ...result,
      ...(attributionToken !== undefined ? { attribution_token: attributionToken } : {}),
    });
  } catch (err) {
    // Failed before/during Claude call — release the reservation so it
    // doesn't permanently consume the daily cap.
    budgetRelease(QUERY_RESERVATION_USD);
    console.error(`[agent] Error querying ${slug}:`, err);
    res.status(500).json({
      error: "Agent query failed",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

// ── Revenue summary (Pro/Enterprise feature, Apr 27 2026) ─────────────────
//
// Authoritative endpoint behind /api/client/revenue-summary on the worker.
// Reads from server SQLite via computeRevenueWindow(), so the dashboard
// and the monthly review email show identical numbers. Plan-gated:
// base tenants get 402 with an upgrade hint instead of zero-state data.

/**
 * GET /agents/:slug/revenue-summary — current month's revenue summary.
 *
 * Returns the three-state shape (verified / estimated / unconfigured)
 * with window bounds. The worker splices `webhook_configured` from D1
 * before returning to the client.
 */
agentRouter.get("/agents/:slug/revenue-summary", requireSlugOrAdminKey, (req: Request, res: Response) => {
  const { slug } = req.params;
  const tenant = getDb()
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .get(slug) as { plan: string | null } | undefined;
  if (!tenant) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const plan = tenant.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    // Plan gate — base tenants don't get revenue attribution per the
    // pricing page. Returning 402 (instead of an empty payload) lets
    // the dashboard hide the revenue card cleanly without rendering
    // the unconfigured zero-state for tenants who literally cannot
    // configure it.
    res.status(402).json({
      error:   "plan_required",
      message: "Revenue attribution is a Pro feature. Upgrade to enable.",
      plan,
    });
    return;
  }

  // Current calendar month, UTC-bounded so the same epoch hits both the
  // dashboard render and the monthly email cron's window calculation.
  const now = new Date();
  const fromISO = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const toISO   = now.toISOString();

  // Optional per-location filter. When the dashboard's topbar location
  // selector is set, the worker forwards ?location_id=<id> through to
  // this endpoint. Validate that the supplied id actually belongs to
  // this tenant — defense against an attacker forging a location_id
  // from another tenant — by joining to locations.
  const rawLocationId = (req.query.location_id ?? "") as string;
  let locationId: string | null = null;
  if (rawLocationId) {
    const ownedRow = getDb()
      .prepare("SELECT id FROM locations WHERE id = ? AND business_slug = ?")
      .get(rawLocationId, slug) as { id: string } | undefined;
    if (!ownedRow) {
      res.status(400).json({ error: "invalid_location_id" });
      return;
    }
    locationId = ownedRow.id;
  }

  // Lazy import to avoid circular deps on agent.ts → revenue.ts → db.ts.
  // computeRevenueWindow throws nothing — it returns 'unconfigured' on
  // any data shortfall — so no try/catch needed here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeRevenueWindow } = require("../lib/revenue.js") as typeof import("../lib/revenue.js");
  const summary = computeRevenueWindow({ db: getDb(), slug, fromISO, toISO, locationId });
  res.json(summary);
});

// ── Multi-location CRUD (Pro/Enterprise feature, Apr 27 2026) ─────────────
//
// Pro = up to 3 locations, Enterprise = unlimited. Caps enforced inside
// addLocation() — the route just surfaces the cap rejection as 402.
// Auth: requireApiKey on every endpoint, same as the rest of the agent
// surface, so the customer's portal session-bridge works unchanged.

/**
 * GET /agents/:slug/locations — list every location for the tenant.
 */
agentRouter.get("/agents/:slug/locations", requireSlugOrAdminKey, (req: Request, res: Response) => {
  const { slug } = req.params;
  const rows = listLocations(getDb(), slug);
  // Hours_json is stored as raw text; parse on the way out for callers.
  const out = rows.map((r) => ({
    id:            r.id,
    name:          r.name,
    address_line1: r.address_line1,
    address_line2: r.address_line2,
    city:          r.city,
    state:         r.state,
    postal_code:   r.postal_code,
    country:       r.country,
    phone:         r.phone,
    hours:         r.hours_json ? safeParseJson(r.hours_json) : null,
    is_primary:    r.is_primary === 1,
    created_at:    r.created_at,
  }));

  // Tenant plan + cap so the UI can render "X of Y locations" without a
  // second round-trip. Reads businesses.plan inline; mirrors the resolution
  // rule in addLocation().
  const tenant = getDb()
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .get(slug) as { plan: string | null } | undefined;
  const plan: LocationPlan = (tenant?.plan === "pro" || tenant?.plan === "enterprise")
    ? tenant.plan
    : "base";
  const cap = getLocationCap(plan);

  res.json({
    locations: out,
    plan,
    cap: Number.isFinite(cap) ? cap : null,    // null on the wire = unlimited
    current_count: out.length,
  });
});

/**
 * POST /agents/:slug/locations — add a new location.
 *
 * Body: { name, city, state, address_line1?, address_line2?,
 *         postal_code?, country?, phone?, hours? }
 *
 * 402 with `{ code: 'plan_limit', cap, current_count, plan }` when
 * adding would exceed the tier's cap. UI surfaces this as an upgrade
 * CTA pointing at Pro / Enterprise.
 */
agentRouter.post("/agents/:slug/locations", requireSlugOrAdminKey, (req: Request, res: Response) => {
  const { slug } = req.params;
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "validation", message: "JSON body required" });
    return;
  }

  // Lightweight validation — repo's addLocation() does the authoritative
  // shape check, but we coerce types here to surface clearer errors.
  const result = addLocation(getDb(), slug, {
    name:          String(body.name ?? "").trim(),
    address_line1: body.address_line1 == null ? null : String(body.address_line1),
    address_line2: body.address_line2 == null ? null : String(body.address_line2),
    city:          String(body.city  ?? "").trim(),
    state:         String(body.state ?? "").trim(),
    postal_code:   body.postal_code == null ? null : String(body.postal_code),
    country:       body.country == null ? "US" : String(body.country),
    phone:         body.phone == null ? null : String(body.phone),
    hours_json:    body.hours == null ? null : (body.hours as Record<string, unknown>),
  });

  if (!result.ok && result.code === "plan_limit") {
    res.status(402).json({
      error:         "plan_limit",
      message:       `Your ${result.plan} plan allows up to ${result.cap} location${result.cap === 1 ? "" : "s"}. Upgrade to add more.`,
      cap:           result.cap,
      current_count: result.current_count,
      plan:          result.plan,
    });
    return;
  }
  if (!result.ok && result.code === "validation") {
    res.status(400).json({ error: "validation", field: result.field });
    return;
  }
  // Locations feed into the agent's prompt + JSON-LD blocks. Bump the
  // worker bot-cache so AI crawlers see the new location immediately.
  void invalidateBotCache(slug);
  res.status(201).json({ location: result.row });
});

/**
 * PATCH /agents/:slug/locations/:id — update a location.
 *
 * Mutable fields: name, address_line1, address_line2, city, state,
 * postal_code, country, phone, hours. is_primary is NOT mutable here —
 * use POST /agents/:slug/locations/:id/promote instead (transactional
 * demote-then-promote so the partial unique index doesn't reject).
 */
agentRouter.patch(
  "/agents/:slug/locations/:id",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug, id } = req.params;
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "validation", message: "JSON body required" });
      return;
    }
    const result = updateLocation(getDb(), slug, id, {
      name:          body.name === undefined ? undefined : String(body.name).trim(),
      address_line1: body.address_line1 === undefined ? undefined : (body.address_line1 == null ? null : String(body.address_line1)),
      address_line2: body.address_line2 === undefined ? undefined : (body.address_line2 == null ? null : String(body.address_line2)),
      city:          body.city  === undefined ? undefined : String(body.city).trim(),
      state:         body.state === undefined ? undefined : String(body.state).trim(),
      postal_code:   body.postal_code === undefined ? undefined : (body.postal_code == null ? null : String(body.postal_code)),
      country:       body.country === undefined ? undefined : String(body.country ?? "US"),
      phone:         body.phone === undefined ? undefined : (body.phone == null ? null : String(body.phone)),
      hours_json:    body.hours === undefined ? undefined : (body.hours == null ? null : (body.hours as Record<string, unknown>)),
    });
    if (!result.ok) {
      if (result.code === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(400).json({ error: "validation", field: result.field });
      return;
    }
    void invalidateBotCache(slug);
    res.json({ location: result.row });
  },
);

/**
 * DELETE /agents/:slug/locations/:id — remove a location.
 *
 * Refuses to delete the primary (409 'primary_locked') so a tenant
 * never lands in the "no locations" state. Customer must promote a
 * different location first.
 */
agentRouter.delete(
  "/agents/:slug/locations/:id",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug, id } = req.params;
    const result = removeLocation(getDb(), slug, id);
    if (!result.ok && result.code === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!result.ok && result.code === "primary_locked") {
      res.status(409).json({
        error:   "primary_locked",
        message: "Promote another location to primary before removing this one.",
      });
      return;
    }
    void invalidateBotCache(slug);
    res.json({ ok: true });
  },
);

/**
 * POST /agents/:slug/locations/:id/promote — make this location primary.
 *
 * Atomic demote-then-promote so the partial unique index on is_primary=1
 * never sees two simultaneously.
 */
agentRouter.post(
  "/agents/:slug/locations/:id/promote",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug, id } = req.params;
    const result = setPrimary(getDb(), slug, id);
    if (!result.ok) {
      res.status(404).json({ error: result.code });
      return;
    }
    void invalidateBotCache(slug);
    res.json({ ok: true });
  },
);

/** Defensive JSON parse for hours_json — return null on bad data rather
 * than throwing, since this is a presentation-layer concern (the bot
 * agent reads the same column directly without parse). */
function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); }
  catch { return null; }
}
