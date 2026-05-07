// Business logic for GET /api/client/traffic-impact.
// Extracted from portal.ts so it can be unit-tested without HTTP plumbing.

import type { Env } from "../types";
import type { Business } from "../portalDb";

export interface DailyRow {
  date:        string;
  ai:          number;
  human:       number;
  total:       number;
  top_sources: unknown;
  // Engagement metrics — tenant-wide per day (GA4 does not split these by
  // source classification; null when the column has not been populated yet).
  engagement_rate:           number | null;
  avg_session_duration_sec:  number | null;
  bounce_rate:               number | null;
  new_users:                 number;
  returning_users:           number;
}

export interface TrafficImpactPayload {
  slug:          string;
  bleed_at:      string | null;
  ga4_connected: boolean;
  daily:         DailyRow[];
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return []; }
}

/**
 * Build the traffic-impact JSON payload for a given business and URL.
 * Auth + business-resolution happen in portal.ts; this function only
 * does the D1 queries and date-window math.
 *
 * Date-window precedence:
 *   1. start_date + end_date query params (explicit range)
 *   2. range=Nd — last N calendar days
 *   3. No params → return all rows (default)
 */
export async function trafficImpactPayload(
  env: Env,
  biz: Business,
  url: URL,
): Promise<TrafficImpactPayload> {
  const range    = url.searchParams.get("range");
  const startQs  = url.searchParams.get("start_date");
  const endQs    = url.searchParams.get("end_date");

  let dateFilterSql  = "";
  let dateFilterArgs: string[] = [];

  if (startQs && endQs) {
    dateFilterSql  = " AND date >= ? AND date <= ?";
    dateFilterArgs = [startQs, endQs];
  } else if (range && /^\d+d$/.test(range)) {
    const days   = parseInt(range, 10);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    dateFilterSql  = " AND date >= ?";
    dateFilterArgs = [cutoff];
  }
  // else: no date filter → all rows

  const result = await env.DB
    .prepare(
      `SELECT date, ai_sessions, human_sessions, total_sessions, top_sources_json,
              engagement_rate, avg_session_duration_sec, bounce_rate,
              new_users, returning_users
         FROM traffic_daily
        WHERE slug = ?${dateFilterSql}
        ORDER BY date ASC`,
    )
    .bind(biz.slug, ...dateFilterArgs)
    .all<{
      date:                      string;
      ai_sessions:               number;
      human_sessions:            number;
      total_sessions:            number;
      top_sources_json:          string | null;
      engagement_rate:           number | null;
      avg_session_duration_sec:  number | null;
      bounce_rate:               number | null;
      new_users:                 number;
      returning_users:           number;
    }>();

  const daily: DailyRow[] = (result.results ?? []).map((r) => ({
    date:                     r.date,
    ai:                       r.ai_sessions,
    human:                    r.human_sessions,
    total:                    r.total_sessions,
    top_sources:              r.top_sources_json ? safeParseJson(r.top_sources_json) : [],
    engagement_rate:          r.engagement_rate          ?? null,
    avg_session_duration_sec: r.avg_session_duration_sec ?? null,
    bounce_rate:              r.bounce_rate              ?? null,
    new_users:                r.new_users                ?? 0,
    returning_users:          r.returning_users          ?? 0,
  }));

  const conn = await env.DB
    .prepare("SELECT 1 FROM ga4_connections WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{ 1: number }>();

  return {
    slug:          biz.slug,
    bleed_at:      biz.created_at ?? null,
    ga4_connected: !!conn,
    daily,
  };
}
