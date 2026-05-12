/**
 * Tests for the SOC 2 CC6.1/CC6.6 TOTP login flow added in
 * worker/src/routes/authApi.ts handleAuthLogin.
 *
 * Verifies:
 *   - User without totp_enabled_at: password-only login still works.
 *   - User with totp_enabled_at + no code in body: returns 401 totp_required.
 *   - User with totp_enabled_at + valid code: returns 200 with access token.
 *   - User with totp_enabled_at + wrong code: returns 401 invalid_credentials
 *     (NOT totp_required — that would leak "your password was right").
 *   - Pending-enrollment user (totp_secret set but totp_enabled_at NULL): does
 *     NOT require a code at login. Confirms the lifecycle gate uses
 *     totp_enabled_at, not totp_secret presence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAuthLogin } from "./authApi";
import { hashPasswordEncoded } from "../auth";
import { generateTotpSecret, generateTotpCode } from "../lib/totp";

interface FakeUserRow {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  full_name: string | null;
  role: string;
  tenant_id: string | null;
  totp_secret: string | null;
  totp_enabled_at: string | null;
}

interface FakeStore {
  users: Map<string, FakeUserRow>;
  loginAttempts: number;
  auditRows: { event_type: string }[];
}

function makeDb(store: FakeStore): D1Database {
  return {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (norm.includes("FROM users WHERE email = ?")) {
                const email = (params[0] as string).toLowerCase().trim();
                for (const u of store.users.values()) {
                  if (u.email === email) return u as unknown as T;
                }
                return null;
              }
              if (
                norm.includes("FROM login_attempts") ||
                norm.includes("COUNT")
              ) {
                return { count: store.loginAttempts } as unknown as T;
              }
              return null;
            },
            async run() {
              if (norm.startsWith("INSERT INTO login_attempts")) {
                store.loginAttempts++;
                return { meta: { changes: 1 } };
              }
              if (norm.startsWith("INSERT INTO sessions")) {
                return { meta: { changes: 1 } };
              }
              if (norm.startsWith("INSERT INTO audit_events")) {
                const event_type = params[4] as string;
                store.auditRows.push({ event_type });
                return { meta: { changes: 1 } };
              }
              if (norm.startsWith("UPDATE users")) {
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeEnv(db: D1Database) {
  return {
    DB: db,
    ACCESS_TOKEN_SIGNING_KEY: "x".repeat(48),
  } as unknown as Parameters<typeof handleAuthLogin>[1];
}

async function makeUser(opts: {
  password: string;
  totp_enabled?: boolean;
  totp_pending_only?: boolean;
}): Promise<FakeUserRow> {
  const passwordHashEncoded = await hashPasswordEncoded(opts.password);
  let secret: string | null = null;
  let enabledAt: string | null = null;
  if (opts.totp_enabled) {
    secret = generateTotpSecret();
    enabledAt = "2026-05-01T00:00:00.000Z";
  } else if (opts.totp_pending_only) {
    secret = generateTotpSecret();
    enabledAt = null;
  }
  return {
    id: "user-id-1",
    email: "max@advocate-mcp.com",
    password_hash: passwordHashEncoded,
    salt: "",
    full_name: "Max",
    role: "admin",
    tenant_id: null,
    totp_secret: secret,
    totp_enabled_at: enabledAt,
  };
}

function emptyStore(): FakeStore {
  return { users: new Map(), loginAttempts: 0, auditRows: [] };
}

async function loginRequest(body: Record<string, unknown>): Promise<Request> {
  return new Request("https://customers.advocatemcp.com/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleAuthLogin — TOTP second factor", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("password-only login still works when totp_enabled_at is NULL", async () => {
    const store = emptyStore();
    const user = await makeUser({ password: "hunter22" });
    store.users.set(user.email, user);

    const res = await handleAuthLogin(
      await loginRequest({ email: user.email, password: "hunter22" }),
      makeEnv(makeDb(store)),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { access_token?: string };
    expect(typeof body.access_token).toBe("string");
    expect(store.auditRows.some((r) => r.event_type === "auth.login_success")).toBe(true);
  });

  it("pending-enrollment (secret set, totp_enabled_at NULL) does NOT require a code", async () => {
    const store = emptyStore();
    const user = await makeUser({ password: "hunter22", totp_pending_only: true });
    store.users.set(user.email, user);

    const res = await handleAuthLogin(
      await loginRequest({ email: user.email, password: "hunter22" }),
      makeEnv(makeDb(store)),
    );
    expect(res.status).toBe(200);
  });

  it("totp_enabled + no code => 401 totp_required", async () => {
    const store = emptyStore();
    const user = await makeUser({ password: "hunter22", totp_enabled: true });
    store.users.set(user.email, user);

    const res = await handleAuthLogin(
      await loginRequest({ email: user.email, password: "hunter22" }),
      makeEnv(makeDb(store)),
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("totp_required");
    expect(store.auditRows.some((r) => r.event_type === "auth.login_totp_required")).toBe(true);
  });

  it("totp_enabled + wrong code => 401 invalid_credentials (NOT totp_required, to avoid leaking 'password was right')", async () => {
    const store = emptyStore();
    const user = await makeUser({ password: "hunter22", totp_enabled: true });
    store.users.set(user.email, user);

    const res = await handleAuthLogin(
      await loginRequest({ email: user.email, password: "hunter22", code: "000000" }),
      makeEnv(makeDb(store)),
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("invalid_credentials");
    expect(store.auditRows.some((r) => r.event_type === "auth.login_totp_failed")).toBe(true);
  });

  it("totp_enabled + valid code => 200 access token + login_success audit", async () => {
    const store = emptyStore();
    const user = await makeUser({ password: "hunter22", totp_enabled: true });
    store.users.set(user.email, user);
    const validCode = await generateTotpCode(user.totp_secret!);

    const res = await handleAuthLogin(
      await loginRequest({ email: user.email, password: "hunter22", code: validCode }),
      makeEnv(makeDb(store)),
    );
    expect(res.status).toBe(200);
    expect(store.auditRows.some((r) => r.event_type === "auth.login_success")).toBe(true);
  });

  it("totp_enabled + wrong password => 401 invalid_credentials BEFORE TOTP is checked", async () => {
    const store = emptyStore();
    const user = await makeUser({ password: "hunter22", totp_enabled: true });
    store.users.set(user.email, user);
    const validCode = await generateTotpCode(user.totp_secret!);

    const res = await handleAuthLogin(
      await loginRequest({ email: user.email, password: "wrongpassword", code: validCode }),
      makeEnv(makeDb(store)),
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("invalid_credentials");
    // Crucially, no totp-failed audit row — password failed first, so the
    // TOTP path was never reached.
    expect(store.auditRows.some((r) => r.event_type === "auth.login_totp_failed")).toBe(false);
    expect(store.auditRows.some((r) => r.event_type === "auth.login_failure")).toBe(true);
  });
});
