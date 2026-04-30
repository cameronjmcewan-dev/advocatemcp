import { Router } from "express";
import type { Request, Response } from "express";
// AMC-004: GET /analytics (no slug param) is admin-only — gated with
// requireServerKeyOnly so a leaked tenant Bearer can't dump the global
// crawler feed. /analytics/:slug stays on requireSlugApiKey (slug-bound).
import { requireSlugApiKey, requireServerKeyOnly } from "../middleware/auth.js";
import { getDb, type QueryRow } from "../db.js";
import { findByRequestId, setOutcome } from "../repos/agentRequests.js";
import { parseDateRange, sqlBounds, type DateRange } from "../lib/dateRange.js";

export const analyticsRouter = Router();

/** Wrap parseDateRange with a 400-on-error response. Used by every
 *  analytics endpoint that supports the global date range filter. */
function parseRangeOr400(req: Request, res: Response): DateRange | null {
  try {
    return parseDateRange(req.query as Record<string, unknown>);
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: string }).code === "invalid_date_range") {
      res.status(400).json({ error: e.message });
    } else {
      res.status(400).json({ error: "invalid_date_range" });
    }
    return null;
  }
}

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

    // Phase A: every aggregate now respects the global date range filter.
    // Range comes from ?start_date=&end_date= or ?range=7d|30d|90d|365d.
    // Default = last 30 days (preserves pre-Phase-A behavior).
    const range = parseRangeOr400(req, res);
    if (!range) return;
    const { startSql, endSql } = sqlBounds(range);

    // Lifetime totals (NOT date-bounded — these are headline KPIs the
    // dashboard renders at the top of the page).
    const { count: totalQueries } = db
      .prepare("SELECT COUNT(*) AS count FROM queries WHERE business_slug = ?")
      .get(slug) as { count: number };

    // ── Breakdown by crawler (within range) ──
    const crawlerRows = db
      .prepare(
        `SELECT COALESCE(crawler_agent, 'unknown') AS crawler, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
           AND timestamp >= ? AND timestamp <= ?
         GROUP BY crawler_agent
         ORDER BY count DESC`
      )
      .all(slug, startSql, endSql) as { crawler: string; count: number }[];

    const queriesByCrawler: Record<string, number> = {};
    for (const row of crawlerRows) {
      queriesByCrawler[row.crawler] = row.count;
    }

    // ── Top queries by frequency (within range) ──
    const topQueryRows = db
      .prepare(
        `SELECT query_text, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
           AND timestamp >= ? AND timestamp <= ?
         GROUP BY query_text
         ORDER BY count DESC
         LIMIT 10`
      )
      .all(slug, startSql, endSql) as { query_text: string; count: number }[];

    const topQueries = topQueryRows.map((r) => r.query_text);

    // ── Daily counts (within range) ──
    // The result key stays `queries_last_30_days` for backwards compat with
    // the existing client; consumers that key on the date array shape (not
    // the count) keep working.
    const queriesInRange = db
      .prepare(
        `SELECT DATE(timestamp) AS date, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
           AND timestamp >= ? AND timestamp <= ?
         GROUP BY DATE(timestamp)
         ORDER BY date ASC`
      )
      .all(slug, startSql, endSql) as { date: string; count: number }[];

    // ── Referral clicks within range ──
    const { clicksInRange } = db
      .prepare(
        `SELECT COUNT(*) AS clicksInRange FROM click_events
         WHERE business_slug = ?
           AND timestamp >= ? AND timestamp <= ?`
      )
      .get(slug, startSql, endSql) as { clicksInRange: number };

    // ── Activity by day-of-week and hour (within range) ──
    const dowHourRows = db
      .prepare(
        `SELECT CAST(strftime('%w', timestamp) AS INTEGER) AS dow,
                CAST(strftime('%H', timestamp) AS INTEGER) AS hour,
                COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
           AND timestamp >= ? AND timestamp <= ?
         GROUP BY dow, hour`
      )
      .all(slug, startSql, endSql) as { dow: number; hour: number; count: number }[];

    // ── 50 most recent queries (within range) ──
    const recentQueries = db
      .prepare(
        `SELECT id, crawler_agent, query_text, response_text, referral_clicked, timestamp, intent
         FROM queries
         WHERE business_slug = ?
           AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp DESC
         LIMIT 50`
      )
      .all(slug, startSql, endSql) as Omit<QueryRow, "business_slug">[];

    // ── Referral click count (lifetime) ──
    const { clicks: referralClicks } = db
      .prepare(
        `SELECT COUNT(*) AS clicks FROM click_events WHERE business_slug = ?`
      )
      .get(slug) as { clicks: number };

    // ── Breakdown by intent (within range) ──
    const intentRows = db
      .prepare(
        `SELECT COALESCE(intent, 'unknown') AS intent, COUNT(*) AS count
         FROM queries
         WHERE business_slug = ?
           AND timestamp >= ? AND timestamp <= ?
         GROUP BY COALESCE(intent, 'unknown')
         ORDER BY count DESC`
      )
      .all(slug, startSql, endSql) as { intent: string; count: number }[];

    const queriesByIntent: Record<string, number> = {};
    for (const row of intentRows) {
      queriesByIntent[row.intent] = row.count;
    }

    res.json({
      slug,
      // Range echo so the client can confirm what it asked for + render the
      // selected pill state on the picker without a second source of truth.
      date_range: { start: range.start, end: range.end, days: range.days },
      total_queries: totalQueries,                  // lifetime
      referral_clicks: referralClicks,              // lifetime
      // Field name preserved for backward compat — the value is now the
      // bounded count, not always-30-day. Documented at the consumer.
      referral_clicks_last_30_days: clicksInRange,
      queries_by_crawler: queriesByCrawler,
      queries_by_intent: queriesByIntent,
      top_queries: topQueries,
      queries_last_30_days: queriesInRange,         // see field-name note above
      activity_by_dow_hour: dowHourRows,
      recent_queries: recentQueries,
    });
  }
);

