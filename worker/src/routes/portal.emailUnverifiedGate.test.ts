/**
 * Tests that all /api/client/* handlers (and the dashboard) reject
 * requests from users with email_verified=0 with 403 + error_code:
 * "email_unverified". Also confirms that verified users (email_verified=1)
 * are not blocked by this gate.
 *
 * Mocking strategy: vi.mock("./authApi") so getSessionFromRequest is fully
 * under test control — no D1 / crypto / access-token machinery needed.
 * The handler itself still runs, so for the verified-user test we also stub
 * the downstream D1 calls that apiAllMetrics makes (getUserBusinesses etc.)
 * to be no-ops rather than spinning up a full D1 emulator.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist the getSessionFromRequest mock before any module loads ────────────
// vi.mock factories are hoisted to the top of the file; we use vi.hoisted to
// create the spy before any module imports run so the factory can reference it.

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

// ── Stub the portalDb helpers that the handler chain calls after auth ────────
// apiAllMetrics calls getActiveBusinesses — stub so it returns [] on the
// verified path (so we never actually try to hit D1).

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

// ── Minimal env stub ─────────────────────────────────────────────────────────

function mockEnv(): Env {
  const DB = {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return { async first() { return null; }, async run() { return { meta: {} }; } };
        },
        async run() { return { meta: {} }; },
        async first() { return null; },
      };
    },
  };
  return {
    DB: DB as unknown as D1Database,
    BUSINESS_MAP: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } as unknown as KVNamespace,
  } as unknown as Env;
}

function unverifiedCtx(): AuthContext {
  return {
    user_id: "u1",
    email: "test@example.com",
    full_name: "Test User",
    role: "client",
    tenant_id: null,
    email_verified: 0,
    auth_method: "cookie",
  };
}

function verifiedCtx(): AuthContext {
  return { ...unverifiedCtx(), email_verified: 1 };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("portal — email_verified gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 + email_unverified for unverified user hitting /api/client/all-metrics", async () => {
    mockGetSession.mockResolvedValue(unverifiedCtx());
    const env = mockEnv();
    const req = new Request("https://customers.advocatemcp.com/api/client/all-metrics", {
      headers: { Cookie: "amcp_session=raw_token_value" },
    });
    const res = await handlePortal(req, env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json() as { error_code: string };
    expect(body.error_code).toBe("email_unverified");
  });

  it("does NOT return 403 email_unverified when user is verified", async () => {
    mockGetSession.mockResolvedValue(verifiedCtx());
    const env = mockEnv();
    const req = new Request("https://customers.advocatemcp.com/api/client/all-metrics", {
      headers: { Cookie: "amcp_session=raw_token_value" },
    });
    const res = await handlePortal(req, env);
    expect(res).not.toBeNull();
    // May be 4xx for a different reason (no business linked, etc.) but
    // must NOT be 403 with error_code email_unverified.
    if (res!.status === 403) {
      const body = await res!.json() as { error_code?: string };
      expect(body.error_code).not.toBe("email_unverified");
    }
  });

  it("returns 403 + email_unverified for unverified user hitting /api/client/metrics", async () => {
    mockGetSession.mockResolvedValue(unverifiedCtx());
    const env = mockEnv();
    const req = new Request("https://customers.advocatemcp.com/api/client/metrics");
    const res = await handlePortal(req, env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json() as { error_code: string };
    expect(body.error_code).toBe("email_unverified");
  });

  it("returns 403 + email_unverified for unverified user hitting /api/client/me", async () => {
    mockGetSession.mockResolvedValue(unverifiedCtx());
    const env = mockEnv();
    const req = new Request("https://customers.advocatemcp.com/api/client/me");
    const res = await handlePortal(req, env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json() as { error_code: string };
    expect(body.error_code).toBe("email_unverified");
  });

  it("returns 403 + email_unverified for unverified user hitting /api/client/profile", async () => {
    mockGetSession.mockResolvedValue(unverifiedCtx());
    const env = mockEnv();
    const req = new Request("https://customers.advocatemcp.com/api/client/profile");
    const res = await handlePortal(req, env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json() as { error_code: string };
    expect(body.error_code).toBe("email_unverified");
  });

  it("returns 401 + no_session (not 403) when there is no session at all", async () => {
    mockGetSession.mockResolvedValue(null);
    const env = mockEnv();
    const req = new Request("https://customers.advocatemcp.com/api/client/all-metrics");
    const res = await handlePortal(req, env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await res!.json() as { error_code: string };
    expect(body.error_code).toBe("no_session");
  });
});
