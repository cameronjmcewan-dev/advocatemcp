/**
 * Public schema.org LocalBusiness JSON-LD endpoint. Mounted BEFORE the
 * worker-only CORS middleware so cross-origin fetches from
 * customers.advocatemcp.com (dashboard) and search-engine crawlers (any
 * origin) can both read the body.
 *
 * Same reasoning as decodeRouter and auditRouter in testApp.ts: the CORS
 * middleware there whitelists only the worker origin, which is correct
 * for authenticated endpoints but wrong for ones any origin must be able
 * to fetch.
 *
 * The handler sets its own Access-Control-Allow-Origin: *.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getDb, type BusinessRow } from "../db.js";
import { toLocalBusinessJsonLd } from "../lib/jsonLd.js";

export const jsonLdRouter = Router();

jsonLdRouter.get("/agents/:slug/json-ld.json", (req: Request, res: Response) => {
  const { slug } = req.params;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, slug, name, description, services, pricing, location, phone, website,
              referral_url, tone, api_key, created_at, category, star_rating, review_count,
              years_in_business, top_services, availability, differentiator,
              service_radius_miles, certifications, pricing_tier, service_area_keywords,
              hours_json, services_json_v2, pricing_json_v2, credentials_json,
              ratings_json, differentiators_text, customer_quotes_json,
              guarantee_text, case_stories_json, lead_routing_json
         FROM businesses WHERE slug = ?`,
    )
    .get(slug) as BusinessRow | undefined;

  if (!row) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(404).json({ error: `No business registered with slug: ${slug}` });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/ld+json; charset=utf-8");
  // 1h cache: JSON-LD is low-volatility; profile edits propagate within an hour.
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(JSON.stringify(toLocalBusinessJsonLd(row), null, 2));
});
