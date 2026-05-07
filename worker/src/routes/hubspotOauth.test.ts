/**
 * Tests for worker/src/routes/hubspotOauth.ts
 *
 * Runs in Node via vitest. Mocks fetch and D1 stubs so no real network or
 * database calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleHubspotStart, handleHubspotCallback } from "./hubspotOauth.js";
import { signState } from "../lib/oauthState.js";

const HUBSPOT_STATE_PREFIX = "hubspot-state:v1:";
const GSC_STATE_PREFIX     = "gsc-state:v1:";

// ── Shared minimal Env stub ───────────────────────────────────────────────────

const dbCalls: Array<{ sql: string; args: unknown[] }> = [];

function makeEnv(overrides?: Partial<typeof baseEnv>): typeof baseEnv {
  dbCalls.length = 0;
  return { ...baseEnv, ...overrides };
}

const baseEnv = {
  TOKEN_SIGNING_KEY:              "test-signing-key-for-hubspot-oauth-tests",
  HUBSPOT_OAUTH_CLIENT_ID:        "test-hubspot-client-id",
  HUBSPOT_OAUTH_CLIENT_SECRET:    "test-hubspot-client-secret-value",
  HUBSPOT_OAUTH_REDIRECT_URI:     "https://customers.advocatemcp.com/oauth/hubspot/callback",
  GA4_TOKEN_ENCRYPTION_KEY:       "0".repeat(64),
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

// ── handleHubspotStart tests ──────────────────────────────────────────────────

describe("handleHubspotStart", () => {
  it("1. returns 302 with correct HubSpot authorize URL and signed state", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/hubspot/start?slug=joes-pizza");
    const env = makeEnv();
    const res = await handleHubspotStart(req, env);

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("https://app.hubspot.com/oauth/authorize");
    expect(location).toContain("state=");
    expect(location).toContain(encodeURIComponent(env.HUBSPOT_OAUTH_CLIENT_ID!));
  });

  it("2. authorize URL contains correct CRM scopes", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/hubspot/start?slug=acme");
    const env = makeEnv();
    const res = await handleHubspotStart(req, env);
    const location = res.headers.get("Location") ?? "";

    expect(location).toContain("crm.objects.contacts.read");
    expect(location).toContain("crm.objects.deals.read");
  });

  it("3. missing slug returns 400", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/hubspot/start");
    const env = makeEnv();
    const res = await handleHubspotStart(req, env);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/slug/i);
  });
});

// ── handleHubspotCallback tests ───────────────────────────────────────────────

describe("handleHubspotCallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("4. callback with invalid state redirects to ?crm=error&provider=hubspot&reason=state_invalid", async () => {
    const env = makeEnv();
    const req = new Request(
      "https://customers.advocatemcp.com/oauth/hubspot/callback?code=auth-code&state=bad.token",
    );
    const res = await handleHubspotCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("crm=error");
    expect(loc).toContain("provider=hubspot");
    expect(loc).toContain("reason=state_invalid");
  });

  it("5. callback with missing code redirects to ?reason=missing_params", async () => {
    const env = makeEnv();
    const validToken = await signState(
      {
        slug: "joes-pizza",
        nonce: "aaaaaaaaaaaaaaaa",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      HUBSPOT_STATE_PREFIX,
    );
    const req = new Request(
      `https://customers.advocatemcp.com/oauth/hubspot/callback?state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleHubspotCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("reason=missing_params");
  });

  it("6. happy path: INSERT OR REPLACE with provider=hubspot and encrypted (not plaintext) refresh token", async () => {
    const env = makeEnv();
    const slug = "joes-pizza";
    const plainRefreshToken = "hubspot-refresh-token-example-value";

    const validToken = await signState(
      {
        slug,
        nonce: "bbbbbbbbbbbbbbbb",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      HUBSPOT_STATE_PREFIX,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          refresh_token: plainRefreshToken,
          access_token:  "hub-at-abc",
          expires_in:    1800,
          token_type:    "bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/hubspot/callback?code=auth-code-xyz&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleHubspotCallback(req, env);

    // Redirects to connected page
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("crm=connected");
    expect(loc).toContain("provider=hubspot");
    expect(loc).not.toContain("crm=error");

    // DB write happened
    expect(dbCalls.length).toBeGreaterThan(0);
    const dbCall = dbCalls[0];

    // First arg is slug, second is the encrypted token
    expect(dbCall.args[0]).toBe(slug);

    const storedEncrypted = dbCall.args[1] as string;
    expect(storedEncrypted).not.toBe(plainRefreshToken);
    // Should be valid base64 (AES-GCM output)
    expect(() => atob(storedEncrypted)).not.toThrow();
    // AES-GCM adds 12B IV + 16B auth tag = at least 28B overhead
    const ctBytes = atob(storedEncrypted).length;
    const ptBytes = new TextEncoder().encode(plainRefreshToken).length;
    expect(ctBytes).toBeGreaterThanOrEqual(ptBytes + 28);
    // Plaintext must not appear in the ciphertext
    expect(atob(storedEncrypted)).not.toContain(plainRefreshToken);
  });

  it("7. state token signed with GSC prefix rejected (cross-domain attack regression)", async () => {
    const env = makeEnv();
    // Sign with GSC prefix — should NOT pass HubSpot callback verification
    const crossDomainToken = await signState(
      {
        slug: "victim-biz",
        nonce: "cccccccccccccccc",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      GSC_STATE_PREFIX, // wrong domain prefix
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/hubspot/callback?code=forged-code&state=${encodeURIComponent(crossDomainToken)}`,
    );
    const res = await handleHubspotCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    // Must be rejected — cross-domain state should fail HMAC verification
    expect(loc).toContain("crm=error");
    expect(loc).toContain("provider=hubspot");
    expect(loc).toContain("reason=state_invalid");
  });

  it("8. token exchange failure redirects to ?reason=token_exchange_failed", async () => {
    const env = makeEnv();
    const validToken = await signState(
      {
        slug: "acme",
        nonce: "dddddddddddddddd",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      HUBSPOT_STATE_PREFIX,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/hubspot/callback?code=bad-code&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleHubspotCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("reason=token_exchange_failed");
  });
});
