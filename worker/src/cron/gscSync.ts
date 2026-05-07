/**
 * Per-tenant GSC search-analytics sync. Runs once per UTC day per
 * connected tenant on the existing every-15-min cron. Mirrors ga4Sync's
 * Promise.allSettled error isolation, last_sync_at gate, LIMIT 50
 * per-tick cap.
 *
 * Each sync fetches the last 4 days from GSC (GSC has 2-3 day
 * processing lag, slightly more than GA4). Older data is captured
 * by the inline backfill at site-selection time.
 */

import type { Env } from "../types";
import { decryptToken } from "../lib/ga4TokenCrypto";
import { refreshAccessToken } from "../lib/ga4";
import { fetchSearchAnalytics } from "../lib/gsc";

// A bit under 24h so the daily sync doesn't drift by small scheduling jitter.
const SYNC_INTERVAL_HOURS = 23;

// GSC has 2-3 day processing lag; sync the last 4 days so finalized
// data is captured even on slow-processing days.
const SYNC_LOOKBACK_DAYS = 4;

// Cap per-day queries to prevent long-tail blowup in gsc_daily.
// Applied client-side after sorting by impressions descending.
const MAX_QUERIES_PER_DAY = 100;

export async function runGSCSyncBatch(env: Env): Promise<void> {
  // Quiet-skip if integration isn't configured — same guard pattern as ga4Sync
  if (!env.GA4_TOKEN_ENCRYPTION_KEY || !env.GSC_OAUTH_CLIENT_ID || !env.GSC_OAUTH_CLIENT_SECRET) {
    return;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - SYNC_INTERVAL_HOURS * 60 * 60 * 1000).toISOString();

  // Find tenants overdue for sync. Only tenants that have already picked a
  // site_url — new connections without a site selection are handled by the
  // inline backfill in apiGSCSelectSite. Capped at 50 per cron tick.
  const stale = await env.DB
    .prepare(
      `SELECT slug, refresh_token_enc, site_url
         FROM gsc_connections
        WHERE site_url IS NOT NULL
          AND last_sync_at IS NOT NULL
          AND last_sync_at < ?
          AND status != 'disconnected'
        LIMIT 50`,
    )
    .bind(cutoff)
    .all<{ slug: string; refresh_token_enc: string; site_url: string }>();

  const rows = stale.results ?? [];
  if (rows.length === 0) return;

  const results = await Promise.allSettled(
    rows.map((row) => syncOneTenant(env, row, now)),
  );

  const ok     = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - ok;
  console.log(JSON.stringify({
    cron:      "gscSync",
    event:     "batch_complete",
    attempted: rows.length,
    ok,
    failed,
  }));
}

async function syncOneTenant(
  env: Env,
  row: { slug: string; refresh_token_enc: string; site_url: string },
  now: Date,
): Promise<void> {
  try {
    const refreshToken = await decryptToken(row.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY!);
    const { accessToken } = await refreshAccessToken(
      refreshToken,
      env.GSC_OAUTH_CLIENT_ID!,
      env.GSC_OAUTH_CLIENT_SECRET!,
    );

    // Fetch the last 4 days. GSC finalizes data within 2-3 days, so re-syncing
    // recent days corrects earlier under-counts.
    const endDate   = new Date(now.getTime() -                       24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const startDate = new Date(now.getTime() - SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const gscRows = await fetchSearchAnalytics({
      siteUrl:  row.site_url,
      startDate,
      endDate,
      accessToken,
    });

    // Group rows by date so we can cap per-day before writing
    const byDate = new Map<string, typeof gscRows>();
    for (const r of gscRows) {
      const bucket = byDate.get(r.date) ?? [];
      bucket.push(r);
      byDate.set(r.date, bucket);
    }

    for (const [date, dayRows] of byDate.entries()) {
      // Cap to top-100 queries by impressions (highest-visibility queries).
      // The GSC rowLimit caps at API time but doesn't sort by impressions —
      // we sort + slice here client-side.
      const top100 = dayRows
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, MAX_QUERIES_PER_DAY);

      for (const r of top100) {
        await env.DB.prepare(
          `INSERT INTO gsc_daily (slug, date, query, impressions, clicks, ctr, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug, date, query) DO UPDATE SET
             impressions = excluded.impressions,
             clicks      = excluded.clicks,
             ctr         = excluded.ctr,
             position    = excluded.position`,
        )
        .bind(row.slug, date, r.query, r.impressions, r.clicks, r.ctr, r.position)
        .run();
      }
    }

    await env.DB
      .prepare(
        "UPDATE gsc_connections SET last_sync_at = ?, last_sync_error = NULL, status = 'connected' WHERE slug = ?",
      )
      .bind(now.toISOString(), row.slug)
      .run();
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
    console.error(JSON.stringify({
      cron:  "gscSync",
      event: "tenant_failed",
      slug:  row.slug,
      error: msg,
    }));
    // Persist error so Settings page can surface it. Don't throw — error
    // isolation is the entire point of the per-tenant Promise.allSettled.
    try {
      await env.DB
        .prepare(
          "UPDATE gsc_connections SET last_sync_error = ?, status = 'error' WHERE slug = ?",
        )
        .bind(msg, row.slug)
        .run();
    } catch {
      // double-fault: DB update failed too. Logged above; nothing else to do.
    }
  }
}
