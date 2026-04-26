/* Tests for the runner's redaction boundary. The /admin/experiments/
 * format-judge admin route does `res.json(result)` and the result now
 * carries `loadedProfiles` — so secrets in BusinessRow would leak
 * through that response if `redactSafeProfile` ever skipped them.
 *
 * These tests pin the contract: api_key + lead_routing_json must NEVER
 * appear in the runner's return value, and the redacted shape must
 * still be hashable via the same HASH_FIELDS profileScore.ts uses
 * (otherwise the Bug 4 stale-hash fix regresses). */

import { describe, it, expect } from "vitest";
import { redactSafeProfile } from "./runner.js";
import type { BusinessRow } from "../../db.js";

function fixtureRow(): BusinessRow {
  return {
    id: 1,
    slug: "acme",
    name: "Acme Co",
    description: "Test fixture",
    services: "[]",
    pricing: null,
    location: "Austin, TX",
    phone: null,
    website: "https://acme.example",
    referral_url: null,
    tone: "neutral",
    api_key: "amcp_SECRET_DO_NOT_LEAK",
    created_at: "2026-04-26T00:00:00Z",
    category: "test",
    star_rating: null,
    review_count: null,
    years_in_business: null,
    top_services: null,
    availability: null,
    differentiator: null,
    service_radius_miles: null,
    certifications: null,
    pricing_tier: null,
    service_area_keywords: null,
    hours_json: null,
    services_json_v2: null,
    pricing_json_v2: null,
    credentials_json: null,
    ratings_json: null,
    differentiators_text: null,
    customer_quotes_json: null,
    guarantee_text: null,
    case_stories_json: null,
    lead_routing_json: '{"phone":"+15551234567","email":"sensitive@acme.example"}',
  };
}

describe("redactSafeProfile", () => {
  it("strips api_key", () => {
    const safe = redactSafeProfile(fixtureRow()) as Record<string, unknown>;
    expect("api_key" in safe).toBe(false);
    // Belt-and-suspenders: even if the structural check above somehow
    // passes a key with `undefined`, the value cannot equal the input.
    expect(safe.api_key).toBeUndefined();
  });

  it("strips lead_routing_json (PII — phone/email recipients)", () => {
    const safe = redactSafeProfile(fixtureRow()) as Record<string, unknown>;
    expect("lead_routing_json" in safe).toBe(false);
    expect(safe.lead_routing_json).toBeUndefined();
  });

  it("preserves the public profile fields used for rendering + hashing", () => {
    const safe = redactSafeProfile(fixtureRow());
    expect(safe.slug).toBe("acme");
    expect(safe.name).toBe("Acme Co");
    expect(safe.website).toBe("https://acme.example");
    expect(safe.description).toBe("Test fixture");
    expect(safe.location).toBe("Austin, TX");
  });

  it("does not mutate the input row", () => {
    const original = fixtureRow();
    redactSafeProfile(original);
    expect(original.api_key).toBe("amcp_SECRET_DO_NOT_LEAK");
    expect(original.lead_routing_json).toBe(
      '{"phone":"+15551234567","email":"sensitive@acme.example"}',
    );
  });

  it("a JSON.stringify of the redacted row never contains the secret", () => {
    // The most direct check: serialize the result the way res.json()
    // does and confirm neither secret value appears anywhere in the
    // string. Catches future BusinessRow fields that copy the api_key
    // or lead_routing_json into other columns.
    const safe = redactSafeProfile(fixtureRow());
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("amcp_SECRET_DO_NOT_LEAK");
    expect(serialized).not.toContain("sensitive@acme.example");
    expect(serialized).not.toContain("+15551234567");
  });
});
