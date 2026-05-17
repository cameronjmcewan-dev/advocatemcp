/**
 * Behavioral tests for buildBusinessJsonLd — locks down two fixes:
 *
 * fix-1 — Phase 4 mentions/sameAs graph splices into the Organization
 *         JSON-LD when opts.mentionsGraph is provided. Renderers that
 *         pass it get the graph; renderers that don't are unchanged.
 *
 * fix-2 — aggregateRating is OMITTED when star_rating is set but
 *         review_count is null/0. Schema.org AggregateRating MUST be
 *         backed by real review data; emitting it with reviewCount=1
 *         (the previous fallback) was misleading + Google may flag it.
 */

import { describe, it, expect } from "vitest";
import { buildBusinessJsonLd } from "./shared.js";
import type { BusinessRow } from "../../../db.js";

function bizFixture(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id:                  1,
    slug:                "advocate",
    name:                "Advocate",
    api_key:             "k",
    description:         "AI search visibility platform",
    category:            "ai-marketing-saas",
    location:            "Austin, TX",
    website:             "https://advocatemcp.com",
    referral_url:        "https://advocatemcp.com",
    phone:               null,
    services:            null,
    services_json_v2:    null,
    top_services:        null,
    pricing:             null,
    pricing_tier:        null,
    pricing_json_v2:     null,
    hours_json:          null,
    availability:        null,
    service_area_keywords: null,
    service_radius_miles: null,
    differentiator:      null,
    guarantee_text:      null,
    star_rating:         null,
    review_count:        null,
    years_in_business:   null,
    certifications:      null,
    competitors:         null,
    credentials_json:    null,
    ratings_json:        null,
    ...overrides,
  } as unknown as BusinessRow;
}

describe("buildBusinessJsonLd — aggregateRating gate (fix-2)", () => {
  it("emits aggregateRating when star_rating + review_count meet the sample threshold", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ star_rating: 4.8, review_count: 23 }),
      { type: "ProfessionalService", includeRating: true },
    );
    expect(ld.aggregateRating).toBeDefined();
    expect((ld.aggregateRating as { ratingValue: number }).ratingValue).toBe(4.8);
    expect((ld.aggregateRating as { reviewCount: number }).reviewCount).toBe(23);
  });

  it("OMITS aggregateRating when star_rating is set but review_count is null", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ star_rating: 4.8, review_count: null }),
      { type: "ProfessionalService", includeRating: true },
    );
    expect(ld.aggregateRating).toBeUndefined();
  });

  it("OMITS aggregateRating when review_count is 0", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ star_rating: 4.8, review_count: 0 }),
      { type: "ProfessionalService", includeRating: true },
    );
    expect(ld.aggregateRating).toBeUndefined();
  });

  it("OMITS aggregateRating when star_rating is null", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ star_rating: null, review_count: 50 }),
      { type: "ProfessionalService", includeRating: true },
    );
    expect(ld.aggregateRating).toBeUndefined();
  });

  it("OMITS aggregateRating when review_count is 1 (thin-trust threshold)", () => {
    // A `5.0 stars (1 review)` aggregate is the canonical thin-trust red
    // flag. AI assistants weight these downward and Google's Rich Results
    // guidelines have at times required a higher minimum to surface the
    // rating snippet at all. Holding fire here protects every tenant
    // from emitting a self-discrediting field — the rating reappears
    // automatically once they accumulate a meaningful sample.
    const ld = buildBusinessJsonLd(
      bizFixture({ star_rating: 5.0, review_count: 1 }),
      { type: "ProfessionalService", includeRating: true },
    );
    expect(ld.aggregateRating).toBeUndefined();
  });

  it("OMITS aggregateRating when review_count is 2 (still below threshold)", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ star_rating: 4.5, review_count: 2 }),
      { type: "ProfessionalService", includeRating: true },
    );
    expect(ld.aggregateRating).toBeUndefined();
  });

  it("emits aggregateRating when review_count is exactly 3 (at threshold boundary)", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ star_rating: 4.7, review_count: 3 }),
      { type: "ProfessionalService", includeRating: true },
    );
    expect(ld.aggregateRating).toBeDefined();
    expect((ld.aggregateRating as { reviewCount: number }).reviewCount).toBe(3);
  });
});

