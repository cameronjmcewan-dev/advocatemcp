import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import crypto from "crypto";
import { requireApiKey } from "../middleware/auth.js";

export const registerRouter = Router();

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
}

/**
 * POST /register
 *
 * Onboard a new business. Auto-generates a slug and API key.
 * Returns the slug, API key, and all endpoint URLs.
 */
registerRouter.post("/register", requireApiKey, (req: Request, res: Response) => {
  const {
    name,
    description,
    services,
    pricing,
    location,
    phone,
    website,
    referral_url,
    tone,
    // Section 1: rich profile fields
    category,
    star_rating,
    review_count,
    years_in_business,
    top_services,
    availability,
    differentiator,
    service_radius_miles,
    certifications,
    pricing_tier,
    service_area_keywords,
  } = req.body as Record<string, unknown>;

  // Validate required fields
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing required field: name (string)" });
    return;
  }
  if (!description || typeof description !== "string") {
    res.status(400).json({ error: "Missing required field: description (string)" });
    return;
  }
  if (!services) {
    res.status(400).json({
      error: "Missing required field: services (string[] or string)",
    });
    return;
  }
  if (!category || typeof category !== "string") {
    res.status(400).json({ error: "Missing required field: category (string)" });
    return;
  }
  if (!location || typeof location !== "string") {
    res.status(400).json({ error: "Missing required field: location (string)" });
    return;
  }
  if (star_rating == null || typeof star_rating !== "number" || star_rating < 0 || star_rating > 5) {
    res.status(400).json({ error: "Missing or invalid field: star_rating (number 0-5)" });
    return;
  }
  if (review_count == null || typeof review_count !== "number" || review_count < 0) {
    res.status(400).json({ error: "Missing or invalid field: review_count (number >= 0)" });
    return;
  }
  if (pricing_tier != null && !["budget", "mid-range", "premium"].includes(pricing_tier as string)) {
    res.status(400).json({ error: "Invalid pricing_tier: must be 'budget', 'mid-range', or 'premium'" });
    return;
  }

  const db = getDb();

  // Generate a unique slug (append -1, -2, … on collision)
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let attempt = 0;
  while (db.prepare("SELECT id FROM businesses WHERE slug = ?").get(slug)) {
    attempt++;
    slug = `${baseSlug}-${attempt}`;
  }

  const apiKey = crypto.randomUUID();
  const servicesJson = Array.isArray(services)
    ? JSON.stringify(services)
    : JSON.stringify([String(services)]);

  try {
    db.prepare(
      `INSERT INTO businesses
         (slug, name, description, services, pricing, location, phone, website, referral_url, tone, api_key,
          category, star_rating, review_count, years_in_business, top_services, availability,
          differentiator, service_radius_miles, certifications, pricing_tier, service_area_keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      slug,
      name,
      description,
      servicesJson,
      typeof pricing === "string" ? pricing : null,
      typeof location === "string" ? location : null,
      typeof phone === "string" ? phone : null,
      typeof website === "string" ? website : null,
      typeof referral_url === "string"
        ? referral_url
        : typeof website === "string"
          ? website
          : null,
      typeof tone === "string" ? tone : "friendly",
      apiKey,
      category as string,
      star_rating as number,
      review_count as number,
      typeof years_in_business === "number" ? years_in_business : null,
      typeof top_services === "string"
        ? top_services
        : Array.isArray(top_services)
          ? (top_services as string[]).join(", ")
          : null,
      typeof availability === "string" ? availability : null,
      typeof differentiator === "string" ? differentiator : null,
      typeof service_radius_miles === "number" ? service_radius_miles : null,
      typeof certifications === "string"
        ? certifications
        : Array.isArray(certifications)
          ? (certifications as string[]).join(", ")
          : null,
      typeof pricing_tier === "string" ? pricing_tier : null,
      typeof service_area_keywords === "string"
        ? service_area_keywords
        : Array.isArray(service_area_keywords)
          ? (service_area_keywords as string[]).join(", ")
          : null
    );

    const base = process.env.API_BASE_URL ?? "https://api.advocatemcp.com";

    res.status(201).json({
      slug,
      api_key: apiKey,
      agent_endpoint: `${base}/agents/${slug}/query`,
      profile_endpoint: `${base}/agents/${slug}/profile`,
      mcp_endpoint: `${base}/mcp`,
      wellknown_url: `https://<your-domain>/.well-known/ai-agent.json`,
      instructions: {
        query_agent: `POST ${base}/agents/${slug}/query — body: { "query": "...", "crawler": "YourBotName" }`,
        view_profile: `GET ${base}/agents/${slug}/profile — public structured profile`,
        view_analytics: `GET ${base}/analytics/${slug} — header: Authorization: Bearer ${apiKey}`,
        connect_mcp: `Add ${base}/mcp to your MCP client (Claude Desktop, Cursor, etc.)`,
        install_worker: `Deploy the Cloudflare Worker and add "${slug}" to your BUSINESS_MAP KV store with your domain as the key`,
      },
    });
  } catch (err) {
    console.error("[register] Error:", err);
    res.status(500).json({
      error: "Registration failed",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
