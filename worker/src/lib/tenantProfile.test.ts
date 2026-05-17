/**
 * Tests for `tenantToProfileObject` — the pure mapping from the rich,
 * nested `TenantRecord` (TENANT_DATA KV) to the flat object shape consumed
 * by `buildWellKnownResponse` and `buildLlmsTxtResponse`.
 *
 * These lock in the contract that lets the Worker read profile data
 * straight from KV instead of HTTP-fetching `/agents/{slug}/profile` — the
 * fetch path triggers Cloudflare's same-zone loop-prevention and returns
 * 401, which is why every tenant's ai-agent.json was missing business
 * fields before this fix.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { tenantToProfileObject, readProfileForDomain } from "./tenantProfile";
import type { TenantRecord } from "../routes/onboard";
import type { Env } from "../types";

function tenantFixture(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    domain:     "acme.example",
    name:       "Acme Co",
    slug:       "acme",
    phone:      "",
    email:      "",
    address:    "",
    city:       "",
    state:      "",
    postalCode: "",
    country:    "",
    services:   [],
    website:    "",
    notes:      "",
    status:     "active",
    cloudflare: {
      customHostnameId:    null,
      verificationMethod:  "txt",
      verificationStatus:  "active",
      sslStatus:           "active",
      txtName:             null,
      txtValue:            null,
      ownershipTxtName:    null,
      ownershipTxtValue:   null,
    },
    statusLog:  [],
    createdAt:  "2026-01-01T00:00:00Z",
    updatedAt:  "2026-01-01T00:00:00Z",
    ...overrides,
  } as unknown as TenantRecord;
}

describe("tenantToProfileObject", () => {
  it("returns null when tenant is null", () => {
    expect(tenantToProfileObject(null)).toBeNull();
  });

  it("returns an object with name when only top-level fields are set", () => {
    const out = tenantToProfileObject(tenantFixture({ name: "Acme Co" }));
    expect(out).not.toBeNull();
    expect(out!.name).toBe("Acme Co");
  });

  it("maps canonical top-level fields (name, phone, email, services)", () => {
    const out = tenantToProfileObject(
      tenantFixture({
        name:     "Acme Widgets",
        phone:    "(555) 555-0100",
        email:    "hello@acme.example",
        services: ["Widget A", "Widget B"],
      }),
    )!;
    expect(out.name).toBe("Acme Widgets");
    expect(out.phone).toBe("(555) 555-0100");
    expect(out.email).toBe("hello@acme.example");
    expect(out.services).toEqual(["Widget A", "Widget B"]);
  });

  it("composes location as 'City, ST' when both are set", () => {
    const out = tenantToProfileObject(
      tenantFixture({ city: "Austin", state: "TX" }),
    )!;
    expect(out.location).toBe("Austin, TX");
  });

  it("falls back to profile.location when city/state aren't set", () => {
    const out = tenantToProfileObject(
      tenantFixture({
        city:  "",
        state: "",
        profile: { location: "Greater Austin Area" },
      }),
    )!;
    expect(out.location).toBe("Greater Austin Area");
  });

  it("omits location entirely when neither city/state nor profile.location is set", () => {
    const out = tenantToProfileObject(tenantFixture())!;
    expect(out.location).toBeUndefined();
  });

  it("maps wizard profile fields (description, category, availability, etc.)", () => {
    const out = tenantToProfileObject(
      tenantFixture({
        profile: {
          description:           "We sell widgets.",
          category:              "widgets",
          availability:          "Mon-Fri 9-5",
          service_area_keywords: "Austin,Round Rock",
          service_radius_miles:  25,
          star_rating:           4.8,
          review_count:          23,
          years_in_business:     12,
          top_services:          "Widget A · Widget B",
        },
      }),
    )!;
    expect(out.description).toBe("We sell widgets.");
    expect(out.category).toBe("widgets");
    expect(out.availability).toBe("Mon-Fri 9-5");
    expect(out.service_area_keywords).toBe("Austin,Round Rock");
    expect(out.service_radius_miles).toBe(25);
    expect(out.star_rating).toBe(4.8);
    expect(out.review_count).toBe(23);
    expect(out.years_in_business).toBe(12);
    expect(out.top_services).toBe("Widget A · Widget B");
  });

  it("prefers profile.differentiator but falls back to differentiators_text", () => {
    const a = tenantToProfileObject(
      tenantFixture({ profile: { differentiator: "Fast turnaround" } }),
    )!;
    expect(a.differentiator).toBe("Fast turnaround");

    const b = tenantToProfileObject(
      tenantFixture({ profile: { differentiators_text: "Family-owned since 1982" } }),
    )!;
    expect(b.differentiator).toBe("Family-owned since 1982");

    // When both set, profile.differentiator wins.
    const c = tenantToProfileObject(
      tenantFixture({
        profile: {
          differentiator:       "New copy",
          differentiators_text: "Old copy",
        },
      }),
    )!;
    expect(c.differentiator).toBe("New copy");
  });

  it("prefers profile.referral_url but falls back to tenant.website", () => {
    const a = tenantToProfileObject(
      tenantFixture({
        website: "https://acme.example",
        profile: { referral_url: "https://acme.example/contact" },
      }),
    )!;
    expect(a.referral_url).toBe("https://acme.example/contact");

    const b = tenantToProfileObject(
      tenantFixture({ website: "https://acme.example" }),
    )!;
    expect(b.referral_url).toBe("https://acme.example");

    const c = tenantToProfileObject(tenantFixture())!;
    expect(c.referral_url).toBeUndefined();
  });

  it("omits empty services arrays (no empty-list noise downstream)", () => {
    const out = tenantToProfileObject(tenantFixture({ services: [] }))!;
    expect(out.services).toBeUndefined();
  });

  it("omits keys whose source value is an empty string", () => {
    const out = tenantToProfileObject(
      tenantFixture({
        name:    "Acme",
        phone:   "",
        email:   "",
        website: "",
      }),
    )!;
    expect(out.phone).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.referral_url).toBeUndefined();
  });

  it("produces a shape compatible with buildWellKnownResponse expectations", () => {
    // Smoke: the keys we emit must be the keys buildWellKnownResponse
    // reads. This test catches any drift between the mapping and the
    // consumer. (The consumer reads: name, category, location,
    // description, services, referral_url, availability.)
    const out = tenantToProfileObject(
      tenantFixture({
        name:     "Acme Widgets Co",
        city:     "Austin",
        state:    "TX",
        services: ["Widget A"],
        website:  "https://acme.example",
        profile: {
          description:  "We make widgets.",
          category:     "widgets",
          availability: "Mon-Fri",
        },
      }),
    )!;
    expect(out.name).toBe("Acme Widgets Co");
    expect(out.category).toBe("widgets");
    expect(out.location).toBe("Austin, TX");
    expect(out.description).toBe("We make widgets.");
    expect(out.services).toEqual(["Widget A"]);
    expect(out.referral_url).toBe("https://acme.example");
    expect(out.availability).toBe("Mon-Fri");
  });
});

// ── readProfileForDomain ───────────────────────────────────────────────────
//
// Two-tier source: TENANT_DATA KV first (fast, no auth), Railway-direct
// HTTP fallback (with X-API-Key). The fallback exists because:
//   - The platform's own advocatemcp.com tenant predates the onboarding
//     flow that writes TENANT_DATA, so its profile lives only in Railway.
//   - A subset of older customer tenants may have stale or sparse KV
//     records and still need the canonical profile from D1.
//
// These tests lock in the source-selection contract and prove the
// fallback uses apiBase (raw Railway), not publicApiBase (Cloudflare-
// fronted, bound to the Worker, would trigger loop-prevention bypass).

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_BASE_URL: "https://railway.internal.example",
    PUBLIC_API_BASE_URL: "https://api.public.example",
    API_KEY: "test-api-key",
    TENANT_DATA: {
      get: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as unknown as Env;
}

function mockFetchOk(body: unknown): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockFetchStatus(status: number): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response("", { status }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readProfileForDomain", () => {
  it("returns the KV-derived profile when TENANT_DATA has a useful record", async () => {
    const tenant = tenantFixture({
      name:     "Acme Co",
      city:     "Austin",
      state:    "TX",
      services: ["Widget A"],
      profile:  { description: "We make widgets.", category: "widgets" },
    });
    const env = makeEnv({
      TENANT_DATA: {
        get: vi.fn().mockResolvedValue(JSON.stringify(tenant)),
      } as unknown as KVNamespace,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const profile = await readProfileForDomain(env, "acme.example", "acme");
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("Acme Co");
    expect(profile!.description).toBe("We make widgets.");
    expect(profile!.location).toBe("Austin, TX");

    // KV was enough — no HTTP fallback should have fired.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to Railway HTTP when TENANT_DATA is missing", async () => {
    const env = makeEnv(); // TENANT_DATA.get returns null
    mockFetchOk({
      name: "Platform Tenant",
      category: "ai-marketing-saas",
      location: "Austin, TX",
      description: "Source-of-truth profile from D1.",
    });

    const profile = await readProfileForDomain(env, "advocatemcp.com", "advocate");
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("Platform Tenant");
    expect(profile!.description).toBe("Source-of-truth profile from D1.");
  });

  it("falls back to Railway HTTP when TENANT_DATA has a sparse record (no name, no description)", async () => {
    // Edge case: the onboarding flow wrote a record but the wizard wasn't
    // completed, so name/description are empty. We treat this as "no
    // useful profile" and reach for Railway instead of rendering a
    // half-empty discovery file.
    const sparseTenant = tenantFixture({ name: "", profile: {} });
    const env = makeEnv({
      TENANT_DATA: {
        get: vi.fn().mockResolvedValue(JSON.stringify(sparseTenant)),
      } as unknown as KVNamespace,
    });
    mockFetchOk({ name: "Hydrated From D1" });

    const profile = await readProfileForDomain(env, "sparse.example", "sparse");
    expect(profile!.name).toBe("Hydrated From D1");
  });

  it("attaches X-API-Key to the Railway-direct fetch", async () => {
    const env = makeEnv({ API_KEY: "secret-key-123" });
    mockFetchOk({ name: "Whatever" });

    await readProfileForDomain(env, "advocatemcp.com", "advocate");

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const init = fetchCall![1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("secret-key-123");
  });

  it("uses apiBase (raw Railway), NEVER publicApiBase, for the fallback URL", async () => {
    // Regression catcher for PR #225's failure mode. publicApiBase
    // (api.advocatemcp.com) is bound to this Worker, so a fetch would
    // trigger Cloudflare's loop-prevention and bypass the X-API-Key
    // proxy entirely. Using apiBase (raw Railway hostname) makes the
    // request go straight to Railway where our manually-attached
    // X-API-Key actually authenticates.
    const env = makeEnv({
      API_BASE_URL:        "https://advocate-production-2887.up.railway.app",
      PUBLIC_API_BASE_URL: "https://api.advocatemcp.com",
    });
    mockFetchOk({ name: "Advocate" });

    await readProfileForDomain(env, "advocatemcp.com", "advocate");

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = String(fetchCall![0]);
    expect(url).toBe("https://advocate-production-2887.up.railway.app/agents/advocate/profile");
    // Belt and braces: explicit assertion against the public host.
    expect(url).not.toContain("api.advocatemcp.com");
  });

  it("returns null when both KV and Railway fail", async () => {
    const env = makeEnv();
    mockFetchStatus(401); // canonical Railway-direct-without-auth failure

    const profile = await readProfileForDomain(env, "unknown.example", "ghost");
    expect(profile).toBeNull();
  });

  it("returns null when slug is null and KV is empty (no URL to construct)", async () => {
    const env = makeEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const profile = await readProfileForDomain(env, "unmapped.example", null);
    expect(profile).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows fetch network errors and returns whatever KV had", async () => {
    const env = makeEnv();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNRESET"));

    const profile = await readProfileForDomain(env, "flaky.example", "flaky");
    expect(profile).toBeNull(); // KV was null, fetch threw, result is null
  });

  it("does not include X-API-Key header when API_KEY env var is unset", async () => {
    const env = makeEnv({ API_KEY: undefined });
    mockFetchOk({ name: "No Auth Today" });

    await readProfileForDomain(env, "advocatemcp.com", "advocate");

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const init = fetchCall![1] as RequestInit;
    expect(init.headers).toEqual({});
  });
});
