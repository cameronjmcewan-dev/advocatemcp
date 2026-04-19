import { describe, it, expect } from "vitest";
import { toLocalBusinessJsonLd, wrapAsScriptTag } from "./jsonLd.js";
import type { BusinessRow } from "../db.js";

function mkBiz(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: 1, slug: "acme", name: "Acme LLC", description: "Acme does things.",
    services: JSON.stringify(["x"]),
    pricing: null, location: "Boise, ID", phone: "208-555-0100",
    website: "https://acme.example", referral_url: null, tone: "friendly",
    api_key: "k", created_at: "2026-01-01",
    category: "plumber", star_rating: null, review_count: null,
    years_in_business: null, top_services: null, availability: null,
    differentiator: null, service_radius_miles: null, certifications: null,
    pricing_tier: null, service_area_keywords: null,
    hours_json: null, services_json_v2: null, pricing_json_v2: null,
    credentials_json: null, ratings_json: null, differentiators_text: null,
    customer_quotes_json: null, guarantee_text: null, case_stories_json: null,
    lead_routing_json: null,
    ...overrides,
  };
}

describe("toLocalBusinessJsonLd", () => {
  it("emits the minimum viable LocalBusiness shape", () => {
    const out = toLocalBusinessJsonLd(mkBiz());
    expect(out["@context"]).toBe("https://schema.org");
    expect(out["@type"]).toBe("LocalBusiness");
    expect(out.name).toBe("Acme LLC");
    expect(out.description).toBe("Acme does things.");
    expect(out.url).toBe("https://acme.example");
    expect(out.telephone).toBe("208-555-0100");
  });

  it("splits 'Boise, ID' into addressLocality + addressRegion", () => {
    const out = toLocalBusinessJsonLd(mkBiz({ location: "Boise, ID" }));
    expect(out.address).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Boise",
      addressRegion: "ID",
    });
  });

  it("falls back to whole string as addressLocality when it's un-splittable", () => {
    const out = toLocalBusinessJsonLd(mkBiz({ location: "Downtown" }));
    expect(out.address).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Downtown",
    });
  });

  it("omits address entirely when location is null", () => {
    const out = toLocalBusinessJsonLd(mkBiz({ location: null as unknown as string }));
    expect(out.address).toBeUndefined();
  });

  it("maps pricing_tier to Google's $ / $$ / $$$ convention", () => {
    expect(toLocalBusinessJsonLd(mkBiz({ pricing_tier: "budget"    })).priceRange).toBe("$");
    expect(toLocalBusinessJsonLd(mkBiz({ pricing_tier: "mid-range" })).priceRange).toBe("$$");
    expect(toLocalBusinessJsonLd(mkBiz({ pricing_tier: "premium"   })).priceRange).toBe("$$$");
    expect(toLocalBusinessJsonLd(mkBiz({ pricing_tier: "luxury"    })).priceRange).toBe("$$$$");
    expect(toLocalBusinessJsonLd(mkBiz({ pricing_tier: null })).priceRange).toBeUndefined();
  });

  it("picks the first-populated rating source for aggregateRating", () => {
    const out = toLocalBusinessJsonLd(mkBiz({
      ratings_json: JSON.stringify({
        yelp:   { rating: 4.6, count: 50 },
        google: { rating: 4.9, count: 312 },
      }),
    }));
    expect(out.aggregateRating).toEqual({
      "@type":     "AggregateRating",
      ratingValue: 4.9,
      reviewCount: 312,
      bestRating:  5,
      worstRating: 0,
    });
  });

  it("falls back to star_rating + review_count when ratings_json is missing", () => {
    const out = toLocalBusinessJsonLd(mkBiz({
      star_rating: 4.7, review_count: 88, ratings_json: null,
    }));
    expect(out.aggregateRating?.ratingValue).toBe(4.7);
    expect(out.aggregateRating?.reviewCount).toBe(88);
  });

  it("omits aggregateRating when no rating data exists", () => {
    const out = toLocalBusinessJsonLd(mkBiz({
      star_rating: null, review_count: null, ratings_json: null,
    }));
    expect(out.aggregateRating).toBeUndefined();
  });

  it("survives malformed ratings_json without throwing and falls back to flat fields", () => {
    const out = toLocalBusinessJsonLd(mkBiz({
      ratings_json: "{not-json",
      star_rating: 4.5, review_count: 10,
    }));
    expect(out.aggregateRating?.ratingValue).toBe(4.5);
  });

  it("uses the website as @id when no canonicalUrl override is given", () => {
    const out = toLocalBusinessJsonLd(mkBiz());
    expect(out["@id"]).toBe("https://acme.example");
  });

  it("respects an explicit canonicalUrl override", () => {
    const out = toLocalBusinessJsonLd(mkBiz(), {
      canonicalUrl: "https://api.advocatemcp.com/agents/acme",
    });
    expect(out["@id"]).toBe("https://api.advocatemcp.com/agents/acme");
  });
});

describe("wrapAsScriptTag", () => {
  it("emits a valid <script type=application/ld+json> block", () => {
    const wrapped = wrapAsScriptTag({ "@context": "https://schema.org", name: "X" });
    expect(wrapped.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(wrapped.endsWith("</script>")).toBe(true);
    // The inner JSON is parseable.
    const inner = wrapped
      .replace(/^<script type="application\/ld\+json">\n/, "")
      .replace(/\n<\/script>$/, "");
    expect(JSON.parse(inner)).toEqual({ "@context": "https://schema.org", name: "X" });
  });
});
