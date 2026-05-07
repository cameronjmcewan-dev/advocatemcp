/**
 * Tests for worker/src/cron/gscSync.ts
 *
 * Strategy: mock D1, fetch, decryptToken, refreshAccessToken,
 * and fetchSearchAnalytics at the module boundary.
 * All HTTP is mocked — no real network calls. Each test verifies one
 * observable behaviour of the GSC sync batch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runGSCSyncBatch } from "./gscSync.js";
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

const mockRefreshAccessToken = vi.fn();
vi.mock("../lib/ga4", () => ({
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
}));

const mockFetchSearchAnalytics = vi.fn();
const mockFetchAiOverviewQueries = vi.fn();
vi.mock("../lib/gsc", () => ({
  fetchSearchAnalytics:    (...args: unknown[]) => mockFetchSearchAnalytics(...args),
  fetchAiOverviewQueries:  (...args: unknown[]) => mockFetchAiOverviewQueries(...args),
}));

// ── D1 stub factory ──────────────────────────────────────────────────────────

function makeDb(dbResponses: Record<string, Array<Record<string, unknown>>> = {}) {
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

// ── Env helpers ──────────────────────────────────────────────────────────────

const TEST_KEY = "0".repeat(64); // 64-char hex = 32 bytes for AES-256

function makeEnv(overrides: Record<string, unknown> = {}) {
  const { db, dbCalls } = makeDb(
    (overrides._dbResponses as Record<string, Array<Record<string, unknown>>>) ?? {},
  );
  const { _dbResponses: _, ...rest } = overrides;
  return {
    env: {
      GA4_TOKEN_ENCRYPTION_KEY: TEST_KEY,
      GSC_OAUTH_CLIENT_ID:      "gsc-client-id",
      GSC_OAUTH_CLIENT_SECRET:  "gsc-client-secret",
      DB: db,
      ...rest,
    },
    dbCalls,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockResolvedValue("decrypted-refresh-token");
  mockRefreshAccessToken.mockResolvedValue({ accessToken: "ya29.fresh", expiresIn: 3600 });
  mockFetchSearchAnalytics.mockResolvedValue([]);
  mockFetchAiOverviewQueries.mockResolvedValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runGSCSyncBatch", () => {
  // 1. Quiet-skip when env vars are unset
  it("1. quiet-skip when GA4_TOKEN_ENCRYPTION_KEY is unset", async () => {
    const { env, dbCalls } = makeEnv({ GA4_TOKEN_ENCRYPTION_KEY: undefined });
    await runGSCSyncBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  it("2. quiet-skip when GSC_OAUTH_CLIENT_ID is unset", async () => {
    const { env, dbCalls } = makeEnv({ GSC_OAUTH_CLIENT_ID: undefined });
    await runGSCSyncBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  it("3. quiet-skip when GSC_OAUTH_CLIENT_SECRET is unset", async () => {
    const { env, dbCalls } = makeEnv({ GSC_OAUTH_CLIENT_SECRET: undefined });
    await runGSCSyncBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  // 2. No-op when no stale tenants exist
  it("4. no-op when stale-tenant query returns empty results", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [] },
    });
    await runGSCSyncBatch(env as never);
    const runCalls = dbCalls.filter((c) => !c.sql.trim().toUpperCase().startsWith("SELECT"));
    expect(runCalls).toHaveLength(0);
  });

  // 3. Happy path: stale tenant → fetch → upsert → AI Overview UPDATE → last_sync_at updated
  it("5. happy path: upserts gsc_daily, fires ai_overview UPDATE for matching rows, stamps last_sync_at", async () => {
    const encryptedToken = await encryptToken("rt-gsc", TEST_KEY);
    const staleRow = {
      slug: "tenant-a",
      refresh_token_enc: encryptedToken,
      site_url: "https://example.com/",
    };

    mockFetchSearchAnalytics.mockResolvedValue([
      { date: "2026-05-04", query: "best plumber austin", impressions: 200, clicks: 10, ctr: 0.05, position: 3.1 },
      { date: "2026-05-04", query: "emergency plumber",   impressions: 80,  clicks:  4, ctr: 0.05, position: 5.0 },
    ]);
    // One of the two queries appeared in an AI Overview
    mockFetchAiOverviewQueries.mockResolvedValue([
      { date: "2026-05-04", query: "best plumber austin", impressions: 150, clicks: 3 },
    ]);

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [staleRow] },
    });

    await runGSCSyncBatch(env as never);

    // decryptToken called with encrypted value and correct key
    expect(mockDecryptToken).toHaveBeenCalledWith(encryptedToken, TEST_KEY);

    // refreshAccessToken called with decrypted refresh token + GSC client creds
    expect(mockRefreshAccessToken).toHaveBeenCalledWith(
      "decrypted-refresh-token",
      "gsc-client-id",
      "gsc-client-secret",
    );

    // fetchSearchAnalytics called with site_url + date window
    expect(mockFetchSearchAnalytics).toHaveBeenCalledOnce();
    const fetchArgs = mockFetchSearchAnalytics.mock.calls[0][0] as {
      siteUrl: string;
      startDate: string;
      endDate: string;
      accessToken: string;
    };
    expect(fetchArgs.siteUrl).toBe("https://example.com/");
    expect(fetchArgs.accessToken).toBe("ya29.fresh");
    expect(fetchArgs.startDate < fetchArgs.endDate).toBe(true);

    // fetchAiOverviewQueries called once with the same siteUrl + date window
    expect(mockFetchAiOverviewQueries).toHaveBeenCalledOnce();
    const aiArgs = mockFetchAiOverviewQueries.mock.calls[0][0] as {
      siteUrl: string; startDate: string; endDate: string; accessToken: string;
    };
    expect(aiArgs.siteUrl).toBe("https://example.com/");
    expect(aiArgs.accessToken).toBe("ya29.fresh");
    expect(aiArgs.startDate).toBe(fetchArgs.startDate);
    expect(aiArgs.endDate).toBe(fetchArgs.endDate);

    // gsc_daily upserts must have fired (two rows)
    const upsertCalls = dbCalls.filter(
      (c) => c.sql.includes("gsc_daily") && c.sql.includes("ON CONFLICT"),
    );
    expect(upsertCalls.length).toBeGreaterThanOrEqual(2);
    // Each upsert bind: slug, date, query, impressions, clicks, ctr, position = 7 args
    expect((upsertCalls[0].args as unknown[]).length).toBe(7);
    expect(upsertCalls[0].args[0]).toBe("tenant-a");

    // ai_overview_shown UPDATE must have fired for the matching row
    const aiUpdateCalls = dbCalls.filter(
      (c) => c.sql.includes("ai_overview_shown") && c.sql.includes("UPDATE gsc_daily"),
    );
    expect(aiUpdateCalls).toHaveLength(1);
    expect(aiUpdateCalls[0].args[0]).toBe("tenant-a");
    expect(aiUpdateCalls[0].args[1]).toBe("2026-05-04");
    expect(aiUpdateCalls[0].args[2]).toBe("best plumber austin");

    // last_sync_at UPDATE must have fired
    const updateCall = dbCalls.find(
      (c) => c.sql.includes("last_sync_at") && Array.isArray(c.args) && c.args.includes("tenant-a"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.sql).toContain("last_sync_error = NULL");
  });

  // 4. Error isolation: tenant A throws → tenant B still succeeds
  it("6. error isolation: tenant B syncs even when tenant A throws", async () => {
    const encA = await encryptToken("rt-a", TEST_KEY);
    const encB = await encryptToken("rt-b", TEST_KEY);

    const rows = [
      { slug: "tenant-a", refresh_token_enc: encA, site_url: "https://a.com/" },
      { slug: "tenant-b", refresh_token_enc: encB, site_url: "https://b.com/" },
    ];

    mockDecryptToken
      .mockResolvedValueOnce("rt-a-decrypted")
      .mockResolvedValueOnce("rt-b-decrypted");

    mockRefreshAccessToken
      .mockRejectedValueOnce(new Error("gsc: refresh failed: 401 invalid_grant"))
      .mockResolvedValueOnce({ accessToken: "ya29.b", expiresIn: 3600 });

    mockFetchSearchAnalytics.mockResolvedValue([]);

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": rows },
    });

    // Must not throw — Promise.allSettled isolation
    await expect(runGSCSyncBatch(env as never)).resolves.toBeUndefined();

    // tenant-a should get last_sync_error stamped
    const errorUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_error") && !c.sql.includes("NULL")
             && Array.isArray(c.args) && c.args.includes("tenant-a"),
    );
    expect(errorUpdate).toBeDefined();

    // tenant-b should get last_sync_at stamped (success path)
    const successUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_at") && c.sql.includes("last_sync_error = NULL")
             && Array.isArray(c.args) && c.args.includes("tenant-b"),
    );
    expect(successUpdate).toBeDefined();
  });

  // 5. Stale-tenant filter: verify SQL cutoff bind arg
  it("7. stale-tenant SELECT binds a cutoff ~23h in the past", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [] },
    });

    const before = new Date();
    await runGSCSyncBatch(env as never);
    const after = new Date();

    const selectCall = dbCalls.find((c) => c.sql.includes("gsc_connections"));
    expect(selectCall).toBeDefined();

    const cutoff = new Date(selectCall!.args[0] as string);
    const msBefore = before.getTime() - 23 * 60 * 60 * 1000 - 5000;
    const msAfter  = after.getTime()  - 23 * 60 * 60 * 1000 + 5000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(msBefore);
    expect(cutoff.getTime()).toBeLessThanOrEqual(msAfter);
  });

  // 6. Top-100 cap per day: 200-row response yields only 100 upserts for that date
  it("8. caps queries at top-100 per day by impressions (200-row mock → 100 upserts)", async () => {
    const enc = await encryptToken("rt-cap", TEST_KEY);
    const staleRow = { slug: "tenant-cap", refresh_token_enc: enc, site_url: "https://big.com/" };

    // Build 200 rows all for the same date, with distinct impression counts
    const manyRows = Array.from({ length: 200 }, (_, i) => ({
      date:        "2026-05-05",
      query:       `query number ${i}`,
      impressions: 200 - i,   // descending, so first 100 are the top 100
      clicks:      1,
      ctr:         0.01,
      position:    5.0,
    }));
    mockFetchSearchAnalytics.mockResolvedValue(manyRows);

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [staleRow] },
    });

    await runGSCSyncBatch(env as never);

    // Only 100 gsc_daily upserts should have fired (not 200)
    const upsertCalls = dbCalls.filter(
      (c) => c.sql.includes("gsc_daily") && c.sql.includes("ON CONFLICT"),
    );
    expect(upsertCalls).toHaveLength(100);

    // Verify the top impression query (impressions=200, "query number 0") is included
    const firstQuery = upsertCalls[0].args[2] as string;
    expect(firstQuery).toBe("query number 0");
  });

  // WHERE clause assertions
  it("9. SQL query contains LIMIT 50", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [] },
    });
    await runGSCSyncBatch(env as never);
    const selectCall = dbCalls.find((c) => c.sql.includes("gsc_connections"));
    expect(selectCall?.sql).toContain("LIMIT 50");
  });

  it("10. WHERE clause excludes disconnected tenants", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [] },
    });
    await runGSCSyncBatch(env as never);
    const selectCall = dbCalls.find((c) => c.sql.includes("gsc_connections"));
    expect(selectCall?.sql).toMatch(/status\s*!=\s*'disconnected'/);
  });

  it("11. WHERE clause requires site_url IS NOT NULL", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [] },
    });
    await runGSCSyncBatch(env as never);
    const selectCall = dbCalls.find((c) => c.sql.includes("gsc_connections"));
    expect(selectCall?.sql).toContain("site_url IS NOT NULL");
  });

  it("12. error update sets status=error and persists truncated error message", async () => {
    const enc = await encryptToken("rt", TEST_KEY);
    const row = { slug: "bad-tenant", refresh_token_enc: enc, site_url: "https://bad.com/" };

    mockDecryptToken.mockResolvedValue("rt-plain");
    mockRefreshAccessToken.mockRejectedValue(new Error("gsc: refresh failed: 401 expired"));

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [row] },
    });

    await runGSCSyncBatch(env as never);

    const errUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_error") && !c.sql.includes("NULL")
             && Array.isArray(c.args) && c.args.includes("bad-tenant"),
    );
    expect(errUpdate).toBeDefined();
    expect(errUpdate?.sql).toContain("status = 'error'");

    const errMsg = errUpdate?.args[0] as string;
    expect(typeof errMsg).toBe("string");
    expect(errMsg).toContain("401 expired");
    expect(errMsg.length).toBeLessThanOrEqual(500);
  });

  // AI Overview failure isolation
  it("13. AI Overview detection failure does NOT block main upsert or last_sync_at stamp", async () => {
    const enc = await encryptToken("rt-ai", TEST_KEY);
    const staleRow = { slug: "tenant-ai", refresh_token_enc: enc, site_url: "https://ai.com/" };

    mockFetchSearchAnalytics.mockResolvedValue([
      { date: "2026-05-04", query: "emergency plumber", impressions: 80, clicks: 4, ctr: 0.05, position: 5.0 },
    ]);
    // AI Overview fetch fails with a 500-style error
    mockFetchAiOverviewQueries.mockRejectedValue(new Error("gsc: aiOverview query failed: 500 Internal"));

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [staleRow] },
    });

    // Must not throw
    await expect(runGSCSyncBatch(env as never)).resolves.toBeUndefined();

    // Main upsert still fired for the GSC row
    const upsertCalls = dbCalls.filter(
      (c) => c.sql.includes("gsc_daily") && c.sql.includes("ON CONFLICT"),
    );
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);

    // last_sync_at still got stamped (success path for the main sync)
    const successUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_at") && c.sql.includes("last_sync_error = NULL")
             && Array.isArray(c.args) && c.args.includes("tenant-ai"),
    );
    expect(successUpdate).toBeDefined();

    // last_sync_error must NOT have been set to the AI error
    const errorUpdate = dbCalls.find(
      (c) => c.sql.includes("last_sync_error") && !c.sql.includes("NULL")
             && Array.isArray(c.args) && c.args.includes("tenant-ai"),
    );
    expect(errorUpdate).toBeUndefined();
  });

  it("14. AI Overview UPDATE fires for each row returned by fetchAiOverviewQueries", async () => {
    const enc = await encryptToken("rt-multi-ai", TEST_KEY);
    const staleRow = { slug: "tenant-multi", refresh_token_enc: enc, site_url: "https://multi.com/" };

    mockFetchSearchAnalytics.mockResolvedValue([
      { date: "2026-05-03", query: "query a", impressions: 100, clicks: 5, ctr: 0.05, position: 2.0 },
      { date: "2026-05-03", query: "query b", impressions: 80,  clicks: 3, ctr: 0.04, position: 3.0 },
      { date: "2026-05-04", query: "query c", impressions: 60,  clicks: 2, ctr: 0.03, position: 4.0 },
    ]);
    // Two AI Overview hits across two different dates
    mockFetchAiOverviewQueries.mockResolvedValue([
      { date: "2026-05-03", query: "query a", impressions: 90, clicks: 4 },
      { date: "2026-05-04", query: "query c", impressions: 50, clicks: 1 },
    ]);

    const { env, dbCalls } = makeEnv({
      _dbResponses: { "gsc_connections": [staleRow] },
    });

    await runGSCSyncBatch(env as never);

    const aiUpdateCalls = dbCalls.filter(
      (c) => c.sql.includes("ai_overview_shown") && c.sql.includes("UPDATE gsc_daily"),
    );
    // One UPDATE per AI Overview row
    expect(aiUpdateCalls).toHaveLength(2);
    // Each UPDATE is scoped to (slug, date, query)
    expect(aiUpdateCalls[0].args).toEqual(["tenant-multi", "2026-05-03", "query a"]);
    expect(aiUpdateCalls[1].args).toEqual(["tenant-multi", "2026-05-04", "query c"]);
  });
});