/**
 * GET /analytics
 *
 * Global feed — last N crawler hits across all businesses.
 * Admin-only via `requireServerKeyOnly` (X-API-Key: <SERVER_API_KEY>).
 * Optional `?limit=N` query param (default 50, capped at 500).
 */
analyticsRouter.get("/analytics", requireServerKeyOnly, (req: Request, res: Response) => {
  const db = getDb();

  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 50;

  const hits = db
    .prepare(
      `SELECT q.id, q.business_slug, b.name AS business_name,
              q.crawler_agent, q.query_text, q.intent,
              q.referral_clicked, q.timestamp
       FROM queries q
       LEFT JOIN businesses b ON b.slug = q.business_slug
       ORDER BY q.timestamp DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
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
    const { ref, user_agent, ip_hash, destination, query_id, legacy, agent_id, request_id } = (req.body ?? {}) as {
      ref?: string;
      user_agent?: string;
      ip_hash?: string;
      destination?: string;
      query_id?: number;
      legacy?: 0 | 1;
      agent_id?: string;
      request_id?: string;
    };
    const db = getDb();

    // Cross-tenant guard: if query_id is provided, verify the query row
    // belongs to this slug before touching anything. Rejects forged
    // slug+query_id combinations without leaking whether the row exists
    // under a different slug.
    //
    // Session 11.5: same lookup hydrates agent_id + request_id from the
    // queries row when the worker didn't carry them in the body. Body
    // values still win (the worker is closer to the actual click event)
    // — the queries row is a fallback, not an override.
    let derivedAgentId: string | null = null;
    let derivedRequestId: string | null = null;
    if (query_id !== undefined) {
      const qRow = db
        .prepare(
          "SELECT business_slug, agent_id, request_id FROM queries WHERE id = ?",
        )
        .get(query_id) as
        | { business_slug: string; agent_id: string | null; request_id: string | null }
        | undefined;

      if (!qRow || qRow.business_slug !== slug) {
        res.status(400).json({ error: "query_id does not belong to this slug" });
        return;
      }
      derivedAgentId = qRow.agent_id;
      derivedRequestId = qRow.request_id;
    }
    const effectiveAgentId = agent_id ?? derivedAgentId;
    const effectiveRequestId = request_id ?? derivedRequestId;

    // Transactional: INSERT click + UPDATE referral_clicked atomically so
    // analytics counts are always consistent even if the process crashes
    // between the two writes.
    const transaction = db.transaction(() => {
      db.prepare(
        `INSERT INTO click_events (business_slug, ref, user_agent, ip_hash, destination, query_id, legacy, agent_id, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        slug,
        ref ?? null,
        user_agent ?? null,
        ip_hash ?? null,
        destination ?? null,
        query_id ?? null,
        legacy ?? 0,
        effectiveAgentId,
        effectiveRequestId
      );

      if (query_id !== undefined) {
        db.prepare(
          "UPDATE queries SET referral_clicked = 1 WHERE id = ? AND business_slug = ?"
        ).run(query_id, slug);
      }

      // Backfill: if the click can be tied back to a known MCP tool call,
      // promote that audit row's outcome to 'click'. Best-effort — anonymous
      // clicks (no matching agent_requests row) are fine.
      if (effectiveRequestId) {
        const ar = findByRequestId(db, effectiveRequestId);
        if (ar) setOutcome(db, { id: ar.id, outcomeSignal: "click" });
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

/**
 * GET /analytics/:slug/activity
 *
 * Returns the new-feature data for a business:
 *   - reservations (Session 9)
 *   - handoffs (Session 9)
 *   - agent_requests (Session 11, identified-agent MCP tool calls)
 *   - competitor_radar (Session 4, Pro tenants only)
 *
 * Requires Authorization: Bearer <api_key> for the slug.
 */
analyticsRouter.get(
  "/analytics/:slug/activity",
  requireSlugApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const db = getDb();

    // Phase A: same date-range filter as /analytics/:slug. The "recent N"
    // lists (last 20 reservations / handoffs / agent_requests) are now
    // bounded by the date range too — combined with the LIMIT, they give
    // "the last 20 within the selected window" rather than always the
    // 20 most recent absolutely.
    const range = parseRangeOr400(req, res);
    if (!range) return;
    const { startSql, endSql } = sqlBounds(range);

    // Reservations — last 20 within range. Timestamps are INTEGER unix
    // seconds in the schema (migration 006); convert to ISO strings so the
    // dashboard can `new Date(iso)` without special-casing. Date-bound
    // requested_at since that's the column the existing index covers
    // (idx_reservations_business_requested).
    const reservations = db
      .prepare(
        `SELECT id, agent_id, status,
                datetime(window_start, 'unixepoch') AS window_start,
                datetime(window_end,   'unixepoch') AS window_end,
                datetime(requested_at, 'unixepoch') AS requested_at,
                datetime(expires_at,   'unixepoch') AS expires_at
         FROM reservations
         WHERE business_slug = ?
           AND requested_at >= strftime('%s', ?)
           AND requested_at <= strftime('%s', ?)
         ORDER BY requested_at DESC
         LIMIT 20`,
      )
      .all(slug, startSql, endSql) as Array<{
        id: string;
        agent_id: string | null;
        status: string;
        window_start: string;
        window_end: string;
        requested_at: string;
        expires_at: string;
      }>;

    // Handoffs — last 20 within range. Same timestamp treatment as reservations.
    const handoffs = db
      .prepare(
        `SELECT id, mode, delivered_via, reservation_id, agent_id,
                datetime(created_at, 'unixepoch') AS created_at
         FROM handoffs
         WHERE business_slug = ?
           AND created_at >= strftime('%s', ?)
           AND created_at <= strftime('%s', ?)
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(slug, startSql, endSql) as Array<{
        id: string;
        mode: string;
        delivered_via: string | null;
        reservation_id: string | null;
        agent_id: string | null;
        created_at: string;
      }>;

    // Agent requests — last 30 identified-agent MCP tool calls within range.
    const agent_requests = db
      .prepare(
        `SELECT id, tool_called, agent_id, agent_id_source, outcome_signal,
                latency_ms, cost_cents, timestamp
         FROM agent_requests
         WHERE business_slug = ?
           AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp DESC
         LIMIT 30`,
      )
      .all(slug, startSql, endSql) as Array<{
        id: number;
        tool_called: string;
        agent_id: string;
        agent_id_source: string;
        outcome_signal: string;
        latency_ms: number | null;
        cost_cents: number | null;
        timestamp: string;
      }>;

    // Agent reputation for agents who hit this business
    const agent_reputation = db
      .prepare(
        `SELECT ar.agent_id, ar.window, ar.requests, ar.reservations_confirmed,
                ar.conversion_rate, ar.quality_score, ar.updated_at
         FROM agent_reputation ar
         WHERE ar.agent_id IN (
           SELECT DISTINCT agent_id FROM agent_requests WHERE business_slug = ?
         )
         ORDER BY ar.window, ar.quality_score DESC`,
      )
      .all(slug) as Array<{
        agent_id: string;
        window: string;
        requests: number;
        reservations_confirmed: number;
        conversion_rate: number;
        quality_score: number;
        updated_at: string;
      }>;

    // Competitor radar — last 10 polls (Pro tenants). Schema from
    // migration 013: the table keys on `slug` (not business_slug), and
    // the cited flag is `our_domain_cited`. `citation_count` is the total
    // citations in that poll; `our_domain_cited` is the boolean "were we
    // one of them?". Normalize field names to the shape the dashboard
    // already renders (query_phrasing, tenant_cited, citation_count).
    const competitor_polls = db
      .prepare(
        `SELECT id,
                phrasing AS query_phrasing,
                polled_at,
                our_domain_cited AS tenant_cited,
                citation_count
         FROM competitor_polls
         WHERE slug = ?
           AND polled_at >= ? AND polled_at <= ?
         ORDER BY polled_at DESC
         LIMIT 10`,
      )
      .all(slug, startSql, endSql) as Array<{
        id: number;
        query_phrasing: string;
        polled_at: string;
        tenant_cited: number;
        citation_count: number;
      }>;

    // Summary totals
    const reservation_totals = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END) AS held,
           SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
           SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
           COUNT(*) AS total
         FROM reservations WHERE business_slug = ?`,
      )
      .get(slug) as { held: number; confirmed: number; expired: number; total: number };

    const handoff_totals = db
      .prepare(
        `SELECT
           SUM(CASE WHEN mode = 'human' THEN 1 ELSE 0 END) AS human,
           SUM(CASE WHEN mode = 'agent' THEN 1 ELSE 0 END) AS agent,
           COUNT(*) AS total
         FROM handoffs WHERE business_slug = ?`,
      )
      .get(slug) as { human: number; agent: number; total: number };

    const agent_request_totals = db
      .prepare(
        `SELECT
           COUNT(DISTINCT agent_id) AS unique_agents,
           COUNT(*) AS total_calls
         FROM agent_requests WHERE business_slug = ?`,
      )
      .get(slug) as { unique_agents: number; total_calls: number };

    res.json({
      slug,
      date_range: { start: range.start, end: range.end, days: range.days },
      reservations,
      handoffs,
      agent_requests,
      agent_reputation,
      competitor_polls,
      totals: {
        reservations: reservation_totals,
        handoffs: handoff_totals,
        agent_requests: agent_request_totals,
      },
    });
  },
);
