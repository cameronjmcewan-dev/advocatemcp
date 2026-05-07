/**
 * Per-tenant CRM LTV daily snapshot. Runs once per UTC day per
 * connected CRM tenant on the existing every-15-min cron. Same Promise.allSettled
 * isolation, last_used_at gate, LIMIT 50 per tick.
 *
 * For each tenant: fetch contacts from the last 90 days via the
 * provider-appropriate passthrough lib, run aggregateLtv against
 * click_events, write the AI + unknown bucket totals into ltv_daily
 * keyed (slug, today, provider, source_class). Backfill mode only —
 * we don't fill historical gaps because the CRM API can't tell us
 * what contacts existed at past dates without paginating their full
 * history.
 *
 * Today's snapshot REPLACES yesterday's-via-INSERT-OR-REPLACE so
 * if cron runs multiple times per day the freshest aggregate wins.
 *
 * Privacy: zero PII written to D1. The aggregateLtv result is just
 * 4 integers per bucket. Individual contact data lives in customer's
 * CRM only.
 */

import type { Env } from "../types";
import { decryptToken } from "../lib/ga4TokenCrypto";
import { refreshHubspotAccessToken, fetchContactsWithRevenue as fetchHubspotContactsWithRevenue } from "../lib/hubspot";
import { refreshSalesforceAccessToken, fetchContactsWithRevenue as fetchSalesforceContactsWithRevenue } from "../lib/salesforce";
import { aggregateLtv } from "../lib/ltvAggregator";

// A bit under 24h so the daily snapshot doesn't drift by small scheduling jitter.
const SYNC_INTERVAL_HOURS = 23;

// 90-day lookback for contact fetches — same as the LTV endpoint default.
const LOOKBACK_DAYS = 90;

interface CrmConnectionRow {
  slug:              string;
  provider:          string;
  refresh_token_enc: string;
  account_id:        string | null;
}

export async function runCrmLtvSnapshotBatch(env: Env): Promise<void> {
  // Quiet-skip if token encryption or all CRM OAuth is not configured.
  // We need the encryption key AND at least one CRM provider configured.
  if (!env.GA4_TOKEN_ENCRYPTION_KEY) return;
  const hasHubspot     = !!(env.HUBSPOT_OAUTH_CLIENT_ID && env.HUBSPOT_OAUTH_CLIENT_SECRET);
  const hasSalesforce  = !!(env.SALESFORCE_OAUTH_CLIENT_ID && env.SALESFORCE_OAUTH_CLIENT_SECRET);
  if (!hasHubspot && !hasSalesforce) return;

  const now    = new Date();
  const cutoff = new Date(now.getTime() - SYNC_INTERVAL_HOURS * 60 * 60 * 1000).toISOString();

  // Find tenants whose last LTV snapshot is overdue. NULL last_used_at means
  // never snapshotted — include those too so a fresh connection gets its first row.
  const stale = await env.DB
    .prepare(
      `SELECT slug, provider, refresh_token_enc, account_id
         FROM crm_connections
        WHERE status = 'connected'
          AND (last_used_at IS NULL OR last_used_at < ?)
        LIMIT 50`,
    )
    .bind(cutoff)
    .all<CrmConnectionRow>();

  const rows = stale.results ?? [];
  if (rows.length === 0) return;

  const results = await Promise.allSettled(
    rows.map((row) => snapshotOneTenant(env, row, now)),
  );

  const ok     = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - ok;
  console.log(JSON.stringify({
    cron:       "crmLtvSnapshot",
    event:      "batch_complete",
    attempted:  rows.length,
    ok,
    failed,
  }));
}

