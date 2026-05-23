/**
 * Tests for worker/src/routes/ga4Oauth.ts
 *
 * Runs in Node via vitest. Mocks fetch and D1 stubs so no real network or
 * database calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleGA4Start, handleGA4Callback } from "./ga4Oauth.js";
import { signGA4State } from "../lib/ga4State.js";

// ── Shared minimal Env stub ───────────────────────────────────────────────────

const dbCalls: Array<{ sql: string; args: unknown[] }> = [];

function makeEnv(overrides?: Partial<typeof baseEnv>): typeof baseEnv {
  dbCalls.length = 0; // reset before each test
  return { ...baseEnv, ...overrides };
}

const baseEnv = {
  TOKEN_SIGNING_KEY: "test-signing-key-for-ga4-oauth-tests",
  GA4_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GA4_OAUTH_CLIENT_SECRET: "test-client-secret-value",
  GA4_OAUTH_REDIRECT_URI: "https://customers.advocatemcp.com/oauth/ga4/callback",
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

// ── handleGA4Start tests ──────────────────────────────────────────────────────

describe("handleGA4Start", () => {
  it("1. returns 302 with location containing signed state", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/ga4/start?slug=joes-pizza");
    const env = makeEnv();
    const res = await handleGA4Start(req, env);

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location).toContain("state=");
    expect(location).toContain(encodeURIComponent(env.GA4_OAUTH_CLIENT_ID!));
    expect(location).toContain("access_type=offline");
    expect(location).toContain("prompt=consent");
  });

  it("2. missing slug returns 400 JSON error", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/ga4/start");
    const env = makeEnv();
    const res = await handleGA4Start(req, env);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/slug/i);
  });

  it("3. authorize URL includes correct scope and redirect_uri", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/ga4/start?slug=acme");
    const env = makeEnv();
    const res = await handleGA4Start(req, env);
    const location = res.headers.get("Location") ?? "";

    expect(location).toContain("analytics.readonly");
    expect(location).toContain(encodeURIComponent(env.GA4_OAUTH_REDIRECT_URI!));
  });

  it("3a. authorize URL requests openid+email scopes (powers GA4 card account-email display)", async () => {
    // Mirror of PR #258's GSC test 3a. The GA4 card displays
    // "Connected as <email>" using the email captured at callback
    // time from the id_token. id_token is only issued when
    // openid+email scopes are in the OAuth request. If someone
    // strips these scopes in a future refactor, the card silently
    // falls back to the slug-only "Connected" copy — same regression
    // surface the GSC version protects against.
    const req = new Request("https://customers.advocatemcp.com/oauth/ga4/start?slug=acme");
    const env = makeEnv();
    const res = await handleGA4Start(req, env);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("openid");
    expect(location).toContain("email");
  });
});

// ── handleGA4Callback tests ───────────────────────────────────────────────────

describe("handleGA4Callback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("4. invalid state redirects to ?ga4=error&reason=state_invalid", async () => {
    const env = makeEnv();
    const req = new Request(
      "https://customers.advocatemcp.com/oauth/ga4/callback?code=auth-code&state=bad.token",
    );
    const res = await handleGA4Callback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("ga4=error");
    expect(loc).toContain("reason=state_invalid");
  });

  it("5. expired state redirects to ?ga4=error&reason=state_expired", async () => {
    const env = makeEnv();
    // Build a real but expired token
    const expiredToken = await signGA4State(
      {
        slug: "joes-pizza",
        nonce: "deadbeefdeadbeef",
        ts: Math.floor(Date.now() / 1000) - 700,
      },
      env.TOKEN_SIGNING_KEY!,
    );
    const req = new Request(
      `https://customers.advocatemcp.com/oauth/ga4/callback?code=auth-code&state=${encodeURIComponent(expiredToken)}`,
    );
    const res = await handleGA4Callback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("ga4=error");
    expect(loc).toContain("reason=state_expired");
  });

  it("6. missing code redirects to ?ga4=error&reason=missing_params", async () => {
    const env = makeEnv();
    const validToken = await signGA4State(
      {
        slug: "joes-pizza",
        nonce: "aaaaaaaaaaaaaaaa",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
    );
    const req = new Request(
      `https://customers.advocatemcp.com/oauth/ga4/callback?state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGA4Callback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("ga4=error");
    expect(loc).toContain("reason=missing_params");
  });

  it("7. happy path: writes encrypted token to DB and redirects to ?ga4=connected", async () => {
    const env = makeEnv();
    const slug = "joes-pizza";
    const plainRefreshToken = "ya29.A0ARrdaM-example-refresh-token-value";

    const validToken = await signGA4State(
      {
        slug,
        nonce: "bbbbbbbbbbbbbbbb",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
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
      `https://customers.advocatemcp.com/oauth/ga4/callback?code=auth-code-xyz&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGA4Callback(req, env);

    // Redirects to connected page
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("ga4=connected");
    expect(loc).not.toContain("ga4=error");

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

  it("8. missing state redirects to ?ga4=error&reason=missing_params", async () => {
    const env = makeEnv();
    const req = new Request(
      "https://customers.advocatemcp.com/oauth/ga4/callback?code=some-code",
    );
    const res = await handleGA4Callback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("ga4=error");
    expect(loc).toContain("reason=missing_params");
  });

  it("9. no refresh_token in Google response redirects to ?ga4=error&reason=no_refresh_token", async () => {
    const env = makeEnv();
    const validToken = await signGA4State(
      {
        slug: "acme",
        nonce: "cccccccccccccccc",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "ya29.access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/ga4/callback?code=code-no-refresh&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGA4Callback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("ga4=error");
    expect(loc).toContain("reason=no_refresh_token");
  });

  // ── google_account_email capture (added 2026-05-23) ────────────────────────
  // Mirror of PR #258's GSC id_token tests. The OAuth scope now
  // includes `openid email`, so the token response carries an
  // id_token whose JWT payload includes the connected Google account's
  // email. handleGA4Callback decodes it (no signature check — token
  // came directly from Google over TLS) and persists it to
  // ga4_connections.google_account_email. The dashboard's GA4 card
  // renders "Connected as <email>" when this column is populated.

  /**
   * Build a fake id_token (header.payload.signature) with the given
   * payload object. Signature is intentionally garbage — we don't
   * verify it in handleGA4Callback, only decode the payload.
   */
  function makeFakeIdToken(payload: Record<string, unknown>): string {
    const header = "eyJhbGciOiJSUzI1NiJ9"; // {"alg":"RS256"} base64url
    const payloadJson = JSON.stringify(payload);
    // btoa→base64url: + → -, / → _, strip padding
    const payloadB64 = btoa(payloadJson)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${header}.${payloadB64}.fake-signature-not-verified`;
  }

  it("10. happy path with id_token: persists google_account_email", async () => {
    const env = makeEnv();
    const slug = "acme-widgets";
    const expectedEmail = "owner@acme.example";

    const validToken = await signGA4State(
      { slug, nonce: "dddddddddddddddd", ts: Math.floor(Date.now() / 1000) },
      env.TOKEN_SIGNING_KEY!,
    );

    const idToken = makeFakeIdToken({
      email: expectedEmail,
      email_verified: true,
      sub: "1234567890",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          refresh_token: "ya29.refresh-id-token-case",
          access_token:  "ya29.access",
          expires_in:    3600,
          id_token:      idToken,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/ga4/callback?code=auth-code-id-token&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGA4Callback(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toContain("ga4=connected");

    // DB write captured the email in the bind args.
    expect(dbCalls.length).toBeGreaterThan(0);
    const dbCall = dbCalls[0];
    // INSERT signature: (slug, encrypted_token, google_account_email)
    expect(dbCall.args[0]).toBe(slug);
    expect(dbCall.args[2]).toBe(expectedEmail);
  });

  it("11. omitted id_token: row still writes, google_account_email = null", async () => {
    // Tenants who connected before this scope change have refresh
    // tokens that only granted analytics.readonly. If they hit the
    // callback again somehow (shouldn't happen in normal flow but
    // possible during deploy-rollout windows), the token endpoint
    // omits id_token entirely. handleGA4Callback must still write
    // the row — with email column = null — instead of crashing.
    const env = makeEnv();
    const slug = "legacy-tenant";

    const validToken = await signGA4State(
      { slug, nonce: "eeeeeeeeeeeeeeee", ts: Math.floor(Date.now() / 1000) },
      env.TOKEN_SIGNING_KEY!,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          refresh_token: "ya29.refresh-legacy",
          access_token:  "ya29.access",
          expires_in:    3600,
          // No id_token field
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/ga4/callback?code=auth-code-legacy&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGA4Callback(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toContain("ga4=connected");

    expect(dbCalls.length).toBeGreaterThan(0);
    const dbCall = dbCalls[0];
    expect(dbCall.args[0]).toBe(slug);
    expect(dbCall.args[2]).toBeNull();
  });

  it("12. malformed id_token: row still writes, google_account_email = null", async () => {
    // Defensive: a corrupted or non-JWT id_token must not break the
    // OAuth flow. Best-effort decode falls through to null email.
    const env = makeEnv();
    const slug = "malformed-tenant";

    const validToken = await signGA4State(
      { slug, nonce: "ffffffffffffffff", ts: Math.floor(Date.now() / 1000) },
      env.TOKEN_SIGNING_KEY!,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          refresh_token: "ya29.refresh-malformed",
          access_token:  "ya29.access",
          expires_in:    3600,
          // Not a valid JWT structure
          id_token: "not.a.valid-jwt-payload-base64",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/ga4/callback?code=auth-code-malformed&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleGA4Callback(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toContain("ga4=connected");

    expect(dbCalls.length).toBeGreaterThan(0);
    const dbCall = dbCalls[0];
    expect(dbCall.args[0]).toBe(slug);
    expect(dbCall.args[2]).toBeNull();
  });
});
