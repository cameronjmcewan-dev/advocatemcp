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

import { describe, it, expect } from "vitest";
import { tenantToProfileObject } from "./tenantProfile";
import type { TenantRecord } from "../routes/onboard";

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
