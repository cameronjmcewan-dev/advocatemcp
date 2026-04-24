/**
 * Pure SQL helpers that feed the Phase 2 internal dashboard.
 *
 * Every function takes a Database and returns plain data — no HTTP, no
 * rendering. The dashboard route composes them.
 *
 * Read-only. All queries hit indexes added in migration 020 where
 * possible (idx_queries_industry_ts, idx_queries_intent_v2_ts,
 * idx_queries_geo_region). Keep window clauses parameterized so Phase 3
 * (customer-facing) can reuse the same helpers with a tenant scope.
 *
 * Vision doc reminder: "Internal before external." The output shape
 * should be easy to read and not pre-packaged for a public API yet.
 */

import type { Database } from "better-sqlite3";

// ── Types ─────────────────────────────────────────────────────────────────

export interface OverviewStats {
  total_queries: number;
  queries_last_7d: number;
  queries_last_30d: number;
  unique_tenants_active_30d: number;
  total_cost_cents_30d: number;
  queries_with_intent_v2: number;
  queries_with_geo: number;
  queries_with_industry: number;
  top_crawler: { name: string; count: number } | null;
  top_model: { name: string; count: number } | null;
}

export interface TopQuery {
  query_text: string;
  count: number;
  intent_v2: string | null;
  unique_tenants: number;
  last_seen: string;
}

export interface ProfileGap {
  slug: string;
  name: string;
  category: string | null;
  industry_code: string | null;
  total_queries_30d: number;
  top_missing_intent: string | null;
  missing_count: number;
  missing_field: string | null;
}

export interface IndustryTrend {
  industry_code: string;
  day: string;                 // YYYY-MM-DD (UTC)
  query_count: number;
  unique_tenants: number;
  avg_cost_cents: number;
}

// ── Overview ──────────────────────────────────────────────────────────────

export function overviewStats(db: Database): OverviewStats {
  const totalQ = (db.prepare(`SELECT COUNT(*) AS n FROM queries`).get() as { n: number }).n;

  const q7 = (db.prepare(
    `SELECT COUNT(*) AS n FROM queries WHERE timestamp >= datetime('now', '-7 days')`
  ).get() as { n: number }).n;

  const q30 = (db.prepare(
    `SELECT COUNT(*) AS n FROM queries WHERE timestamp >= datetime('now', '-30 days')`
  ).get() as { n: number }).n;

  const uniqueTenants = (db.prepare(
    `SELECT COUNT(DISTINCT business_slug) AS n FROM queries
      WHERE timestamp >= datetime('now', '-30 days')`
  ).get() as { n: number }).n;

  const cost = (db.prepare(
    `SELECT COALESCE(SUM(cost_cents), 0) AS n FROM queries
      WHERE timestamp >= datetime('now', '-30 days')`
  ).get() as { n: number }).n;

  const intentV2 = (db.prepare(
    `SELECT COUNT(*) AS n FROM queries WHERE intent_v2 IS NOT NULL`
  ).get() as { n: number }).n;

  const geo = (db.prepare(
    `SELECT COUNT(*) AS n FROM queries WHERE geo_country IS NOT NULL`
  ).get() as { n: number }).n;

  const industry = (db.prepare(
    `SELECT COUNT(*) AS n FROM queries WHERE industry_code IS NOT NULL`
  ).get() as { n: number }).n;

  const topCrawler = db.prepare(
    `SELECT crawler_agent AS name, COUNT(*) AS count
       FROM queries
      WHERE crawler_agent IS NOT NULL
        AND timestamp >= datetime('now', '-30 days')
      GROUP BY crawler_agent
      ORDER BY count DESC
      LIMIT 1`
  ).get() as { name: string; count: number } | undefined;

  const topModel = db.prepare(
    `SELECT model AS name, COUNT(*) AS count
       FROM queries
      WHERE model IS NOT NULL
        AND timestamp >= datetime('now', '-30 days')
      GROUP BY model
      ORDER BY count DESC
      LIMIT 1`
  ).get() as { name: string; count: number } | undefined;

  return {
    total_queries:             totalQ,
    queries_last_7d:           q7,
    queries_last_30d:          q30,
    unique_tenants_active_30d: uniqueTenants,
    total_cost_cents_30d:      cost,
    queries_with_intent_v2:    intentV2,
    queries_with_geo:          geo,
    queries_with_industry:     industry,
    top_crawler:               topCrawler ?? null,
    top_model:                 topModel ?? null,
  };
}

// ── Top queries by volume ────────────────────────────────────────────────
//
// Group by normalized query_text (lower-case, collapsed whitespace). SQLite
// doesn't have REGEXP_REPLACE natively, but the common case is handled by
// LOWER() + TRIM(). The Haiku classifier normalises reasonably — raw
// unchanged query_text is fine for v1.

export function topQueries(db: Database, opts?: { limit?: number; days?: number }): TopQuery[] {
  const limit = opts?.limit ?? 25;
  const days  = opts?.days  ?? 30;

  return db.prepare(
    `SELECT
       LOWER(TRIM(query_text))                AS query_text,
       COUNT(*)                                AS count,
       MAX(intent_v2)                          AS intent_v2,
       COUNT(DISTINCT business_slug)           AS unique_tenants,
       MAX(timestamp)                          AS last_seen
     FROM queries
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
      AND query_text IS NOT NULL
      AND LENGTH(TRIM(query_text)) > 0
    GROUP BY LOWER(TRIM(query_text))
    ORDER BY count DESC, last_seen DESC
    LIMIT ?`
  ).all(days, limit) as TopQuery[];
}

