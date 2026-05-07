/**
 * Tests for worker/src/cron/authoritySync.ts
 *
 * Mocks D1, searchRedditMentions, classifySentimentBatch, and
 * aggregateAuthorityMentions at the module boundary.
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

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchRedditMentions.mockResolvedValue([SAMPLE_MENTION]);
  mockClassifySentimentBatch.mockResolvedValue(SAMPLE_SENTIMENT);
  mockAggregateAuthorityMentions.mockReturnValue(SAMPLE_BUCKET);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAuthoritySyncBatch", () => {
  // 1. Quiet-skip when API key missing
  it("1. quiet-skip when ANTHROPIC_API_KEY is unset", async () => {
    const { env, dbCalls } = makeEnv({ ANTHROPIC_API_KEY: undefined });
    await runAuthoritySyncBatch(env as never);
    expect(dbCalls).toHaveLength(0);
    expect(mockSearchRedditMentions).not.toHaveBeenCalled();
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

  // 3. Happy path
  it("3. happy path: stale tenant → Reddit fetch → sentiment classify → aggregate → upsert + stamp", async () => {
    const staleRow = { slug: "acme-co", brand_keyword: "acme" };
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
    const rowA = { slug: "biz-a", brand_keyword: "brand-a" };
    const rowB = { slug: "biz-b", brand_keyword: "brand-b" };

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
    const staleRow = { slug: "rate-limited-biz", brand_keyword: "brand" };
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
    expect(selectCall!.sql).toContain("reddit_enabled = 1");

    const cutoff = new Date(selectCall!.args[0] as string);
    const msBefore = before.getTime() - 23 * 60 * 60 * 1000 - 5000;
    const msAfter  = after.getTime()  - 23 * 60 * 60 * 1000 + 5000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(msBefore);
    expect(cutoff.getTime()).toBeLessThanOrEqual(msAfter);
  });
});
