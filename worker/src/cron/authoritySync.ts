/**
 * Per-tenant Off-site Authority sync. Runs once per UTC day per
 * configured tenant on the existing every-15-min cron. Same Promise.allSettled
 * isolation, last_synced_at gate, LIMIT 50 per tick.
 *
 * Reddit path: Pulls Reddit mentions for the tenant's brand_keyword,
 * classifies sentiment via Claude, aggregates per-day buckets, INSERT OR
 * REPLACE into off_site_authority_daily.
 *
 * Google Reviews path: Fetches the tenant's Google Place details using
 * the server-side GOOGLE_PLACES_API_KEY. Converts each review's star
 * rating to sentiment WITHOUT calling Claude (saves cost + more reliable).
 * Aggregates per-day buckets. Writes the Place's overall rating +
 * user_ratings_total into the rating / rating_count columns.
 *
 * Cap: 100 mentions classified per tenant per day to bound Claude
 * spend (~$0.50/tenant/day worst case, typically $0.05). Google reviews
 * return at most 5 by default — no cap needed for that branch.
 */

import type { Env } from "../types";
import { searchRedditMentions, RedditRateLimitError } from "../lib/reddit";
import { classifySentimentBatch } from "../lib/sentimentClassifier";
import { aggregateAuthorityMentions, type DailyAuthorityBucket } from "../lib/authorityAggregator";
import { fetchPlaceDetails, googleRatingToSentiment } from "../lib/googlePlaces";

// A bit under 24h so the daily sync doesn't drift by small scheduling jitter.
const SYNC_INTERVAL_HOURS = 23;

// Hard cap on mentions classified per tenant per day.
const MAX_MENTIONS_PER_TENANT = 100;

interface AuthorityConfigRow {
  slug:            string;
  brand_keyword:   string | null;
  google_place_id: string | null;
}

export async function runAuthoritySyncBatch(env: Env): Promise<void> {
  // Quiet-skip if neither API key is configured (Reddit needs Anthropic,
  // Google needs its own key — each branch has its own guard below).
  if (!env.ANTHROPIC_API_KEY && !env.GOOGLE_PLACES_API_KEY) return;

  const now    = new Date();
  const cutoff = new Date(now.getTime() - SYNC_INTERVAL_HOURS * 60 * 60 * 1000).toISOString();

  const stale = await env.DB
    .prepare(
      `SELECT slug, brand_keyword, google_place_id
         FROM authority_config
        WHERE (
          (brand_keyword IS NOT NULL AND reddit_enabled = 1)
          OR google_place_id IS NOT NULL
        )
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

/**
 * Returns the total number of mentions processed (Reddit + Google) for
 * observability.
 */
async function syncOneTenant(
  env: Env,
  row: AuthorityConfigRow,
  now: Date,
): Promise<number> {
  try {
    let totalMentions = 0;

    // ── Reddit branch ─────────────────────────────────────────────────────
    if (row.brand_keyword && env.ANTHROPIC_API_KEY) {
      totalMentions += await syncRedditForTenant(env, row.slug, row.brand_keyword);
    }

    // ── Google Reviews branch ─────────────────────────────────────────────
    if (row.google_place_id && env.GOOGLE_PLACES_API_KEY) {
      totalMentions += await syncGooglePlacesForTenant(env, row.slug, row.google_place_id);
    }

    // Stamp success after both branches complete
    await stampSuccess(env, row.slug, now);

    return totalMentions;
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

/** Fetches Reddit mentions, classifies via Claude, and upserts buckets. */
async function syncRedditForTenant(
  env: Env,
  slug: string,
  brandKeyword: string,
): Promise<number> {
  let redditMentions = await searchRedditMentions({
    brandKeyword,
    limit: 25, // Reddit's per-request max without OAuth
  });

  if (redditMentions.length > MAX_MENTIONS_PER_TENANT) {
    redditMentions = redditMentions.slice(0, MAX_MENTIONS_PER_TENANT);
  }

  if (redditMentions.length === 0) return 0;

  const batchInput = redditMentions.map((m) => ({ id: m.id, text: m.text }));
  const sentimentResults = await classifySentimentBatch(
    batchInput,
    brandKeyword,
    env.ANTHROPIC_API_KEY!,
  );

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

  const buckets = aggregateAuthorityMentions("reddit", mentionsWithSentiment);

  for (const [, bucket] of buckets.entries()) {
    await upsertBucket(env, slug, bucket);
  }

  return redditMentions.length;
}

/**
 * Fetches Google Place details, converts star ratings to sentiment without
 * calling Claude, aggregates buckets, and populates the rating + rating_count
 * columns from the Place's overall score.
 */
async function syncGooglePlacesForTenant(
  env: Env,
  slug: string,
  placeId: string,
): Promise<number> {
  const details = await fetchPlaceDetails({
    placeId,
    apiKey: env.GOOGLE_PLACES_API_KEY!,
  });

  const reviews = details.reviews;
  if (reviews.length === 0) return 0;

  // Build mention-shaped inputs from Google reviews. Use a composite ID for
  // deduplication across syncs — the review's unix time + author_name is the
  // most stable identifier available without OAuth.
  const mentionsWithSentiment = reviews.map((rv) => ({
    id:          `gplaces:${rv.time}:${rv.author_name}`,
    text:        rv.text,
    created_utc: rv.time,
    sentiment:   googleRatingToSentiment(rv.rating),
  }));

  const buckets = aggregateAuthorityMentions("google_reviews", mentionsWithSentiment);

  // Attach the Place's overall rating + total count to every bucket produced.
  // The aggregator only computes per-mention avg; the Place-level score is
  // authoritative and worth persisting separately.
  for (const bucket of buckets.values()) {
    bucket.rating       = details.rating;
    bucket.rating_count = details.user_ratings_total;
  }

  for (const [, bucket] of buckets.entries()) {
    await upsertBucket(env, slug, bucket);
  }

  return reviews.length;
}

/** Writes a single aggregated bucket into off_site_authority_daily. */
async function upsertBucket(
  env: Env,
  slug: string,
  bucket: DailyAuthorityBucket,
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT OR REPLACE INTO off_site_authority_daily
         (slug, date, platform, mention_count, positive_count, neutral_count,
          negative_count, avg_sentiment, top_mentions_json, rating, rating_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      slug,
      bucket.date,
      bucket.platform,
      bucket.mention_count,
      bucket.positive_count,
      bucket.neutral_count,
      bucket.negative_count,
      bucket.avg_sentiment,
      bucket.top_mentions_json,
      bucket.rating  ?? null,
      bucket.rating_count ?? null,
    )
    .run();
}

async function stampSuccess(env: Env, slug: string, now: Date): Promise<void> {
  await env.DB
    .prepare(
      "UPDATE authority_config SET last_synced_at = ?, last_sync_error = NULL WHERE slug = ?",
    )
    .bind(now.toISOString(), slug)
    .run();
}
