/**
 * Admin endpoints for managing competitor records + triggering the
 * comparison-pages builder on demand.
 *
 * Phase 4 grey-hat operator tools. The comparison-pages cron only fires
 * monthly and only generates pages when at least one competitor has
 * non-empty `verified_facts_json`. Until an operator populates that
 * data, Phase 4 stays dormant — these endpoints close that loop.
 *
 * Same auth posture as routes/admin/faqs.ts: mounted BEFORE the
 * requireAdmin Bearer chain so SERVER_API_KEY (the worker's shared
 * secret, also handed to operators) authenticates instead of needing
 * a separate ADMIN_API_KEY. The router does an in-handler
 * slug-ownership check so a business's own api_key can't manage
 * another tenant's competitor list.
 *
 * Apr 29 2026.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { getDb } from "../../db.js";
import type { BusinessRow } from "../../db.js";
import { runComparisonPagesBuilder } from "../../jobs/comparisonPagesBuilder.js";
import { slugifyOne } from "../../lib/slugifyServiceLocation.js";

export const adminCompetitorsRouter = Router();

const VerifiedFactsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const CompetitorBodySchema = z.object({
  competitor_name:     z.string().min(1).max(120),
  competitor_url:      z.string().url().optional(),
  verified_facts_json: VerifiedFactsSchema.default({}),
  source_urls_json:    z.array(z.string().url()).default([]),
  facts_source:        z.string().max(64).default("manual"),
});

interface CompetitorRow {
  id:                  number;
  business_id:         number;
  competitor_name:     string;
  competitor_slug:     string;
  competitor_url:      string | null;
  verified_facts_json: string;
  source_urls_json:    string;
  facts_source:        string;
  facts_updated_at:    number | null;
  created_at:          number;
  updated_at:          number;
}

/** Resolve business by slug + check the request's api_key authorizes
 *  managing this tenant's competitors. SERVER_API_KEY bypasses the
 *  per-tenant check (used by ops + CI). Business's own api_key matches
 *  only if the URL slug == its slug.
 */
function getAuthorizedBusiness(req: Request, slug: string): BusinessRow | { error: string; status: number } {
  const db = getDb();
  const biz = db
    .prepare("SELECT * FROM businesses WHERE slug = ? LIMIT 1")
    .get(slug) as BusinessRow | undefined;
  if (!biz) return { error: "business_not_found", status: 404 };

  const auth = req.header("authorization") ?? "";
  const apiKeyHeader = req.header("x-api-key") ?? "";
  const presented = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : apiKeyHeader.trim();

  // requireApiKey middleware (one level up) already accepted the request.
  // We only need to refuse the case where a NON-SERVER api_key tries to
  // manage another tenant.
  const serverKey = process.env.API_KEY ?? "";
  if (presented && serverKey && presented === serverKey) return biz;
  if (presented && presented === biz.api_key) return biz;
  return { error: "slug_not_owned_by_caller", status: 403 };
}

/**
 * POST /admin/businesses/:slug/competitors
 *
 * Create a competitor record for the named tenant. Body shape:
 *   {
 *     "competitor_name": "Scrunch AI",
 *     "competitor_url":  "https://scrunch.ai",
 *     "verified_facts_json": { "pricing": "99", "review_count": "50" },
 *     "source_urls_json":    ["https://scrunch.ai/pricing"],
 *     "facts_source":        "manual"
 *   }
 *
 * Slug is derived from `competitor_name` via slugifyOne and must be
 * unique within the tenant (UNIQUE(business_id, competitor_slug)). On
 * conflict returns 409.
 */
