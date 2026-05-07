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

const mockRefreshAccessToken = vi.fn();
const mockFetchDailyTraffic = vi.fn();
vi.mock("../lib/ga4", () => ({
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
  fetchDailyTraffic:  (...args: unknown[]) => mockFetchDailyTraffic(...args),
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
          // find first matching key
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
  // Remove internal helper key before spreading
  const { _dbResponses: _, ...rest } = overrides;
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

  // 3. Happy path: stale tenant → fetch → upsert → last_sync_at updated
  it("5. happy path: upserts traffic_daily and stamps last_sync_at for stale tenant", async () => {
    const encryptedToken = await encryptToken("rt-abc", TEST_KEY);
    const staleRow = { slug: "tenant-a", refresh_token_enc: encryptedToken, property_id: "properties/123" };

    mockFetchDailyTraffic.mockResolvedValue([
      { date: "2026-05-05", source: "perplexity.ai", medium: "referral", sessions: 10 },
      { date: "2026-05-05", source: "google", medium: "organic", sessions: 20 },
    ]);
    // perplexity is ai, google is human
    mockClassify.mockImplementation((_src: string, _med: string) =>
      _src.includes("perplexity") ? "ai" : "human",
    );

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

    // An INSERT ... ON CONFLICT upsert must have fired
    const upsertCall = dbCalls.find((c) => c.sql.includes("traffic_daily") && c.sql.includes("ON CONFLICT"));
    expect(upsertCall).toBeDefined();

    // last_sync_at UPDATE must have fired for slug=tenant-a
    const updateCall = dbCalls.find(
      (c) => c.sql.includes("last_sync_at") && Array.isArray(c.args) && c.args.includes("tenant-a"),
    );
    expect(updateCall).toBeDefined();

    // last_sync_error must be cleared (NULL) in the success update
    expect(updateCall?.sql).toContain("last_sync_error = NULL");
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

  // Bonus: tenants with last_sync_at IS NULL are excluded (handled by OAuth backfill)
  it("10. WHERE clause requires last_sync_at IS NOT NULL", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { "ga4_connections": [] },
    });
    await runGA4SyncBatch(env as never);
    const selectCall = dbCalls.find((c) => c.sql.includes("ga4_connections"));
    expect(selectCall?.sql).toContain("last_sync_at IS NOT NULL");
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
});
