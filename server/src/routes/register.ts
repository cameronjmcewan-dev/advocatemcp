import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import crypto from "crypto";
import { requireApiKey } from "../middleware/auth.js";
import { OnboardingPayloadSchema } from "../schemas/business.js";
import { getApiBaseUrl } from "../lib/baseUrl.js";

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
  const baseSlug = slugify(p.name);
  const apiKey = crypto.randomUUID();
  const j = (v: unknown): string | null =>
    v === undefined ? null : JSON.stringify(v);

  // Pick + INSERT is retried on UNIQUE-slug violations to close the race
  // where two concurrent /register calls (same business name, different
  // Node processes on the same DB) both pass the "is the slug free" check
  // and race each other to INSERT. The winner commits, the loser hits
  // SQLITE_CONSTRAINT_UNIQUE, bumps the suffix, and retries. Bounded at
  // MAX_SLUG_ATTEMPTS so a pathological contention storm returns 503 rather
  // than looping forever. Within a single Node process better-sqlite3's
  // synchronous API serializes the handler — this is the multi-process case.
  const MAX_SLUG_ATTEMPTS = 10;
  const insertStmt = db.prepare(
    `INSERT INTO businesses
       (slug, name, description, services, pricing, location, phone, website,
        referral_url, tone, api_key,
        category, star_rating, review_count, years_in_business, top_services,
        availability, differentiator, service_radius_miles, certifications,
        pricing_tier, service_area_keywords,
        hours_json, services_json_v2, pricing_json_v2, credentials_json,
        ratings_json, differentiators_text, customer_quotes_json,
        guarantee_text, case_stories_json, lead_routing_json,
        plan, email,
        beta_started_at, beta_ends_at, beta_coupon_id, beta_cohort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const slugFreeStmt = db.prepare("SELECT id FROM businesses WHERE slug = ?");

  let insertedSlug: string | null = null;
  let suffix = 0;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    // Advance suffix until the slug is free at this instant. The pick is
    // inside the retry loop so every attempt picks fresh.
    let candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
    while (slugFreeStmt.get(candidate)) {
      suffix++;
      candidate = `${baseSlug}-${suffix}`;
    }

    try {
      insertStmt.run(
        candidate,
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
        p.email ?? null,
        // Beta cohort fields. Worker stripe webhook detects the beta
        // promo code at checkout, then forwards these to /register so
        // server-side digest + ending-email crons can pick the right copy.
        p.beta_started_at ?? null,
        p.beta_ends_at ?? null,
        p.beta_coupon_id ?? null,
        p.beta_cohort ?? null,
      );
      insertedSlug = candidate;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      // Only retry on slug-unique collision; everything else is a genuine
      // failure that deserves a 500.
      if (/UNIQUE/i.test(msg) && /\.slug\b/i.test(msg)) {
        suffix++;
        continue;
      }
      console.error("[register] Error:", err);
      res.status(500).json({
        error: "registration_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
      return;
    }
  }

  if (insertedSlug === null) {
    console.error(`[register] slug_contention_exhausted baseSlug=${baseSlug} attempts=${MAX_SLUG_ATTEMPTS}`);
    res.status(503).json({
      error: "slug_contention",
      message: "could not allocate unique slug; retry",
    });
    return;
  }

  const base = getApiBaseUrl();
  res.status(201).json({
    slug: insertedSlug,
    api_key: apiKey,
    agent_endpoint: `${base}/agents/${insertedSlug}/query`,
    profile_endpoint: `${base}/agents/${insertedSlug}/profile`,
    mcp_endpoint: `${base}/mcp`,
    wellknown_url: `https://<your-domain>/.well-known/ai-agent.json`,
  });
});
