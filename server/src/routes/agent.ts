import { Router } from "express";
import type { Request, Response } from "express";
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";

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
agentRouter.get("/agents/:slug/profile", (req: Request, res: Response) => {
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

agentRouter.post("/agents/:slug/query", async (req: Request, res: Response) => {
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
