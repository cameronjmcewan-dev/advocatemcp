/**
 * Per-tenant GA4 traffic sync. Runs once per UTC day per connected tenant.
 *
 * Called from the scheduled handler in src/index.ts on the every-15-min cron tick.
 * The 15-minute cadence lets us catch up from a missed UTC midnight without
 * being its own dedicated cron — and the per-tenant guard (last_sync_at
 * within last 23 hours = skip) prevents over-syncing.
 *
 * Each sync fetches yesterday + day-before-yesterday from GA4 (that's the
 * window where Google's data has finalized — GA4 has 24-48h processing lag).
 * Older data is captured by the inline backfill at OAuth-time.
 *
 * Per-tenant errors are isolated via Promise.allSettled — one customer's GA4
 * permission failure doesn't block other customers' syncs. Errors are logged
 * AND persisted into ga4_connections.last_sync_error so the Settings page
 * can surface them.
 */

import type { Env } from "../types";
import { decryptToken } from "../lib/ga4TokenCrypto";
import { refreshAccessToken, fetchDailyTraffic } from "../lib/ga4";
import { classifyTrafficSource } from "../lib/aiTrafficClassifier";

// A bit under 24h so the daily sync doesn't drift by small scheduling jitter.
const SYNC_INTERVAL_HOURS = 23;

export async function runGA4SyncBatch(env: Env): Promise<void> {
  if (!env.GA4_TOKEN_ENCRYPTION_KEY || !env.GA4_OAUTH_CLIENT_ID || !env.GA4_OAUTH_CLIENT_SECRET) {
    // GA4 integration not configured on this deployment — quiet skip.
    return;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - SYNC_INTERVAL_HOURS * 60 * 60 * 1000).toISOString();

  // Find tenants overdue for sync. New connections (last_sync_at IS NULL) are
  // covered by the inline OAuth-time backfill; we ONLY pick up tenants with a
  // prior successful sync that's now stale. Capped at 50 per cron tick to
  // stay under the worker CPU budget.
  const stale = await env.DB
    .prepare(
      `SELECT slug, refresh_token_enc, property_id
         FROM ga4_connections
        WHERE property_id IS NOT NULL
          AND last_sync_at IS NOT NULL
          AND last_sync_at < ?
          AND status != 'disconnected'
        LIMIT 50`,
    )
    .bind(cutoff)
    .all<{ slug: string; refresh_token_enc: string; property_id: string }>();

  const rows = stale.results ?? [];
  if (rows.length === 0) return;

  const results = await Promise.allSettled(
    rows.map((row) => syncOneTenant(env, row, now)),
  );

  // Log a summary for cron visibility.
  const ok     = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - ok;
  console.log(JSON.stringify({
    cron:      "ga4Sync",
    event:     "batch_complete",
    attempted: rows.length,
    ok,
    failed,
  }));
}

