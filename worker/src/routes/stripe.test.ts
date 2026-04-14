/**
 * Tests for Phase F Part 1 additions in worker/src/routes/stripe.ts and
 * worker/src/routes/activate.ts.
 *
 * Scope — pure function / small-surface tests only. No real D1, no
 * real Stripe API, no real Web Crypto HMAC (signActivationToken is
 * mocked via vi.mock). The real activation-token signing is already
 * tested end-to-end in src/lib/activation-token.test.ts. What we test
 * here is the idempotency + short-circuit contract of
 * provisionActivationToken and the auth + not-found branches of the
 * new GET /admin/businesses/:slug/activation handler.
 *
 * Two surfaces covered:
 *
 *   1. provisionActivationToken
 *      - first call mints, returns "minted"
 *      - second call short-circuits on the SELECT and returns
 *        "existing" WITHOUT invoking signActivationToken a second
 *        time (asserted via the vi.fn mock call count)
 *      - missing ACTIVATION_SIGNING_KEY → "no_key", no sign call
 *      - missing businesses row → "no_row", no sign call
 *
 *   2. handleGetActivation
 *      - happy path: valid admin secret + existing slug → 200 JSON
 *      - missing X-Admin-Secret → 401
 *      - wrong  X-Admin-Secret → 401
 *      - valid admin secret but unknown slug → 404
 *
 * The signActivationToken short-circuit assertion in test group (1) is
 * the test the session brief explicitly called out: it protects
 * against a future refactor that accidentally calls sign-then-no-op
 * write. If someone changes provisionActivationToken to mint before
 * checking, this test turns red.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── vi.mock declaration — MUST come before imports of the modules
// under test so vitest hoists it correctly and the stripe.ts import
// below receives the mocked signActivationToken.
//
// The module specifier MUST match exactly what stripe.ts uses (no .js
// suffix). A mismatched specifier — e.g. "../lib/activation-token.js"
// here while stripe.ts imports "../lib/activation-token" — registers
// the mock against a different module record and stripe.ts's real
// import is left unmocked. That bug cost one iteration during
// implementation; don't re-introduce the .js suffix without aligning
// both sides.
vi.mock("../lib/activation-token", () => ({
  signActivationToken: vi.fn(
    async ({ slug }: { slug: string }) => `mock-token-for-${slug}`,
  ),
}));

vi.mock("../lib/resend", () => ({
  sendActivationEmail: vi.fn(
    async () => ({ ok: true, id: "email_mock_123", retryable: false }),
  ),
}));

import { provisionActivationToken, registerBusinessOnRailway } from "./stripe";
import { handleGetActivation, handleResendActivation } from "./activate";
import { signActivationToken } from "../lib/activation-token";
import { sendActivationEmail } from "../lib/resend";
import type { Env } from "../types";

const mockedSign = vi.mocked(signActivationToken);
const mockedSend = vi.mocked(sendActivationEmail);

// ── Minimal fake D1 — just enough of the D1Database shape to cover
// the two SQL statements the helpers emit. Keyed by slug. Each row
// stores only the activation-related columns; nothing else is read
// or written by the code under test.

interface FakeBusinessRow {
  slug: string;
  activation_token: string | null;
  activation_status: string;
  activation_issued_at: string | null;
  api_key: string;
}

function createFakeDb(
  initial: Record<string, Partial<FakeBusinessRow>> = {},
): { db: D1Database; rows: Map<string, FakeBusinessRow> } {
  const table = new Map<string, FakeBusinessRow>();
  for (const [slug, row] of Object.entries(initial)) {
    table.set(slug, {
      slug,
      api_key:              row.api_key ?? "pending",
      activation_token:     row.activation_token ?? null,
      activation_status:    row.activation_status ?? "none",
      activation_issued_at: row.activation_issued_at ?? null,
    });
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // getActivationRecord uses SELECT ... WHERE slug = ? LIMIT 1
              const slug = params[0] as string;
              const row = table.get(slug);
              if (!row) return null;
              return {
                activation_token:     row.activation_token,
                activation_status:    row.activation_status,
                activation_issued_at: row.activation_issued_at,
              } as unknown as T;
            },
            async run() {
              // setActivationTokenIfMissing emits this SQL (multi-line
              // template literal — don't substring-match tokens across
              // the line break):
              //
              //   UPDATE businesses
              //     SET activation_token = ?, activation_status = ?,
              //         activation_issued_at = ?
              //     WHERE slug = ? AND activation_token IS NULL
              //
              // The test fake matches by collapsing all whitespace and
              // looking for the key fragments. This makes the fake
              // robust against formatting changes in the real query.
              const normalized = sql.replace(/\s+/g, " ").trim();

              // setActivationTokenIfMissing — atomic mint
              if (
                normalized.startsWith("UPDATE businesses") &&
                normalized.includes("SET activation_token") &&
                normalized.includes("activation_token IS NULL")
              ) {
                const [token, status, issuedAt, slug] = params as [
                  string, string, string, string,
                ];
                const row = table.get(slug);
                if (!row) return { meta: { changes: 0 } };
                if (row.activation_token !== null) {
                  return { meta: { changes: 0 } };
                }
                row.activation_token     = token;
                row.activation_status    = status;
                row.activation_issued_at = issuedAt;
                return { meta: { changes: 1 } };
              }

              // updateActivationStatus — unconditional status flip
              if (
                normalized.startsWith("UPDATE businesses") &&
                normalized.includes("SET activation_status") &&
                !normalized.includes("activation_token IS NULL")
              ) {
                const [status, slug] = params as [string, string];
                const row = table.get(slug);
                if (row) row.activation_status = status;
                return { meta: { changes: row ? 1 : 0 } };
              }

              // updateBusinessApiKey — unconditional api_key update
              if (
                normalized.startsWith("UPDATE businesses") &&
                normalized.includes("SET api_key")
              ) {
                const [apiKey, slug] = params as [string, string];
                const row = table.get(slug);
                if (row) row.api_key = apiKey;
                return { meta: { changes: row ? 1 : 0 } };
              }

              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, rows: table };
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    ACTIVATION_SIGNING_KEY: "test-phase-f-key",
    ADMIN_SECRET: "test-admin-secret",
    RESEND_API_KEY: "test-phase-f-key",
    API_BASE_URL: "https://test-railway.example.com",
    API_KEY: "test-api-key",
    ...overrides,
  } as unknown as Env;
}

// ── Test suite ───────────────────────────────────────────────────────────

describe("provisionActivationToken (Phase F Part 1)", () => {
  beforeEach(() => {
    mockedSign.mockClear();
    mockedSend.mockClear();
  });

  it("first call mints a token and returns 'minted'", async () => {
    const { db, rows } = createFakeDb({ "workman-copy-co": {} });
    const env = makeEnv(db);

    const result = await provisionActivationToken(
      env,
      "workman-copy-co",
      "2026-04-11T12:00:00.000Z",
    );

    expect(result).toBe("minted");
    expect(mockedSign).toHaveBeenCalledTimes(1);
    expect(mockedSign).toHaveBeenCalledWith(
      { slug: "workman-copy-co" },
      "test-phase-f-key",
      7 * 24 * 3600, // 7-day TTL — Phase F Part 2
    );

    const row = rows.get("workman-copy-co");
    expect(row?.activation_token).toBe("mock-token-for-workman-copy-co");
    expect(row?.activation_status).toBe("pending_send");
    expect(row?.activation_issued_at).toBe("2026-04-11T12:00:00.000Z");
  });

  it(
    "second call short-circuits without invoking signActivationToken",
    async () => {
      const { db, rows } = createFakeDb({ "workman-copy-co": {} });
      const env = makeEnv(db);

      // First call — mints.
      const first = await provisionActivationToken(
        env,
        "workman-copy-co",
        "2026-04-11T12:00:00.000Z",
      );
      expect(first).toBe("minted");
      expect(mockedSign).toHaveBeenCalledTimes(1);

      // Second call — must short-circuit on the SELECT and NOT invoke
      // signActivationToken a second time. This is the regression
      // guard requested in the Phase F Part 1 design session.
      const second = await provisionActivationToken(
        env,
        "workman-copy-co",
        "2026-04-11T13:00:00.000Z",
      );
      expect(second).toBe("existing");
      expect(mockedSign).toHaveBeenCalledTimes(1); // still 1, not 2

      // And the stored token is the one from the FIRST call — the
      // second call did not overwrite it.
      const row = rows.get("workman-copy-co");
      expect(row?.activation_token).toBe("mock-token-for-workman-copy-co");
      expect(row?.activation_issued_at).toBe("2026-04-11T12:00:00.000Z");
    },
  );

  it(
    "returns 'no_key' and skips signing when ACTIVATION_SIGNING_KEY is missing",
    async () => {
      const { db } = createFakeDb({ "workman-copy-co": {} });
      const env = makeEnv(db, {});
      delete (env as { ACTIVATION_SIGNING_KEY?: string }).ACTIVATION_SIGNING_KEY;

      const result = await provisionActivationToken(
        env,
        "workman-copy-co",
        "2026-04-11T12:00:00.000Z",
      );

      expect(result).toBe("no_key");
      expect(mockedSign).toHaveBeenCalledTimes(0);
    },
  );

  it("returns 'no_row' when the businesses row does not exist", async () => {
    const { db } = createFakeDb({});
    const env = makeEnv(db);

    const result = await provisionActivationToken(
      env,
      "ghost-slug",
      "2026-04-11T12:00:00.000Z",
    );

    expect(result).toBe("no_row");
    expect(mockedSign).toHaveBeenCalledTimes(0);
  });
});

// ── handleGetActivation tests ────────────────────────────────────────────

describe("handleGetActivation (GET /admin/businesses/:slug/activation)", () => {
  function makeRequest(secret?: string): Request {
    const headers: Record<string, string> = {};
    if (secret !== undefined) headers["X-Admin-Secret"] = secret;
    return new Request(
      "https://customers.advocatemcp.com/admin/businesses/workman-copy-co/activation",
      { method: "GET", headers },
    );
  }

  it("happy path — returns 200 with the activation record JSON", async () => {
    const { db } = createFakeDb({
      "workman-copy-co": {
        activation_token:     "mock-token-for-workman-copy-co",
        activation_status:    "pending_send",
        activation_issued_at: "2026-04-11T12:00:00.000Z",
      },
    });
    const env = makeEnv(db);

    const response = await handleGetActivation(
      makeRequest("test-admin-secret"),
      env,
      "workman-copy-co",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      slug:                 "workman-copy-co",
      activation_token:     "mock-token-for-workman-copy-co",
      activation_status:    "pending_send",
      activation_issued_at: "2026-04-11T12:00:00.000Z",
    });
  });

  it("returns 200 with null token when the webhook has not yet fired", async () => {
    const { db } = createFakeDb({ "workman-copy-co": {} });
    const env = makeEnv(db);

    const response = await handleGetActivation(
      makeRequest("test-admin-secret"),
      env,
      "workman-copy-co",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.slug).toBe("workman-copy-co");
    expect(body.activation_token).toBeNull();
    expect(body.activation_status).toBe("none");
    expect(body.activation_issued_at).toBeNull();
  });

  it("returns 401 when X-Admin-Secret header is missing", async () => {
    const { db } = createFakeDb({ "workman-copy-co": {} });
    const env = makeEnv(db);

    const response = await handleGetActivation(
      makeRequest(undefined),
      env,
      "workman-copy-co",
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when X-Admin-Secret header is wrong", async () => {
    const { db } = createFakeDb({ "workman-copy-co": {} });
    const env = makeEnv(db);

    const response = await handleGetActivation(
      makeRequest("not-the-right-secret"),
      env,
      "workman-copy-co",
    );

    expect(response.status).toBe(401);
  });

  it("returns 404 when the slug does not exist", async () => {
    const { db } = createFakeDb({});
    const env = makeEnv(db);

    const response = await handleGetActivation(
      makeRequest("test-admin-secret"),
      env,
      "ghost-slug",
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toContain("ghost-slug");
  });
});

// ── handleResendActivation tests ─────────────────────────────────────────

describe("handleResendActivation (POST /admin/businesses/:slug/resend-activation)", () => {
  function makeRequest(
    secret?: string,
    body?: unknown,
    method = "POST",
  ): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret !== undefined) headers["X-Admin-Secret"] = secret;
    return new Request(
      "https://customers.advocatemcp.com/admin/businesses/test-biz/resend-activation",
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
    );
  }

  beforeEach(() => {
    mockedSend.mockClear();
    // Default: successful send
    mockedSend.mockResolvedValue({ ok: true, id: "email_resend_test", retryable: false });
  });

  it("returns 405 for non-POST method", async () => {
    const { db } = createFakeDb({ "test-biz": { activation_token: "tok" } });
    const env = makeEnv(db);

    // GET requests cannot have a body — construct directly without the helper
    const response = await handleResendActivation(
      new Request(
        "https://customers.advocatemcp.com/admin/businesses/test-biz/resend-activation",
        { method: "GET", headers: { "X-Admin-Secret": "test-admin-secret" } },
      ),
      env,
      "test-biz",
    );

    expect(response.status).toBe(405);
  });

  it("returns 401 when X-Admin-Secret is missing", async () => {
    const { db } = createFakeDb({ "test-biz": {} });
    const env = makeEnv(db);

    const response = await handleResendActivation(
      makeRequest(undefined, { email: "a@b.com" }),
      env,
      "test-biz",
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when X-Admin-Secret is wrong", async () => {
    const { db } = createFakeDb({ "test-biz": {} });
    const env = makeEnv(db);

    const response = await handleResendActivation(
      makeRequest("wrong-secret", { email: "a@b.com" }),
      env,
      "test-biz",
    );

    expect(response.status).toBe(401);
  });

  it("returns 404 when slug does not exist", async () => {
    const { db } = createFakeDb({});
    const env = makeEnv(db);

    const response = await handleResendActivation(
      makeRequest("test-admin-secret", { email: "a@b.com" }),
      env,
      "ghost-slug",
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toContain("ghost-slug");
  });

  it("returns 400 when no activation token has been minted yet", async () => {
    const { db } = createFakeDb({ "test-biz": { activation_token: null } });
    const env = makeEnv(db);

    const response = await handleResendActivation(
      makeRequest("test-admin-secret", { email: "a@b.com" }),
      env,
      "test-biz",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toContain("wait for the Stripe webhook");
  });

  it("returns 500 when RESEND_API_KEY is not configured", async () => {
    const { db } = createFakeDb({
      "test-biz": { activation_token: "tok", activation_status: "pending_send" },
    });
    const env = makeEnv(db);
    delete (env as { RESEND_API_KEY?: string }).RESEND_API_KEY;

    const response = await handleResendActivation(
      makeRequest("test-admin-secret", { email: "a@b.com" }),
      env,
      "test-biz",
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toContain("RESEND_API_KEY");
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("returns 200 and updates status to 'sent' on successful send", async () => {
    const { db, rows } = createFakeDb({
      "test-biz": { activation_token: "mock-tok-123", activation_status: "pending_send" },
    });
    const env = makeEnv(db);

    const response = await handleResendActivation(
      makeRequest("test-admin-secret", { email: "customer@example.com" }),
      env,
      "test-biz",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.email_id).toBe("email_resend_test");
    expect(body.slug).toBe("test-biz");
    expect(body.email).toBe("customer@example.com");

    // Status should be updated to 'sent'
    expect(rows.get("test-biz")?.activation_status).toBe("sent");

    // Verify sendActivationEmail was called with the right args
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const callArgs = mockedSend.mock.calls[0];
    expect(callArgs[0]).toBe("test-phase-f-key"); // RESEND_API_KEY in makeEnv
    expect(callArgs[1]).toBe("customer@example.com");
    expect(callArgs[2]).toContain("mock-tok-123");
  });

  it("returns 500 and does NOT update status on Resend failure", async () => {
    mockedSend.mockResolvedValueOnce({
      ok: false,
      error: "Resend API 422: Invalid email address",
      retryable: false,
    });

    const { db, rows } = createFakeDb({
      "test-biz": { activation_token: "mock-tok-123", activation_status: "pending_send" },
    });
    const env = makeEnv(db);

    const response = await handleResendActivation(
      makeRequest("test-admin-secret", { email: "bad@" }),
      env,
      "test-biz",
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toContain("Invalid email address");
    expect(body.retryable).toBe(false);

    // Status must NOT have changed
    expect(rows.get("test-biz")?.activation_status).toBe("pending_send");
  });

  it("returns 400 for malformed JSON body", async () => {
    const { db } = createFakeDb({
      "test-biz": { activation_token: "tok" },
    });
    const env = makeEnv(db);

    const response = await handleResendActivation(
      new Request(
        "https://customers.advocatemcp.com/admin/businesses/test-biz/resend-activation",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Secret": "test-admin-secret",
          },
          body: "not valid json{{{",
        },
      ),
      env,
      "test-biz",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toContain("valid JSON");
  });

  it("returns 400 when email field is missing from body", async () => {
    const { db } = createFakeDb({
      "test-biz": { activation_token: "tok" },
    });
    const env = makeEnv(db);

    const response = await handleResendActivation(
      makeRequest("test-admin-secret", { name: "not email" }),
      env,
      "test-biz",
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toContain("email");
  });
});

// ── registerBusinessOnRailway tests ──────────────────────────────────────

describe("registerBusinessOnRailway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTenant(overrides: Record<string, unknown> = {}): import("./onboard").TenantRecord {
    return {
      domain: "test-biz.hosted.advocatemcp.com",
      name: "Test Biz",
      slug: "test-biz",
      phone: "555-1234",
      email: "test@example.com",
      address: "", city: "", state: "", postalCode: "", country: "US",
      services: [], website: "https://testbiz.com", notes: "",
      status: "active" as const,
      cloudflare: {
        customHostnameId: null, verificationMethod: "none",
        verificationStatus: "not_applicable", sslStatus: "not_applicable",
        txtName: null, txtValue: null, ownershipTxtName: null, ownershipTxtValue: null,
      },
      stripe: { customerId: null, subscriptionId: null, checkoutSessionId: null, plan: "base" },
      skipDns: true,
      statusLog: [], createdAt: "", updatedAt: "",
      ...overrides,
    } as import("./onboard").TenantRecord;
  }

  it("returns ok:true with api_key on successful Railway registration", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ slug: "test-biz", api_key: "railway-uuid-123" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { db } = createFakeDb({ "test-biz": {} });
    const env = makeEnv(db);
    const tenant = makeTenant();

    const result = await registerBusinessOnRailway(env, tenant);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.api_key).toBe("railway-uuid-123");
      expect(result.slug).toBe("test-biz");
    }

    // Verify the fetch was called with the right URL and body shape
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe("https://test-railway.example.com/register");
    const reqInit = fetchCall[1] as RequestInit;
    const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
    expect(body.name).toBe("Test Biz");
    expect(body.star_rating).toBe(0);
    expect(body.review_count).toBe(0);
    expect(body.category).toBe("general");
    expect((reqInit.headers as Record<string, string>)["X-API-Key"]).toBe("test-api-key");
  });

  it("returns ok:false with error on Railway 4xx failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Missing required field: description" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { db } = createFakeDb({ "test-biz": {} });
    const env = makeEnv(db);
    const tenant = makeTenant();

    const result = await registerBusinessOnRailway(env, tenant);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("400");
      expect(result.error).toContain("Missing required field");
    }
  });

  it("returns ok:false on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { db } = createFakeDb({ "test-biz": {} });
    const env = makeEnv(db);
    const tenant = makeTenant();

    const result = await registerBusinessOnRailway(env, tenant);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("maps wizard profile fields to Railway's expected shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ slug: "test-biz", api_key: "key-abc" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { db } = createFakeDb({ "test-biz": {} });
    const env = makeEnv(db);
    const tenant = makeTenant();
    // Attach a wizard-style profile
    (tenant as unknown as { profile: unknown }).profile = {
      category: "legal",
      location: { city: "Austin", state: "TX", service_areas: ["Austin, TX"] },
      contact: { website: "https://biz.com", phone: "512-555-0000" },
      referral_url: "https://biz.com/contact",
      services: [{ name: "Consultation", description: "Legal advice" }],
      pricing_tier: "500_2000",
      differentiators: ["Award-winning"],
      availability: "Same day",
    };

    await registerBusinessOnRailway(env, tenant);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const reqInit = fetchCall[1] as RequestInit;
    const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;

    expect(body.category).toBe("legal");
    expect(body.location).toBe("Austin, TX");
    expect(body.services).toEqual(["Consultation"]);
    expect(body.referral_url).toBe("https://biz.com/contact");
    expect(body.pricing_tier).toBe("mid-range");
    expect(body.differentiator).toBe("Award-winning");
    expect(body.availability).toBe("Same day");
    expect(body.phone).toBe("512-555-0000");
  });
});

// ── Task 6: handlePublicOnboard — profile validation ────────────────────────
//
// Tests that the 9-step wizard profile is validated at ingress by
// validateOnboardingPayload before being attached to the tenant.
// Both test cases deliberately stop before Stripe API calls:
//   - invalid profile → 400 before any KV or Stripe work
//   - valid profile   → passes validation; 500 for missing Stripe key
//     confirms we got past the validation gate without a 400.

import { handlePublicOnboard } from "./stripe";

function makePublicOnboardRequest(body: unknown, origin = "https://advocatemcp.com"): Request {
  return new Request("https://customers.advocatemcp.com/api/onboard/public", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": origin,
    },
    body: JSON.stringify(body),
  });
}

function makePublicEnv(overrides: Partial<Env> = {}): Env {
  const kvStore = (): KVNamespace => {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
      getWithMetadata: vi.fn(async (key: string) => ({ value: store.get(key) ?? null, metadata: null })),
    } as unknown as KVNamespace;
  };

  const fakeD1 = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ success: true, meta: { changes: 0 } })),
        all: vi.fn(async () => ({ results: [] })),
      })),
    })),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;

  return {
    BUSINESS_MAP: kvStore(),
    TENANT_DATA: kvStore(),
    DB: fakeD1,
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_ID_BASE: undefined,
    STRIPE_PRICE_ID_PRO: undefined,
    ADMIN_SECRET: undefined,
    API_KEY: undefined,
    API_BASE_URL: undefined,
    TOKEN_SIGNING_KEY: undefined,
    ACTIVATION_SIGNING_KEY: undefined,
    ACCESS_TOKEN_SIGNING_KEY: undefined,
    RESEND_API_KEY: undefined,
    CF_API_TOKEN: undefined,
    CF_ZONE_ID: undefined,
    ...overrides,
  } as unknown as Env;
}

describe("handlePublicOnboard — Task 6: profile validation (9-step wizard)", () => {
  it("returns 400 validation_error when profile is present but missing required name field", async () => {
    const req = makePublicOnboardRequest({
      slug: "testbiz",
      name: "Test Biz",
      email: "owner@testbiz.com",
      plan: "base",
      profile: {
        // name is required by validateOnboardingPayload — intentionally omitted
        description: "A test business",
        category: "plumbing",
        location: "Austin, TX",
        services: ["Pipe repair"],
        star_rating: 4.5,
        review_count: 10,
      },
    });

    const resp = await handlePublicOnboard(req, makePublicEnv());
    expect(resp.status).toBe(400);

    const body = (await resp.json()) as { error: string; message: string };
    expect(body.error).toBe("validation_error");
    expect(body.message).toMatch(/name/);
  });

  it("passes validation and does not return 400 when a valid profile is supplied", async () => {
    // A complete valid profile. Because STRIPE_SECRET_KEY is absent the
    // handler returns 500 stripe_not_configured — but crucially NOT 400
    // validation_error, proving the profile passed the validation gate.
    const req = makePublicOnboardRequest({
      slug: "austinplumbing",
      name: "Austin Plumbing Co",
      email: "owner@austinplumbing.com",
      plan: "base",
      profile: {
        name: "Austin Plumbing Co",
        description: "Expert plumbing services in Austin, TX",
        category: "plumbing",
        location: "Austin, TX",
        services: ["Pipe repair", "Drain cleaning"],
        star_rating: 4.8,
        review_count: 42,
        hours_json: {
          mon: { open: "08:00", close: "17:00" },
          tue: { open: "08:00", close: "17:00" },
          wed: null,
          thu: null,
          fri: { open: "08:00", close: "17:00" },
          sat: null,
          sun: null,
        },
        lead_routing_json: {
          preferred_channel: "phone",
          phone: "512-555-0100",
        },
      },
    });

    const resp = await handlePublicOnboard(req, makePublicEnv());
    // Must not be a profile validation failure
    expect(resp.status).not.toBe(400);
    const body = (await resp.json()) as { error?: string };
    expect(body.error).not.toBe("validation_error");
    // With no Stripe key the handler short-circuits with this specific error
    expect(body.error).toBe("stripe_not_configured");
  });

  it("passes without profile for legacy minimal onboard (profile absent)", async () => {
    const req = makePublicOnboardRequest({
      slug: "legacybiz",
      name: "Legacy Biz",
      email: "owner@legacy.com",
      plan: "base",
      // no profile field — old wizard, must still work
    });

    const resp = await handlePublicOnboard(req, makePublicEnv());
    // Must not be a validation error
    expect(resp.status).not.toBe(400);
    const body = (await resp.json()) as { error?: string };
    expect(body.error).not.toBe("validation_error");
    expect(body.error).toBe("stripe_not_configured");
  });
});
