/**
 * Per-tenant Off-site Authority sync. Runs once per UTC day per
 * configured tenant on the existing every-15-min cron. Same Promise.allSettled
 * isolation, last_synced_at gate, LIMIT 50 per tick.
 *
 * Pulls Reddit mentions for the tenant's brand_keyword, classifies
 * sentiment via Claude, aggregates per-day buckets, INSERT OR REPLACE
 * into off_site_authority_daily.
 *
 * Cap: 100 mentions classified per tenant per day to bound Claude
 * spend (~$0.50/tenant/day worst case, typically $0.05). If Reddit
 * returns more, only the freshest 100 get classified.
 *
 * Google Reviews comes in PR 2 — this PR ships Reddit only. The
 * platform field in off_site_authority_daily is parameterized so PR 2
 * just adds another platform branch.
 */

import type { Env } from "../types";
import { searchRedditMentions, RedditRateLimitError } from "../lib/reddit";
import { classifySentimentBatch } from "../lib/sentimentClassifier";
import { aggregateAuthorityMentions } from "../lib/authorityAggregator";

// A bit under 24h so the daily sync doesn't drift by small scheduling jitter.
const SYNC_INTERVAL_HOURS = 23;

// Hard cap on mentions classified per tenant per day.
const MAX_MENTIONS_PER_TENANT = 100;

interface AuthorityConfigRow {
  slug:          string;
  brand_keyword: string;
}

export async function runAuthoritySyncBatch(env: Env): Promise<void> {
  // Quiet-skip if Anthropic API key is not configured
  if (!env.ANTHROPIC_API_KEY) return;

  const now    = new Date();
  const cutoff = new Date(now.getTime() - SYNC_INTERVAL_HOURS * 60 * 60 * 1000).toISOString();

  const stale = await env.DB
    .prepare(
      `SELECT slug, brand_keyword
         FROM authority_config
        WHERE brand_keyword IS NOT NULL
          AND reddit_enabled = 1
          AND (last_synced_at IS NULL OR last_synced_at < ?)
        LIMIT 50`,
    )
    .bind(cutoff)
    .all<AuthorityConfigRow>();

  const rows = stale.results ?? [];
  if (rows.length === 0) return;

  const results = await Promise.allSettled(
    rows.map((row) => syncOneTenant(env, row, now)),
  );

  const ok     = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - ok;
  const totalMentions = results.reduce((acc, r) => {
    return acc + (r.status === "fulfilled" ? (r.value ?? 0) : 0);
  }, 0);

  console.log(JSON.stringify({
    cron:             "authoritySync",
    event:            "batch_complete",
    attempted:        rows.length,
    ok,
    failed,
    total_mentions:   totalMentions,
  }));
}

/** Returns the number of mentions classified for observability. */
async function syncOneTenant(
  env: Env,
  row: AuthorityConfigRow,
  now: Date,
): Promise<number> {
  try {
    // Step 1: Fetch Reddit mentions
    let redditMentions = await searchRedditMentions({
      brandKeyword: row.brand_keyword,
      limit: 25, // Reddit's per-request max without OAuth
    });

    // Defensive cap at 100 (the Reddit 25-limit already constrains this today;
    // the cap is future-proofing for when we add multiple sources).
    if (redditMentions.length > MAX_MENTIONS_PER_TENANT) {
      redditMentions = redditMentions.slice(0, MAX_MENTIONS_PER_TENANT);
    }

    if (redditMentions.length === 0) {
      await stampSuccess(env, row.slug, now);
      return 0;
    }

    // Step 2: Classify sentiment via Claude
    const batchInput = redditMentions.map((m) => ({ id: m.id, text: m.text }));
    const sentimentResults = await classifySentimentBatch(
      batchInput,
      row.brand_keyword,
      env.ANTHROPIC_API_KEY!,
    );

    // Step 3: Zip mentions with their sentiment results
    const mentionsWithSentiment = redditMentions.map((m) => {
      const sr = sentimentResults.find((r) => r.id === m.id);
      return {
        id:          m.id,
        text:        m.text,
        permalink:   m.permalink,
        created_utc: m.created_utc,
        sentiment:   sr?.result ?? { label: "neutral" as const, score: 0 },
      };
    });

    // Step 4: Aggregate into daily buckets
    const buckets = aggregateAuthorityMentions("reddit", mentionsWithSentiment);

    // Step 5: UPSERT into off_site_authority_daily
    for (const [, bucket] of buckets.entries()) {
      await env.DB
        .prepare(
          `INSERT OR REPLACE INTO off_site_authority_daily
             (slug, date, platform, mention_count, positive_count, neutral_count,
              negative_count, avg_sentiment, top_mentions_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.slug,
          bucket.date,
          bucket.platform,
          bucket.mention_count,
          bucket.positive_count,
          bucket.neutral_count,
          bucket.negative_count,
          bucket.avg_sentiment,
          bucket.top_mentions_json,
        )
        .run();
    }

    // Step 6: Stamp success
    await stampSuccess(env, row.slug, now);

    return redditMentions.length;
  } catch (err) {
    // Reddit rate-limit is transient — don't mark tenant as error, just log + continue.
    // Check .name rather than instanceof so vitest module mocking doesn't break
    // the class identity (test mock and SUT import different class instances).
    if (err instanceof RedditRateLimitError || (err instanceof Error && err.name === "RedditRateLimitError")) {
      const retryAfter = err instanceof RedditRateLimitError
        ? err.retryAfter
        : (err as unknown as { retryAfter?: number | null }).retryAfter ?? null;
      console.log(JSON.stringify({
        cron:   "authoritySync",
        event:  "reddit_rate_limited",
        slug:   row.slug,
        retry_after: retryAfter,
      }));
      return 0;
    }

    const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
    console.error(JSON.stringify({
      cron:  "authoritySync",
      event: "tenant_failed",
      slug:  row.slug,
      error: msg,
    }));

    // Persist error so Settings page can surface it. Don't throw — error
    // isolation is the entire point of the per-tenant Promise.allSettled.
    try {
      await env.DB
        .prepare(
          "UPDATE authority_config SET last_sync_error = ? WHERE slug = ?",
        )
        .bind(msg, row.slug)
        .run();
    } catch {
      // double-fault: DB update failed too. Already logged above.
    }

    throw err; // re-throw so Promise.allSettled records it as rejected
  }
}

async function stampSuccess(env: Env, slug: string, now: Date): Promise<void> {
  await env.DB
    .prepare(
      "UPDATE authority_config SET last_synced_at = ?, last_sync_error = NULL WHERE slug = ?",
    )
    .bind(now.toISOString(), slug)
    .run();
}