async function syncOneTenant(
  env: Env,
  row: { slug: string; refresh_token_enc: string; property_id: string },
  now: Date,
): Promise<void> {
  try {
    const refreshToken = await decryptToken(row.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY!);
    const { accessToken } = await refreshAccessToken(
      refreshToken,
      env.GA4_OAUTH_CLIENT_ID!,
      env.GA4_OAUTH_CLIENT_SECRET!,
    );

    // Fetch the last 2 days. GA4 finalizes data within 24-48h, so re-syncing
    // recent days lets us correct earlier under-counts.
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dayBefore  = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const startDate  = dayBefore.toISOString().slice(0, 10);
    const endDate    = yesterday.toISOString().slice(0, 10);

    const ga4Rows = await fetchDailyTraffic({
      propertyId: row.property_id,
      startDate,
      endDate,
      accessToken,
    });

    // Aggregate per (slug, date).
    // Rates (engagement_rate, bounce_rate) must be session-weighted averages
    // across source/medium rows for the same date — we accumulate underlying
    // counts and derive rates at write time to avoid averaging averages.
    type Agg = {
      ai_sessions: number;
      human_sessions: number;
      engaged_sessions_total: number;
      total_session_seconds: number;      // sum of sessions × averageSessionDuration
      bounced_sessions_total: number;     // sum of sessions × bounceRate
      new_users: number;
      returning_users: number;            // = totalUsers − newUsers
      sources: Record<string, number>;
    };
    const byDate = new Map<string, Agg>();
    for (const r of ga4Rows) {
      let agg = byDate.get(r.date);
      if (!agg) {
        agg = {
          ai_sessions: 0, human_sessions: 0,
          engaged_sessions_total: 0, total_session_seconds: 0,
          bounced_sessions_total: 0, new_users: 0, returning_users: 0,
          sources: {},
        };
        byDate.set(r.date, agg);
      }
      const cls = classifyTrafficSource(r.source, r.medium);
      if (cls === "ai") agg.ai_sessions    += r.sessions;
      else              agg.human_sessions += r.sessions;
      agg.engaged_sessions_total += r.engagedSessions;
      agg.total_session_seconds  += r.sessions * r.averageSessionDuration;
      agg.bounced_sessions_total += r.sessions * r.bounceRate;
      agg.new_users              += r.newUsers;
      // Clamp to >= 0 — GA4 sampling can produce rows where totalUsers <
      // newUsers, which would otherwise write a negative integer into the
      // NOT NULL DEFAULT 0 column.
      agg.returning_users        += Math.max(0, r.totalUsers - r.newUsers);
      const srcKey = `${r.source}|${r.medium}`;
      agg.sources[srcKey] = (agg.sources[srcKey] ?? 0) + r.sessions;
    }

    for (const [date, agg] of byDate.entries()) {
      const top = Object.entries(agg.sources)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([sm, n]) => {
          const [s, m] = sm.split("|");
          return { source: s, medium: m, sessions: n };
        });
      const total = agg.ai_sessions + agg.human_sessions;
      const engagement_rate         = total > 0 ? agg.engaged_sessions_total / total : null;
      const avg_session_duration_sec = total > 0 ? Math.round(agg.total_session_seconds / total) : null;
      const bounce_rate              = total > 0 ? agg.bounced_sessions_total / total : null;
      await env.DB.prepare(
        `INSERT INTO traffic_daily (
           slug, date, ai_sessions, human_sessions, total_sessions, top_sources_json,
           engagement_rate, avg_session_duration_sec, bounce_rate, new_users, returning_users
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug, date) DO UPDATE SET
           ai_sessions              = excluded.ai_sessions,
           human_sessions           = excluded.human_sessions,
           total_sessions           = excluded.total_sessions,
           top_sources_json         = excluded.top_sources_json,
           engagement_rate          = excluded.engagement_rate,
           avg_session_duration_sec = excluded.avg_session_duration_sec,
           bounce_rate              = excluded.bounce_rate,
           new_users                = excluded.new_users,
           returning_users          = excluded.returning_users`,
      )
      .bind(
        row.slug,
        date,
        agg.ai_sessions,
        agg.human_sessions,
        total,
        JSON.stringify(top),
        engagement_rate,
        avg_session_duration_sec,
        bounce_rate,
        agg.new_users,
        agg.returning_users,
      )
      .run();
    }

    await env.DB
      .prepare(
        "UPDATE ga4_connections SET last_sync_at = ?, last_sync_error = NULL, status = 'connected' WHERE slug = ?",
      )
      .bind(now.toISOString(), row.slug)
      .run();
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
    console.error(JSON.stringify({
      cron:  "ga4Sync",
      event: "tenant_failed",
      slug:  row.slug,
      error: msg,
    }));
    // Persist error so Settings page can surface it. Don't throw — error
    // isolation is the entire point of the per-tenant Promise.allSettled.
    try {
      await env.DB
        .prepare(
          "UPDATE ga4_connections SET last_sync_error = ?, status = 'error' WHERE slug = ?",
        )
        .bind(msg, row.slug)
        .run();
    } catch {
      // double-fault: DB update failed too. Logged above; nothing else to do.
    }
  }
}
