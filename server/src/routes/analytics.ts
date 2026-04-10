import { Router } from "express";
import type { Request, Response } from "express";
import { requireSlugApiKey, requireApiKey } from "../middleware/auth.js";
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

    // ── Daily counts for last 30 days ──
    const last30Days = db
      .prepare(
        `SELECT DATE(timestamp) AS date, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
           AND timestamp >= DATE('now', '-29 days')
         GROUP BY DATE(timestamp)
         ORDER BY date ASC`
      )
      .all(slug) as { date: string; count: number }[];

    // ── Referral clicks in last 30 days ──
    const { clicks30 } = db
      .prepare(
        `SELECT COUNT(*) AS clicks30 FROM click_events
         WHERE business_slug = ? AND timestamp >= DATE('now', '-29 days')`
      )
      .get(slug) as { clicks30: number };

    // ── Activity by day-of-week and hour (UTC) ──
    const dowHourRows = db
      .prepare(
        `SELECT CAST(strftime('%w', timestamp) AS INTEGER) AS dow,
                CAST(strftime('%H', timestamp) AS INTEGER) AS hour,
                COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
         GROUP BY dow, hour`
      )
      .all(slug) as { dow: number; hour: number; count: number }[];

    // ── 50 most recent queries ──
    const recentQueries = db
      .prepare(
        `SELECT id, crawler_agent, query_text, response_text, referral_clicked, timestamp, intent
         FROM queries
         WHERE business_slug = ?
         ORDER BY timestamp DESC
         LIMIT 50`
      )
      .all(slug) as Omit<QueryRow, "business_slug">[];

    // ── Referral click count (from deduplicated click_events log) ──
    const { clicks: referralClicks } = db
      .prepare(
        `SELECT COUNT(*) AS clicks FROM click_events WHERE business_slug = ?`
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
      referral_clicks_last_30_days: clicks30,
      queries_by_crawler: queriesByCrawler,
      queries_by_intent: queriesByIntent,
      top_queries: topQueries,
      queries_last_30_days: last30Days,
      activity_by_dow_hour: dowHourRows,
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
analyticsRouter.get("/analytics", requireApiKey, (_req: Request, res: Response) => {
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
    .prepare("SELECT COUNT(*) AS total_referral_clicks FROM click_events")
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
 * Called by the Cloudflare Worker /track endpoint after confirming the
 * request came from a non-bot User-Agent. Logs a rich click event row.
 *
 * Body:
 *   ref?         : string  — bot name that generated the response
 *   user_agent?  : string  — human visitor UA
 *   ip_hash?     : string  — SHA-256(IP) for deduplication
 *   destination? : string  — URL the visitor was redirected to (Session 1)
 *   query_id?    : number  — queries.id that generated this token (Session 1)
 *   legacy?      : 0 | 1  — 1 if token was cleartext (Session 1 fallback path)
 */
analyticsRouter.post(
  "/analytics/:slug/referral-click",
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const { ref, user_agent, ip_hash, destination, query_id, legacy } = (req.body ?? {}) as {
      ref?: string;
      user_agent?: string;
      ip_hash?: string;
      destination?: string;
      query_id?: number;
      legacy?: 0 | 1;
    };
    const db = getDb();

    // Cross-tenant guard: if query_id is provided, verify the query row
    // belongs to this slug before touching anything. Rejects forged
    // slug+query_id combinations without leaking whether the row exists
    // under a different slug.
    if (query_id !== undefined) {
      const qRow = db
        .prepare("SELECT business_slug FROM queries WHERE id = ?")
        .get(query_id) as { business_slug: string } | undefined;

      if (!qRow || qRow.business_slug !== slug) {
        res.status(400).json({ error: "query_id does not belong to this slug" });
        return;
      }
    }

    // Transactional: INSERT click + UPDATE referral_clicked atomically so
    // analytics counts are always consistent even if the process crashes
    // between the two writes.
    const transaction = db.transaction(() => {
      db.prepare(
        `INSERT INTO click_events (business_slug, ref, user_agent, ip_hash, destination, query_id, legacy)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        slug,
        ref ?? null,
        user_agent ?? null,
        ip_hash ?? null,
        destination ?? null,
        query_id ?? null,
        legacy ?? 0
      );

      if (query_id !== undefined) {
        db.prepare(
          "UPDATE queries SET referral_clicked = 1 WHERE id = ? AND business_slug = ?"
        ).run(query_id, slug);
      }
    });

    transaction();
    res.json({ ok: true });
  }
);

/**
 * GET /analytics/:slug/clicks
 *
 * Returns the 50 most recent referral click events for a business.
 * Requires Authorization: Bearer <api_key> for the slug.
 */
analyticsRouter.get(
  "/analytics/:slug/clicks",
  requireSlugApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const db = getDb();

    const clicks = db
      .prepare(
        `SELECT id, ref, user_agent, timestamp
         FROM click_events
         WHERE business_slug = ?
         ORDER BY timestamp DESC
         LIMIT 50`
      )
      .all(slug) as Array<{
        id: number;
        ref: string | null;
        user_agent: string | null;
        timestamp: string;
      }>;

    res.json({ slug, clicks });
  }
);
