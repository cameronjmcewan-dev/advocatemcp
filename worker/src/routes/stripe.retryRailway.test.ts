/**
 * Tests for POST /admin/onboard/retry-railway — operator recovery
 * endpoint that replays registerBusinessOnRailway for a tenant whose
 * Stripe webhook succeeded but whose Railway registration silently
 * failed. Covers the full branch matrix so a future refactor that
 * accidentally skips D1 update or auth is caught.
 *
 * No real Railway. No real KV. No real D1. All three are faked here
 * with just enough of the shape the handler touches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { handleRetryRailwayRegistration } from "./stripe";
import type { Env } from "../types";
import type { TenantRecord } from "./onboard";

// ── Fake D1 — only the two operations the handler exercises ──────────────
//   1. getBusinessBySlug        → SELECT * FROM businesses WHERE slug = ? LIMIT 1
//   2. updateBusinessApiKey     → UPDATE businesses SET api_key = ? WHERE slug = ?
//
// Keyed by slug. Stores domain + api_key (everything else the Business
// interface declares is optional / unused here).

interface FakeBizRow { slug: string; domain: string | null; api_key: string }

function createFakeDb(
  initial: Record<string, Partial<FakeBizRow>> = {},
): { db: D1Database; rows: Map<string, FakeBizRow> } {
  const rows = new Map<string, FakeBizRow>();
  for (const [slug, row] of Object.entries(initial)) {
    rows.set(slug, {
      slug,
      domain:  row.domain ?? null,
      api_key: row.api_key ?? "pending",
    });
  }
  const db = {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // getBusinessBySlug
              if (normalized.startsWith("SELECT * FROM businesses")) {
                const slug = params[0] as string;
                const row = rows.get(slug);
                return (row ?? null) as unknown as T;
              }
              return null;
            },
            async run() {
              // updateBusinessApiKey
              if (
                normalized.startsWith("UPDATE businesses") &&
                normalized.includes("SET api_key")
              ) {
                const [apiKey, slug] = params as [string, string];
                const row = rows.get(slug);
                if (row) row.api_key = apiKey;
                return { meta: { changes: row ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, rows };
}

// ── Fake KV — keyed by domain; stores serialized TenantRecord JSON ───────

function createFakeKv(
  initial: Record<string, TenantRecord | null> = {},
): KVNamespace {
  const store = new Map<string, string>();
  for (const [domain, tenant] of Object.entries(initial)) {
    if (tenant) store.set(domain, JSON.stringify(tenant));
  }
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list() { return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true } as { keys: { name: string }[]; list_complete: boolean }; },
  } as unknown as KVNamespace;
}

function makeTenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    domain:  "wcc.example.com",
    name:    "Example Tenant",
    slug:    "example-tenant",
    phone:   "555-0100",
    email:   "owner@wcc.example.com",
    address: "", city: "Boise", state: "ID", postalCode: "", country: "US",
    services: ["copywriting"],
    website: "https://wcc.example.com",
    notes:   "",
    status:  "active",
    cloudflare: {
      customHostnameId: null, verificationMethod: "none",
      verificationStatus: "not_applicable", sslStatus: "not_applicable",
      txtName: null, txtValue: null, ownershipTxtName: null, ownershipTxtValue: null,
    },
    stripe: { customerId: null, subscriptionId: null, checkoutSessionId: null, plan: "base" },
    skipDns: false,
    profile: {
      category: "copywriter",
      description: "Boise copywriter",
      tone: "friendly",
    },
    statusLog: [], createdAt: "", updatedAt: "",
    ...overrides,
  } as TenantRecord;
}

function makeEnv(
  db: D1Database,
  kv: KVNamespace,
  overrides: Partial<Env> = {},
): Env {
  return {
    DB: db,
    TENANT_DATA: kv,
    ADMIN_SECRET: "test-admin-secret",
    API_BASE_URL: "https://test-railway.example.com",
    API_KEY: "test-api-key",
    ...overrides,
  } as unknown as Env;
}

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://customers.advocatemcp.com/admin/onboard/retry-railway", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /admin/onboard/retry-railway", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("401s without admin secret", async () => {
    const { db } = createFakeDb({ "example-tenant": { domain: "wcc.example.com" } });
    const kv = createFakeKv({ "wcc.example.com": makeTenant() });
    const env = makeEnv(db, kv);

    const res = await handleRetryRailwayRegistration(
      makeRequest({ slug: "example-tenant" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("400s on missing slug field", async () => {
    const { db } = createFakeDb({});
    const kv = createFakeKv({});
    const env = makeEnv(db, kv);
    const res = await handleRetryRailwayRegistration(
      makeRequest({}, { "X-Admin-Secret": "test-admin-secret" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("404s when D1 has no row for the slug", async () => {
    const { db } = createFakeDb({});
    const kv = createFakeKv({});
    const env = makeEnv(db, kv);
    const res = await handleRetryRailwayRegistration(
      makeRequest({ slug: "nonexistent" }, { "X-Admin-Secret": "test-admin-secret" }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("404s when D1 row exists but KV tenant record is missing", async () => {
    const { db } = createFakeDb({ "example-tenant": { domain: "wcc.example.com" } });
    const kv = createFakeKv({});
    const env = makeEnv(db, kv);
    const res = await handleRetryRailwayRegistration(
      makeRequest({ slug: "example-tenant" }, { "X-Admin-Secret": "test-admin-secret" }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("422s when KV tenant has no wizard profile", async () => {
    const { db } = createFakeDb({ "example-tenant": { domain: "wcc.example.com" } });
    const tenantNoProfile = makeTenant();
    delete (tenantNoProfile as { profile?: unknown }).profile;
    const kv = createFakeKv({ "wcc.example.com": tenantNoProfile });
    const env = makeEnv(db, kv);
    const res = await handleRetryRailwayRegistration(
      makeRequest({ slug: "example-tenant" }, { "X-Admin-Secret": "test-admin-secret" }),
      env,
    );
    expect(res.status).toBe(422);
  });

  it("500s when API_BASE_URL / API_KEY are not configured", async () => {
    const { db } = createFakeDb({ "example-tenant": { domain: "wcc.example.com" } });
    const kv = createFakeKv({ "wcc.example.com": makeTenant() });
    const env = makeEnv(db, kv, { API_BASE_URL: undefined, API_KEY: undefined });
    const res = await handleRetryRailwayRegistration(
      makeRequest({ slug: "example-tenant" }, { "X-Admin-Secret": "test-admin-secret" }),
      env,
    );
    expect(res.status).toBe(500);
  });

  it("502s when Railway returns an error — and does NOT update D1 api_key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "schema mismatch" }), { status: 400 }),
    );
    const { db, rows } = createFakeDb({
      "example-tenant": { domain: "wcc.example.com", api_key: "pending" },
    });
    const kv = createFakeKv({ "wcc.example.com": makeTenant() });
    const env = makeEnv(db, kv);

    const res = await handleRetryRailwayRegistration(
      makeRequest({ slug: "example-tenant" }, { "X-Admin-Secret": "test-admin-secret" }),
      env,
    );
    expect(res.status).toBe(502);
    expect(rows.get("example-tenant")?.api_key).toBe("pending");
  });

  it("200 on success — updates D1 api_key with the new Railway key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ slug: "example-tenant", api_key: "railway-new-key-123" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { db, rows } = createFakeDb({
      "example-tenant": { domain: "wcc.example.com", api_key: "pending" },
    });
    const kv = createFakeKv({ "wcc.example.com": makeTenant() });
    const env = makeEnv(db, kv);

    const res = await handleRetryRailwayRegistration(
      makeRequest({ slug: "example-tenant" }, { "X-Admin-Secret": "test-admin-secret" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok?: boolean; slug?: string; domain?: string; action?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.slug).toBe("example-tenant");
    expect(body.domain).toBe("wcc.example.com");
    expect(rows.get("example-tenant")?.api_key).toBe("railway-new-key-123");
  });

  it("accepts Bearer auth form in addition to X-Admin-Secret", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ slug: "example-tenant", api_key: "k" }), { status: 201 }),
    );
    const { db } = createFakeDb({
      "example-tenant": { domain: "wcc.example.com", api_key: "pending" },
    });
    const kv = createFakeKv({ "wcc.example.com": makeTenant() });
    const env = makeEnv(db, kv);
    const res = await handleRetryRailwayRegistration(
      makeRequest({ slug: "example-tenant" }, { Authorization: "Bearer test-admin-secret" }),
      env,
    );
    expect(res.status).toBe(200);
  });
});
