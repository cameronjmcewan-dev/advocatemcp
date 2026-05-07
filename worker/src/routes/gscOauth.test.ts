/**
 * Tests for worker/src/routes/gscOauth.ts
 *
 * Runs in Node via vitest. Mocks fetch and D1 stubs so no real network or
 * database calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleGSCStart, handleGSCCallback } from "./gscOauth.js";
import { signState } from "../lib/oauthState.js";

const GSC_STATE_PREFIX = "gsc-state:v1:";

// ── Shared minimal Env stub ───────────────────────────────────────────────────

const dbCalls: Array<{ sql: string; args: unknown[] }> = [];

function makeEnv(overrides?: Partial<typeof baseEnv>): typeof baseEnv {
  dbCalls.length = 0; // reset before each test
  return { ...baseEnv, ...overrides };
}

const baseEnv = {
  TOKEN_SIGNING_KEY: "test-signing-key-for-gsc-oauth-tests",
  GSC_OAUTH_CLIENT_ID: "test-gsc-client-id.apps.googleusercontent.com",
  GSC_OAUTH_CLIENT_SECRET: "test-gsc-client-secret-value",
  GSC_OAUTH_REDIRECT_URI: "https://customers.advocatemcp.com/oauth/gsc/callback",
  GA4_TOKEN_ENCRYPTION_KEY: "0".repeat(64),
  // D1 stub — minimal shape the handler touches
  DB: {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          dbCalls.push({ sql, args });
          return { success: true };
        },
      }),
    }),
  },
} as unknown as import("../types.js").Env;

// ── handleGSCStart tests ──────────────────────────────────────────────────────

describe("handleGSCStart", () => {
  it("1. returns 302 with location containing signed state", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/gsc/start?slug=joes-pizza");
    const env = makeEnv();
    const res = await handleGSCStart(req, env);

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location).toContain("state=");
    expect(location).toContain(encodeURIComponent(env.GSC_OAUTH_CLIENT_ID!));
    expect(location).toContain("access_type=offline");
    expect(location).toContain("prompt=consent");
  });

  it("2. missing slug returns 400 JSON error", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/gsc/start");
    const env = makeEnv();
    const res = await handleGSCStart(req, env);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/slug/i);
  });

  it("3. authorize URL includes correct GSC scope and redirect_uri", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/gsc/start?slug=acme");
    const env = makeEnv();
    const res = await handleGSCStart(req, env);
    const location = res.headers.get("Location") ?? "";

    expect(location).toContain("webmasters.readonly");
    expect(location).toContain(encodeURIComponent(env.GSC_OAUTH_REDIRECT_URI!));
  });
});

// ── handleGSCCallback tests ───────────────────────────────────────────────────

describe("handleGSCCallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("4. invalid state redirects to ?gsc=error&reason=state_invalid", async () => {
    const env = makeEnv();
    const req = new Request(
      "https://customers.advocatemcp.com/oauth/gsc/callback?code=auth-code&state=bad.token",
    );
    const res = await handleGSCCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("gsc=error");
    expect(loc).toContain("reason=state_invalid");
  });

  it("5. expired state redirects to ?gsc=error&reason=state_expired", async () => {
    const env = makeEnv();
    // Build a real but expired token
    const expiredToken = await signState(
      {
        slug: "joes-pizza",
        nonce: "deadbeefdeadbeef",
        ts: Math.floor(Date.now() / 1000) - 700,
      },
      env.TOKEN_SIGNING_KEY!,
      GSC_STATE_PREFIX,
    );
    const req = new Request(
      `https://customers.advocatemcp.com/oauth/gsc/callback?code=auth-code&state=${encodeURIComponent(expiredToken)}`,
    );
    const res = await handleGSCCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("gsc=error");
    expect(loc).toContain("reason=state_expired");
  });

  it("6. missing code redirects to ?gsc=error&reason=missing_params", async () => {
    const env = makeEnv();
    const validToken = await signState(
      {
        slug: "joes-pizza",
        nonce: "aaaaaaaaaaaaaaaa",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      GSC_STATE_PREFIX,
    );
    const req = new Request(
      `https://customers.advocatemcp.com/oauth/gsc/callback?state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGSCCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("gsc=error");
    expect(loc).toContain("reason=missing_params");
  });

  it("7. happy path: writes encrypted token to DB and redirects to ?gsc=connected", async () => {
    const env = makeEnv();
    const slug = "joes-pizza";
    const plainRefreshToken = "ya29.A0ARrdaM-example-gsc-refresh-token-value";

    const validToken = await signState(
      {
        slug,
        nonce: "bbbbbbbbbbbbbbbb",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      GSC_STATE_PREFIX,
    );

    // Mock Google token endpoint
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          refresh_token: plainRefreshToken,
          access_token: "ya29.access",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/gsc/callback?code=auth-code-xyz&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGSCCallback(req, env);

    // Redirects to connected page
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("gsc=connected");
    expect(loc).not.toContain("gsc=error");

    // DB write happened with correct slug
    expect(dbCalls.length).toBeGreaterThan(0);
    const dbCall = dbCalls[0];
    expect(dbCall.args[0]).toBe(slug);

    // The stored value must NOT be the plaintext refresh token
    const storedEncrypted = dbCall.args[1] as string;
    expect(storedEncrypted).not.toBe(plainRefreshToken);
    // It should look like base64 (AES-GCM output format)
    expect(() => atob(storedEncrypted)).not.toThrow();
    // AES-GCM adds 12B IV + 16B auth tag = 28B overhead; ciphertext byte
    // length must exceed plaintext byte length. Catches a regression where
    // encryptToken was replaced with a no-op base64 encoder.
    const ctBytes = atob(storedEncrypted).length;
    const ptBytes = new TextEncoder().encode(plainRefreshToken).length;
    expect(ctBytes).toBeGreaterThanOrEqual(ptBytes + 28);
    // And the plaintext must NOT appear inside the base64-decoded ciphertext.
    expect(atob(storedEncrypted)).not.toContain(plainRefreshToken);
  });

  it("8. missing state redirects to ?gsc=error&reason=missing_params", async () => {
    const env = makeEnv();
    const req = new Request(
      "https://customers.advocatemcp.com/oauth/gsc/callback?code=some-code",
    );
    const res = await handleGSCCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("gsc=error");
    expect(loc).toContain("reason=missing_params");
  });

  it("9. no refresh_token in Google response redirects to ?gsc=error&reason=no_refresh_token", async () => {
    const env = makeEnv();
    const validToken = await signState(
      {
        slug: "acme",
        nonce: "cccccccccccccccc",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      GSC_STATE_PREFIX,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "ya29.access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/gsc/callback?code=code-no-refresh&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGSCCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("gsc=error");
    expect(loc).toContain("reason=no_refresh_token");
  });
});
