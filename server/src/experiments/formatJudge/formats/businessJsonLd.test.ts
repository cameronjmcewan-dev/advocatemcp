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
  it("emits aggregateRating when both star_rating + review_count > 0", () => {
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
