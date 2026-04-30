/**
 * Tests for the Railway-sync reconciler.
 *
 * Mocks the D1 database and registerBusinessOnRailway so the test runs
 * without network or wrangler. Verifies:
 *   - Bails out cleanly when Railway isn't configured
 *   - Skips tenants with no KV profile (zombie state, no fix possible)
 *   - Calls registerBusinessOnRailway for each candidate, in order
 *   - On success: stamps railway_synced_at and updates api_key
 *   - On failure: increments .failed and surfaces an error entry
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileRailwaySync } from "./railwayReconciler.js";

// Mock the worker-side dependencies the reconciler pulls in. The Sentry
// import resolves transparently because @sentry/cloudflare exports
// no-ops when DSN is unset (which is always the case in tests).
const mockGetTenant = vi.fn();
vi.mock("../routes/onboard", () => ({
  getTenant: (env: unknown, domain: string) => mockGetTenant(env, domain),
}));

const mockRegister = vi.fn();
vi.mock("../routes/stripe", () => ({
  registerBusinessOnRailway: (env: unknown, tenant: unknown) =>
    mockRegister(env, tenant),
}));

const mockUpdateBiz = vi.fn();
vi.mock("../portalDb", () => ({
  updateBusinessApiKey: (db: unknown, slug: string, apiKey: string) =>
    mockUpdateBiz(db, slug, apiKey),
}));

/** Build a fake D1 binding that returns a fixed candidate set. */
function fakeDb(rows: Array<Record<string, unknown>>) {
  const updateRuns: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    db: {
      prepare(sql: string) {
        let bindArgs: unknown[] = [];
        const handle = {
          bind(...args: unknown[]) {
            bindArgs = args;
            return handle;
          },
          async all<T>() {
            // Reconciler only `.all()`s the candidate-scan SELECT.
            return { results: rows as T[] };
          },
          async run() {
            // Used for the railway_synced_at UPDATE.
            updateRuns.push({ sql, binds: bindArgs });
            return { meta: { changes: 1 } };
          },
        };
        return handle;
      },
    },
    updateRuns,
  };
}

describe("reconcileRailwaySync", () => {
  beforeEach(() => {
    mockGetTenant.mockReset();
    mockRegister.mockReset();
    mockUpdateBiz.mockReset();
  });

  it("returns zero-state when Railway isn't configured", async () => {
    const result = await reconcileRailwaySync({
      // No API_BASE_URL or API_KEY.
      DB: fakeDb([]).db as unknown as D1Database,
    } as unknown as Parameters<typeof reconcileRailwaySync>[0]);

    expect(result.scanned).toBe(0);
    expect(result.retried).toBe(0);
    expect(mockGetTenant).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("returns zero-state when no candidates exist", async () => {
    const { db } = fakeDb([]);
    const result = await reconcileRailwaySync({
      API_BASE_URL: "https://railway.test",
      API_KEY: "k",
      DB: db,
    } as unknown as Parameters<typeof reconcileRailwaySync>[0]);

    expect(result.scanned).toBe(0);
    expect(mockGetTenant).not.toHaveBeenCalled();
  });

  it("skips candidates whose KV record is missing", async () => {
    mockGetTenant.mockResolvedValue(null);
    const { db } = fakeDb([
      {
        id: "biz_1",
        slug: "stuck-tenant",
        business_name: "Stuck",
        domain: "stuck-tenant.hosted.advocatemcp.com",
        api_key: "placeholder",
        stripe_customer_id: "cus_x",
      },
    ]);

    const result = await reconcileRailwaySync({
      API_BASE_URL: "https://railway.test",
      API_KEY: "k",
      DB: db,
    } as unknown as Parameters<typeof reconcileRailwaySync>[0]);

    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.retried).toBe(0);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("retries registration and stamps marker on success", async () => {
    mockGetTenant.mockResolvedValue({
      slug: "advocate",
      domain: "advocate.hosted.advocatemcp.com",
      profile: { name: "Advocate", description: "..." },
    });
    mockRegister.mockResolvedValue({ ok: true, api_key: "new-uuid-1234", slug: "advocate" });
    mockUpdateBiz.mockResolvedValue(undefined);

    const { db, updateRuns } = fakeDb([
      {
        id: "biz_2",
        slug: "advocate",
        business_name: "Advocate",
        domain: "advocate.hosted.advocatemcp.com",
        api_key: "stale-key",
        stripe_customer_id: "cus_y",
      },
    ]);

    const result = await reconcileRailwaySync({
      API_BASE_URL: "https://railway.test",
      API_KEY: "k",
      DB: db,
    } as unknown as Parameters<typeof reconcileRailwaySync>[0]);

    expect(result.scanned).toBe(1);
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockUpdateBiz).toHaveBeenCalledWith(db, "advocate", "new-uuid-1234");

    // The marker UPDATE should have run with the slug.
    const markerWrite = updateRuns.find((u) => u.sql.includes("railway_synced_at"));
    expect(markerWrite).toBeDefined();
    expect(markerWrite!.binds[1]).toBe("advocate");
  });

  it("records failures in the result and continues with the rest of the batch", async () => {
    mockGetTenant
      .mockResolvedValueOnce({
        slug: "fail-one",
        domain: "fail-one.hosted.advocatemcp.com",
        profile: { name: "Fail One" },
      })
      .mockResolvedValueOnce({
        slug: "win-two",
        domain: "win-two.hosted.advocatemcp.com",
        profile: { name: "Win Two" },
      });
    mockRegister
      .mockResolvedValueOnce({ ok: false, error: "Railway 502: Bad Gateway" })
      .mockResolvedValueOnce({ ok: true, api_key: "k2", slug: "win-two" });

    const { db } = fakeDb([
      {
        id: "biz_a", slug: "fail-one", business_name: "Fail One",
        domain: "fail-one.hosted.advocatemcp.com",
        api_key: "p", stripe_customer_id: "cus_a",
      },
      {
        id: "biz_b", slug: "win-two", business_name: "Win Two",
        domain: "win-two.hosted.advocatemcp.com",
        api_key: "p", stripe_customer_id: "cus_b",
      },
    ]);

    const result = await reconcileRailwaySync({
      API_BASE_URL: "https://railway.test",
      API_KEY: "k",
      DB: db,
    } as unknown as Parameters<typeof reconcileRailwaySync>[0]);

    expect(result.scanned).toBe(2);
    expect(result.retried).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].slug).toBe("fail-one");
    expect(result.errors[0].reason).toContain("502");
  });
});
