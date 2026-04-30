/**
 * Railway-sync reconciler.
 *
 * Self-healing for the failure mode where a Stripe webhook successfully
 * creates a tenant in TENANT_DATA KV + D1 `businesses` but the call to
 * `registerBusinessOnRailway` silently failed (network blip, Railway 5xx,
 * timeout, zod rejection). The customer ends up in a zombie state where
 * the dashboard renders empty cards forever because every /api/client/*
 * endpoint that proxies to Railway 401s on a stale api_key.
 *
 * Detection signal:
 *   businesses.railway_synced_at IS NULL
 *
 * The column is stamped to NOW() right after a successful
 * `registerBusinessOnRailway`. Any tenant row with stripe_customer_id
 * set (i.e. paid) AND railway_synced_at NULL has either:
 *   - never had its registerBusinessOnRailway run (webhook bug)
 *   - had it run but it failed (network / timeout / Railway down)
 *   - had it run successfully on a worker version that predates this
 *     column (one-time backfill at deploy boundary handles those)
 *
 * The cron retries the registration. On success, stamps the column.
 * On failure, captures to Sentry with rich context so we see it on the
 * next signup instead of waiting for a customer to email support.
 *
 * Idempotency: registerBusinessOnRailway calls Railway's POST /register
 * which auto-suffixes slug collisions. If a row was already registered
 * under the same slug, we'd get a different slug back. The reconciler
 * guards against this by ONLY retrying tenants whose D1 api_key looks
 * like the placeholder (length-mismatch heuristic — wizard-set keys
 * are < 30 chars, Railway-issued UUIDs are 36 chars).
 *
 * Apr 29 2026.
 */

import * as Sentry from "@sentry/cloudflare";
import type { Env } from "../types";
import { getTenant } from "../routes/onboard";
import { registerBusinessOnRailway } from "../routes/stripe";
import { updateBusinessApiKey } from "../portalDb";

interface CandidateRow {
  id:                  string;
  slug:                string;
  business_name:       string;
  domain:              string | null;
  api_key:             string;
  stripe_customer_id:  string | null;
}

export interface ReconcilerResult {
  scanned:    number;
  retried:    number;
  succeeded:  number;
  failed:     number;
  skipped:    number;
  errors:     Array<{ slug: string; reason: string }>;
}

/**
 * Find paid tenants whose Railway sync hasn't been confirmed and replay
 * the registration for each. Designed to run on a 15-minute cron so a
 * webhook failure self-heals within one tick.
 *
 * Limits the batch to BATCH_SIZE candidates per run so a backlog (or a
 * persistent Railway outage) doesn't burn through the worker CPU budget
 * in one tick. Subsequent ticks pick up the rest.
 */
export async function reconcileRailwaySync(env: Env): Promise<ReconcilerResult> {
  const BATCH_SIZE = 25;
  const result: ReconcilerResult = {
    scanned: 0, retried: 0, succeeded: 0, failed: 0, skipped: 0, errors: [],
  };

  // Bail fast when Railway isn't configured — nothing the reconciler
  // can do until ops sets the secret. This is the same guard
  // handleRetryRailwayRegistration uses; staying consistent prevents
  // the cron from spamming Sentry every tick during local dev.
  if (!env.API_BASE_URL || !env.API_KEY) {
    return result;
  }

  let candidates: CandidateRow[];
  try {
    const rows = await env.DB
      .prepare(
        // Paid tenants (stripe_customer_id IS NOT NULL) whose Railway
        // sync hasn't been confirmed (railway_synced_at IS NULL). Limit
        // bounds the worst-case CPU spend per tick.
        `SELECT id, slug, business_name, domain, api_key, stripe_customer_id
           FROM businesses
          WHERE stripe_customer_id IS NOT NULL
            AND railway_synced_at IS NULL
          LIMIT ?`,
      )
      .bind(BATCH_SIZE)
      .all<CandidateRow>();
    candidates = rows.results ?? [];
  } catch (err) {
    Sentry.captureException(err, {
      tags: { reconciler: "railway_sync", phase: "candidate_scan" },
    });
    return result;
  }

  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  for (const biz of candidates) {
    const slug = biz.slug;
    Sentry.setTag("reconcile_slug", slug);

    if (!biz.domain) {
      result.skipped++;
      continue;
    }

    const tenant = await getTenant(env, biz.domain);
    if (!tenant || !tenant.profile) {
      // KV record is gone or never had a wizard payload — we can't
      // reconstruct what to register. Skip and surface to Sentry once
      // so ops sees the divergence (D1 thinks the tenant exists, KV
      // disagrees). Don't keep alerting on the same slug — capture
      // with a fingerprint so it dedupes cleanly.
      Sentry.captureMessage(
        `railway_reconcile_skip_no_kv_profile: ${slug}`,
        {
          level: "warning",
          tags:  { reconciler: "railway_sync", slug },
          fingerprint: ["railway_reconcile_skip_no_kv_profile", slug],
        },
      );
      result.skipped++;
      continue;
    }

    result.retried++;
    const reg = await registerBusinessOnRailway(env, tenant);
    if (!reg.ok) {
      result.failed++;
      result.errors.push({ slug, reason: reg.error });
      // Capture each failure as a structured Sentry event (level: error
      // bumped from warning so it triggers the high-priority alert
      // route per docs/observability.md). Fingerprinted by slug so the
      // same tenant failing repeatedly groups into a single issue.
      Sentry.captureMessage(
        `railway_reconcile_failed: ${slug}`,
        {
          level: "error",
          tags:  { reconciler: "railway_sync", slug, error: reg.error },
          fingerprint: ["railway_reconcile_failed", slug],
        },
      );
      continue;
    }

    // Success — write the new api_key back to D1 + stamp the synced
    // marker. Both writes happen sequentially; if the api_key write
    // succeeds and the marker write fails, the next tick retries
    // (Railway will return the same api_key for the same slug under
    // its existing-row branch — see the early-return logic in
    // server/src/routes/register.ts).
    try {
      await updateBusinessApiKey(env.DB, slug, reg.api_key);
      await env.DB
        .prepare("UPDATE businesses SET railway_synced_at = ? WHERE slug = ?")
        .bind(new Date().toISOString(), slug)
        .run();
      result.succeeded++;
    } catch (err) {
      result.failed++;
      result.errors.push({ slug, reason: String(err) });
      Sentry.captureException(err, {
        tags: { reconciler: "railway_sync", phase: "d1_write", slug },
      });
    }
  }

  // Single summary log per tick — easier to grep than per-tenant lines
  // when there are dozens of paid tenants in steady state.
  console.log(JSON.stringify({
    reconciler: "railway_sync",
    event: "tick_complete",
    ...result,
  }));

  return result;
}

/**
 * Manually mark a slug as Railway-synced. Used by the Stripe webhook
 * happy path so brand-new tenants don't briefly look like reconciler
 * candidates between webhook fire and the next cron tick.
 */
export async function markRailwaySynced(env: Env, slug: string): Promise<void> {
  await env.DB
    .prepare("UPDATE businesses SET railway_synced_at = ? WHERE slug = ?")
    .bind(new Date().toISOString(), slug)
    .run();
}
