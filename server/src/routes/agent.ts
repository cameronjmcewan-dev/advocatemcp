import { Router } from "express";
import type { Request, Response } from "express";
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";
import { requireApiKey } from "../middleware/auth.js";
import crypto from "crypto";

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
              service_radius_miles, certifications, pricing_tier, service_area_keywords
       FROM businesses WHERE slug = ?`
    )
    .get(slug) as BusinessRow | undefined;

  if (!row) {
    res.status(404).json({ error: `No business registered with slug: ${slug}` });
    return;
  }

  const parseCSV = (v: string | null): string[] =>
    v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const parseJSON = (v: string): string[] => {
    try { return JSON.parse(v); } catch { return [v]; }
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
  ] as const;

  const updates: string[] = [];
  const values: unknown[] = [];

  for (const field of allowed) {
    if (!(field in req.body)) continue;
    let val = (req.body as Record<string, unknown>)[field];
    if (field === "services" && Array.isArray(val)) val = JSON.stringify(val);
    if (field === "top_services" && Array.isArray(val)) val = (val as string[]).join(", ");
    if (field === "certifications" && Array.isArray(val)) val = (val as string[]).join(", ");
    if (field === "service_area_keywords" && Array.isArray(val)) val = (val as string[]).join(", ");
    updates.push(`${field} = ?`);
    values.push(val);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No updatable fields provided" });
    return;
  }

  values.push(slug);
  db.prepare(`UPDATE businesses SET ${updates.join(", ")} WHERE slug = ?`).run(...values);

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
  const { query, crawler } = req.body as {
    query?: string;
    crawler?: string;
  };

  if (!query || typeof query !== "string" || !query.trim()) {
    res.status(400).json({
      error: "Missing required field: query",
      required: { query: "string", crawler: "string (optional)" },
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

  try {
    const result = await queryAgent(business, query.trim(), crawler);
    res.json(result);
  } catch (err) {
    console.error(`[agent] Error querying ${slug}:`, err);
    res.status(500).json({
      error: "Agent query failed",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
