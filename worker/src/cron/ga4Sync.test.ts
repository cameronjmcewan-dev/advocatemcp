/**
 * Tests for worker/src/cron/ga4Sync.ts
 *
 * Strategy: mock D1, fetch, decryptToken, refreshAccessToken,
 * fetchDailyTraffic, and classifyTrafficSource at the module boundary.
 * All HTTP is mocked — no real network calls. Each test verifies one
 * observable behaviour of the sync batch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runGA4SyncBatch } from "./ga4Sync.js";
import { encryptToken } from "../lib/ga4TokenCrypto.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockDecryptToken = vi.fn();
vi.mock("../lib/ga4TokenCrypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ga4TokenCrypto")>();
  return {
    ...actual,
    decryptToken: (...args: unknown[]) => mockDecryptToken(...args),
  };
});

vi.mock("../lib/geoAggregator", () => ({
  aggregateGeoRows: (...args: unknown[]) => mockAggregateGeoRows(...args),
}));
const mockAggregateGeoRows = vi.fn();

const mockRefreshAccessToken = vi.fn();
const mockFetchDailyTraffic = vi.fn();
const mockFetchDailyGeography = vi.fn();
vi.mock("../lib/ga4", () => ({
  refreshAccessToken:   (...args: unknown[]) => mockRefreshAccessToken(...args),
  fetchDailyTraffic:    (...args: unknown[]) => mockFetchDailyTraffic(...args),
  fetchDailyGeography:  (...args: unknown[]) => mockFetchDailyGeography(...args),
}));

const mockClassify = vi.fn();
vi.mock("../lib/aiTrafficClassifier", () => ({
  classifyTrafficSource: (...args: unknown[]) => mockClassify(...args),
}));

// ── D1 stub factory ──────────────────────────────────────────────────────────

/**
 * Build a minimal D1 stub that records every prepare/bind/run/all call.
 *
 * `dbResponses` maps SQL substrings to the row array that `.all()` returns.
 * If no key matches, `.all()` returns [].
 */
function makeDb(
  dbResponses: Record<string, Array<Record<string, unknown>>> = {},
  firstResponses: Record<string, Record<string, unknown> | null> = {},
) {
  const dbCalls: Array<{ sql: string; args: unknown[] }> = [];

  const db = {
    prepare(sql: string) {
      const stmt: {
        _args: unknown[];
        bind: (...args: unknown[]) => typeof stmt;
        run:  () => Promise<{ success: boolean }>;
        all:  <T>() => Promise<{ results: T[] }>;
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
          // find first matching key
          const key = Object.keys(dbResponses).find((k) => sql.includes(k));
          const results = (key ? dbResponses[key] : []) as T[];
          return { results };
        },
        async first<T>() {
          dbCalls.push({ sql, args: stmt._args });
          // Lookup by SQL substring match — same dispatch model as all().
          // Lets new tests inject `{ c: N }` rowcount responses for the
          // cron's adaptive-lookback rowcount check without rewriting
          // the rest of the harness.
          const key = Object.keys(firstResponses).find((k) => sql.includes(k));
          return (key ? firstResponses[key] : null) as T | null;
        },
      };
      return stmt;
    },
  };

  return { db, dbCalls };
}

// ── Env helpers ──────────────────────────────────────────────────────────────

const TEST_KEY = "0".repeat(64); // 64-char hex = 32 bytes for AES-256

