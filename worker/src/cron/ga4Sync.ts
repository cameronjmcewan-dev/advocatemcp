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
import { refreshAccessToken, fetchDailyTraffic, fetchDailyGeography, fetchDailyConversions } from "../lib/ga4";
import { classifyTrafficSource } from "../lib/aiTrafficClassifier";
import { aggregateGeoRows } from "../lib/geoAggregator";
import { aggregateConversionRows } from "../lib/conversionAggregator";

// A bit under 24h so the daily sync doesn't drift by small scheduling jitter.
const SYNC_INTERVAL_HOURS = 23;

export async function runGA4SyncBatch(env: Env): Promise<void> {
  if (!env.GA4_TOKEN_ENCRYPTION_KEY || !env.GA4_OAUTH_CLIENT_ID || !env.GA4_OAUTH_CLIENT_SECRET) {
    // GA4 integration not configured on this deployment — quiet skip.
    return;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - SYNC_INTERVAL_HOURS * 60 * 60 * 1000).toISOString();

  // Find tenants overdue for sync. Picks up BOTH new connections
  // (last_sync_at IS NULL — inline OAuth-time backfill never ran, or
  // ran and silently failed before stamping last_sync_at) AND
  // previously-synced tenants whose data is stale. Without the NULL
  // branch, a failed inline backfill leaves the tenant permanently
  // unrowed — the cron skips them forever and `traffic_daily` stays
  // empty. Bamboo Brace + Advocate both hit this in May 2026; the
  // self-heal makes the cron the safety net for a missed backfill.
  // Capped at 50 per cron tick to stay under the worker CPU budget.
  const stale = await env.DB
    .prepare(
      `SELECT slug, refresh_token_enc, property_id
         FROM ga4_connections
        WHERE property_id IS NOT NULL
          AND (last_sync_at IS NULL OR last_sync_at < ?)
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

    // Adaptive lookback window. Two cases:
    //
    //  (a) Tenant has >= MIN_HEALTHY_ROWS days of existing data
    //      → normal incremental sync: fetch the last 2 days. GA4
    //        finalizes within 24-48h, so re-syncing recent days lets
    //        us absorb the late-arriving counts.
    //
    //  (b) Tenant has fewer rows than that → treat as needing
    //      backfill. Pull the same 540-day (~18 month) window the
    //      inline OAuth-time backfill uses (portal.ts:4054). Covers
    //      tenants whose original backfill failed silently and
    //      tenants who reconnected without re-running it.
    //
    // 30 rows is the threshold because that's "obviously enough
    // history that backfill clearly succeeded." Anything below could
    // be either a genuinely-new property OR a broken backfill —
    // re-pulling 540 days is harmless either way (idempotent UPSERT;
    // GA4 returns whatever rows actually exist).
    const MIN_HEALTHY_ROWS = 30;
    const rowcountRes = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM traffic_daily WHERE slug = ?")
      .bind(row.slug)
      .first<{ c: number }>();
    const existingRowcount = rowcountRes?.c ?? 0;
    const needsBackfill = existingRowcount < MIN_HEALTHY_ROWS;

    const lookbackDays = needsBackfill ? 540 : 2;
    const endOfWindow   = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const startOfWindow = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const startDate  = startOfWindow.toISOString().slice(0, 10);
    const endDate    = endOfWindow.toISOString().slice(0, 10);

    if (needsBackfill) {
      console.log(JSON.stringify({
        cron:               "ga4Sync",
        event:              "self_heal_backfill",
        slug:               row.slug,
        existing_rowcount:  existingRowcount,
        lookback_days:      lookbackDays,
      }));
    }

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

    // Geography sync — separate report, separate upserts. Failures here
    // don't fail the main sync (just logged); geography is supplementary.
    try {
      const geoRows = await fetchDailyGeography({ propertyId: row.property_id, startDate, endDate, accessToken });
      const buckets = aggregateGeoRows(geoRows);
      for (const b of buckets.values()) {
        await env.DB.prepare(
          `INSERT INTO traffic_geo_daily (slug, date, country, city, ai_sessions, human_sessions)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug, date, country, city) DO UPDATE SET
             ai_sessions    = excluded.ai_sessions,
             human_sessions = excluded.human_sessions`,
        )
        .bind(row.slug, b.date, b.country, b.city, b.ai_sessions, b.human_sessions)
        .run();
      }
    } catch (geoErr) {
      // Geography is supplementary — log + continue. Main traffic_daily
      // already wrote successfully.
      console.error(JSON.stringify({
        cron:  "ga4Sync_geo",
        event: "geo_failed",
        slug:  row.slug,
        error: String(geoErr instanceof Error ? geoErr.message : geoErr).slice(0, 500),
      }));
    }

    // Phase 3 PR 1 TODO: extract writeConversions(env, slug, buckets) helper.
    // This try/catch + upsert loop is duplicated across syncOneTenant,
    // apiGA4SelectProperty, and apiGA4Resync — three near-identical blocks.
    // Roadmap calls for shared-helper extraction in Phase 3 PR 1
    // alongside the OAuth state lib refactor.
    try {
      const convRows = await fetchDailyConversions({ propertyId: row.property_id, startDate, endDate, accessToken });
      const buckets = aggregateConversionRows(convRows);
      for (const b of buckets.values()) {
        await env.DB.prepare(
          `INSERT INTO conversion_daily (slug, date, source_class, event_name, event_count, total_revenue, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug, date, source_class, event_name) DO UPDATE SET
             event_count   = excluded.event_count,
             total_revenue = excluded.total_revenue,
             currency      = excluded.currency`,
        )
        .bind(row.slug, b.date, b.source_class, b.event_name, b.event_count, b.total_revenue, b.currency)
        .run();
      }
    } catch (convErr) {
      // Conversions are supplementary — log + continue. Tenant may not
      // have key_events configured, which legitimately returns zero rows
      // (handled implicitly above), but actual fetch errors here surface.
      console.error(JSON.stringify({
        cron:  "ga4Sync_conv",
        event: "conv_failed",
        slug:  row.slug,
        error: String(convErr instanceof Error ? convErr.message : convErr).slice(0, 500),
      }));
    }
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
