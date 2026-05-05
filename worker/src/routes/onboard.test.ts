/**
 * Integration-style tests for POST /api/onboard/public (handlePublicOnboard).
 *
 * Scope: pipeline smoke test — exercises the full handler logic with a
 * realistic payload, covering paths NOT already covered by stripe.test.ts
 * (which tests provisionActivationToken / handleGetActivation) and
 * validateOnboarding.test.ts (which unit-tests the validator in isolation).
 *
 * What we test here:
 *   Test A — Full realistic wizard payload (7 core fields + 4 blob columns)
 *             goes the full distance: validator passes, Stripe fake returns
 *             ok:true, KV put is called, response is 201. Asserts the
 *             putTenant call received a tenant whose profile.hours_json and
 *             profile.credentials_json carry the right nested values.
 *
 *   Test B — profile.star_rating is a non-number string → 400
 *             validation_error. Exercises a type-check branch inside
 *             validateOnboardingPayload that is NOT covered by existing
 *             tests (validateOnboarding.test.ts only tests star_rating > 5
 *             as a numeric violation, not the typeof guard).
 *
 * Mocking strategy:
 *   - getTenant / putTenant mocked via vi.mock("./onboard") so no real KV is needed.
 *   - fetch stubbed at the module level so stripeApi returns a synthetic
 *     checkout response without hitting the Stripe API.
 *   - D1 (env.DB) faked with the minimal shape needed by registerBusinessInD1
 *     (SELECT for existing slug → null, INSERT → run()).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks — hoisted before any import of the modules under test ─────────

vi.mock("./onboard", () => ({
  getTenant: vi.fn(async () => null),   // no existing tenant — always fresh
  putTenant: vi.fn(async () => undefined),
  // Re-export the non-mocked helpers that stripe.ts also imports from onboard.
  // Without these, stripe.ts's import { jsonOk, jsonErr, ... } from "./onboard"
  // resolves to undefined at test time and the handler crashes before line 1.
  normalizeDomain: vi.fn((d: string) => d),
  getTenantList: vi.fn(async () => []),
  getTenantsByStatus: vi.fn(async () => []),
  addStatusLog:    (_t: unknown, _s: string, _d: string) => undefined,
  transitionStatus: (_t: unknown, _s: string, _d: string) => undefined,
  buildDnsInstructions: vi.fn(() => ({})),
  createCfHostnameForTenant: vi.fn(async () => undefined),
  requireAdmin:    vi.fn(() => false),
  jsonOk: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  jsonErr: (status: number, code: string, message: string, detail?: unknown) =>
    new Response(
      JSON.stringify({ error: code, message, ...(detail !== undefined ? { detail } : {}) }),
      { status, headers: { "Content-Type": "application/json" } },
    ),
  CNAME_TARGET: "customers.advocatemcp.com",
}));

// Mock the D1 activation helpers — not exercised in this handler path but
// stripe.ts imports them at the top level from portalDb, so they must resolve.
vi.mock("../portalDb", () => ({
  getActivationRecord:         vi.fn(async () => null),
  setActivationTokenIfMissing: vi.fn(async () => ({ meta: { changes: 0 } })),
  updateActivationStatus:      vi.fn(async () => undefined),
  updateBusinessApiKey:        vi.fn(async () => undefined),
  // May 2 2026: handlePublicOnboard now creates a user + session before
  // the Stripe redirect. These three need to resolve in the integration
  // smoke tests.
  getUserByEmail:              vi.fn(async () => null),
  createUser:                  vi.fn(async (_db, email, password_hash, salt, full_name, role) => ({
    id: "mock-user-id",
    email, password_hash, salt, full_name, role,
    created_at: new Date().toISOString(),
    email_verified: 0,
  })),
  grantAccess:                 vi.fn(async () => undefined),
}));

vi.mock("../lib/activation-token", () => ({
  signActivationToken: vi.fn(async () => "mock-activation-token"),
}));

vi.mock("../lib/resend", () => ({
  sendActivationEmail: vi.fn(async () => ({ ok: true, id: "email_mock", retryable: false })),
}));

import { handlePublicOnboard } from "./stripe.js";
import { getTenant, putTenant } from "./onboard.js";
import { grantAccess } from "../portalDb.js";
import type { Env } from "../types.js";

const mockedGetTenant = vi.mocked(getTenant);
const mockedPutTenant = vi.mocked(putTenant);
const mockedGrantAccess = vi.mocked(grantAccess);

// ── Fake D1 ───────────────────────────────────────────────────────────────────
// registerBusinessInD1 runs SELECT then INSERT. We just need both to succeed.

function createFakeDb(): D1Database {
  return {
    prepare(_sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> { return null; },
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
  } as unknown as D1Database;
}

// ── Fake KV ───────────────────────────────────────────────────────────────────
// putTenant is mocked, but env.TENANT_DATA must exist so the Env typecheck
// is satisfied. BUSINESS_MAP.get is never hit in this handler.

function createFakeKv(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    DB:                   createFakeDb(),
    TENANT_DATA:          createFakeKv(),
    BUSINESS_MAP:         createFakeKv(),
    STRIPE_SECRET_KEY:    "sk_test_fake",
    STRIPE_PRICE_ID_BASE: "price_fake_base",
    STRIPE_PRICE_ID_PRO:  "price_fake_pro",
    ADMIN_SECRET:         "test-secret",
  } as unknown as Env;
}

// ── Stripe fetch stub ─────────────────────────────────────────────────────────

const fakeStripeResponse = {
  url: "https://checkout.stripe.com/pay/cs_test_fake",
  id:  "cs_test_fake_session_id",
};

function stubFetchOk(): void {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(fakeStripeResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ));
}

function restoreFetch(): void {
  vi.unstubAllGlobals();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handlePublicOnboard — integration smoke tests", () => {
  beforeEach(() => {
    mockedGetTenant.mockResolvedValue(null);
    mockedPutTenant.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreFetch();
    vi.clearAllMocks();
  });

  it(
    "Test A — full realistic payload with blob fields → 201, profile persisted to KV",
    async () => {
      stubFetchOk();
      const env = makeEnv();

      const payload = {
        slug:  "smoke-plumbing-co",
        name:  "Smoke Plumbing Co",
        email: "owner@smokeplumbing.example.com",
        password: "test-password-123",
        plan:  "base",
        profile: {
          // 7 required flat fields
          name:         "Smoke Plumbing Co",
          description:  "Emergency and residential plumbing since 1999",
          category:     "plumber",
          location:     "Boise, ID",
          services:     ["drain cleaning", "pipe repair"],
          star_rating:  4.8,
          review_count: 142,
          // 4 blob fields the Task 7 plan calls out specifically
          hours_json: {
            mon: { open: "07:00", close: "18:00" },
            tue: { open: "07:00", close: "18:00" },
            wed: { open: "07:00", close: "18:00" },
            thu: { open: "07:00", close: "18:00" },
            fri: { open: "07:00", close: "18:00" },
            sat: { open: "09:00", close: "14:00" },
            sun: null,
            emergency_24_7: true,
          },
          credentials_json: {
            licenses:       [{ name: "Idaho Plumbing License", number: "PL-4482" }],
            insured:        true,
            bonded:         false,
            certifications: ["WaterSense Certified"],
          },
          lead_routing_json: {
            preferred_channel: "phone",
            phone:             "+12085550199",
          },
          pricing_json_v2: {
            model:    "hourly",
            min_rate: 95,
            max_rate: 145,
            currency: "USD",
          },
        },
      };

      const req = new Request("https://customers.advocatemcp.com/api/onboard/public", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      const resp = await handlePublicOnboard(req, env);
      expect(resp.status).toBe(201);

      // putTenant was called exactly once with the assembled tenant
      expect(mockedPutTenant).toHaveBeenCalledTimes(1);
      const [, savedTenant] = mockedPutTenant.mock.calls[0];

      // The profile blobs the plan specifically calls out
      const profile = savedTenant.profile ?? {};
      const hours = profile.hours_json as { emergency_24_7?: boolean } | undefined;
      const creds = profile.credentials_json as { insured?: boolean } | undefined;

      expect(hours?.emergency_24_7).toBe(true);
      expect(creds?.insured).toBe(true);
    },
  );

  it(
    "Test B — profile.star_rating is a non-number string → 400 validation_error",
    async () => {
      // fetch stub is NOT needed — the handler returns 400 before reaching Stripe
      const env = makeEnv();

      const payload = {
        slug:  "type-error-plumbing",
        name:  "Type Error Plumbing",
        email: "owner@type-error.example.com",
        plan:  "base",
        profile: {
          // All required fields present, but star_rating is a string — tests
          // the `typeof star_rating !== "number"` branch in validateOnboardingPayload
          // (validateOnboarding.test.ts only covers star_rating > 5 as a numeric
          // out-of-range violation, not this typeof guard).
          name:         "Type Error Plumbing",
          description:  "A plumber",
          category:     "plumber",
          location:     "Portland, OR",
          services:     ["repair"],
          star_rating:  "four point five",   // wrong type — should be number
          review_count: 10,
        },
      };

      const req = new Request("https://customers.advocatemcp.com/api/onboard/public", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      const resp = await handlePublicOnboard(req, env);
      expect(resp.status).toBe(400);

      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("validation_error");

      // putTenant must NOT have been called — we never reached the KV write
      expect(mockedPutTenant).not.toHaveBeenCalled();
    },
  );

  it(
    "Test C — grantAccess is called to populate user_business_access",
    async () => {
      stubFetchOk();
      const env = makeEnv();

      const payload = {
        slug:  "grant-access-test-co",
        name:  "Grant Access Test Co",
        email: "owner@grant-access.example.com",
        password: "test-password-123",
        plan:  "pro",
      };

      const req = new Request("https://customers.advocatemcp.com/api/onboard/public", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      const resp = await handlePublicOnboard(req, env);
      expect(resp.status).toBe(201);

      // grantAccess must have been called exactly once with the user ID
      // from createUser and the business ID from registerBusinessInD1.
      // The mock is called with (db, userId, bizId).
      expect(mockedGrantAccess).toHaveBeenCalledTimes(1);
      const callArgs = mockedGrantAccess.mock.calls[0];
      expect(callArgs[1]).toBe("mock-user-id"); // userId from createUser mock
      // bizId is a UUID without hyphens, generated inside registerBusinessInD1
      expect(typeof callArgs[2]).toBe("string");
      expect(callArgs[2]).toMatch(/^[a-f0-9]{32}$/);
    },
  );
});