adminCompetitorsRouter.post("/businesses/:slug/competitors", (req: Request, res: Response) => {
  const { slug } = req.params;
  const auth = getAuthorizedBusiness(req, slug);
  if ("error" in auth) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const biz = auth;

  const parsed = CompetitorBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;
  const competitorSlug = slugifyOne(body.competitor_name);
  if (!competitorSlug) {
    res.status(400).json({ error: "competitor_name_yields_empty_slug" });
    return;
  }

  const db = getDb();
  const now = Date.now();
  try {
    const result = db.prepare(
      `INSERT INTO competitors
         (business_id, competitor_name, competitor_slug, competitor_url,
          verified_facts_json, source_urls_json, facts_source,
          facts_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      biz.id,
      body.competitor_name,
      competitorSlug,
      body.competitor_url ?? null,
      JSON.stringify(body.verified_facts_json),
      JSON.stringify(body.source_urls_json),
      body.facts_source,
      now,
      now,
      now,
    );
    res.status(201).json({
      id:               Number(result.lastInsertRowid),
      business_id:      biz.id,
      business_slug:    biz.slug,
      competitor_name:  body.competitor_name,
      competitor_slug:  competitorSlug,
      facts_source:     body.facts_source,
      verified_fact_count: Object.keys(body.verified_facts_json).length,
      source_url_count:    body.source_urls_json.length,
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      res.status(409).json({ error: "competitor_slug_already_exists", competitor_slug: competitorSlug });
      return;
    }
    res.status(500).json({ error: "insert_failed", detail: String(err) });
  }
});

/**
 * GET /admin/businesses/:slug/competitors
 *
 * List the competitor records for the named tenant. Includes parsed
 * verified_facts_json + source_urls_json so operators can spot-check
 * what data is on file.
 */
adminCompetitorsRouter.get("/businesses/:slug/competitors", (req: Request, res: Response) => {
  const { slug } = req.params;
  const auth = getAuthorizedBusiness(req, slug);
  if ("error" in auth) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const biz = auth;

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, business_id, competitor_name, competitor_slug, competitor_url,
            verified_facts_json, source_urls_json, facts_source,
            facts_updated_at, created_at, updated_at
       FROM competitors
       WHERE business_id = ?
       ORDER BY created_at DESC`,
  ).all(biz.id) as CompetitorRow[];

  res.json({
    business_slug: biz.slug,
    business_id:   biz.id,
    count:         rows.length,
    competitors:   rows.map((r) => ({
      id:                 r.id,
      competitor_name:    r.competitor_name,
      competitor_slug:    r.competitor_slug,
      competitor_url:     r.competitor_url,
      verified_facts:     JSON.parse(r.verified_facts_json) as Record<string, unknown>,
      source_urls:        JSON.parse(r.source_urls_json) as string[],
      facts_source:       r.facts_source,
      facts_updated_at:   r.facts_updated_at,
      created_at:         r.created_at,
      updated_at:         r.updated_at,
    })),
  });
});

/**
 * DELETE /admin/businesses/:slug/competitors/:id
 *
 * Remove a competitor record. Cascades to comparison_pages (FK ON DELETE
 * CASCADE) so any generated pages referencing this competitor are
 * dropped at the same time.
 */
adminCompetitorsRouter.delete("/businesses/:slug/competitors/:id", (req: Request, res: Response) => {
  const { slug, id } = req.params;
  const auth = getAuthorizedBusiness(req, slug);
  if ("error" in auth) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const biz = auth;

  const competitorId = Number.parseInt(id, 10);
  if (!Number.isFinite(competitorId)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  const db = getDb();
  // Tenant-scoped delete — business_id in the WHERE clause stops a
  // tenant from removing another tenant's competitor by ID guess.
  const result = db.prepare(
    "DELETE FROM competitors WHERE id = ? AND business_id = ?",
  ).run(competitorId, biz.id);

  if (result.changes === 0) {
    res.status(404).json({ error: "competitor_not_found_for_business" });
    return;
  }
  res.json({ ok: true, deleted_id: competitorId });
});

/**
 * POST /admin/competitors/run-now
 *
 * Triggers the comparison-pages builder synchronously (one batch) so
 * operators can verify generation works without waiting for the
 * monthly cron. Same auth gate as POST/GET above — SERVER_API_KEY only
 * (no per-business slug, this is the cross-tenant builder).
 *
 * Returns the builder's result struct so callers see considered /
 * generated / rejected counts + total cost.
 */
adminCompetitorsRouter.post("/competitors/run-now", async (req: Request, res: Response) => {
  // Only SERVER_API_KEY (operator) can trigger cross-tenant generation.
  const auth = req.header("authorization") ?? "";
  const apiKeyHeader = req.header("x-api-key") ?? "";
  const presented = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : apiKeyHeader.trim();
  const serverKey = process.env.API_KEY ?? "";
  if (!serverKey || presented !== serverKey) {
    res.status(403).json({ error: "operator_key_required" });
    return;
  }

  const batchSize = Number.parseInt(String(req.body?.batch_size ?? 5), 10);
  try {
    const result = await runComparisonPagesBuilder(
      Number.isFinite(batchSize) && batchSize > 0 ? Math.min(batchSize, 20) : 5,
    );
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: "builder_failed", detail: String(err) });
  }
});