async function snapshotOneTenant(
  env: Env,
  row: CrmConnectionRow,
  now: Date,
): Promise<void> {
  try {
    const today      = now.toISOString().slice(0, 10);
    const cutoff90   = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const refreshToken = await decryptToken(row.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY!);

    let contacts: Array<{ id: string; email: string | null; createdAt: string; lifecycleStage?: string; totalRevenue?: number }>;

    if (row.provider === "hubspot") {
      if (!env.HUBSPOT_OAUTH_CLIENT_ID || !env.HUBSPOT_OAUTH_CLIENT_SECRET) {
        throw new Error("crmLtvSnapshot: HubSpot env vars not configured for this provider row");
      }
      const { accessToken } = await refreshHubspotAccessToken(
        refreshToken,
        env.HUBSPOT_OAUTH_CLIENT_ID,
        env.HUBSPOT_OAUTH_CLIENT_SECRET,
      );
      contacts = await fetchHubspotContactsWithRevenue({ accessToken, createdAfter: cutoff90, maxContacts: 1000 });
    } else if (row.provider === "salesforce") {
      if (!env.SALESFORCE_OAUTH_CLIENT_ID || !env.SALESFORCE_OAUTH_CLIENT_SECRET) {
        throw new Error("crmLtvSnapshot: Salesforce env vars not configured for this provider row");
      }
      const { accessToken, instanceUrl } = await refreshSalesforceAccessToken(
        refreshToken,
        env.SALESFORCE_OAUTH_CLIENT_ID,
        env.SALESFORCE_OAUTH_CLIENT_SECRET,
      );
      contacts = await fetchSalesforceContactsWithRevenue({
        accessToken,
        instanceUrl,
        createdAfter: cutoff90,
        maxContacts: 1000,
      });
    } else {
      // Unknown provider — log and skip rather than error.
      console.warn(JSON.stringify({
        cron:     "crmLtvSnapshot",
        event:    "unknown_provider",
        slug:     row.slug,
        provider: row.provider,
      }));
      return;
    }

    // Fetch click_events for the same 90-day window to drive attribution.
    const clickResult = await env.DB
      .prepare(
        "SELECT ref, timestamp FROM click_events WHERE business_slug = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5000",
      )
      .bind(row.slug, cutoff90)
      .all<{ ref: string | null; timestamp: string }>();
    const clickEvents = clickResult.results ?? [];

    const result = aggregateLtv(contacts, clickEvents);

    // Write AI bucket — INSERT OR REPLACE so repeated cron runs on the same day
    // update the row rather than failing on the PRIMARY KEY conflict.
    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO ltv_daily
           (slug, date, provider, source_class, contact_count, customer_count, total_revenue_cents, avg_ltv_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.slug, today, row.provider, "ai",
        result.ai.contact_count,
        result.ai.customer_count,
        result.ai.total_revenue_cents,
        result.ai.avg_ltv_cents,
      )
      .run();

    // Write unknown bucket.
    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO ltv_daily
           (slug, date, provider, source_class, contact_count, customer_count, total_revenue_cents, avg_ltv_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.slug, today, row.provider, "unknown",
        result.unknown.contact_count,
        result.unknown.customer_count,
        result.unknown.total_revenue_cents,
        result.unknown.avg_ltv_cents,
      )
      .run();

    await env.DB
      .prepare("UPDATE crm_connections SET last_used_at = ?, last_error = NULL WHERE slug = ? AND provider = ?")
      .bind(now.toISOString(), row.slug, row.provider)
      .run();
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
    console.error(JSON.stringify({
      cron:     "crmLtvSnapshot",
      event:    "tenant_failed",
      slug:     row.slug,
      provider: row.provider,
      error:    msg,
    }));
    // Persist error so Settings page can surface it. Don't throw — error
    // isolation is the entire point of the per-tenant Promise.allSettled.
    try {
      await env.DB
        .prepare("UPDATE crm_connections SET last_error = ? WHERE slug = ? AND provider = ?")
        .bind(msg, row.slug, row.provider)
        .run();
    } catch {
      // double-fault: DB update failed too. Logged above; nothing else to do.
    }
  }
}
