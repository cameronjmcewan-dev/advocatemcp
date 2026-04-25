import { Router } from "express";
import type { Request, Response } from "express";
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";
import { requireApiKey } from "../middleware/auth.js";
import { buildToken } from "../lib/tracked-url.js";
import { resolveAgentId } from "../lib/agentIdentity.js";
import { verifyGoogleRating } from "../lib/googlePlaces.js";
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
agentRouter.get("/agents/:slug/profile", requireApiKey, (req: Request, res: Response) => {
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

  for (const field of allowed) {
    if (!(field in req.body)) continue;
    let val = (req.body as Record<string, unknown>)[field];

    // Normalise arrays → CSV for columns that store CSV.
    if (field === "services" && Array.isArray(val)) val = JSON.stringify(val);
    if (field === "top_services" && Array.isArray(val)) val = (val as string[]).join(", ");
    if (field === "certifications" && Array.isArray(val)) val = (val as string[]).join(", ");
    if (field === "service_area_keywords" && Array.isArray(val)) val = (val as string[]).join(", ");
    if (field === "competitors" && Array.isArray(val)) val = (val as string[]).join(", ");

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

agentRouter.post("/agents/:slug/query", requireApiKey, async (req: Request, res: Response) => {
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
    console.error(`[agent] Error querying ${slug}:`, err);
    res.status(500).json({
      error: "Agent query failed",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
