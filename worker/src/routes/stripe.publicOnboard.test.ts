import { describe, it, expect, beforeEach, vi } from "vitest";
import { handlePublicOnboard } from "./stripe";

// Minimal env mock — only what handlePublicOnboard touches for the
// password-handling path. Stripe creation, KV writes, etc. are stubbed
// to no-op success responses.
function mockEnv() {
  const users = new Map<string, { id: string; email: string; password_hash: string; salt: string; email_verified: number }>();
  const sessions = new Map<string, { id: string; user_id: string; token_hash: string }>();

  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (/^INSERT INTO users/i.test(sql)) {
                const [id, email, password_hash, salt] = args as string[];
                users.set(id, { id, email, password_hash, salt, email_verified: 0 });
              }
              if (/^INSERT INTO sessions/i.test(sql)) {
                const [id, user_id, token_hash] = args as string[];
                sessions.set(id, { id, user_id, token_hash });
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
                const id = args[0] as string;
                return (users.get(id) ?? null) as T;
              }
              if (/SELECT .* FROM sessions WHERE id/i.test(sql)) {
                const id = args[0] as string;
                return (sessions.get(id) ?? null) as T;
              }
              return null;
            },
            async all() {
              return { results: [], success: true };
            },
          };
        },
      };
    },
  };

  const KV = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(null) };

  return {
    env: {
      DB: DB as unknown as D1Database,
      TENANT_DATA: KV as unknown as KVNamespace,
      BUSINESS_MAP: KV as unknown as KVNamespace,
      ACCESS_TOKEN_SIGNING_KEY: "x".repeat(64),
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_PRICE_ID_BASE: "price_base",
      STRIPE_PRICE_ID_PRO: "price_pro",
    } as unknown as Parameters<typeof handlePublicOnboard>[1],
    users,
    sessions,
  };
}

function jsonReq(body: unknown): Request {
  return new Request("https://customers.advocatemcp.com/api/onboard/public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handlePublicOnboard — password handling", () => {
  beforeEach(() => {
    // Stub Stripe checkout creation (the public onboard ends with a redirect URL)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/cs_test_123" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
  });

  it("rejects payload missing password with 400 + validation_error", async () => {
    const { env } = mockEnv();
    const req = jsonReq({
      slug: "smoke-test-001",
      name: "Smoke Test",
      email: "smoke@example.com",
      plan: "base",
      // password omitted
    });
    const res = await handlePublicOnboard(req, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("rejects password shorter than 8 chars", async () => {
    const { env } = mockEnv();
    const req = jsonReq({
      slug: "smoke-test-002",
      name: "Smoke Test",
      email: "smoke2@example.com",
      password: "short",
      plan: "base",
    });
    const res = await handlePublicOnboard(req, env);
    expect(res.status).toBe(400);
  });

  it("hashes the password and inserts a users row with email_verified=0", async () => {
    const { env, users } = mockEnv();
    const req = jsonReq({
      slug: "smoke-test-003",
      name: "Smoke Test",
      email: "smoke3@example.com",
      password: "correct-horse-battery",
      plan: "base",
    });
    await handlePublicOnboard(req, env);
    const inserted = Array.from(users.values()).find(u => u.email === "smoke3@example.com");
    expect(inserted).toBeDefined();
    expect(inserted!.email_verified).toBe(0);
    expect(inserted!.password_hash.length).toBeGreaterThan(20);
    expect(inserted!.password_hash).not.toBe("correct-horse-battery"); // not plaintext
  });

  it("sets the amcp_refresh cookie on the response", async () => {
    const { env } = mockEnv();
    const req = jsonReq({
      slug: "smoke-test-004",
      name: "Smoke Test",
      email: "smoke4@example.com",
      password: "correct-horse-battery",
      plan: "base",
    });
    const res = await handlePublicOnboard(req, env);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/amcp_refresh=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
  });
});
