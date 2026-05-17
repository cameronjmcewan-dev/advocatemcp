/**
 * Tests POST /api/auth/logout (the Phase C handleAuthLogout endpoint at
 * authApi.ts:445) clears BOTH the legacy amcp_session cookie and the
 * Phase C amcp_refresh cookie.
 *
 * Pre-fix: the handler only cleared amcp_refresh, leaving amcp_session
 * intact in the browser AND the D1 session row for amcp_session
 * undeleted. Any subsequent request that walked
 * getSessionFromRequest's cookie branch would silently re-authenticate
 * the user — sign-out appeared to do nothing. The legacy /auth/logout
 * handler at portal.ts:764 was fixed for the same bug shape; see the
 * comment block there + portal.legacyLogout.test.ts for the mirror.
 *
 * Post-fix: both cookies are cleared via two Set-Cookie headers
 * (Headers.append — a plain object literal can only carry one
 * Set-Cookie value) AND both D1 session rows are best-effort deleted.
 */

import { describe, it, expect } from "vitest";
import { handlePortal } from "./portal";
import type { Env } from "../types";

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
    BUSINESS_MAP: {} as unknown as KVNamespace,
    TENANT_DATA:  {} as unknown as KVNamespace,
  } as unknown as Env;
}

function makeLogoutRequest(): Request {
  return new Request("https://customers.advocatemcp.com/api/auth/logout", {
    method:  "POST",
    headers: { Cookie: "amcp_session=stale-session; amcp_refresh=stale-refresh" },
  });
}

function getSetCookies(res: Response): string[] {
  // Headers.getSetCookie is the right API for multi-cookie responses
  // (Node 20+ / undici). Older types don't include it, so we cast.
  const headersAny = res.headers as unknown as { getSetCookie?: () => string[] };
  if (headersAny.getSetCookie) return headersAny.getSetCookie();
  const single = res.headers.get("Set-Cookie");
  return single ? [single] : [];
}

describe("POST /api/auth/logout — cookie clearing", () => {
  it("returns 200 with ok:true", async () => {
    const env = mockEnv();
    const res = await handlePortal(makeLogoutRequest(), env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("clears amcp_refresh cookie with matching Path + Domain", async () => {
    // The refresh cookie was set with Path=/api/auth/refresh +
    // Domain=.advocatemcp.com — the clear-cookie header MUST match those
    // attributes or the browser will keep the original cookie.
    const env = mockEnv();
    const res = await handlePortal(makeLogoutRequest(), env);
    const setCookies = getSetCookies(res!);
    const refreshClear = setCookies.find((c) => /^amcp_refresh=/.test(c));
    expect(refreshClear).toBeDefined();
    expect(refreshClear!).toMatch(/Max-Age=0/);
    expect(refreshClear!).toMatch(/Path=\/api\/auth\/refresh/);
    expect(refreshClear!).toMatch(/Domain=\.advocatemcp\.com/);
  });

  it("clears amcp_session cookie with matching Path + Domain", async () => {
    // The session cookie was set with Path=/ + Domain=.advocatemcp.com —
    // the clear-cookie header MUST match those attributes or the browser
    // will keep the original cookie. This is the regression that broke
    // sign-out pre-fix: the Phase C handler only cleared amcp_refresh.
    const env = mockEnv();
    const res = await handlePortal(makeLogoutRequest(), env);
    const setCookies = getSetCookies(res!);
    const sessionClear = setCookies.find((c) => /^amcp_session=/.test(c));
    expect(sessionClear).toBeDefined();
    expect(sessionClear!).toMatch(/Max-Age=0/);
    expect(sessionClear!).toMatch(/Path=\//);
    expect(sessionClear!).toMatch(/Domain=\.advocatemcp\.com/);
  });

  it("attempts to delete both D1 session rows (legacy + refresh)", async () => {
    // Best-effort delete: both refresh-keyed and session-keyed rows are
    // queried on logout. We don't assert success (D1 may be empty or
    // the request may have no cookie); we assert the handler issued
    // both DELETE statements via the prepare() spy.
    const calls: string[] = [];
    const DB = {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async first() { return null; },
              async run() {
                if (/delete\s+from\s+sessions/i.test(sql)) calls.push(sql);
                return { meta: {} };
              },
            };
          },
          async run() { return { meta: {} }; },
          async first() { return null; },
        };
      },
    };
    const env = {
      DB: DB as unknown as D1Database,
      BUSINESS_MAP: {} as unknown as KVNamespace,
      TENANT_DATA:  {} as unknown as KVNamespace,
    } as unknown as Env;
    await handlePortal(makeLogoutRequest(), env);
    // Two DELETE FROM sessions calls: one for the refresh-token hash,
    // one for the session-token hash. Both via deleteSession(env.DB, raw).
    expect(calls.length).toBe(2);
  });
});
