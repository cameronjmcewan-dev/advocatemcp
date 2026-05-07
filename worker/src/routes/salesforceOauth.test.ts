/**
 * Tests for worker/src/routes/salesforceOauth.ts
 *
 * Runs in Node via vitest. Mocks fetch and D1 stubs so no real network or
 * database calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSalesforceStart, handleSalesforceCallback } from "./salesforceOauth.js";
import { signState } from "../lib/oauthState.js";

const SALESFORCE_STATE_PREFIX = "salesforce-state:v1:";
const HUBSPOT_STATE_PREFIX    = "hubspot-state:v1:";

// ── Shared minimal Env stub ───────────────────────────────────────────────────

const dbCalls: Array<{ sql: string; args: unknown[] }> = [];

function makeEnv(overrides?: Partial<typeof baseEnv>): typeof baseEnv {
  dbCalls.length = 0;
  return { ...baseEnv, ...overrides };
}

const baseEnv = {
  TOKEN_SIGNING_KEY:                "test-signing-key-for-salesforce-oauth-tests",
  SALESFORCE_OAUTH_CLIENT_ID:       "test-sf-client-id",
  SALESFORCE_OAUTH_CLIENT_SECRET:   "test-sf-client-secret-value",
  SALESFORCE_OAUTH_REDIRECT_URI:    "https://customers.advocatemcp.com/oauth/salesforce/callback",
  GA4_TOKEN_ENCRYPTION_KEY:         "0".repeat(64),
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

// ── handleSalesforceStart tests ───────────────────────────────────────────────

describe("handleSalesforceStart", () => {
  it("1. returns 302 with correct Salesforce authorize URL and signed state", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/salesforce/start?slug=acme-corp");
    const env = makeEnv();
    const res = await handleSalesforceStart(req, env);

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("https://login.salesforce.com/services/oauth2/authorize");
    expect(location).toContain("state=");
    expect(location).toContain(encodeURIComponent(env.SALESFORCE_OAUTH_CLIENT_ID!));
  });

  it("2. authorize URL contains correct Salesforce scopes", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/salesforce/start?slug=acme-corp");
    const env = makeEnv();
    const res = await handleSalesforceStart(req, env);
    const location = res.headers.get("Location") ?? "";

    // Scopes are URL-encoded in the query string
    expect(location).toContain("api");
    expect(location).toContain("refresh_token");
    expect(location).toContain("offline_access");
  });

  it("3. missing slug returns 400", async () => {
    const req = new Request("https://customers.advocatemcp.com/oauth/salesforce/start");
    const env = makeEnv();
    const res = await handleSalesforceStart(req, env);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/slug/i);
  });
});

// ── handleSalesforceCallback tests ───────────────────────────────────────────

describe("handleSalesforceCallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("4. callback with invalid state redirects to ?crm=error&provider=salesforce&reason=state_invalid", async () => {
    const env = makeEnv();
    const req = new Request(
      "https://customers.advocatemcp.com/oauth/salesforce/callback?code=auth-code&state=bad.token",
    );
    const res = await handleSalesforceCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("crm=error");
    expect(loc).toContain("provider=salesforce");
    expect(loc).toContain("reason=state_invalid");
  });

  it("5. callback with missing code redirects to ?reason=missing_params", async () => {
    const env = makeEnv();
    const validToken = await signState(
      {
        slug: "acme-corp",
        nonce: "aaaaaaaaaaaaaaaa",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      SALESFORCE_STATE_PREFIX,
    );
    const req = new Request(
      `https://customers.advocatemcp.com/oauth/salesforce/callback?state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleSalesforceCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("reason=missing_params");
  });

  it("6. happy path: INSERT OR REPLACE with provider=salesforce AND account_id populated from instance_url", async () => {
    const env = makeEnv();
    const slug = "acme-corp";
    const plainRefreshToken = "salesforce-refresh-token-example";
    const instanceUrl = "https://acme.my.salesforce.com";

    const validToken = await signState(
      {
        slug,
        nonce: "bbbbbbbbbbbbbbbb",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      SALESFORCE_STATE_PREFIX,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          refresh_token: plainRefreshToken,
          access_token:  "sf-at-abc",
          instance_url:  instanceUrl,
          id:            "https://login.salesforce.com/id/000000000000000000/000000000000000000",
          token_type:    "Bearer",
          issued_at:     "1714000000000",
          signature:     "sigvalue",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/salesforce/callback?code=auth-code-sf&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleSalesforceCallback(req, env);

    // Redirects to connected page
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("crm=connected");
    expect(loc).toContain("provider=salesforce");
    expect(loc).not.toContain("crm=error");

    // DB write happened
    expect(dbCalls.length).toBeGreaterThan(0);
    const dbCall = dbCalls[0];

    // SQL should target provider='salesforce' and include account_id column
    expect(dbCall.sql).toContain("salesforce");
    expect(dbCall.sql).toContain("account_id");

    // args[0] = slug, args[1] = encrypted token, args[2] = instance_url
    expect(dbCall.args[0]).toBe(slug);

    const storedEncrypted = dbCall.args[1] as string;
    // Token must be encrypted (not plaintext)
    expect(storedEncrypted).not.toBe(plainRefreshToken);
    expect(() => atob(storedEncrypted)).not.toThrow();
    // AES-GCM adds 12B IV + 16B auth tag = at least 28B overhead
    const ctBytes = atob(storedEncrypted).length;
    const ptBytes = new TextEncoder().encode(plainRefreshToken).length;
    expect(ctBytes).toBeGreaterThanOrEqual(ptBytes + 28);
    // Plaintext must not appear in the ciphertext
    expect(atob(storedEncrypted)).not.toContain(plainRefreshToken);

    // instance_url stored in account_id position
    expect(dbCall.args[2]).toBe(instanceUrl);
  });

  it("7. cross-domain attack regression: state signed with hubspot prefix is rejected", async () => {
    const env = makeEnv();
    // Sign with HubSpot prefix — should NOT pass Salesforce callback verification
    const crossDomainToken = await signState(
      {
        slug: "victim-biz",
        nonce: "cccccccccccccccc",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      HUBSPOT_STATE_PREFIX, // wrong domain prefix
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/salesforce/callback?code=forged-code&state=${encodeURIComponent(crossDomainToken)}`,
    );
    const res = await handleSalesforceCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    // Must be rejected — cross-domain state should fail HMAC verification
    expect(loc).toContain("crm=error");
    expect(loc).toContain("provider=salesforce");
    expect(loc).toContain("reason=state_invalid");
  });

  it("8. token exchange failure redirects to ?reason=token_exchange_failed", async () => {
    const env = makeEnv();
    const validToken = await signState(
      {
        slug: "acme-corp",
        nonce: "dddddddddddddddd",
        ts: Math.floor(Date.now() / 1000),
      },
      env.TOKEN_SIGNING_KEY!,
      SALESFORCE_STATE_PREFIX,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const req = new Request(
      `https://customers.advocatemcp.com/oauth/salesforce/callback?code=bad-code&state=${encodeURIComponent(validToken)}`,
    );
    const res = await handleSalesforceCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain("reason=token_exchange_failed");
  });
});