function makeEnv(overrides: Record<string, unknown> = {}) {
  const { db, dbCalls } = makeDb(
    (overrides._dbResponses as Record<string, Array<Record<string, unknown>>>) ?? {},
    (overrides._firstResponses as Record<string, Record<string, unknown> | null>) ?? {},
  );
  // Remove internal helper keys before spreading
  const { _dbResponses: _dbResponses, _firstResponses: _firstResponses, ...rest } = overrides;
  return {
    env: {
      GA4_TOKEN_ENCRYPTION_KEY: TEST_KEY,
      GA4_OAUTH_CLIENT_ID:      "client-id",
      GA4_OAUTH_CLIENT_SECRET:  "client-secret",
      DB: db,
      ...rest,
    },
    dbCalls,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockResolvedValue("decrypted-refresh-token");
  mockRefreshAccessToken.mockResolvedValue({ accessToken: "ya29.fresh", expiresIn: 3600 });
  mockFetchDailyTraffic.mockResolvedValue([]);
  mockFetchDailyGeography.mockResolvedValue([]);
  mockAggregateGeoRows.mockReturnValue(new Map());
  mockClassify.mockReturnValue("human");
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("runGA4SyncBatch", () => {
  // 1. Quiet-skip when GA4 env vars are unset (no D1 calls)
  it("1. quiet-skip when GA4_TOKEN_ENCRYPTION_KEY is unset", async () => {
    const { env, dbCalls } = makeEnv({ GA4_TOKEN_ENCRYPTION_KEY: undefined });
    await runGA4SyncBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  it("2. quiet-skip when GA4_OAUTH_CLIENT_ID is unset", async () => {
    const { env, dbCalls } = makeEnv({ GA4_OAUTH_CLIENT_ID: undefined });
    await runGA4SyncBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  it("3. quiet-skip when GA4_OAUTH_CLIENT_SECRET is unset", async () => {
    const { env, dbCalls } = makeEnv({ GA4_OAUTH_CLIENT_SECRET: undefined });
    await runGA4SyncBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  // 2. No-op when no stale tenants exist
  it("4. no-op when stale-tenant query returns empty results", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [] },
    });
    await runGA4SyncBatch(env as never);
    // Only the SELECT should have fired; no run() calls for UPDATEs / INSERTs
    const runCalls = dbCalls.filter((c) => !c.sql.trim().toUpperCase().startsWith("SELECT"));
    expect(runCalls).toHaveLength(0);
  });

  // 3. Happy path: stale tenant → fetch → upsert → last_sync_at updated → geo upserts fire
  it("5. happy path: upserts traffic_daily, stamps last_sync_at, and fires geo upserts for stale tenant", async () => {
    const encryptedToken = await encryptToken("rt-abc", TEST_KEY);
    const staleRow = { slug: "tenant-a", refresh_token_enc: encryptedToken, property_id: "properties/123" };

    mockFetchDailyTraffic.mockResolvedValue([
      {
        date: "2026-05-05", source: "perplexity.ai", medium: "referral", sessions: 10,
        engagedSessions: 8, averageSessionDuration: 95.0, bounceRate: 0.20, newUsers: 6, totalUsers: 10,
      },
      {
        date: "2026-05-05", source: "google", medium: "organic", sessions: 20,
        engagedSessions: 14, averageSessionDuration: 110.5, bounceRate: 0.30, newUsers: 12, totalUsers: 20,
      },
    ]);
    // perplexity is ai, google is human
    mockClassify.mockImplementation((_src: string, _med: string) =>
      _src.includes("perplexity") ? "ai" : "human",
    );

    // Geo mock: one geo bucket for the date
    const geoBuckets = new Map([
      [
        "2026-05-05|United States|New York",
        { date: "2026-05-05", country: "United States", city: "New York", ai_sessions: 10, human_sessions: 5 },
      ],
    ]);
    mockFetchDailyGeography.mockResolvedValue([]);  // raw rows not used — aggregator is mocked
    mockAggregateGeoRows.mockReturnValue(geoBuckets);

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [staleRow] },
    });

    await runGA4SyncBatch(env as never);

    // decryptToken called with the encrypted value and the correct key
    expect(mockDecryptToken).toHaveBeenCalledWith(encryptedToken, TEST_KEY);

    // refreshAccessToken called with the decrypted refresh token
    expect(mockRefreshAccessToken).toHaveBeenCalledWith(
      "decrypted-refresh-token",
      "client-id",
      "client-secret",
    );

    // fetchDailyTraffic called with the correct property + date window
    expect(mockFetchDailyTraffic).toHaveBeenCalledOnce();
    const fetchArgs = mockFetchDailyTraffic.mock.calls[0][0] as {
      propertyId: string;
      startDate: string;
      endDate: string;
      accessToken: string;
    };
    expect(fetchArgs.propertyId).toBe("properties/123");
    expect(fetchArgs.accessToken).toBe("ya29.fresh");
    // startDate is 2 days ago; endDate is 1 day ago — just verify they differ
    expect(fetchArgs.startDate < fetchArgs.endDate).toBe(true);

    // fetchDailyGeography called with the same property + date window + access token
    expect(mockFetchDailyGeography).toHaveBeenCalledOnce();
    const geoFetchArgs = mockFetchDailyGeography.mock.calls[0][0] as {
      propertyId: string;
      startDate: string;
      endDate: string;
      accessToken: string;
    };
    expect(geoFetchArgs.propertyId).toBe("properties/123");
    expect(geoFetchArgs.accessToken).toBe("ya29.fresh");

    // An INSERT ... ON CONFLICT upsert must have fired on traffic_daily with all 11 columns bound
    const upsertCall = dbCalls.find((c) => c.sql.includes("traffic_daily") && c.sql.includes("ON CONFLICT"));
    expect(upsertCall).toBeDefined();
    // 11 bind args: slug, date, ai_sessions, human_sessions, total_sessions,
    //   top_sources_json, engagement_rate, avg_session_duration_sec,
    //   bounce_rate, new_users, returning_users
    expect(Array.isArray(upsertCall?.args)).toBe(true);
    expect((upsertCall?.args as unknown[]).length).toBe(11);

    // A geo upsert must have fired on traffic_geo_daily with 6 bind args
    const geoUpsertCall = dbCalls.find((c) => c.sql.includes("traffic_geo_daily") && c.sql.includes("ON CONFLICT"));
    expect(geoUpsertCall).toBeDefined();
    // 6 bind args: slug, date, country, city, ai_sessions, human_sessions
    expect(Array.isArray(geoUpsertCall?.args)).toBe(true);
    expect((geoUpsertCall?.args as unknown[]).length).toBe(6);
    expect((geoUpsertCall?.args as unknown[])[0]).toBe("tenant-a");
    expect((geoUpsertCall?.args as unknown[])[1]).toBe("2026-05-05");
    expect((geoUpsertCall?.args as unknown[])[2]).toBe("United States");
    expect((geoUpsertCall?.args as unknown[])[3]).toBe("New York");

    // last_sync_at UPDATE must have fired for slug=tenant-a
    const updateCall = dbCalls.find(
      (c) => c.sql.includes("last_sync_at") && Array.isArray(c.args) && c.args.includes("tenant-a"),
    );
    expect(updateCall).toBeDefined();

    // last_sync_error must be cleared (NULL) in the success update
    expect(updateCall?.sql).toContain("last_sync_error = NULL");
  });

  // Geo failure isolation: geo fetch throws → main sync still succeeded
  it("12. geo failure does not fail the main sync — last_sync_at still stamped", async () => {
    const enc = await encryptToken("rt-geo-fail", TEST_KEY);
    const staleRow = { slug: "tenant-geo-fail", refresh_token_enc: enc, property_id: "properties/999" };

    mockFetchDailyTraffic.mockResolvedValue([]);
    mockFetchDailyGeography.mockRejectedValue(new Error("ga4: runReport failed: 429 Quota exceeded"));

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [staleRow] },
    });

    // Must not throw — geo failure is swallowed
    await expect(runGA4SyncBatch(env as never)).resolves.toBeUndefined();

    // last_sync_at must still be stamped (main sync was successful)
    const successUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_at") && c.sql.includes("last_sync_error = NULL")
             && Array.isArray(c.args) && c.args.includes("tenant-geo-fail"),
    );
    expect(successUpdate).toBeDefined();

    // No error update on ga4_connections status — geo error is NOT persisted there
    const errorUpdate = dbCalls.find(
      (c) => c.sql.includes("status = 'error'") && Array.isArray(c.args) && c.args.includes("tenant-geo-fail"),
    );
    expect(errorUpdate).toBeUndefined();
  });

  // 4. Error isolation: tenant A throws → tenant B still succeeds
  it("6. error isolation: tenant B syncs even when tenant A throws", async () => {
    const encA = await encryptToken("rt-a", TEST_KEY);
    const encB = await encryptToken("rt-b", TEST_KEY);

    const rows = [
      { slug: "tenant-a", refresh_token_enc: encA, property_id: "properties/111" },
      { slug: "tenant-b", refresh_token_enc: encB, property_id: "properties/222" },
    ];

    mockDecryptToken
      .mockResolvedValueOnce("rt-a-decrypted")  // tenant-a decrypts ok
      .mockResolvedValueOnce("rt-b-decrypted");  // tenant-b decrypts ok

    mockRefreshAccessToken
      .mockRejectedValueOnce(new Error("ga4: refresh failed: 401 invalid_grant")) // tenant-a fails
      .mockResolvedValueOnce({ accessToken: "ya29.b", expiresIn: 3600 });         // tenant-b ok

    mockFetchDailyTraffic.mockResolvedValue([]);

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": rows },
    });

    // Must not throw — Promise.allSettled isolation
    await expect(runGA4SyncBatch(env as never)).resolves.toBeUndefined();

    // tenant-a should get last_sync_error stamped
    const errorUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_error") && !c.sql.includes("NULL") && Array.isArray(c.args) && c.args.includes("tenant-a"),
    );
    expect(errorUpdate).toBeDefined();

    // tenant-b should get last_sync_at stamped (success path)
    const successUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_at") && c.sql.includes("last_sync_error = NULL") && Array.isArray(c.args) && c.args.includes("tenant-b"),
    );
    expect(successUpdate).toBeDefined();
  });

  // 5. Stale-tenant filter: verify the SQL bind arg for the cutoff
  it("7. stale-tenant SELECT binds a cutoff ~23h in the past", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [] },
    });

    const before = new Date();
    await runGA4SyncBatch(env as never);
    const after = new Date();

    const selectCall = dbCalls.find((c) => c.sql.includes("ga4_connections"));
    expect(selectCall).toBeDefined();

    // The cutoff is bind arg [0]
    const cutoff = new Date(selectCall!.args[0] as string);
    const msBefore = before.getTime() - 23 * 60 * 60 * 1000 - 5000; // 5s slack
    const msAfter  = after.getTime()  - 23 * 60 * 60 * 1000 + 5000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(msBefore);
    expect(cutoff.getTime()).toBeLessThanOrEqual(msAfter);
  });

  // 6. Cap at 50 per cron tick
  it("8. SQL query contains LIMIT 50", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [] },
    });
    await runGA4SyncBatch(env as never);
    const selectCall = dbCalls.find((c) => c.sql.includes("ga4_connections"));
    expect(selectCall?.sql).toContain("LIMIT 50");
  });

  // 7. Tenant with status='disconnected' is excluded by WHERE clause
  it("9. WHERE clause excludes disconnected tenants", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [] },
    });
    await runGA4SyncBatch(env as never);
    const selectCall = dbCalls.find((c) => c.sql.includes("ga4_connections"));
    expect(selectCall?.sql).toMatch(/status\s*!=\s*'disconnected'/);
  });

  // Self-heal: tenants with last_sync_at IS NULL are INCLUDED so the
  // cron can backfill any tenant whose inline OAuth-time backfill
  // silently failed. Inverted from the original test (which pinned
  // the IS NOT NULL filter as a load-shedding decision). The new
  // contract: select picks up BOTH NULL last_sync_at and stale
  // last_sync_at. Combined with the adaptive lookback window in
  // syncOneTenant (test below), this means a tenant who never got a
  // successful backfill recovers on the next cron tick.
  it("10. WHERE clause picks up NULL last_sync_at AND stale last_sync_at (self-heal)", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [] },
    });
    await runGA4SyncBatch(env as never);
    const selectCall = dbCalls.find((c) => c.sql.includes("ga4_connections"));
    // SQL should branch on either NULL OR stale, not require IS NOT NULL.
    expect(selectCall?.sql).toMatch(/last_sync_at\s+IS\s+NULL\s+OR\s+last_sync_at\s*<\s*\?/);
    expect(selectCall?.sql).not.toMatch(/last_sync_at\s+IS\s+NOT\s+NULL/);
  });

  // Bonus: status is set to 'error' and last_sync_error is the message (truncated to 500)
  it("11. error update sets status=error and persists truncated error message", async () => {
    const enc = await encryptToken("rt", TEST_KEY);
    const row = { slug: "bad-tenant", refresh_token_enc: enc, property_id: "properties/1" };

    mockDecryptToken.mockResolvedValue("rt-plain");
    mockRefreshAccessToken.mockRejectedValue(new Error("ga4: refresh failed: 401 expired"));

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [row] },
    });

    await runGA4SyncBatch(env as never);

    const errUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_error") && !c.sql.includes("NULL") && Array.isArray(c.args) && c.args.includes("bad-tenant"),
    );
    expect(errUpdate).toBeDefined();
    expect(errUpdate?.sql).toContain("status = 'error'");

    // First arg to the UPDATE bind is the error message string
    const errMsg = errUpdate?.args[0] as string;
    expect(typeof errMsg).toBe("string");
    expect(errMsg).toContain("401 expired");
    // Message must be capped at 500 chars
    expect(errMsg.length).toBeLessThanOrEqual(500);
  });

  // ── Adaptive lookback window (self-heal backfill, May 2026) ────────────
  //
  // Two adaptive-lookback tests + one inverse test that locks in the
  // normal incremental sync path. The contract: when traffic_daily has
  // fewer than MIN_HEALTHY_ROWS (30) rows for a slug, the cron treats
  // it as "needs backfill" and pulls 540 days (matches the inline
  // OAuth-time backfill in portal.ts). Otherwise it does the cheap
  // 2-day incremental sync.

  it("13. adaptive lookback: rowcount < 30 triggers 540-day backfill window", async () => {
    const enc = await encryptToken("rt", TEST_KEY);
    const row = { slug: "new-tenant", refresh_token_enc: enc, property_id: "properties/1" };

    const { env } = makeEnv({
      _dbResponses:   { "ga4_connections": [row] },
      _firstResponses: { "COUNT(*) AS c FROM traffic_daily": { c: 6 } },
    });

    await runGA4SyncBatch(env as never);

    expect(mockFetchDailyTraffic).toHaveBeenCalledTimes(1);
    const callArgs = mockFetchDailyTraffic.mock.calls[0]![0] as {
      startDate: string; endDate: string;
    };
    const start = new Date(callArgs.startDate);
    const end   = new Date(callArgs.endDate);
    const spanDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    // 540 ± 1 day to absorb DST / timezone edge.
    expect(spanDays).toBeGreaterThanOrEqual(539);
    expect(spanDays).toBeLessThanOrEqual(541);
  });

  it("14. adaptive lookback: rowcount >= 30 stays on the 2-day incremental window", async () => {
    const enc = await encryptToken("rt", TEST_KEY);
    const row = { slug: "healthy-tenant", refresh_token_enc: enc, property_id: "properties/2" };

    const { env } = makeEnv({
      _dbResponses:   { "ga4_connections": [row] },
      _firstResponses: { "COUNT(*) AS c FROM traffic_daily": { c: 200 } },
    });

    await runGA4SyncBatch(env as never);

    expect(mockFetchDailyTraffic).toHaveBeenCalledTimes(1);
    const callArgs = mockFetchDailyTraffic.mock.calls[0]![0] as {
      startDate: string; endDate: string;
    };
    const start = new Date(callArgs.startDate);
    const end   = new Date(callArgs.endDate);
    const spanDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    // Incremental sync = yesterday + day-before-yesterday = 1-day span.
    // (start = day-before-yesterday, end = yesterday → diff = 1 day)
    expect(spanDays).toBe(1);
  });

  it("15. adaptive lookback: rowcount of 0 (truly empty) still triggers backfill window", async () => {
    // Edge case: brand-new tenant whose inline OAuth-backfill never
    // ran. last_sync_at is NULL (we test the SELECT picks them up in
    // test 10) AND traffic_daily has zero rows. Self-heal must still
    // fire the wide window — without it the tenant gets stuck at "1
    // day of data" forever.
    const enc = await encryptToken("rt", TEST_KEY);
    const row = { slug: "zero-rows", refresh_token_enc: enc, property_id: "properties/3" };

    const { env } = makeEnv({
      _dbResponses:   { "ga4_connections": [row] },
      _firstResponses: { "COUNT(*) AS c FROM traffic_daily": { c: 0 } },
    });

    await runGA4SyncBatch(env as never);

    expect(mockFetchDailyTraffic).toHaveBeenCalledTimes(1);
    const callArgs = mockFetchDailyTraffic.mock.calls[0]![0] as {
      startDate: string; endDate: string;
    };
    const spanDays = Math.round(
      (new Date(callArgs.endDate).getTime() - new Date(callArgs.startDate).getTime())
      / (1000 * 60 * 60 * 24),
    );
    expect(spanDays).toBeGreaterThanOrEqual(539);
    expect(spanDays).toBeLessThanOrEqual(541);
  });
});
