/**
 * Tests for worker/src/cron/authoritySync.ts
 *
 * Mocks D1, searchRedditMentions, classifySentimentBatch,
 * aggregateAuthorityMentions, and fetchPlaceDetails at the module boundary.
 * No real network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAuthoritySyncBatch } from "./authoritySync.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

// RedditRateLimitError must be defined INSIDE the vi.mock factory (or imported
// via importActual) because vi.mock factories are hoisted to the top of the
// file — referencing an imported binding from outside the factory causes a
// "Cannot access before initialization" ReferenceError at test-run time.
class RedditRateLimitError extends Error {
  readonly retryAfter: number | null;
  constructor(retryAfter: number | null = null) {
    super("reddit: rate limited by Reddit API");
    this.name = "RedditRateLimitError";
    this.retryAfter = retryAfter;
  }
}

const mockSearchRedditMentions = vi.fn();
vi.mock("../lib/reddit", () => {
  class _RedditRateLimitError extends Error {
    readonly retryAfter: number | null;
    constructor(retryAfter: number | null = null) {
      super("reddit: rate limited by Reddit API");
      this.name = "RedditRateLimitError";
      this.retryAfter = retryAfter;
    }
  }
  return {
    searchRedditMentions: (...args: unknown[]) => mockSearchRedditMentions(...args),
    RedditRateLimitError: _RedditRateLimitError,
  };
});

const mockClassifySentimentBatch = vi.fn();
vi.mock("../lib/sentimentClassifier", () => ({
  classifySentimentBatch: (...args: unknown[]) => mockClassifySentimentBatch(...args),
}));

const mockAggregateAuthorityMentions = vi.fn();
vi.mock("../lib/authorityAggregator", () => ({
  aggregateAuthorityMentions: (...args: unknown[]) => mockAggregateAuthorityMentions(...args),
}));

const mockFetchPlaceDetails = vi.fn();
vi.mock("../lib/googlePlaces", () => ({
  fetchPlaceDetails:        (...args: unknown[]) => mockFetchPlaceDetails(...args),
  googleRatingToSentiment:  (rating: number) => {
    if (rating >= 4.5) return { label: "positive", score: 1.0 };
    if (rating >= 3.5) return { label: "positive", score: 0.5 };
    if (rating >= 2.5) return { label: "neutral",  score: 0.0 };
    if (rating >= 1.5) return { label: "negative", score: -0.5 };
    return                     { label: "negative", score: -1.0 };
  },
}));

// ── D1 stub factory ───────────────────────────────────────────────────────────

type DbResponseMap = Record<string, Array<Record<string, unknown>>>;

function makeDb(dbResponses: DbResponseMap = {}) {
  const dbCalls: Array<{ sql: string; args: unknown[] }> = [];

  const db = {
    prepare(sql: string) {
      const stmt: {
        _args: unknown[];
        bind: (...args: unknown[]) => typeof stmt;
        run: () => Promise<{ success: boolean }>;
        all: <T>() => Promise<{ results: T[] }>;
        first: <T>() => Promise<T | null>;
      } = {
        _args: [],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async run() {
          dbCalls.push({ sql, args: stmt._args });
          return { success: true };
        },
        async all<T>() {
          dbCalls.push({ sql, args: stmt._args });
          const key = Object.keys(dbResponses).find((k) => sql.includes(k));
          const results = (key ? dbResponses[key] : []) as T[];
          return { results };
        },
        async first<T>() {
          dbCalls.push({ sql, args: stmt._args });
          return null as T | null;
        },
      };
      return stmt;
    },
  };

  return { db, dbCalls };
}

// ── Env helpers ───────────────────────────────────────────────────────────────

function makeEnv(overrides: Record<string, unknown> = {}) {
  const { db, dbCalls } = makeDb(
    (overrides._dbResponses as DbResponseMap) ?? {},
  );
  const { _dbResponses: _, ...rest } = overrides;
  return {
    env: {
      ANTHROPIC_API_KEY: "sk-ant-test",
      DB: db,
      ...rest,
    },
    dbCalls,
  };
}

// ── Default Reddit + sentiment fixtures ──────────────────────────────────────

const SAMPLE_MENTION = {
  id:          "t3_abc123",
  subreddit:   "testsubreddit",
  permalink:   "https://reddit.com/r/testsubreddit/comments/abc123/",
  author:      "testuser",
  text:        "Great product!",
  created_utc: 1746489600,
  score:       10,
};

const SAMPLE_SENTIMENT = [
  { id: "t3_abc123", result: { label: "positive" as const, score: 0.8, theme: "product quality" } },
];

const SAMPLE_BUCKET = new Map([
  ["2026-05-06", {
    date:              "2026-05-06",
    platform:          "reddit",
    mention_count:     1,
    positive_count:    1,
    neutral_count:     0,
    negative_count:    0,
    avg_sentiment:     0.8,
    top_mentions_json: "[]",
  }],
]);

// Google Places fixtures
const SAMPLE_PLACE_DETAILS = {
  name:               "Bamboo Brace",
  rating:             4.8,
  user_ratings_total: 320,
  reviews: [
    { author_name: "Alice", rating: 5, text: "Amazing!", time: 1746489600 },
    { author_name: "Bob",   rating: 3, text: "Average.", time: 1745884800 },
  ],
};

const SAMPLE_GOOGLE_BUCKET = new Map([
  ["2026-05-06", {
    date:              "2026-05-06",
    platform:          "google_reviews",
    mention_count:     2,
    positive_count:    1,
    neutral_count:     1,
    negative_count:    0,
    avg_sentiment:     0.25,
    top_mentions_json: "[]",
  }],
]);

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchRedditMentions.mockResolvedValue([SAMPLE_MENTION]);
  mockClassifySentimentBatch.mockResolvedValue(SAMPLE_SENTIMENT);
  mockAggregateAuthorityMentions.mockReturnValue(SAMPLE_BUCKET);
  mockFetchPlaceDetails.mockResolvedValue(SAMPLE_PLACE_DETAILS);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAuthoritySyncBatch", () => {
  // 1. Quiet-skip when both API keys missing
  it("1. quiet-skip when both ANTHROPIC_API_KEY and GOOGLE_PLACES_API_KEY are unset", async () => {
    const { env, dbCalls } = makeEnv({
      ANTHROPIC_API_KEY:    undefined,
      GOOGLE_PLACES_API_KEY: undefined,
    });
    await runAuthoritySyncBatch(env as never);
    expect(dbCalls).toHaveLength(0);
    expect(mockSearchRedditMentions).not.toHaveBeenCalled();
    expect(mockFetchPlaceDetails).not.toHaveBeenCalled();
  });

  // 2. No-op when no stale tenants
  it("2. no-op when stale-tenant query returns empty results", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { authority_config: [] },
    });
    await runAuthoritySyncBatch(env as never);
    expect(mockSearchRedditMentions).not.toHaveBeenCalled();
    const nonSelectCalls = dbCalls.filter((c) => !c.sql.trim().toUpperCase().startsWith("SELECT"));
    expect(nonSelectCalls).toHaveLength(0);
  });

  // 3. Happy path (Reddit)
  it("3. happy path: stale tenant → Reddit fetch → sentiment classify → aggregate → upsert + stamp", async () => {
    const staleRow = { slug: "acme-co", brand_keyword: "acme", google_place_id: null };
    const { env, dbCalls } = makeEnv({
      _dbResponses: { authority_config: [staleRow] },
    });

    await runAuthoritySyncBatch(env as never);

    // Reddit fetch called with brand keyword
    expect(mockSearchRedditMentions).toHaveBeenCalledOnce();
    const redditArgs = mockSearchRedditMentions.mock.calls[0][0] as { brandKeyword: string };
    expect(redditArgs.brandKeyword).toBe("acme");

    // Sentiment classified
    expect(mockClassifySentimentBatch).toHaveBeenCalledOnce();
    const [batchInput, keyword, apiKey] = mockClassifySentimentBatch.mock.calls[0] as [unknown[], string, string];
    expect(batchInput).toHaveLength(1);
    expect(keyword).toBe("acme");
    expect(apiKey).toBe("sk-ant-test");

    // Aggregator called
    expect(mockAggregateAuthorityMentions).toHaveBeenCalledOnce();

    // UPSERT into off_site_authority_daily
    const upserts = dbCalls.filter((c) => c.sql.includes("off_site_authority_daily"));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.args[0]).toBe("acme-co");
    expect(upserts[0]!.args[2]).toBe("reddit");

    // last_synced_at stamped
    const stampCall = dbCalls.find(
      (c) => c.sql.includes("last_synced_at") && c.sql.includes("last_sync_error = NULL")
             && Array.isArray(c.args) && c.args.includes("acme-co"),
    );
    expect(stampCall).toBeDefined();
  });

  // 4. Per-tenant error isolation
  it("4. error isolation: tenant B succeeds even when tenant A throws", async () => {
    const rowA = { slug: "biz-a", brand_keyword: "brand-a", google_place_id: null };
    const rowB = { slug: "biz-b", brand_keyword: "brand-b", google_place_id: null };

    mockSearchRedditMentions
      .mockResolvedValueOnce([]) // A: empty mentions — success path (stamp immediately)
      .mockRejectedValueOnce(new Error("reddit: search failed: 503")); // B: throw

    const { env, dbCalls } = makeEnv({
      _dbResponses: { authority_config: [rowA, rowB] },
    });

    // Must not throw top-level
    await expect(runAuthoritySyncBatch(env as never)).resolves.toBeUndefined();

    // biz-a should have last_synced_at stamped
    const aStamp = dbCalls.find(
      (c) => c.sql.includes("last_synced_at") && Array.isArray(c.args) && c.args.includes("biz-a"),
    );
    expect(aStamp).toBeDefined();

    // biz-b should have last_sync_error stamped
    const bError = dbCalls.find(
      (c) => c.sql.includes("last_sync_error") && !c.sql.includes("NULL")
             && Array.isArray(c.args) && c.args.includes("biz-b"),
    );
    expect(bError).toBeDefined();
  });

  // 5. Reddit 429 doesn't mark tenant as error (transient)
  it("5. Reddit 429 (RedditRateLimitError) does not write last_sync_error — logged only", async () => {
    const staleRow = { slug: "rate-limited-biz", brand_keyword: "brand", google_place_id: null };
    mockSearchRedditMentions.mockRejectedValueOnce(new RedditRateLimitError(60));

    const { env, dbCalls } = makeEnv({
      _dbResponses: { authority_config: [staleRow] },
    });

    await runAuthoritySyncBatch(env as never);

    // last_sync_error update must NOT have been called for this slug
    const errUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_error") && !c.sql.includes("NULL")
             && Array.isArray(c.args) && c.args.includes("rate-limited-biz"),
    );
    expect(errUpdate).toBeUndefined();

    // No upsert or stamp either
    const upserts = dbCalls.filter((c) => c.sql.includes("off_site_authority_daily"));
    expect(upserts).toHaveLength(0);
  });

  // 6. Stale SELECT uses correct cutoff and LIMIT 50
  it("6. stale-tenant SELECT binds 23h cutoff and LIMIT 50", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { authority_config: [] },
    });

    const before = new Date();
    await runAuthoritySyncBatch(env as never);
    const after = new Date();

    const selectCall = dbCalls.find((c) => c.sql.includes("authority_config"));
    expect(selectCall).toBeDefined();
    expect(selectCall!.sql).toContain("LIMIT 50");

    const cutoff = new Date(selectCall!.args[0] as string);
    const msBefore = before.getTime() - 23 * 60 * 60 * 1000 - 5000;
    const msAfter  = after.getTime()  - 23 * 60 * 60 * 1000 + 5000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(msBefore);
    expect(cutoff.getTime()).toBeLessThanOrEqual(msAfter);
  });

  // 7. Google Places happy path
  it("7. Google Places happy path: fetchPlaceDetails → sentiment → aggregate → upsert with rating + rating_count", async () => {
    const staleRow = {
      slug:            "bamboo-co",
      brand_keyword:   null,        // no Reddit for this tenant
      google_place_id: "ChIJbamboo",
    };

    // Override the aggregator to return a google_reviews bucket
    mockAggregateAuthorityMentions.mockReturnValueOnce(new Map([
      ["2026-05-06", {
        date:              "2026-05-06",
        platform:          "google_reviews",
        mention_count:     2,
        positive_count:    1,
        neutral_count:     1,
        negative_count:    0,
        avg_sentiment:     0.25,
        top_mentions_json: "[]",
        rating:            undefined,
        rating_count:      undefined,
      }],
    ]));

    const { env, dbCalls } = makeEnv({
      ANTHROPIC_API_KEY:    undefined, // no Reddit
      GOOGLE_PLACES_API_KEY: "gp_key_test",
      _dbResponses: { authority_config: [staleRow] },
    });

    await runAuthoritySyncBatch(env as never);

    // fetchPlaceDetails called with correct args
    expect(mockFetchPlaceDetails).toHaveBeenCalledOnce();
    const placesArgs = mockFetchPlaceDetails.mock.calls[0][0] as { placeId: string; apiKey: string };
    expect(placesArgs.placeId).toBe("ChIJbamboo");
    expect(placesArgs.apiKey).toBe("gp_key_test");

    // Aggregator called with "google_reviews" platform
    expect(mockAggregateAuthorityMentions).toHaveBeenCalledOnce();
    const [platform] = mockAggregateAuthorityMentions.mock.calls[0] as [string];
    expect(platform).toBe("google_reviews");

    // No Claude call — Google reviews use star rating, not sentiment classifier
    expect(mockClassifySentimentBatch).not.toHaveBeenCalled();

    // UPSERT into off_site_authority_daily with rating + rating_count populated
    const upserts = dbCalls.filter((c) => c.sql.includes("off_site_authority_daily"));
    expect(upserts).toHaveLength(1);
    const uArgs = upserts[0]!.args;
    expect(uArgs[0]).toBe("bamboo-co");
    expect(uArgs[2]).toBe("google_reviews");
    // args[9] = rating, args[10] = rating_count
    expect(uArgs[9]).toBe(4.8);
    expect(uArgs[10]).toBe(320);

    // Stamp success
    const stampCall = dbCalls.find(
      (c) => c.sql.includes("last_synced_at") && c.sql.includes("last_sync_error = NULL")
             && Array.isArray(c.args) && c.args.includes("bamboo-co"),
    );
    expect(stampCall).toBeDefined();
  });

  // 8. Tenant with both Reddit AND Google runs both branches
  it("8. tenant with both Reddit and Google configured: both branches run, both upsert", async () => {
    const staleRow = {
      slug:            "dual-co",
      brand_keyword:   "dualbrand",
      google_place_id: "ChIJdual",
    };

    // Reddit bucket mock (first call)
    const redditBucket = new Map([
      ["2026-05-06", {
        date: "2026-05-06", platform: "reddit",
        mention_count: 1, positive_count: 1, neutral_count: 0, negative_count: 0,
        avg_sentiment: 0.8, top_mentions_json: "[]",
      }],
    ]);
    // Google bucket mock (second call)
    const googleBucket = new Map([
      ["2026-05-06", {
        date: "2026-05-06", platform: "google_reviews",
        mention_count: 2, positive_count: 2, neutral_count: 0, negative_count: 0,
        avg_sentiment: 0.75, top_mentions_json: "[]",
      }],
    ]);

    mockAggregateAuthorityMentions
      .mockReturnValueOnce(redditBucket)
      .mockReturnValueOnce(googleBucket);

    const { env, dbCalls } = makeEnv({
      GOOGLE_PLACES_API_KEY: "gp_key_test",
      _dbResponses: { authority_config: [staleRow] },
    });

    await runAuthoritySyncBatch(env as never);

    // Both fetches called
    expect(mockSearchRedditMentions).toHaveBeenCalledOnce();
    expect(mockFetchPlaceDetails).toHaveBeenCalledOnce();

    // Two upserts — one per platform
    const upserts = dbCalls.filter((c) => c.sql.includes("off_site_authority_daily"));
    expect(upserts).toHaveLength(2);
    const platforms = upserts.map((u) => u.args[2]);
    expect(platforms).toContain("reddit");
    expect(platforms).toContain("google_reviews");

    // One stamp after both complete
    const stamps = dbCalls.filter(
      (c) => c.sql.includes("last_synced_at") && Array.isArray(c.args) && c.args.includes("dual-co"),
    );
    expect(stamps).toHaveLength(1);
  });

  // 9. Google Places API failure: error isolated, Reddit still runs
  it("9. Google Places API failure: error stamped, Reddit branch still succeeds", async () => {
    const staleRow = {
      slug:            "partial-co",
      brand_keyword:   "partialbrand",
      google_place_id: "ChIJpartial",
    };

    mockFetchPlaceDetails.mockRejectedValueOnce(
      new Error("googlePlaces: fetch failed: 403 REQUEST_DENIED"),
    );

    const { env, dbCalls } = makeEnv({
      GOOGLE_PLACES_API_KEY: "bad_key",
      _dbResponses: { authority_config: [staleRow] },
    });

    await runAuthoritySyncBatch(env as never);

    // The Google failure propagates out of syncOneTenant, so the whole tenant
    // is marked as failed (both branches run serially within the same try/catch).
    // Reddit fetch still called before the Google failure.
    expect(mockSearchRedditMentions).toHaveBeenCalledOnce();

    // last_sync_error should be stamped (Google failure propagated)
    const errUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_error") && !c.sql.includes("NULL")
             && Array.isArray(c.args) && c.args.includes("partial-co"),
    );
    expect(errUpdate).toBeDefined();
    const errMsg = errUpdate!.args[0] as string;
    expect(errMsg).toContain("googlePlaces: fetch failed: 403");
  });
});
