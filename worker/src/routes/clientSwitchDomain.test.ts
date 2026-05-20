/**
 * Tests for POST /api/client/tenant/switch-domain.
 *
 * Covers the full edge-case ladder for the self-serve "hosted subdomain
 * → custom domain" flow. Each test exercises a single guard so a
 * regression in one branch can't hide behind another. The happy-path
 * test verifies BUSINESS_MAP variant fan-out + TENANT_DATA write + D1
 * update + response shape end-to-end.
 *
 * Mock surface:
 *   - getSessionFromRequest    (auth)
 *   - getUserBusinesses        (D1 access list)
 *   - getUserRoleOnBusiness    (D1 role lookup)
 *   - getTenant / putTenant    (TENANT_DATA KV)
 *   - createCfHostnameForTenant (Cloudflare for SaaS handshake)
 *   - env.BUSINESS_MAP         (in-memory KV)
 *   - env.DB                   (UPDATE businesses ...)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./authApi", () => ({
  getSessionFromRequest: vi.fn(),
}));

vi.mock("./onboard", async () => {
  // We need the real `normalizeDomain`, `buildDnsInstructions`, etc.
  // helpers — they're pure, no I/O. Only the mutating helpers
  // (`getTenant`, `putTenant`, `createCfHostnameForTenant`) need
  // mocks.
  const actual = await vi.importActual<typeof import("./onboard")>("./onboard");
  return {
    ...actual,
    getTenant:                vi.fn(),
    putTenant:                vi.fn(),
    createCfHostnameForTenant: vi.fn(),
  };
});

vi.mock("../portalDb", () => ({
  getUserBusinesses:     vi.fn(),
  getUserRoleOnBusiness: vi.fn(),
}));

import { handleClientSwitchDomain } from "./clientSwitchDomain";
import { getSessionFromRequest } from "./authApi";
import { getTenant, putTenant, createCfHostnameForTenant, type TenantRecord } from "./onboard";
import { getUserBusinesses, getUserRoleOnBusiness } from "../portalDb";
import type { Env } from "../types";

const mockedSession   = vi.mocked(getSessionFromRequest);
const mockedGetTenant = vi.mocked(getTenant);
const mockedPutTenant = vi.mocked(putTenant);
const mockedCreateCf  = vi.mocked(createCfHostnameForTenant);
const mockedBusinesses = vi.mocked(getUserBusinesses);
const mockedRole       = vi.mocked(getUserRoleOnBusiness);

// ── Fake KV ─────────────────────────────────────────────────────────────────

function makeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get:    vi.fn(async (k: string) => store.get(k) ?? null),
    put:    vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    list:   vi.fn(async () => ({ keys: Array.from(store.keys()).map((name) => ({ name })), list_complete: true })),
    // Expose for assertions.
    _store: store,
  } as unknown as KVNamespace;
}

// ── Fake D1 ─────────────────────────────────────────────────────────────────

interface D1Spy {
  binds: unknown[];
  run:   ReturnType<typeof vi.fn>;
}

function makeDB(opts: { runThrows?: Error } = {}) {
  const spies: D1Spy[] = [];
  const prepared = vi.fn((sql: string) => {
    const spy: D1Spy = {
      binds: [],
      run:   vi.fn(async () => {
        if (opts.runThrows) throw opts.runThrows;
        return { success: true, meta: { changes: 1 } };
      }),
    };
    spies.push(spy);
    return {
      _sql: sql,
      bind: (...args: unknown[]) => {
        spy.binds = args;
        return {
          run:   spy.run,
          first: async () => null,
        };
      },
    };
  });
  return { prepare: prepared, _spies: spies } as unknown as D1Database & { _spies: D1Spy[] };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeTenantFixture(overrides: Partial<TenantRecord> = {}): TenantRecord {
  const now = new Date().toISOString();
  return {
    domain:     "the-bamboo-brace.hosted.advocatemcp.com",
    name:       "The Bamboo Brace",
    slug:       "the-bamboo-brace",
    phone:      "",
    email:      "info@bamboobrace.com",
    address:    "",
    city:       "",
    state:      "",
    postalCode: "",
    country:    "US",
    services:   [],
    website:    "https://bamboobrace.com",
    notes:      "",
    status:     "active",
    cloudflare: {
      customHostnameId:    "old-hosted-id",
      verificationMethod:  "txt",
      verificationStatus:  "active",
      sslStatus:           "active",
      txtName:             null,
      txtValue:            null,
      ownershipTxtName:    null,
      ownershipTxtValue:   null,
    },
    skipDns:    true,
    statusLog:  [],
    createdAt:  now,
    updatedAt:  now,
    ...overrides,
  } as TenantRecord;
}

function makeRequest(body: unknown, opts: { contentType?: string } = {}): Request {
  return new Request("https://customers.advocatemcp.com/api/client/tenant/switch-domain", {
    method:  "POST",
    headers: { "Content-Type": opts.contentType ?? "application/json" },
    body:    body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function makeEnv(overrides: { BUSINESS_MAP?: KVNamespace; DB?: D1Database } = {}): Env {
  return {
    BUSINESS_MAP:        overrides.BUSINESS_MAP ?? makeKV(),
    TENANT_DATA:         makeKV(),
    DB:                  overrides.DB ?? makeDB(),
    CF_API_TOKEN:        "test-token",
    CF_ZONE_ID:          "test-zone",
    ACCESS_TOKEN_SIGNING_KEY: "test-key",
  } as unknown as Env;
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockedSession.mockResolvedValue({
    user_id:        "user-123",
    email:          "owner@bamboobrace.com",
    full_name:      "Michael",
    role:           "client",
    tenant_id:      null,
    email_verified: 1,
    auth_method:    "bearer",
  });
  mockedBusinesses.mockResolvedValue([
    {
      id:            "biz-bamboo",
      slug:          "the-bamboo-brace",
      business_name: "The Bamboo Brace",
      domain:        "the-bamboo-brace.hosted.advocatemcp.com",
      api_key:       "key-bamboo",
    } as unknown as Awaited<ReturnType<typeof getUserBusinesses>>[number],
  ]);
  mockedRole.mockResolvedValue("owner");
  mockedGetTenant.mockResolvedValue(makeTenantFixture());
  mockedPutTenant.mockResolvedValue();
  mockedCreateCf.mockImplementation(async (_env, tenant) => {
    // Simulate a successful registration — fill in the CF state on the
    // passed-in tenant the way the real helper does.
    tenant.cloudflare.customHostnameId = "new-cf-id";
    tenant.cloudflare.verificationStatus = "pending";
    tenant.cloudflare.sslStatus          = "pending";
    tenant.cloudflare.txtName            = "_acme-challenge.bamboobrace.com";
    tenant.cloudflare.txtValue           = "verify-bamboobrace";
    tenant.cloudflare.ownershipTxtName   = "_cf-custom-hostname.bamboobrace.com";
    tenant.cloudflare.ownershipTxtValue  = "ownership-bamboobrace";
    return { created: true, variants: [] };
  });
});

describe("POST /api/client/tenant/switch-domain", () => {
  it("returns 401 when no authenticated session", async () => {
    mockedSession.mockResolvedValueOnce(null);
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "bamboobrace.com" }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 415 when Content-Type is not application/json", async () => {
    const res = await handleClientSwitchDomain(
      makeRequest("slug=x", { contentType: "text/plain" }),
      makeEnv(),
    );
    expect(res.status).toBe(415);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const res = await handleClientSwitchDomain(
      makeRequest("{ not json", { contentType: "application/json" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("returns 400 when slug is missing", async () => {
    const res = await handleClientSwitchDomain(
      makeRequest({ new_domain: "bamboobrace.com" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("missing_slug");
  });

  it("returns 400 when new_domain is malformed", async () => {
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "not a real domain" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_domain");
  });

  it("returns 400 when new_domain is advocatemcp.com or a subdomain of it (normalizeDomain rejects)", async () => {
    // `normalizeDomain` in onboard.ts blocks `*.advocatemcp.com` at the
    // parse layer so we never reach a deeper guard. The user-facing
    // contract is "advocatemcp.com hostnames can't be self-served";
    // surfacing this as `invalid_domain` with a hint message satisfies
    // it without a redundant second branch.
    for (const reserved of ["advocatemcp.com", "www.advocatemcp.com", "evil.advocatemcp.com", "the-bamboo-brace.hosted.advocatemcp.com"]) {
      const res = await handleClientSwitchDomain(
        makeRequest({ slug: "the-bamboo-brace", new_domain: reserved }),
        makeEnv(),
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe("invalid_domain");
      // Hint copy points the user at the actual constraint.
      expect(body.message.toLowerCase()).toContain("reserved");
    }
  });

  it("returns 404 when the slug is not in the caller's access list", async () => {
    mockedBusinesses.mockResolvedValueOnce([]);
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "stranger", new_domain: "bamboobrace.com" }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller's role on the business is not 'owner'", async () => {
    mockedRole.mockResolvedValueOnce("editor");
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "bamboobrace.com" }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when the business is already on a custom domain", async () => {
    mockedBusinesses.mockResolvedValueOnce([
      {
        id:            "biz-bamboo",
        slug:          "the-bamboo-brace",
        business_name: "The Bamboo Brace",
        domain:        "bamboobrace.com", // already custom!
        api_key:       "key-bamboo",
      } as unknown as Awaited<ReturnType<typeof getUserBusinesses>>[number],
    ]);
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "newbamboobrace.com" }),
      makeEnv(),
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("already_custom_domain");
  });

  it("returns 409 when new_domain is already claimed by a DIFFERENT slug", async () => {
    const env = makeEnv({
      BUSINESS_MAP: makeKV({ "bamboobrace.com": "other-tenant-slug" }),
    });
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "bamboobrace.com" }),
      env,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("domain_taken");
  });

  it("returns 502 when Cloudflare API throws", async () => {
    mockedCreateCf.mockRejectedValueOnce(new Error("CF API down"));
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "bamboobrace.com" }),
      makeEnv(),
    );
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("cf_api_error");
  });

  it("returns 502 when Cloudflare returns created=false (every variant failed)", async () => {
    mockedCreateCf.mockResolvedValueOnce({ created: false, variants: [] });
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "bamboobrace.com" }),
      makeEnv(),
    );
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("cf_registration_failed");
  });

  it("happy path: writes BUSINESS_MAP variants, writes TENANT_DATA, updates D1, returns CNAME details", async () => {
    const kv = makeKV();
    const db = makeDB();
    const env = makeEnv({ BUSINESS_MAP: kv, DB: db });
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "bamboobrace.com" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.new_domain).toBe("bamboobrace.com");
    expect(body.old_domain).toBe("the-bamboo-brace.hosted.advocatemcp.com");
    expect(body.slug).toBe("the-bamboo-brace");
    expect(body.dns).toBeDefined();
    const cf = body.cloudflare as Record<string, unknown>;
    expect(cf.customHostnameId).toBe("new-cf-id");
    expect(cf.verificationStatus).toBe("pending");

    // BUSINESS_MAP wrote the apex + www variants (deriveHostnameVariants
    // expands `bamboobrace.com` into both). Both should resolve to the
    // tenant's slug.
    const store = (kv as unknown as { _store: Map<string, string> })._store;
    expect(store.get("bamboobrace.com")).toBe("the-bamboo-brace");
    expect(store.get("www.bamboobrace.com")).toBe("the-bamboo-brace");

    // D1 UPDATE businesses fired with the new domain + new CF id.
    const dbSpies = (db as unknown as { _spies: D1Spy[] })._spies;
    const updateSpy = dbSpies.find((s) => (s.run as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0);
    expect(updateSpy).toBeDefined();
    expect(updateSpy!.binds[0]).toBe("bamboobrace.com");
    expect(updateSpy!.binds[1]).toBe("new-cf-id");
    expect(updateSpy!.binds[2]).toBe("biz-bamboo");

    // putTenant called twice: new domain primary + old domain marked
    // as redirect alias.
    expect(mockedPutTenant).toHaveBeenCalledTimes(2);
  });

  it("idempotent: retry with same new_domain after first call succeeds (BUSINESS_MAP says OUR slug, not blocked)", async () => {
    const kv = makeKV({
      "bamboobrace.com":     "the-bamboo-brace",
      "www.bamboobrace.com": "the-bamboo-brace",
    });
    const env = makeEnv({ BUSINESS_MAP: kv });
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "bamboobrace.com" }),
      env,
    );
    // Should still succeed — the conflict check only refuses if the
    // existing slug is DIFFERENT. Same-slug retry passes through and
    // CF helper handles its own re-registration via reuse path.
    expect(res.status).toBe(200);
  });

  it("D1 update failure is swallowed (KV writes already succeeded, return 200)", async () => {
    const db = makeDB({ runThrows: new Error("d1 down") });
    const res = await handleClientSwitchDomain(
      makeRequest({ slug: "the-bamboo-brace", new_domain: "bamboobrace.com" }),
      makeEnv({ DB: db }),
    );
    // 200 even though D1 update threw — KV is what bots actually read.
    // /api/client/me will return the new domain once D1 catches up.
    expect(res.status).toBe(200);
  });
});
