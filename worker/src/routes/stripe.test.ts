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

import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { provisionActivationToken } from "./stripe";
import { handleGetActivation } from "./activate";
import { signActivationToken } from "../lib/activation-token";
import type { Env } from "../types";

const mockedSign = vi.mocked(signActivationToken);

// ── Minimal fake D1 — just enough of the D1Database shape to cover
// the two SQL statements the helpers emit. Keyed by slug. Each row
// stores only the activation-related columns; nothing else is read
// or written by the code under test.

interface FakeBusinessRow {
  slug: string;
  activation_token: string | null;
  activation_status: string;
  activation_issued_at: string | null;
}

function createFakeDb(
  initial: Record<string, Partial<FakeBusinessRow>> = {},
): { db: D1Database; rows: Map<string, FakeBusinessRow> } {
  const table = new Map<string, FakeBusinessRow>();
  for (const [slug, row] of Object.entries(initial)) {
    table.set(slug, {
      slug,
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
    // The rest of the Env interface is irrelevant to these tests —
    // stripe.ts provisionActivationToken only touches DB + ACTIVATION_SIGNING_KEY
    // and handleGetActivation only touches DB + ADMIN_SECRET.
  } as unknown as Env;
}

// ── Test suite ───────────────────────────────────────────────────────────

describe("provisionActivationToken (Phase F Part 1)", () => {
  beforeEach(() => {
    mockedSign.mockClear();
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