describe("buildBusinessJsonLd — list-separator splitting (fix-3)", () => {
  // The customer-supplied list fields (top_services, service_area_keywords)
  // historically only split on `,` and `;`. Any tenant who typed their
  // services with bullet-style separators (` · `, `•`, `|`) — common in
  // marketing copy — saw their entire list collapse to a single string in
  // knowsAbout / makesOffer / areaServed. Splitting on all four common
  // separators fixes this for every tenant with no per-tenant config.

  it("splits top_services on the · mid-dot separator into knowsAbout entries", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({
        top_services: "AI search interception · Per-bot agent profiles · Attribution loop · Central MCP server",
        category: "ai-marketing-saas",
      }),
      { type: "ProfessionalService", includeKnowsAbout: true },
    );
    const knowsAbout = ld.knowsAbout as string[];
    expect(knowsAbout).toContain("AI search interception");
    expect(knowsAbout).toContain("Per-bot agent profiles");
    expect(knowsAbout).toContain("Attribution loop");
    expect(knowsAbout).toContain("Central MCP server");
    expect(knowsAbout).toContain("ai-marketing-saas");
    // Sanity: 4 services + 1 category = 5 entries, no joined-string survivor.
    expect(knowsAbout.length).toBe(5);
    expect(knowsAbout.every((s) => !s.includes("·"))).toBe(true);
  });

  it("splits top_services on the • bullet separator", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ top_services: "Plumbing • Drain cleaning • Water heaters" }),
      { type: "ProfessionalService", includeKnowsAbout: true },
    );
    expect(ld.knowsAbout).toEqual(expect.arrayContaining(["Plumbing", "Drain cleaning", "Water heaters"]));
  });

  it("splits service_area_keywords on the | pipe separator into areaServed[]", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ service_area_keywords: "Austin|Round Rock|Cedar Park|Pflugerville" }),
      { type: "ProfessionalService" },
    );
    expect(ld.areaServed).toEqual(["Austin", "Round Rock", "Cedar Park", "Pflugerville"]);
  });

  it("still splits on , and ; (backward compatible)", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ top_services: "A, B; C , D ; E" }),
      { type: "ProfessionalService", includeKnowsAbout: true },
    );
    const knowsAbout = ld.knowsAbout as string[];
    expect(knowsAbout).toEqual(expect.arrayContaining(["A", "B", "C", "D", "E"]));
  });

  it("splits top_services into makesOffer entries on bullet separator", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({ top_services: "Plumbing • HVAC • Electrical", category: "trades" }),
      { type: "ProfessionalService", includeServiceArray: true },
    );
    const offers = ld.makesOffer as Array<{ itemOffered: { name: string } }>;
    expect(offers).toHaveLength(3);
    expect(offers[0]!.itemOffered.name).toBe("Plumbing");
    expect(offers[1]!.itemOffered.name).toBe("HVAC");
    expect(offers[2]!.itemOffered.name).toBe("Electrical");
  });
});

describe("buildBusinessJsonLd — mentions/sameAs graph splice (fix-1)", () => {
  const graphFixture = {
    mentions: [
      { "@type": "WebPage", url: "https://advocatemcp.com/best-x-in-y", name: "Best X in Y" },
      { "@type": "WebPage", url: "https://advocatemcp.com/compare/a-vs-b" },
    ],
    sameAs: ["https://customer.com/best-x-in-y"],
  };

  it("appends mentions[] when mentionsGraph is provided", () => {
    const ld = buildBusinessJsonLd(bizFixture(), {
      type: "ProfessionalService",
      mentionsGraph: graphFixture,
    });
    expect(ld.mentions).toEqual(graphFixture.mentions);
  });

  it("merges sameAs[] without duplicating existing entries", () => {
    const ld = buildBusinessJsonLd(
      bizFixture({
        ratings_json: JSON.stringify({
          google: { url: "https://google.com/maps/place/foo", rating: 4.5, count: 10 },
        }),
      }),
      {
        type: "ProfessionalService",
        mentionsGraph: {
          mentions: [],
          sameAs: ["https://customer.com/best-x-in-y", "https://google.com/maps/place/foo"],
        },
      },
    );
    expect(ld.sameAs).toEqual([
      "https://google.com/maps/place/foo",
      "https://customer.com/best-x-in-y",
    ]);
  });

  it("does NOT splice when mentionsGraph is undefined (legacy path)", () => {
    const ld = buildBusinessJsonLd(bizFixture(), { type: "ProfessionalService" });
    expect(ld.mentions).toBeUndefined();
  });

  it("does NOT add empty mentions array", () => {
    const ld = buildBusinessJsonLd(bizFixture(), {
      type: "ProfessionalService",
      mentionsGraph: { mentions: [], sameAs: [] },
    });
    expect(ld.mentions).toBeUndefined();
  });
});
