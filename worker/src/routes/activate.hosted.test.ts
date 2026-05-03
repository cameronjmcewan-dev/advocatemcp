import { describe, it, expect, vi } from "vitest";
import { handleActivateHosted } from "./activate";

function mockEnvWithUser(opts: { hasPassword: boolean }) {
  const userId = "user_existing_001";
  const users = new Map<string, { id: string; email: string; password_hash: string; salt: string; email_verified: number; full_name: string; role: string }>();
  if (opts.hasPassword) {
    users.set(userId, {
      id: userId,
      email: "existing@example.com",
      password_hash: "stored_hash",
      salt: "stored_salt",
      email_verified: 0,
      full_name: "Existing User",
      role: "client",
    });
  }

  const businesses = new Map<string, { id: string; slug: string }>();
  businesses.set("biz_001", { id: "biz_001", slug: "smoke-test-001" });

  const sessions = new Map<string, unknown>();
  const updates: { sql: string; args: unknown[] }[] = [];

  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              updates.push({ sql, args });
              if (/INSERT INTO sessions/i.test(sql)) {
                sessions.set(args[0] as string, { user_id: args[1], token_hash: args[2] });
              }
              if (/INSERT INTO users/i.test(sql)) {
                const [id, email, password_hash, salt, full_name, role] = args as string[];
                users.set(id, { id, email, password_hash, salt, full_name, role, email_verified: 0 });
              }
              return { success: true, meta: { changes: 1 } };
            },
            async first<T>() {
              if (/SELECT .* FROM users WHERE email/i.test(sql)) {
                const email = args[0] as string;
                for (const u of users.values()) if (u.email === email) return u as T;
                return null;
              }
              if (/SELECT .* FROM users WHERE id/i.test(sql)) {
                return (users.get(args[0] as string) ?? null) as T;
              }
              if (/SELECT .* FROM businesses WHERE slug/i.test(sql)) {
                for (const b of businesses.values()) if (b.slug === args[0]) return b as T;
                return null;
              }
              return null;
            },
          };
        },
      };
    },
  };

  return {
    env: {
      DB: DB as unknown as D1Database,
      TENANT_DATA: { get: vi.fn().mockResolvedValue(JSON.stringify({
        slug: "smoke-test-001",
        name: "Smoke Test",
        email: "existing@example.com",
        skipDns: true,
      })) } as unknown as KVNamespace,
      ACTIVATION_SIGNING_KEY: "y".repeat(64),
      ACCESS_TOKEN_SIGNING_KEY: "x".repeat(64),
      RESEND_API_KEY: "re_dummy",
    },
    users,
    sessions,
    updates,
    userId,
  };
}

async function tokenReq(env: unknown, body: Record<string, unknown> = {}): Promise<Request> {
  const { signActivationToken } = await import("../lib/activation-token");
  const token = await signActivationToken(
    { slug: "smoke-test-001" },
    (env as { ACTIVATION_SIGNING_KEY: string }).ACTIVATION_SIGNING_KEY,
  );
  return new Request("https://customers.advocatemcp.com/api/activate/hosted", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Activation-Token": token },
    body: JSON.stringify(body),
  });
}

describe("handleActivateHosted — existing-user branch", () => {
  it("when user has password_hash, succeeds with empty body — sets email_verified=1, mints session", async () => {
    const { env, updates } = mockEnvWithUser({ hasPassword: true });
    const req = await tokenReq(env, {});
    const res = await handleActivateHosted(req, env as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(updates.some(u => /UPDATE users SET email_verified\s*=\s*1/i.test(u.sql))).toBe(true);
    expect(res.headers.get("Set-Cookie") ?? "").toMatch(/amcp_refresh=/);
  });

  it("when user has password_hash, ignores any password in the body (does not overwrite hash)", async () => {
    const { env, updates } = mockEnvWithUser({ hasPassword: true });
    const req = await tokenReq(env, { password: "different-password" });
    await handleActivateHosted(req, env as never);
    expect(updates.some(u => /UPDATE users SET password_hash/i.test(u.sql))).toBe(false);
  });

  it("when no users row exists yet (legacy path), still requires + accepts a password ≥8 chars", async () => {
    const { env, updates } = mockEnvWithUser({ hasPassword: false });
    const req = await tokenReq(env, { password: "correct-horse-battery" });
    const res = await handleActivateHosted(req, env as never);
    expect(res.status).toBe(200);
    expect(updates.some(u => /INSERT INTO users/i.test(u.sql))).toBe(true);
  });

  it("legacy path rejects missing password with 400", async () => {
    const { env } = mockEnvWithUser({ hasPassword: false });
    const req = await tokenReq(env, {});
    const res = await handleActivateHosted(req, env as never);
    expect(res.status).toBe(400);
  });
});
