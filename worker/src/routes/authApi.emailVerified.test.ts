import { describe, it, expect } from "vitest";
import { getSessionFromRequest } from "./authApi";

function mockEnv(opts: { email_verified: 0 | 1 }) {
  const DB = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              // getSessionByToken does a single JOIN across sessions + users.
              // The query contains both "sessions" and "FROM users", so match
              // on "token_hash" which is a reliable distinguisher.
              if (/token_hash/i.test(sql)) {
                return {
                  id: "s1",
                  user_id: "u1",
                  token_hash: "h",
                  expires_at: new Date(Date.now() + 3600_000).toISOString(),
                  created_at: new Date().toISOString(),
                  last_seen_at: new Date().toISOString(),
                  email: "test@example.com",
                  password_hash: "h",
                  salt: "s",
                  full_name: "Test",
                  role: "client",
                  email_verified: opts.email_verified,
                  u_created_at: new Date().toISOString(),
                  u_updated_at: new Date().toISOString(),
                };
              }
              return null;
            },
            async run() { return { success: true }; },
          };
        },
      };
    },
  };
  return { DB: DB as unknown as D1Database } as unknown as Parameters<typeof getSessionFromRequest>[1];
}

function reqWithCookie(): Request {
  // getSessionToken reads "amcp_session" cookie (src/auth.ts SESSION_COOKIE)
  return new Request("https://customers.advocatemcp.com/api/client/all-metrics", {
    headers: { Cookie: "amcp_session=raw_token_value" },
  });
}

describe("getSessionFromRequest — email_verified surfacing", () => {
  it("returns email_verified=1 in the AuthContext when the column is 1", async () => {
    const env = mockEnv({ email_verified: 1 });
    const ctx = await getSessionFromRequest(reqWithCookie(), env);
    expect(ctx).not.toBeNull();
    expect(ctx!.email_verified).toBe(1);
  });

  it("returns email_verified=0 when the column is 0", async () => {
    const env = mockEnv({ email_verified: 0 });
    const ctx = await getSessionFromRequest(reqWithCookie(), env);
    expect(ctx).not.toBeNull();
    expect(ctx!.email_verified).toBe(0);
  });
});
