/**
 * Tests for worker/src/cron/crmLtvSync.ts
 *
 * Strategy: mock D1, decryptToken, refreshHubspotAccessToken,
 * refreshSalesforceAccessToken, fetchContactsWithRevenue (both providers),
 * and aggregateLtv at the module boundary.
 * All HTTP is mocked — no real network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCrmLtvSnapshotBatch } from "./crmLtvSync.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockDecryptToken = vi.fn();
vi.mock("../lib/ga4TokenCrypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ga4TokenCrypto")>();
  return {
    ...actual,
    decryptToken: (...args: unknown[]) => mockDecryptToken(...args),
  };
});

const mockRefreshHubspotAccessToken = vi.fn();
const mockFetchHubspotContactsWithRevenue = vi.fn();
vi.mock("../lib/hubspot", () => ({
  refreshHubspotAccessToken:    (...args: unknown[]) => mockRefreshHubspotAccessToken(...args),
  fetchContactsWithRevenue:     (...args: unknown[]) => mockFetchHubspotContactsWithRevenue(...args),
}));

const mockRefreshSalesforceAccessToken = vi.fn();
const mockFetchSalesforceContactsWithRevenue = vi.fn();
vi.mock("../lib/salesforce", () => ({
  refreshSalesforceAccessToken: (...args: unknown[]) => mockRefreshSalesforceAccessToken(...args),
  fetchContactsWithRevenue:     (...args: unknown[]) => mockFetchSalesforceContactsWithRevenue(...args),
}));

const mockAggregateLtv = vi.fn();
vi.mock("../lib/ltvAggregator", () => ({
  aggregateLtv: (...args: unknown[]) => mockAggregateLtv(...args),
}));

// ── D1 stub factory ──────────────────────────────────────────────────────────

function makeDb(dbResponses: Record<string, Array<Record<string, unknown>>> = {}) {
  const dbCalls: Array<{ sql: string; args: unknown[] }> = [];

  const db = {
    prepare(sql: string) {
      const stmt: {
        _args: unknown[];
        bind:  (...args: unknown[]) => typeof stmt;
        run:   () => Promise<{ success: boolean }>;
        all:   <T>() => Promise<{ results: T[] }>;
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

const TEST_KEY = "0".repeat(64); // 64-char hex = 32 bytes for AES-256

function makeEnv(overrides: Record<string, unknown> = {}) {
  const { db, dbCalls } = makeDb(
    (overrides._dbResponses as Record<string, Array<Record<string, unknown>>>) ?? {},
  );
  const { _dbResponses: _, ...rest } = overrides;
  return {
    env: {
      GA4_TOKEN_ENCRYPTION_KEY:        TEST_KEY,
      HUBSPOT_OAUTH_CLIENT_ID:         "hs-client-id",
      HUBSPOT_OAUTH_CLIENT_SECRET:     "hs-client-secret",
      SALESFORCE_OAUTH_CLIENT_ID:      "sf-client-id",
      SALESFORCE_OAUTH_CLIENT_SECRET:  "sf-client-secret",
      DB: db,
      ...rest,
    },
    dbCalls,
  };
}

const DEFAULT_LTV_RESULT = {
  ai:      { contact_count: 3, customer_count: 1, total_revenue_cents: 50000, avg_ltv_cents: 50000 },
  unknown: { contact_count: 7, customer_count: 2, total_revenue_cents: 20000, avg_ltv_cents: 10000 },
  errored: 0,
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockResolvedValue("decrypted-refresh-token");
  mockRefreshHubspotAccessToken.mockResolvedValue({ accessToken: "hs-access-token", expiresIn: 1800 });
  mockRefreshSalesforceAccessToken.mockResolvedValue({ accessToken: "sf-access-token", expiresIn: 7200, instanceUrl: "https://org.salesforce.com" });
  mockFetchHubspotContactsWithRevenue.mockResolvedValue([]);
  mockFetchSalesforceContactsWithRevenue.mockResolvedValue([]);
  mockAggregateLtv.mockReturnValue(DEFAULT_LTV_RESULT);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runCrmLtvSnapshotBatch", () => {
  // 1. Quiet-skip on missing env vars
  it("1a. quiet-skip when GA4_TOKEN_ENCRYPTION_KEY is unset", async () => {
    const { env, dbCalls } = makeEnv({ GA4_TOKEN_ENCRYPTION_KEY: undefined });
    await runCrmLtvSnapshotBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  it("1b. quiet-skip when neither HUBSPOT nor SALESFORCE env vars are set", async () => {
    const { env, dbCalls } = makeEnv({
      HUBSPOT_OAUTH_CLIENT_ID:        undefined,
      HUBSPOT_OAUTH_CLIENT_SECRET:    undefined,
      SALESFORCE_OAUTH_CLIENT_ID:     undefined,
      SALESFORCE_OAUTH_CLIENT_SECRET: undefined,
    });
    await runCrmLtvSnapshotBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  it("1c. quiet-skip when only HUBSPOT client_id (no secret) and no Salesforce — not fully configured", async () => {
    const { env, dbCalls } = makeEnv({
      HUBSPOT_OAUTH_CLIENT_ID:        "hs-id",
      HUBSPOT_OAUTH_CLIENT_SECRET:    undefined,
      SALESFORCE_OAUTH_CLIENT_ID:     undefined,
      SALESFORCE_OAUTH_CLIENT_SECRET: undefined,
    });
    await runCrmLtvSnapshotBatch(env as never);
    expect(dbCalls).toHaveLength(0);
  });

  // 2. No-op when stale list is empty
  it("2. no-op when stale-tenant query returns empty results", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { crm_connections: [] },
    });
    await runCrmLtvSnapshotBatch(env as never);
    // Only the SELECT should have fired
    const nonSelectCalls = dbCalls.filter((c) => !c.sql.trim().toUpperCase().startsWith("SELECT"));
    expect(nonSelectCalls).toHaveLength(0);
  });

  // 3. Happy path — HubSpot tenant: stale → fetch → aggregate → 2 ltv_daily rows upserted
  it("3. happy path — hubspot tenant: upserts ai + unknown rows into ltv_daily, stamps last_used_at", async () => {
    const staleRow = {
      slug:              "biz-hs",
      provider:          "hubspot",
      refresh_token_enc: "enc-rt-hs",
      account_id:        null,
    };
    const { env, dbCalls } = makeEnv({
      _dbResponses: { crm_connections: [staleRow] },
    });

    await runCrmLtvSnapshotBatch(env as never);

    // decryptToken called with the right enc + key
    expect(mockDecryptToken).toHaveBeenCalledWith("enc-rt-hs", TEST_KEY);

    // refreshHubspotAccessToken called (not Salesforce)
    expect(mockRefreshHubspotAccessToken).toHaveBeenCalledOnce();
    expect(mockRefreshSalesforceAccessToken).not.toHaveBeenCalled();

    // fetchHubspotContactsWithRevenue called with 90-day cutoff
    expect(mockFetchHubspotContactsWithRevenue).toHaveBeenCalledOnce();
    const fetchArgs = mockFetchHubspotContactsWithRevenue.mock.calls[0][0] as { accessToken: string; createdAfter: string };
    expect(fetchArgs.accessToken).toBe("hs-access-token");
    expect(typeof fetchArgs.createdAfter).toBe("string");

    // aggregateLtv called
    expect(mockAggregateLtv).toHaveBeenCalledOnce();

    // 2 ltv_daily INSERT OR REPLACE rows: ai and unknown
    const upserts = dbCalls.filter((c) => c.sql.includes("ltv_daily") && c.sql.includes("INSERT OR REPLACE"));
    expect(upserts).toHaveLength(2);

    // ai row
    const aiUpsert = upserts.find((c) => (c.args as string[]).includes("ai"));
    expect(aiUpsert).toBeDefined();
    expect(aiUpsert!.args[0]).toBe("biz-hs");
    expect(aiUpsert!.args[2]).toBe("hubspot");

    // unknown row
    const unknownUpsert = upserts.find((c) => (c.args as string[]).includes("unknown"));
    expect(unknownUpsert).toBeDefined();
    expect(unknownUpsert!.args[0]).toBe("biz-hs");

    // last_used_at UPDATE fired with last_error = NULL
    const updateCall = dbCalls.find(
      (c) => c.sql.includes("last_used_at") && c.sql.includes("last_error = NULL")
             && Array.isArray(c.args) && c.args.includes("biz-hs"),
    );
    expect(updateCall).toBeDefined();
  });

  // 4. Happy path — Salesforce tenant
  it("4. happy path — salesforce tenant: upserts ai + unknown rows, uses instanceUrl from token refresh", async () => {
    const staleRow = {
      slug:              "biz-sf",
      provider:          "salesforce",
      refresh_token_enc: "enc-rt-sf",
      account_id:        "https://old-org.salesforce.com",
    };
    const { env, dbCalls } = makeEnv({
      _dbResponses: { crm_connections: [staleRow] },
    });

    await runCrmLtvSnapshotBatch(env as never);

    // refreshSalesforceAccessToken called (not HubSpot)
    expect(mockRefreshSalesforceAccessToken).toHaveBeenCalledOnce();
    expect(mockRefreshHubspotAccessToken).not.toHaveBeenCalled();

    // fetchSalesforceContactsWithRevenue called with instanceUrl from token refresh
    expect(mockFetchSalesforceContactsWithRevenue).toHaveBeenCalledOnce();
    const sfArgs = mockFetchSalesforceContactsWithRevenue.mock.calls[0][0] as {
      accessToken: string;
      instanceUrl: string;
      createdAfter: string;
    };
    expect(sfArgs.accessToken).toBe("sf-access-token");
    expect(sfArgs.instanceUrl).toBe("https://org.salesforce.com");

    // 2 ltv_daily upserts
    const upserts = dbCalls.filter((c) => c.sql.includes("ltv_daily") && c.sql.includes("INSERT OR REPLACE"));
    expect(upserts).toHaveLength(2);

    // provider column set to 'salesforce'
    const aiUpsert = upserts.find((c) => (c.args as string[]).includes("ai"));
    expect(aiUpsert!.args[2]).toBe("salesforce");
  });

  // 5. Per-tenant error isolation
  it("5. error isolation: tenant B succeeds even when tenant A throws on refresh", async () => {
    const rowA = { slug: "biz-a", provider: "hubspot",    refresh_token_enc: "enc-a", account_id: null };
    const rowB = { slug: "biz-b", provider: "salesforce", refresh_token_enc: "enc-b", account_id: null };

    mockDecryptToken
      .mockResolvedValueOnce("rt-a")
      .mockResolvedValueOnce("rt-b");

    mockRefreshHubspotAccessToken.mockRejectedValueOnce(new Error("hubspot: token refresh failed: 401 invalid_grant"));

    const { env, dbCalls } = makeEnv({
      _dbResponses: { crm_connections: [rowA, rowB] },
    });

    // Must not throw — Promise.allSettled isolation
    await expect(runCrmLtvSnapshotBatch(env as never)).resolves.toBeUndefined();

    // biz-a should get last_error stamped
    const errUpdate = dbCalls.find(
      (c) => c.sql.includes("last_error") && !c.sql.includes("NULL")
             && Array.isArray(c.args) && c.args.includes("biz-a"),
    );
    expect(errUpdate).toBeDefined();

    // biz-b should get last_used_at stamped (success path)
    const successUpdate = dbCalls.find(
      (c) => c.sql.includes("last_used_at") && c.sql.includes("last_error = NULL")
             && Array.isArray(c.args) && c.args.includes("biz-b"),
    );
    expect(successUpdate).toBeDefined();
  });

  // 6. Cap at LIMIT 50
  it("6. stale-tenant SELECT uses LIMIT 50 and gate on status = 'connected'", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { crm_connections: [] },
    });
    await runCrmLtvSnapshotBatch(env as never);

    const selectCall = dbCalls.find((c) => c.sql.includes("crm_connections"));
    expect(selectCall).toBeDefined();
    expect(selectCall!.sql).toContain("LIMIT 50");
    expect(selectCall!.sql).toMatch(/status\s*=\s*'connected'/);
  });

  // Additional: verify bucket values are written correctly
  it("7. correct LTV bucket values written to ltv_daily rows", async () => {
    const staleRow = { slug: "biz-vals", provider: "hubspot", refresh_token_enc: "enc", account_id: null };
    const { env, dbCalls } = makeEnv({
      _dbResponses: { crm_connections: [staleRow] },
    });

    await runCrmLtvSnapshotBatch(env as never);

    // args order: [slug, date, provider, source_class, contact_count, customer_count, total_revenue_cents, avg_ltv_cents]
    const aiUpsert = dbCalls.find(
      (c) => c.sql.includes("ltv_daily") && (c.args as string[]).includes("ai"),
    );
    expect(aiUpsert!.args[4]).toBe(DEFAULT_LTV_RESULT.ai.contact_count);
    expect(aiUpsert!.args[5]).toBe(DEFAULT_LTV_RESULT.ai.customer_count);
    expect(aiUpsert!.args[6]).toBe(DEFAULT_LTV_RESULT.ai.total_revenue_cents);
    expect(aiUpsert!.args[7]).toBe(DEFAULT_LTV_RESULT.ai.avg_ltv_cents);

    const unknownUpsert = dbCalls.find(
      (c) => c.sql.includes("ltv_daily") && (c.args as string[]).includes("unknown"),
    );
    expect(unknownUpsert!.args[4]).toBe(DEFAULT_LTV_RESULT.unknown.contact_count);
    expect(unknownUpsert!.args[5]).toBe(DEFAULT_LTV_RESULT.unknown.customer_count);
    expect(unknownUpsert!.args[6]).toBe(DEFAULT_LTV_RESULT.unknown.total_revenue_cents);
    expect(unknownUpsert!.args[7]).toBe(DEFAULT_LTV_RESULT.unknown.avg_ltv_cents);
  });

  // Cutoff gate
  it("8. stale-tenant SELECT binds a cutoff ~23h in the past", async () => {
    const { env, dbCalls } = makeEnv({
      _dbResponses: { crm_connections: [] },
    });

    const before = new Date();
    await runCrmLtvSnapshotBatch(env as never);
    const after = new Date();

    const selectCall = dbCalls.find((c) => c.sql.includes("crm_connections"));
    expect(selectCall).toBeDefined();

    const cutoff = new Date(selectCall!.args[0] as string);
    const msBefore = before.getTime() - 23 * 60 * 60 * 1000 - 5000;
    const msAfter  = after.getTime()  - 23 * 60 * 60 * 1000 + 5000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(msBefore);
    expect(cutoff.getTime()).toBeLessThanOrEqual(msAfter);
  });
});
