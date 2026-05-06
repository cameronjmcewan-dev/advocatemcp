/**
 * Regression tests for the user_business_access invariant.
 *
 * Every onboarding path that creates a user AND a business must call
 * grantAccess() so that getUserBusinesses() returns a row for that user.
 * The bug that prompted these tests: example-tenant had a businesses row but
 * no user_business_access row, causing "404: No business found for this
 * account" on the dashboard.
 *
 * Paths covered:
 *   1. handleActivateHosted (new user)     — MUST have access row ✓
 *   2. handleActivateHosted (existing user) — MUST have access row ✓
 *   3. adminCreateClient (client role)      — MUST have access row ✓
 *   4. adminCreateClient (admin role)       — no business created, no row expected ✓
 *
 * Paths intentionally NOT tested here (no user created, comment-documented):
 *   - handleOnboard                — admin shell only, no user
 *   - handleStripeWebhook          — billing state update only, no user
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../lib/activation-token", () => ({
  signActivationToken: vi.fn(async () => "mock-token"),
  verifyActivationToken: vi.fn(async () => ({
    slug: "acme",
    iat: 0,
    exp: 99999999999,
  })),
  base64urlToBytes: vi.fn(),
}));

vi.mock("../lib/access-token", () => ({
  signAccessToken: vi.fn(async () => "mock-access-token"),
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

// ── Dynamically import adminCreateClient via the handler ──────────────────────
// portal.ts exports it indirectly through handlePortal — easier to call
// directly via the named export once we confirm it's exported.
// If it's not exported, we invoke it through handlePortal dispatch.
// Check first:
import * as portalModule from "./portal";

const mockedVerify = vi.mocked(verifyActivationToken);
const mockedGetTenant = vi.mocked(getTenant);

// ── Fake D1 factory ───────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  full_name: string | null;
  role: string;
  email_verified: number;
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
      email_verified: u.email_verified ?? 0,
    });
  }

  // Tracks (user_id, business_id) pairs that have been granted
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
                return (businesses.get(slug) ?? null) as T | null;
              }

              // createBusiness re-read: SELECT * FROM businesses WHERE id = ?
              if (norm.includes("FROM businesses") && norm.includes("WHERE id")) {
                const id = params[0] as string;
                for (const b of businesses.values()) {
                  if (b.id === id) return b as T;
                }
                return null;
              }

              // getUserByEmail
              if (norm.includes("FROM users") && norm.includes("WHERE email")) {
                const email = (params[0] as string).toLowerCase();
                return (users.get(email) ?? null) as T | null;
              }

              // getUserById
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
                  email_verified: 0,
                });
                return { meta: { changes: 1 } };
              }

              // createBusiness: INSERT INTO businesses
              if (norm.startsWith("INSERT INTO businesses")) {
                const [id, slug, name, apiKey] = params as string[];
                businesses.set(slug, {
                  id,
                  slug,
                  business_name: name,
                  api_key: apiKey,
                });
                return { meta: { changes: 1 } };
              }

              // updateUserPassword
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

              // email_verified flip
              if (norm.startsWith("UPDATE users") && norm.includes("email_verified")) {
                const userId = params[0] as string;
                for (const u of users.values()) {
                  if (u.id === userId) {
                    u.email_verified = 1;
                    break;
                  }
                }
                return { meta: { changes: 1 } };
              }

              // grantAccess: INSERT OR IGNORE INTO user_business_access
              if (norm.includes("user_business_access")) {
                // params: [id, user_id, business_id, created_at]
                const userId = params[1] as string;
                const bizId = params[2] as string;
                accessGrants.add(`${userId}:${bizId}`);
                return { meta: { changes: 1 } };
              }

              // createSession
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnv(db: D1Database, extra?: Partial<Env>): Env {
  return {
    DB: db,
    ACTIVATION_SIGNING_KEY: "test-key",
    ACCESS_TOKEN_SIGNING_KEY: "test-access-key",
    ADMIN_SECRET: "test-admin",
    ...extra,
  } as unknown as Env;
}

function makeHostedTenant(slug = "acme"): TenantRecord {
  return {
    domain: `${slug}.hosted.advocatemcp.com`,
    name: "Acme Co",
    slug,
    phone: "",
    email: "owner@acme.com",
    address: "", city: "", state: "", postalCode: "", country: "US",
    services: [], website: "", notes: "",
    status: "active" as const,
    cloudflare: {
      customHostnameId: null,
      verificationMethod: "none",
      verificationStatus: "not_applicable",
      sslStatus: "not_applicable",
      txtName: null, txtValue: null,
      ownershipTxtName: null, ownershipTxtValue: null,
    },
    skipDns: true,
    statusLog: [],
    createdAt: "",
    updatedAt: "",
  };
}

function makeActivateRequest(password: string, token = "valid-token"): Request {
  return new Request("https://customers.advocatemcp.com/api/activate/hosted", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Activation-Token": token,
    },
    body: JSON.stringify({ password }),
  });
}

function makeAdminCreateClientRequest(
  body: Record<string, unknown>,
  secret = "test-admin",
): Request {
  return new Request("https://customers.advocatemcp.com/admin/create-client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("user_business_access invariant — every user-creating path must call grantAccess()", () => {
  beforeEach(() => {
    mockedVerify.mockClear();
    mockedGetTenant.mockClear();
    mockedVerify.mockResolvedValue({ slug: "acme", iat: 0, exp: 99999999999 });
    mockedGetTenant.mockResolvedValue(null);
  });

  // ── handleActivateHosted — new user path ────────────────────────────────────

  it("handleActivateHosted (new user): user_business_access row exists after activation", async () => {
    mockedGetTenant.mockResolvedValue(makeHostedTenant("acme"));

    const { db, users, accessGrants } = createFakeDb({
      businesses: { acme: { id: "biz-acme-1" } },
    });
    const env = makeEnv(db);

    const resp = await handleActivateHosted(makeActivateRequest("securepassword123"), env);
    expect(resp.status).toBe(200);

    // User was created
    expect(users.has("owner@acme.com")).toBe(true);
    const user = users.get("owner@acme.com")!;

    // Access link must exist: (user.id, biz.id)
    expect(accessGrants.size).toBeGreaterThanOrEqual(1);
    expect(accessGrants.has(`${user.id}:biz-acme-1`)).toBe(true);
  });

  // ── handleActivateHosted — existing user path ───────────────────────────────

  it("handleActivateHosted (existing user with no password): user_business_access row exists", async () => {
    mockedGetTenant.mockResolvedValue(makeHostedTenant("acme"));

    // User exists but has no password hash yet (pre-signup state)
    const { db, users, accessGrants } = createFakeDb({
      businesses: { acme: { id: "biz-acme-1" } },
      users: { "owner@acme.com": { id: "existing-u-1", password_hash: "", salt: "" } },
    });
    const env = makeEnv(db);

    const resp = await handleActivateHosted(makeActivateRequest("securepassword456"), env);
    expect(resp.status).toBe(200);

    const user = users.get("owner@acme.com")!;
    expect(accessGrants.has(`${user.id}:biz-acme-1`)).toBe(true);
  });

  // ── handleActivateHosted — idempotent: second call doesn't break anything ──

  it("handleActivateHosted (idempotent): calling twice leaves access grant intact", async () => {
    mockedGetTenant.mockResolvedValue(makeHostedTenant("acme"));

    const { db, accessGrants } = createFakeDb({
      businesses: { acme: { id: "biz-acme-1" } },
    });
    const env = makeEnv(db);

    const r1 = await handleActivateHosted(makeActivateRequest("securepassword123"), env);
    expect(r1.status).toBe(200);

    const r2 = await handleActivateHosted(makeActivateRequest("differentpassword"), env);
    expect(r2.status).toBe(200);

    // Grant set is still non-empty — INSERT OR IGNORE is idempotent
    expect(accessGrants.size).toBeGreaterThanOrEqual(1);
  });

  // ── adminCreateClient — client role ─────────────────────────────────────────

  it("adminCreateClient (client): user_business_access row exists after creation", async () => {
    const { db, users, accessGrants } = createFakeDb();
    const env = makeEnv(db);

    // adminCreateClient is not exported by name — invoke via handlePortal
    // which dispatches on the path
    const req = makeAdminCreateClientRequest({
      email: "newclient@example.com",
      password: "testpassword",
      full_name: "New Client",
      slug: "new-biz",
      business_name: "New Biz Inc",
      api_key: "test-api-key-123",
      role: "client",
    });

    const resp = await (portalModule as unknown as {
      handlePortal: (req: Request, env: Env) => Promise<Response | null>
    }).handlePortal(req, env);

    // handlePortal returns null for unmatched paths — assert the route matched
    expect(resp).not.toBeNull();
    const response = resp as Response;
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.message).toContain("created");

    // User must exist
    expect(users.has("newclient@example.com")).toBe(true);
    const user = users.get("newclient@example.com")!;

    // Access grant must exist — the (user.id, biz.id) pair is in accessGrants
    expect(accessGrants.size).toBeGreaterThanOrEqual(1);
    const hasGrant = [...accessGrants].some((g) => g.startsWith(`${user.id}:`));
    expect(hasGrant).toBe(true);
  });

  // ── adminCreateClient — admin role (no business, no grant expected) ─────────

  it("adminCreateClient (admin role): no business created, no access grant", async () => {
    const { db, accessGrants } = createFakeDb();
    const env = makeEnv(db);

    const req = makeAdminCreateClientRequest({
      email: "adminuser@example.com",
      password: "adminpassword",
      full_name: "Admin User",
      role: "admin",
      // slug/business_name/api_key intentionally omitted for admin role
    });

    const resp = await (portalModule as unknown as {
      handlePortal: (req: Request, env: Env) => Promise<Response | null>
    }).handlePortal(req, env);

    expect(resp).not.toBeNull();
    const response = resp as Response;
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.business).toBeNull();

    // No access grants — admin role creates no business
    expect(accessGrants.size).toBe(0);
  });
});
