import { Router } from "express";
import type { Request, Response } from "express";
import { requireSlugApiKey } from "../middleware/auth.js";
import { getDb, type QueryRow } from "../db.js";

export const analyticsRouter = Router();

/**
 * GET /analytics/:slug
 *
 * Requires `Authorization: Bearer <api_key>` matching the slug's business.
 *
 * Returns aggregate stats + recent queries for the business.
 */
analyticsRouter.get(
  "/analytics/:slug",
  requireSlugApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const db = getDb();

    // ── Total query count ──
    const { count: totalQueries } = db
      .prepare("SELECT COUNT(*) AS count FROM queries WHERE business_slug = ?")
      .get(slug) as { count: number };

    // ── Breakdown by crawler ──
    const crawlerRows = db
      .prepare(
        `SELECT COALESCE(crawler_agent, 'unknown') AS crawler, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
         GROUP BY crawler_agent
         ORDER BY count DESC`
      )
      .all(slug) as { crawler: string; count: number }[];

    const queriesByCrawler: Record<string, number> = {};
    for (const row of crawlerRows) {
      queriesByCrawler[row.crawler] = row.count;
    }

    // ── Top queries by frequency ──
    const topQueryRows = db
      .prepare(
        `SELECT query_text, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
         GROUP BY query_text
         ORDER BY count DESC
         LIMIT 10`
      )
      .all(slug) as { query_text: string; count: number }[];

    const topQueries = topQueryRows.map((r) => r.query_text);

    // ── Daily counts for last 7 days ──
    const last7Days = db
      .prepare(
        `SELECT DATE(timestamp) AS date, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
           AND timestamp >= DATE('now', '-6 days')
         GROUP BY DATE(timestamp)
         ORDER BY date ASC`
      )
      .all(slug) as { date: string; count: number }[];

    // ── 10 most recent queries ──
    const recentQueries = db
      .prepare(
        `SELECT id, crawler_agent, query_text, response_text, referral_clicked, timestamp
         FROM queries
         WHERE business_slug = ?
         ORDER BY timestamp DESC
         LIMIT 10`
      )
      .all(slug) as Omit<QueryRow, "business_slug">[];

    // ── Referral click count ──
    const { clicks: referralClicks } = db
      .prepare(
        `SELECT COALESCE(SUM(referral_clicked), 0) AS clicks
         FROM queries
         WHERE business_slug = ?`
      )
      .get(slug) as { clicks: number };

    // ── Breakdown by intent ──
    const intentRows = db
      .prepare(
        `SELECT COALESCE(intent, 'unknown') AS intent, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
         GROUP BY COALESCE(intent, 'unknown')
         ORDER BY count DESC`
      )
      .all(slug) as { intent: string; count: number }[];

    const queriesByIntent: Record<string, number> = {};
    for (const row of intentRows) {
      queriesByIntent[row.intent] = row.count;
    }

    res.json({
      slug,
      total_queries: totalQueries,
      referral_clicks: referralClicks,
      queries_by_crawler: queriesByCrawler,
      queries_by_intent: queriesByIntent,
      top_queries: topQueries,
      queries_last_7_days: last7Days,
      recent_queries: recentQueries,
    });
  }
);

/**
 * GET /analytics
 *
 * Global feed — last 50 crawler hits across all businesses.
 * No auth required (query text and business name are non-sensitive).
 */
analyticsRouter.get("/analytics", (_req: Request, res: Response) => {
  const db = getDb();

  const hits = db
    .prepare(
      `SELECT q.id, q.business_slug, b.name AS business_name,
              q.crawler_agent, q.query_text, q.intent,
              q.referral_clicked, q.timestamp
       FROM queries q
       LEFT JOIN businesses b ON b.slug = q.business_slug
       ORDER BY q.timestamp DESC
       LIMIT 50`
    )
    .all() as Array<{
      id: number;
      business_slug: string;
      business_name: string | null;
      crawler_agent: string | null;
      query_text: string;
      intent: string | null;
      referral_clicked: number;
      timestamp: string;
    }>;

  const { total_queries } = db
    .prepare("SELECT COUNT(*) AS total_queries FROM queries")
    .get() as { total_queries: number };

  const { total_referral_clicks } = db
    .prepare("SELECT COALESCE(SUM(referral_clicked),0) AS total_referral_clicks FROM queries")
    .get() as { total_referral_clicks: number };

  const crawlerRows = db
    .prepare(
      `SELECT COALESCE(crawler_agent,'unknown') AS crawler, COUNT(*) AS count
       FROM queries GROUP BY crawler_agent ORDER BY count DESC`
    )
    .all() as { crawler: string; count: number }[];

  const queries_by_crawler: Record<string, number> = {};
  for (const r of crawlerRows) queries_by_crawler[r.crawler] = r.count;

  res.json({ total_queries, total_referral_clicks, queries_by_crawler, recent_hits: hits });
});

/**
 * POST /analytics/:slug/referral-click
 *
 * Called by the Cloudflare Worker (or any client) when a user actually
 * follows the referral link. Increments `referral_clicked` on the latest
 * query for this session (best-effort; takes the most recent query).
 */
analyticsRouter.post(
  "/analytics/:slug/referral-click",
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const db = getDb();

    const latest = db
      .prepare(
        `SELECT id FROM queries
         WHERE business_slug = ?
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get(slug) as { id: number } | undefined;

    if (!latest) {
      res.status(404).json({ error: "No queries found for this slug" });
      return;
    }

    db.prepare(
      "UPDATE queries SET referral_clicked = 1 WHERE id = ?"
    ).run(latest.id);

    res.json({ ok: true, query_id: latest.id });
  }
);
