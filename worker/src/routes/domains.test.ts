/**
 * Integration tests for worker/src/routes/domains.ts — specifically the
 * self-healing activation flow added in the DNS self-healing change.
 *
 * Scope: focused on the new behavior (POST body includes custom_origin_server;
 * reconcile fires on the already-exists branch; cf_reconcile_error surfaces
 * correctly). Does NOT retroactively cover unrelated existing paths (slug
 * validation, origin discovery, KV writes) — those remain without unit tests
 * for now by design (out of scope for this change).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the CF API at the module boundary ─────────────────────────────────
// activateDomain calls the internal cfRequest fn, which calls fetch().
// We stub fetch() globally to control CF API responses per-test.
// afterEach unstubs so we don't leak a stale fetch mock into other test files
// (matches the pattern in onboard.test.ts, stripe.test.ts, resend.test.ts).

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// Mock origin discovery so we don't need to stub a full HTTP redirect chain.
vi.mock("../lib/origin-discovery.js", () => ({
  discoverOriginUrl: vi.fn(async (domain: string) => ({
    ok: true,
    originUrl: `https://${domain}.example.squarespace.com`,
    finalHostname: `${domain}.example.squarespace.com`,
  })),
}));

// Mock TENANT_DATA upsert path so we don't need to mock KV fully.
vi.mock("./onboard", async () => {
  const actual = await vi.importActual<typeof import("./onboard")>("./onboard");
  return {
    ...actual,
    getTenant: vi.fn(async () => null),
    putTenant: vi.fn(async () => undefined),
    extractCfData: vi.fn(() => undefined),
  };
});

import { activateDomain } from "./domains.js";
import type { Env } from "../types.js";

function mockEnv(): Env {
  return {
    CF_API_TOKEN: "test-token",
    CF_ZONE_ID: "test-zone-id",
    API_BASE_URL: "https://advocate-production-2887.up.railway.app",
    API_KEY: "test-api-key",
    BUSINESS_MAP: {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
    } as unknown as Env["BUSINESS_MAP"],
    DB: {
      prepare: () => ({
        bind: () => ({
          run: vi.fn(async () => undefined),
          first: vi.fn(async () => null),
        }),
      }),
    } as unknown as Env["DB"],
    TENANT_DATA: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as Env["TENANT_DATA"],
  } as Env;
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("activateDomain — self-healing spec", () => {
  it("POSTs to CF with custom_origin_server in the body for a new hostname", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true }))  // Railway profile 200
      .mockResolvedValueOnce(respond({                 // CF POST
        success: true,
        result: {
          id: "cf-hostname-123",
          hostname: "www.example.com",
          custom_origin_server: "advocatemcp-worker.advocatecameron.workers.dev",
          ssl: { method: "txt", settings: { min_tls_version: "1.2" }, txt_name: "_acme.example.com", txt_value: "abc" },
        },
      }));

    const env = mockEnv();
    const result = await activateDomain(env, {
      domain: "www.example.com",
      slug: "example-slug",
      originUrl: null,
    });

    expect(result.ok).toBe(true);
    // Tighten the success assertion: this is the new-hostname path, not
    // already_exists, and the CF id from the mock should round-trip verbatim.
    expect(result.body.status).toBe("pending_verification");
    expect(result.body.cf_hostname_id).toBe("cf-hostname-123");

    const cfPost = fetchMock.mock.calls.find(
      ([url, init]) => typeof url === "string" && url.includes("api.cloudflare.com") && (init as RequestInit)?.method === "POST",
    );
    expect(cfPost).toBeDefined();
    const body = JSON.parse((cfPost![1] as RequestInit).body as string);
    expect(body.custom_origin_server).toBe("advocatemcp-worker.advocatecameron.workers.dev");
    expect(body.hostname).toBe("www.example.com");
    expect(body.ssl).toEqual({
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    });
  });
});

describe("activateDomain — reconcile on existing hostname", () => {
  it("PATCHes an existing hostname missing custom_origin_server", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true }))  // Railway profile 200
      .mockResolvedValueOnce(respond({                 // CF POST — returns 1406 (already exists)
        success: false,
        errors: [{ code: 1406, message: "hostname already exists" }],
      }))
      .mockResolvedValueOnce(respond({                 // CF GET ?hostname= — return the legacy record
        success: true,
        result: [{
          id: "cf-legacy-456",
          hostname: "www.legacy.com",
          // custom_origin_server MISSING — this is the broken state
          ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
        }],
      }))
      .mockResolvedValueOnce(respond({                 // CF PATCH — return the reconciled record
        success: true,
        result: {
          id: "cf-legacy-456",
          hostname: "www.legacy.com",
          custom_origin_server: "advocatemcp-worker.advocatecameron.workers.dev",
          ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
        },
      }));

    const env = mockEnv();
    const result = await activateDomain(env, {
      domain: "www.legacy.com",
      slug: "legacy-slug",
      originUrl: null,
    });

    expect(result.ok).toBe(true);
    expect(result.body.reconcile_summary).toEqual({
      patched: true,
      drift: ["custom_origin_server"],
    });

    // Confirm one PATCH fired with only the drifting field
    const cfPatch = fetchMock.mock.calls.find(
      ([url, init]) => typeof url === "string" && url.includes("api.cloudflare.com") && (init as RequestInit)?.method === "PATCH",
    );
    expect(cfPatch).toBeDefined();
    expect(JSON.parse((cfPatch![1] as RequestInit).body as string)).toEqual({
      custom_origin_server: "advocatemcp-worker.advocatecameron.workers.dev",
    });
  });

  it("fires NO PATCH when the existing hostname already matches the spec", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true }))
      .mockResolvedValueOnce(respond({
        success: false,
        errors: [{ code: 1406, message: "hostname already exists" }],
      }))
      .mockResolvedValueOnce(respond({
        success: true,
        result: [{
          id: "cf-healthy-789",
          hostname: "www.healthy.com",
          custom_origin_server: "advocatemcp-worker.advocatecameron.workers.dev",
          ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
        }],
      }));

    const env = mockEnv();
    const result = await activateDomain(env, {
      domain: "www.healthy.com",
      slug: "healthy-slug",
      originUrl: null,
    });

    expect(result.ok).toBe(true);
    expect(result.body.reconcile_summary).toBeUndefined();

    const cfPatch = fetchMock.mock.calls.find(
      ([url, init]) => typeof url === "string" && url.includes("api.cloudflare.com") && (init as RequestInit)?.method === "PATCH",
    );
    expect(cfPatch).toBeUndefined();
  });

  it("returns 502 cf_reconcile_error when the PATCH fails", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true }))
      .mockResolvedValueOnce(respond({
        success: false,
        errors: [{ code: 1406, message: "hostname already exists" }],
      }))
      .mockResolvedValueOnce(respond({
        success: true,
        result: [{
          id: "cf-broken-999",
          hostname: "www.broken.com",
          ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
        }],
      }))
      .mockResolvedValueOnce(respond({
        success: false,
        errors: [{ code: 9999, message: "cf unreachable" }],
      }, 502));

    const env = mockEnv();
    const result = await activateDomain(env, {
      domain: "www.broken.com",
      slug: "broken-slug",
      originUrl: null,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.reason).toBe("cf_reconcile_error");
  });
});
