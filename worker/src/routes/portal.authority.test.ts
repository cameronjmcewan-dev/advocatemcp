/**
 * Tests for the authority config endpoints in portal.ts:
 *   GET  /api/client/authority/status
 *   POST /api/client/authority/configure
 *   POST /api/client/authority/disconnect
 *
 * Mocking strategy: vi.mock("./authApi") and vi.mock("../portalDb") so
 * getSessionFromRequest + DB helpers are under full test control.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist the session mock before any module loads ────────────────────────────

const { mockGetSession } = vi.hoisted(() => {
  return { mockGetSession: vi.fn() };
});

vi.mock("./authApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./authApi")>();
  return {
    ...original,
    getSessionFromRequest: mockGetSession,
  };
});

vi.mock("../portalDb", async (importOriginal) => {
  const original = await importOriginal<typeof import("../portalDb")>();
  return {
    ...original,
    getActiveBusinesses: vi.fn(async () => []),
    getUserBusinesses:   vi.fn(async () => []),
  };
});

import { handlePortal } from "./portal";
import type { Env } from "../types";
import type { AuthContext } from "./authApi";
import { getUserBusinesses } from "../portalDb";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PRO_BIZ = {
  id:            1,
  slug:          "acme-co",
  business_name: "Acme Co",
  domain:        "acme.com",
  api_key:       "bk_test",
  plan:          "pro",
};

function verifiedCtx(): AuthContext {
  return {
    user_id:        "u1",
    email:          "test@example.com",
    full_name:      "Test User",
    role:           "client",
    tenant_id:      null,
    email_verified: 1,
    auth_method:    "bearer",
  };
}

// D1 stub factory — supports per-sql-snippet response injection
type DbCall = { sql: string; args: unknown[] };

function makeDb(
  planValue: string | null,
  configRow: Record<string, unknown> | null,
  recentRows: Record<string, unknown>[],
): { db: D1Database; calls: DbCall[] } {
  const calls: DbCall[] = [];

  function stmtFor(sql: string, args: unknown[]) {
    return {
      bind: (...a: unknown[]) => stmtFor(sql, a),
      async first<T>() {
        calls.push({ sql, args });
        if (sql.includes("SELECT plan")) {
          return (planValue !== null ? { plan: planValue } : null) as T;
        }
        if (sql.includes("authority_config")) {
          return configRow as T;
        }
        return null as T;
      },
      async run() {
        calls.push({ sql, args });
        return { success: true, meta: {} };
      },
      async all<T>() {
        calls.push({ sql, args });
        if (sql.includes("off_site_authority_daily")) {
          return { results: recentRows as T[] };
        }
        return { results: [] as T[] };
      },
    };
  }

  const db = {
    prepare(sql: string) {
      return stmtFor(sql, []);
    },
  } as unknown as D1Database;

  return { db, calls };
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    BUSINESS_MAP: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } as unknown as KVNamespace,
    TENANT_DATA:  { get: vi.fn(async () => null) } as unknown as KVNamespace,
  } as unknown as Env;
}

function makeRequest(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Request {
  const url = `https://customers.advocatemcp.com${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body    = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(url, init);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(verifiedCtx());
  vi.mocked(getUserBusinesses).mockResolvedValue([PRO_BIZ as never]);
});

// ── GET /api/client/authority/status ─────────────────────────────────────────

describe("GET /api/client/authority/status", () => {
  it("1. returns configured=false when no authority_config row exists", async () => {
    const { db } = makeDb("pro", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/status", "GET");

    const resp = await handlePortal(req, env);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);

    const body = await resp!.json() as { configured: boolean; config: unknown; summary: unknown[] };
    expect(body.configured).toBe(false);
    expect(body.config).toBeNull();
    expect(body.summary).toEqual([]);
  });

  it("2. returns configured=true with config row when authority_config exists", async () => {
    const configRow = {
      slug:            "acme-co",
      brand_keyword:   "acme",
      reddit_enabled:  1,
      google_place_id: "ChIJtest",
      configured_at:   "2026-05-06T00:00:00.000Z",
      last_synced_at:  "2026-05-06T04:00:00.000Z",
      last_sync_error: null,
    };
    const { db } = makeDb("pro", configRow, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/status", "GET");

    const resp = await handlePortal(req, env);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);

    const body = await resp!.json() as { configured: boolean; config: typeof configRow; summary: unknown[] };
    expect(body.configured).toBe(true);
    expect(body.config.google_place_id).toBe("ChIJtest");
    expect(body.config.brand_keyword).toBe("acme");
  });

  it("3. returns 402 plan_required for non-pro tenant", async () => {
    const { db } = makeDb("base", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/status", "GET");

    const resp = await handlePortal(req, env);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(402);
  });
});

// ── POST /api/client/authority/configure ─────────────────────────────────────

describe("POST /api/client/authority/configure", () => {
  it("4. accepts valid brand_keyword + google_place_id and upserts config row", async () => {
    const { db, calls } = makeDb("pro", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/configure", "POST", {
      brand_keyword:   "acme",
      google_place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4",
    });

    const resp = await handlePortal(req, env);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);

    const body = await resp!.json() as { ok: boolean; brand_keyword: string; google_place_id: string };
    expect(body.ok).toBe(true);
    expect(body.brand_keyword).toBe("acme");
    expect(body.google_place_id).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");

    // Confirm the INSERT OR REPLACE was called
    const upsert = calls.find((c) => c.sql.includes("INSERT OR REPLACE INTO authority_config"));
    expect(upsert).toBeDefined();
  });

  it("5. rejects google_place_id shorter than 20 chars with 400", async () => {
    const { db } = makeDb("pro", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/configure", "POST", {
      google_place_id: "short",
    });

    const resp = await handlePortal(req, env);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(400);

    const body = await resp!.json() as { error: string };
    expect(body.error).toContain("20–200");
  });

  it("6. rejects brand_keyword longer than 100 chars with 400", async () => {
    const { db } = makeDb("pro", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/configure", "POST", {
      brand_keyword: "a".repeat(101),
    });

    const resp = await handlePortal(req, env);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(400);
  });

  it("7. returns 402 plan_required for non-pro tenant", async () => {
    const { db } = makeDb("base", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/configure", "POST", { brand_keyword: "acme" });

    const resp = await handlePortal(req, env);
    expect(resp!.status).toBe(402);
  });
});

// ── POST /api/client/authority/disconnect ────────────────────────────────────

describe("POST /api/client/authority/disconnect", () => {
  it("8. disconnects: deletes authority_config row, keeps history by default", async () => {
    const { db, calls } = makeDb("pro", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/disconnect", "POST", {});

    const resp = await handlePortal(req, env);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);

    const body = await resp!.json() as { ok: boolean; history_deleted: boolean };
    expect(body.ok).toBe(true);
    expect(body.history_deleted).toBe(false);

    // Config DELETE called
    const del = calls.find((c) => c.sql.includes("DELETE FROM authority_config"));
    expect(del).toBeDefined();

    // History NOT deleted
    const histDel = calls.find((c) => c.sql.includes("DELETE FROM off_site_authority_daily"));
    expect(histDel).toBeUndefined();
  });

  it("9. disconnect with delete_history=true also purges off_site_authority_daily rows", async () => {
    const { db, calls } = makeDb("pro", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/disconnect", "POST", { delete_history: true });

    const resp = await handlePortal(req, env);
    expect(resp!.status).toBe(200);

    const body = await resp!.json() as { history_deleted: boolean };
    expect(body.history_deleted).toBe(true);

    const histDel = calls.find((c) => c.sql.includes("DELETE FROM off_site_authority_daily"));
    expect(histDel).toBeDefined();
  });

  it("10. returns 402 plan_required for non-pro tenant", async () => {
    const { db } = makeDb("base", null, []);
    const env = makeEnv(db);
    const req = makeRequest("/api/client/authority/disconnect", "POST", {});

    const resp = await handlePortal(req, env);
    expect(resp!.status).toBe(402);
  });
});
