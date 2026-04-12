/**
 * Tests for POST /api/activate/hosted — hosted tenant password-set flow.
 *
 * Separate file from stripe.test.ts because the mock requirements differ:
 * - verifyActivationToken must SUCCEED (return a payload), not just sign
 * - getTenant must be mocked for KV lookup
 * - signAccessToken must be mocked to avoid needing the signing key
 * - auth primitives (generateSalt, hashPassword) run for real since
 *   they're fast enough in the test env
 *
 * Seven tests covering:
 *   1. Missing token → 401
 *   2. Non-hosted tenant (skipDns false) → 400
 *   3. Missing business row in D1 → 400
 *   4. Password too short → 400
 *   5. Success — new user created, returns 200 with access_token + Set-Cookie
 *   6. Success — existing user, password updated, returns 200
 *   7. Idempotent grantAccess — second activation doesn't error
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../lib/activation-token", () => ({
  signActivationToken: vi.fn(async () => "mock-token"),
  verifyActivationToken: vi.fn(async () => ({ slug: "test-hosted", iat: 0, exp: 99999999999 })),
  base64urlToBytes: vi.fn(),
}));

vi.mock("../lib/access-token", () => ({
  signAccessToken: vi.fn(async () => "mock-access-token-xyz"),
  ACCESS_TOKEN_TTL_SECONDS: 900,
}));

vi.mock("./onboard", () => ({
  getTenant: vi.fn(async () => null),
}));

import { handleActivateHosted } from "./activate";
import { verifyActivationToken } from "../lib/activation-token";
import { getTenant } from "./onboard";
import type { Env } from "../types";
import type { TenantRecord } from "./onboard";

const mockedVerify = vi.mocked(verifyActivationToken);
const mockedGetTenant = vi.mocked(getTenant);

// ── Fake D1 ──────────────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  full_name: string | null;
  role: string;
}

interface FakeBiz {
  id: string;
  slug: string;
  business_name: string;
  api_key: string;
}

function createFakeDb(opts: {
  businesses?: Record<string, Partial<FakeBiz>>;
  users?: Record<string, Partial<FakeUser>>;
} = {}) {
  const businesses = new Map<string, FakeBiz>();
  for (const [slug, b] of Object.entries(opts.businesses ?? {})) {
    businesses.set(slug, {
      id: b.id ?? `biz-${slug}`,
      slug,
      business_name: b.business_name ?? slug,
      api_key: b.api_key ?? "pending",
    });
  }

  const users = new Map<string, FakeUser>();
  for (const [email, u] of Object.entries(opts.users ?? {})) {
    users.set(email.toLowerCase(), {
      id: u.id ?? `user-${email}`,
      email: email.toLowerCase(),
      password_hash: u.password_hash ?? "old-hash",
      salt: u.salt ?? "old-salt",
      full_name: u.full_name ?? null,
      role: u.role ?? "client",
    });
  }

  const accessGrants = new Set<string>();
  const sessions: Array<{ user_id: string }> = [];

  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              const norm = sql.replace(/\s+/g, " ").trim();

              // getBusinessBySlug: SELECT * FROM businesses WHERE slug = ?
              if (norm.includes("FROM businesses") && norm.includes("WHERE slug")) {
                const slug = params[0] as string;
                const biz = businesses.get(slug);
                return (biz ?? null) as T | null;
              }

              // getUserByEmail: SELECT * FROM users WHERE email = ?
              if (norm.includes("FROM users") && norm.includes("WHERE email")) {
                const email = (params[0] as string).toLowerCase();
                const user = users.get(email);
                return (user ?? null) as T | null;
              }

              // getUserById: SELECT * FROM users WHERE id = ?
              if (norm.includes("FROM users") && norm.includes("WHERE id")) {
                const id = params[0] as string;
                for (const u of users.values()) {
                  if (u.id === id) return u as T;
                }
                return null;
              }

              return null;
            },
            async run() {
              const norm = sql.replace(/\s+/g, " ").trim();

              // createUser: INSERT INTO users
              if (norm.startsWith("INSERT INTO users")) {
                const [id, email, hash, salt, name, role] = params as string[];
                users.set(email.toLowerCase(), {
                  id,
                  email: email.toLowerCase(),
                  password_hash: hash,
                  salt,
                  full_name: name,
                  role: role ?? "client",
                });
                return { meta: { changes: 1 } };
              }

              // updateUserPassword: UPDATE users SET password_hash = ?
              if (norm.startsWith("UPDATE users") && norm.includes("password_hash")) {
                const [hash, salt, , userId] = params as string[];
                for (const u of users.values()) {
                  if (u.id === userId) {
                    u.password_hash = hash;
                    u.salt = salt;
                    break;
                  }
                }
                return { meta: { changes: 1 } };
              }

              // grantAccess: INSERT OR IGNORE INTO user_business_access
              if (norm.includes("user_business_access")) {
                const key = `${params[1]}-${params[2]}`;
                accessGrants.add(key);
                return { meta: { changes: 1 } };
              }

              // createSession: INSERT INTO sessions
              if (norm.startsWith("INSERT INTO sessions")) {
                sessions.push({ user_id: params[1] as string });
                return { meta: { changes: 1 } };
              }

              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, users, businesses, accessGrants, sessions };
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    ACTIVATION_SIGNING_KEY: "test-key",
    ACCESS_TOKEN_SIGNING_KEY: "test-access-key",
    ADMIN_SECRET: "test-admin",
  } as unknown as Env;
}

function makeHostedTenant(): TenantRecord {
  return {
    domain: "test-hosted.hosted.advocatemcp.com",
    name: "Test Hosted",
    slug: "test-hosted",
    phone: "", email: "customer@example.com",
    address: "", city: "", state: "", postalCode: "", country: "US",
    services: [], website: "", notes: "",
    status: "active" as const,
    cloudflare: {
      customHostnameId: null, verificationMethod: "none",
      verificationStatus: "not_applicable", sslStatus: "not_applicable",
      txtName: null, txtValue: null, ownershipTxtName: null, ownershipTxtValue: null,
    },
    skipDns: true,
    statusLog: [], createdAt: "", updatedAt: "",
  };
}

function makeRequest(body?: unknown, token?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["X-Activation-Token"] = token;
  return new Request(
    "https://customers.advocatemcp.com/api/activate/hosted",
    {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleActivateHosted (POST /api/activate/hosted)", () => {
  beforeEach(() => {
    mockedVerify.mockClear();
    mockedGetTenant.mockClear();
    // Default: verify succeeds, tenant not found
    mockedVerify.mockResolvedValue({ slug: "test-hosted", iat: 0, exp: 99999999999 });
    mockedGetTenant.mockResolvedValue(null);
  });

  it("returns 401 when token is missing", async () => {
    const { db } = createFakeDb();
    const env = makeEnv(db);

    const resp = await handleActivateHosted(
      new Request("https://customers.advocatemcp.com/api/activate/hosted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "test12345" }),
      }),
      env,
    );

    expect(resp.status).toBe(401);
  });

  it("returns 400 when tenant is not hosted (skipDns false)", async () => {
    const tenant = makeHostedTenant();
    tenant.skipDns = false;
    mockedGetTenant.mockResolvedValue(tenant);

    const { db } = createFakeDb({ businesses: { "test-hosted": {} } });
    const env = makeEnv(db);

    const resp = await handleActivateHosted(
      makeRequest({ password: "test12345" }, "valid-token"),
      env,
    );

    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error_code).toBe("not_hosted");
  });

  it("returns 400 when business row is missing from D1", async () => {
    mockedGetTenant.mockResolvedValue(makeHostedTenant());

    const { db } = createFakeDb({ businesses: {} }); // no businesses
    const env = makeEnv(db);

    const resp = await handleActivateHosted(
      makeRequest({ password: "test12345" }, "valid-token"),
      env,
    );

    expect(resp.status).toBe(400);
  });

  it("returns 400 when password is too short", async () => {
    mockedGetTenant.mockResolvedValue(makeHostedTenant());

    const { db } = createFakeDb({ businesses: { "test-hosted": {} } });
    const env = makeEnv(db);

    const resp = await handleActivateHosted(
      makeRequest({ password: "short" }, "valid-token"),
      env,
    );

    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error_code).toBe("password_too_short");
  });

  it("creates a new user and returns 200 with access_token + Set-Cookie", async () => {
    mockedGetTenant.mockResolvedValue(makeHostedTenant());

    const { db, users, accessGrants, sessions } = createFakeDb({
      businesses: { "test-hosted": { id: "biz-123" } },
    });
    const env = makeEnv(db);

    const resp = await handleActivateHosted(
      makeRequest({ password: "securepassword123" }, "valid-token"),
      env,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.access_token).toBe("mock-access-token-xyz");
    expect(body.redirect).toBe("https://advocatemcp.com/dashboard.html");
    expect(body.hosted_url).toBe("https://test-hosted.hosted.advocatemcp.com");

    // Set-Cookie header present
    const cookie = resp.headers.get("Set-Cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("amcp_refresh");
    expect(cookie).toContain("HttpOnly");

    // User was created
    expect(users.has("customer@example.com")).toBe(true);
    const user = users.get("customer@example.com")!;
    expect(user.role).toBe("client");

    // Access was granted
    expect(accessGrants.size).toBe(1);

    // Session was created
    expect(sessions.length).toBe(1);
  });

  it("updates password for existing user and returns 200", async () => {
    mockedGetTenant.mockResolvedValue(makeHostedTenant());

    const { db, users } = createFakeDb({
      businesses: { "test-hosted": { id: "biz-123" } },
      users: { "customer@example.com": { id: "existing-user-1", password_hash: "old", salt: "old" } },
    });
    const env = makeEnv(db);

    const resp = await handleActivateHosted(
      makeRequest({ password: "newpassword456" }, "valid-token"),
      env,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // Password was updated (hash changed from "old")
    const user = users.get("customer@example.com")!;
    expect(user.password_hash).not.toBe("old");
    expect(user.salt).not.toBe("old");
    // User ID preserved
    expect(user.id).toBe("existing-user-1");
  });

  it("idempotent — calling twice doesn't error (grantAccess INSERT OR IGNORE)", async () => {
    mockedGetTenant.mockResolvedValue(makeHostedTenant());

    const { db } = createFakeDb({
      businesses: { "test-hosted": { id: "biz-123" } },
    });
    const env = makeEnv(db);

    const resp1 = await handleActivateHosted(
      makeRequest({ password: "securepassword123" }, "valid-token"),
      env,
    );
    expect(resp1.status).toBe(200);

    // Second call — same user, same business
    const resp2 = await handleActivateHosted(
      makeRequest({ password: "differentpassword" }, "valid-token"),
      env,
    );
    expect(resp2.status).toBe(200);
  });
});