// ── Profile-gap analysis ──────────────────────────────────────────────────
//
// For each tenant active in the last 30 days, identify the intent_v2 that
// got asked most AND for which the tenant's profile field is empty.
//
// intent_v2 → profile field map:
//   pricing  → pricing OR pricing_json_v2
//   hours    → hours_json OR availability
//   location → location OR service_area_keywords
//   contact  → phone OR referral_url
//   service  → services OR top_services
//   reviews  → star_rating OR review_count
//
// Others (brand, emergency, comparison, research, other) aren't tied to a
// single profile field — surfacing those as gaps would be noise.

const GAP_MAP: Record<string, { cols: string[]; label: string }> = {
  pricing:  { cols: ["pricing", "pricing_json_v2"],         label: "pricing / pricing_json_v2" },
  hours:    { cols: ["hours_json", "availability"],         label: "hours_json / availability" },
  location: { cols: ["location", "service_area_keywords"],  label: "location / service_area_keywords" },
  contact:  { cols: ["phone", "referral_url"],              label: "phone / referral_url" },
  service:  { cols: ["services", "top_services"],           label: "services / top_services" },
  reviews:  { cols: ["star_rating", "review_count"],        label: "star_rating / review_count" },
};

function profileFieldsMissing(biz: Record<string, unknown>, cols: string[]): boolean {
  return cols.every((c) => {
    const v = biz[c];
    if (v == null) return true;
    if (typeof v === "string" && v.trim() === "") return true;
    if (typeof v === "number" && v === 0) return true;
    return false;
  });
}

export function profileGaps(db: Database, opts?: { limit?: number }): ProfileGap[] {
  const limit = opts?.limit ?? 20;

  // Pull each tenant's intent_v2 distribution over the last 30 days,
  // joined with their full profile row so we can check field population
  // in JS.
  const rows = db.prepare(
    `SELECT
       b.slug           AS slug,
       b.name           AS name,
       b.category       AS category,
       q.industry_code  AS industry_code,
       q.intent_v2      AS intent_v2,
       COUNT(*)         AS n,
       b.*
     FROM queries q
     JOIN businesses b ON b.slug = q.business_slug
    WHERE q.timestamp >= datetime('now', '-30 days')
      AND q.intent_v2 IS NOT NULL
    GROUP BY b.slug, q.intent_v2`
  ).all() as Array<Record<string, unknown> & {
    slug: string; name: string; category: string | null;
    industry_code: string | null; intent_v2: string; n: number;
  }>;

  // Bucket by tenant.
  type Bucket = { slug: string; name: string; category: string | null; industry: string | null; intents: Map<string, number>; biz: Record<string, unknown> };
  const byTenant = new Map<string, Bucket>();
  for (const r of rows) {
    if (!byTenant.has(r.slug)) {
      byTenant.set(r.slug, {
        slug: r.slug,
        name: r.name,
        category: r.category,
        industry: r.industry_code,
        intents: new Map(),
        biz: r,
      });
    }
    byTenant.get(r.slug)!.intents.set(r.intent_v2, r.n);
  }

  // For each tenant, find the intent with the largest count that maps to
  // an empty profile field. That's the gap.
  const gaps: ProfileGap[] = [];
  for (const t of byTenant.values()) {
    const totalQ = Array.from(t.intents.values()).reduce((s, n) => s + n, 0);
    const sorted = Array.from(t.intents.entries())
      .filter(([intent]) => intent in GAP_MAP)
      .sort((a, b) => b[1] - a[1]);

    let topIntent: string | null = null;
    let topCount = 0;
    let missingLabel: string | null = null;
    for (const [intent, n] of sorted) {
      const spec = GAP_MAP[intent];
      if (profileFieldsMissing(t.biz, spec.cols)) {
        topIntent = intent;
        topCount = n;
        missingLabel = spec.label;
        break;
      }
    }

    // Skip tenants with no actual gap — they're doing fine.
    if (!topIntent) continue;

    gaps.push({
      slug:               t.slug,
      name:               t.name,
      category:           t.category,
      industry_code:      t.industry,
      total_queries_30d:  totalQ,
      top_missing_intent: topIntent,
      missing_count:      topCount,
      missing_field:      missingLabel,
    });
  }

  return gaps.sort((a, b) => b.missing_count - a.missing_count).slice(0, limit);
}

// ── Industry time-series ──────────────────────────────────────────────────
//
// 30-day window, one row per (industry_code, day). Used for the stacked bar
// chart in the internal dashboard — which industries are trending.

export function trendsByIndustry(db: Database, opts?: { days?: number }): IndustryTrend[] {
  const days = opts?.days ?? 30;

  return db.prepare(
    `SELECT
       COALESCE(industry_code, 'unknown') AS industry_code,
       DATE(timestamp)                    AS day,
       COUNT(*)                           AS query_count,
       COUNT(DISTINCT business_slug)      AS unique_tenants,
       CAST(ROUND(COALESCE(AVG(cost_cents), 0)) AS INTEGER) AS avg_cost_cents
     FROM queries
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY industry_code, DATE(timestamp)
    ORDER BY day DESC, query_count DESC`
  ).all(days) as IndustryTrend[];
}
