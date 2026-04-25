import { Router } from "express";
import type { Request, Response } from "express";
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";
import { requireApiKey } from "../middleware/auth.js";
import { buildToken } from "../lib/tracked-url.js";
import { resolveAgentId } from "../lib/agentIdentity.js";
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
