import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import crypto from "crypto";
import { requireApiKey } from "../middleware/auth.js";
import { OnboardingPayloadSchema } from "../schemas/business.js";

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
 * POST /register — onboard a new business.
 *
 * Validates the request body against OnboardingPayloadSchema (zod), auto-generates
 * a slug + API key, and persists the flat profile columns plus the 9-step wizard
 * JSON blobs. Returns slug, API key, and public endpoint URLs.
 */
registerRouter.post("/register", requireApiKey, (req: Request, res: Response) => {
  const parsed = OnboardingPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_error",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const p = parsed.data;

  const db = getDb();

  // Generate a unique slug (append -1, -2, … on collision)
  const baseSlug = slugify(p.name);
  let slug = baseSlug;
  let attempt = 0;
  while (db.prepare("SELECT id FROM businesses WHERE slug = ?").get(slug)) {
    attempt++;
    slug = `${baseSlug}-${attempt}`;
  }

  const apiKey = crypto.randomUUID();
  const j = (v: unknown): string | null =>
    v === undefined ? null : JSON.stringify(v);

  try {
    db.prepare(
      `INSERT INTO businesses
         (slug, name, description, services, pricing, location, phone, website,
          referral_url, tone, api_key,
          category, star_rating, review_count, years_in_business, top_services,
          availability, differentiator, service_radius_miles, certifications,
          pricing_tier, service_area_keywords,
          hours_json, services_json_v2, pricing_json_v2, credentials_json,
          ratings_json, differentiators_text, customer_quotes_json,
          guarantee_text, case_stories_json, lead_routing_json,
          plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      slug,
      p.name,
      p.description,
      JSON.stringify(p.services),
      p.pricing ?? null,
      p.location,
      p.phone ?? null,
      p.website ?? null,
      p.referral_url ?? p.website ?? null,
      p.tone,
      apiKey,
      p.category,
      p.star_rating,
      p.review_count,
      p.years_in_business ?? null,
      p.top_services ?? null,
      p.availability ?? null,
      p.differentiator ?? null,
      p.service_radius_miles ?? null,
      p.certifications ?? null,
      p.pricing_tier ?? null,
      p.service_area_keywords ?? null,
      j(p.hours_json),
      j(p.services_json_v2),
      j(p.pricing_json_v2),
      j(p.credentials_json),
      j(p.ratings_json),
      p.differentiators_text ?? null,
      j(p.customer_quotes_json),
      p.guarantee_text ?? null,
      j(p.case_stories_json),
      j(p.lead_routing_json),
      // Session 4: 'pro' tenants are picked up by the competitor-radar cron;
      // 'base' is the default at the column level too — we pass the literal
      // here only so an explicit forwarding from the wizard takes effect.
      p.plan ?? "base",
    );

    const base = process.env.API_BASE_URL ?? "https://api.advocatemcp.com";
    res.status(201).json({
      slug,
      api_key: apiKey,
      agent_endpoint: `${base}/agents/${slug}/query`,
      profile_endpoint: `${base}/agents/${slug}/profile`,
      mcp_endpoint: `${base}/mcp`,
      wellknown_url: `https://<your-domain>/.well-known/ai-agent.json`,
    });
  } catch (err) {
    console.error("[register] Error:", err);
    res.status(500).json({
      error: "registration_failed",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
