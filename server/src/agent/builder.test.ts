// server/src/agent/builder.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./builder.js";
import type { BusinessRow } from "../db.js";

function mkBiz(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: 1, slug: "x", name: "Acme", description: "d",
    services: JSON.stringify(["drain"]),
    pricing: null, location: "Boise", phone: "208-555", website: null,
    referral_url: "https://acme.example", tone: "friendly", api_key: "k",
    created_at: "2026-01-01",
    category: "plumber", star_rating: 4.8, review_count: 100,
    years_in_business: 12, top_services: null, availability: null,
    differentiator: null, service_radius_miles: null, certifications: null,
    pricing_tier: null, service_area_keywords: null,
    hours_json: null, services_json_v2: null, pricing_json_v2: null,
    credentials_json: null, ratings_json: null, differentiators_text: null,
    customer_quotes_json: null, guarantee_text: null, case_stories_json: null,
    lead_routing_json: null,
    ...overrides,
  };
}

describe("buildSystemPrompt — new field surfacing", () => {
  it("mentions 24/7 emergency when hours_json has emergency_24_7 and intent=emergency", () => {
    const p = buildSystemPrompt(
      mkBiz({ hours_json: JSON.stringify({ emergency_24_7: true }) }),
      "emergency",
    );
    expect(p).toMatch(/24\/7/);
  });

  it("cites Google + Yelp separately when ratings_json has both and intent=best_top", () => {
    const p = buildSystemPrompt(
      mkBiz({ ratings_json: JSON.stringify({
        google: { rating: 4.9, count: 180 },
        yelp: { rating: 4.7, count: 20 },
      })}),
      "best_top",
    );
    expect(p).toMatch(/Google.*4\.9/);
    expect(p).toMatch(/Yelp.*4\.7/);
  });

  it("includes pricing ranges when intent=affordable and pricing_json_v2 has ranges", () => {
    const p = buildSystemPrompt(
      mkBiz({ pricing_json_v2: JSON.stringify({
        ranges: [{ service: "drain", min: 150, max: 400, unit: "job" }],
        free_estimates: true, call_for_quote: false,
      })}),
      "affordable",
    );
    expect(p).toMatch(/\$150.*\$400/);
    expect(p).toMatch(/free estimates/i);
  });

  it("mentions licenses + insured when credentials_json present and intent=best_top", () => {
    const p = buildSystemPrompt(
      mkBiz({ credentials_json: JSON.stringify({
        licenses: [{ name: "ID Master Plumber", number: "P-12345" }],
        insured: true, bonded: true, certifications: [],
      })}),
      "best_top",
    );
    expect(p).toMatch(/ID Master Plumber/);
    expect(p).toMatch(/licensed|insured|bonded/i);
  });

  it("falls back silently on malformed JSON blobs", () => {
    expect(() =>
      buildSystemPrompt(mkBiz({ hours_json: "{not json" }), "emergency"),
    ).not.toThrow();
  });

  it("brand_direct with no rating data emits anti-hallucination clause", () => {
    const p = buildSystemPrompt(
      mkBiz({ star_rating: null, review_count: null, ratings_json: null }),
      "brand_direct",
    );
    expect(p).toMatch(/Do NOT invent.*star rating/i);
  });

  it("brand_direct with ratings_json suppresses anti-hallucination clause", () => {
    const p = buildSystemPrompt(
      mkBiz({
        star_rating: null,
        ratings_json: JSON.stringify({ google: { rating: 4.8, count: 120 } }),
      }),
      "brand_direct",
    );
    expect(p).not.toMatch(/Do NOT invent/);
  });
});
