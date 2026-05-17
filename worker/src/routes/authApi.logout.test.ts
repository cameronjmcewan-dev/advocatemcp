/**
 * Characterization tests for POST /api/auth/logout (the Phase C
 * handleAuthLogout endpoint at authApi.ts:445).
 *
 * Current behavior captured in this file (as of this commit):
 *   - Returns 200 with {ok:true}.
 *   - Clears the Phase C refresh cookie (amcp_refresh).
 *   - DOES NOT clear the legacy session cookie (amcp_session). This is a
 *     regression: the legacy /auth/logout handler at portal.ts:764 was
 *     fixed to clear BOTH cookies (see portal.legacyLogout.test.ts and
 *     the comment block at portal.ts:755-762), but the Phase C migration
 *     to /api/auth/logout did not carry forward that fix. The legacy
 *     amcp_session cookie + its D1 session row survive, so any path that
 *     hits getSessionFromRequest's cookie branch re-authenticates the
 *     user silently after they "signed out".
 *
 * The third test below explicitly LOCKS IN the regression. When the fix
 * lands, that test's assertion flips from `toBeUndefined` to
 * `toBeDefined` (plus the matching attribute checks).
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

describe("POST /api/auth/logout — current cookie-clearing behavior", () => {
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

  it("[Phase C regression] does NOT clear amcp_session cookie", async () => {
    // This test LOCKS IN the current bug. The Phase C handleAuthLogout
    // only emits a single Set-Cookie header (for amcp_refresh) and
    // leaves the legacy amcp_session cookie intact in the browser. When
    // the fix lands, this expectation flips to `toBeDefined` (with
    // matching Path=/, Domain=.advocatemcp.com, Max-Age=0 attributes,
    // mirroring the legacy portal.legacyLogout.test.ts pattern).
    const env = mockEnv();
    const res = await handlePortal(makeLogoutRequest(), env);
    const setCookies = getSetCookies(res!);
    const sessionClear = setCookies.find((c) => /^amcp_session=/.test(c));
    expect(sessionClear).toBeUndefined();
  });
});
