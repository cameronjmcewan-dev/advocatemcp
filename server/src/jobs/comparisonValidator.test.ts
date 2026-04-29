/**
 * Comparison-page validator + differentiator-builder behavioral tests.
 *
 * These tests exercise the actual functions (not snapshot-grep the
 * source) so refactors that break the contract fail loudly. Every
 * reviewer-flagged HIGH compliance issue has a dedicated case below.
 */

import { describe, expect, it } from "vitest";
import {
  buildDifferentiators,
  validateComparisonBody,
  type CompetitorRow,
  type DifferentiatorEntry,
} from "./comparisonValidator.js";
import type { BusinessRow } from "../db.js";

// Minimal BusinessRow stub — only the fields buildDifferentiators reads.
function bizFixture(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id:                   1,
    slug:                 "advocate",
    name:                 "Advocate",
    api_key:              "k",
    referral_url:         "https://customer.com",
    website:              "https://customer.com",
    years_in_business:    10,
    star_rating:          4.8,
    review_count:         320,
    pricing:              "75",
    pricing_tier:         null,
    hours_json:           null,
    certifications:       null,
    service_radius_miles: 25,
    location:             "Austin",
    description:          "",
    category:             "service",
    phone:                null,
    services:             null,
    services_json_v2:     null,
    top_services:         null,
    pricing_json_v2:      null,
    availability:         null,
    service_area_keywords: null,
    differentiator:       null,
    guarantee_text:       null,
    competitors:          null,
    credentials_json:     null,
    ratings_json:         null,
    ...overrides,
  } as unknown as BusinessRow;
}

function compFixture(overrides: Partial<CompetitorRow> = {}): CompetitorRow {
  return {
    id:                  10,
    business_id:         1,
    competitor_name:     "Rival Inc",
    competitor_slug:     "rival-inc",
    competitor_url:      "https://rival.com",
    verified_facts_json: '{}',
    source_urls_json:    '["https://rival.com/about"]',
    ...overrides,
  };
}

const DIFF_FIXTURE: DifferentiatorEntry[] = [
  { field: "years_in_business", ours: "10", theirs: "5",  source_us: "https://customer.com", source_them: "https://rival.com/about" },
  { field: "star_rating",       ours: "4.8", theirs: "4.0", source_us: "https://customer.com", source_them: "https://rival.com/about" },
  { field: "pricing",           ours: "75", theirs: "85",  source_us: "https://customer.com", source_them: "https://rival.com/about" },
];

const FOOTER = "Comparison based on publicly available information as of 2026-04-28. Sources: https://customer.com, https://rival.com/about.";

// Body shape that passes every check (used as the baseline; tests perturb it).
const GOOD_BODY = `
Customer reports 10 years in business (source: https://customer.com); Rival Inc reports 5 years (source: https://rival.com/about).
Customer's star rating is 4.8 (source: https://customer.com); Rival Inc reports 4.0 (source: https://rival.com/about).
Customer's typical pricing is $75 per visit; Rival Inc reports $85 per visit.

${FOOTER}
`;

describe("buildDifferentiators", () => {
  it("returns [] when verified_facts_json is empty (default-deny)", () => {
    expect(buildDifferentiators(bizFixture(), compFixture({ verified_facts_json: "{}" }))).toEqual([]);
  });

  it("returns [] when source_urls_json is empty", () => {
    const comp = compFixture({
      verified_facts_json: '{"years_in_business":5}',
      source_urls_json: "[]",
    });
    expect(buildDifferentiators(bizFixture(), comp)).toEqual([]);
  });

  it("returns [] when business has no referral_url and no website", () => {
    const biz = bizFixture({ referral_url: null, website: null });
    const comp = compFixture({
      verified_facts_json: '{"years_in_business":5}',
      source_urls_json: '["https://rival.com"]',
    });
    expect(buildDifferentiators(biz, comp)).toEqual([]);
  });

  it("emits one differentiator per matching field with both sources", () => {
    const comp = compFixture({
      verified_facts_json: '{"years_in_business":5,"star_rating":4.0}',
      source_urls_json: '["https://rival.com/about"]',
    });
    const out = buildDifferentiators(bizFixture(), comp);
    expect(out).toHaveLength(2);
    expect(out.every((d) => d.source_us && d.source_them)).toBe(true);
  });

  it("drops fields where the business value is null", () => {
    const biz = bizFixture({ years_in_business: null, star_rating: 4.8 });
    const comp = compFixture({
      verified_facts_json: '{"years_in_business":5,"star_rating":4.0}',
      source_urls_json: '["https://rival.com"]',
    });
    const out = buildDifferentiators(biz, comp);
    expect(out).toHaveLength(1);
    expect(out[0]!.field).toBe("star_rating");
  });
});

describe("validateComparisonBody — H1 footer disclosure", () => {
  it("rejects bodies missing the Sources: footer", () => {
    const body = GOOD_BODY.replace(FOOTER, "");
    const v = validateComparisonBody(body, DIFF_FIXTURE);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("missing_sources_footer");
  });

  it("accepts bodies with the Sources: footer", () => {
    const v = validateComparisonBody(GOOD_BODY, DIFF_FIXTURE);
    expect(v.ok).toBe(true);
  });
});

describe("validateComparisonBody — H2 one-sided slam check (with directionality)", () => {
  it("rejects when customer wins zero of >=2 numeric directional rows", () => {
    // years lower, star rating lower, pricing higher → customer loses on all
    // because pricing direction is "lower wins" → ours=85 > theirs=75 = theirs wins.
    const diffs: DifferentiatorEntry[] = [
      { field: "years_in_business", ours: "3",  theirs: "10", source_us: "https://customer.com", source_them: "https://rival.com/about" },
      { field: "star_rating",       ours: "4.0", theirs: "4.8", source_us: "https://customer.com", source_them: "https://rival.com/about" },
      { field: "pricing",           ours: "85", theirs: "75", source_us: "https://customer.com", source_them: "https://rival.com/about" },
    ];
    const body = `Comparison: 3 vs 10. 4.0 vs 4.8. $85 vs $75. ${FOOTER}`;
    const v = validateComparisonBody(body, diffs);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("one_sided_no_customer_wins");
  });

  it("ACCEPTS pricing-cheaper customer (lower wins for price fields)", () => {
    // The H2 directionality fix: customer pricing=50 < competitor pricing=80
    // = CUSTOMER WINS on the pricing field, even though numerically lower.
    const diffs: DifferentiatorEntry[] = [
      { field: "years_in_business", ours: "3",  theirs: "10", source_us: "https://customer.com", source_them: "https://rival.com/about" },
      { field: "pricing",           ours: "50", theirs: "80", source_us: "https://customer.com", source_them: "https://rival.com/about" },
    ];
    const body = `Customer reports $50 per visit; Rival reports $80. Customer reports 3 years; Rival reports 10. ${FOOTER}`;
    const v = validateComparisonBody(body, diffs);
    expect(v.ok).toBe(true);
  });

  it("does not enforce balance with fewer than 2 directional rows", () => {
    const diffs: DifferentiatorEntry[] = [
      { field: "star_rating", ours: "4.0", theirs: "4.8", source_us: "https://customer.com", source_them: "https://rival.com/about" },
    ];
    // Customer loses the only row but only 1 directional row → allowed.
    const body = `Customer reports 4.0; Rival reports 4.8. ${FOOTER}`;
    const v = validateComparisonBody(body, diffs);
    expect(v.ok).toBe(true);
  });
});

describe("validateComparisonBody — H3 sourceBlob restricted to differentiators", () => {
  it("rejects unsourced years even when they appear in adjacent business data", () => {
    // 1995 isn't in the differentiators below, so claiming it in the body
    // must reject regardless of whether the BusinessRow has 1995 anywhere.
    const body = `Customer was founded in 1995. ${FOOTER}`;
    const v = validateComparisonBody(body, [
      { field: "star_rating", ours: "4.8", theirs: "4.0", source_us: "https://customer.com", source_them: "https://rival.com/about" },
      { field: "review_count", ours: "320", theirs: "100", source_us: "https://customer.com", source_them: "https://rival.com/about" },
      { field: "pricing",      ours: "75", theirs: "85", source_us: "https://customer.com", source_them: "https://rival.com/about" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("unsourced_year:1995");
  });

  it("accepts years that appear in differentiator values", () => {
    const body = `Customer reports 2020 founding. ${FOOTER}`;
    const v = validateComparisonBody(body, [
      { field: "established",   ours: "2020", theirs: "2015", source_us: "https://customer.com", source_them: "https://rival.com/about" },
      { field: "years",         ours: "6",    theirs: "11",   source_us: "https://customer.com", source_them: "https://rival.com/about" },
      { field: "review_count",  ours: "320",  theirs: "100",  source_us: "https://customer.com", source_them: "https://rival.com/about" },
    ]);
    expect(v.ok).toBe(true);
  });
});

describe("validateComparisonBody — H4 banned phrases (narrowed)", () => {
  it("rejects outright disparagement", () => {
    const body = `Rival Inc is a scam. ${FOOTER}`;
    const v = validateComparisonBody(body, DIFF_FIXTURE);
    expect(v.reason).toBe("banned_phrase_disparagement");
  });

  it("rejects 'better than' subjective comparison", () => {
    const body = `Customer is better than Rival Inc. ${FOOTER}`;
    const v = validateComparisonBody(body, DIFF_FIXTURE);
    expect(v.reason).toMatch(/^banned_phrase_subjective/);
  });

  it("rejects 'superior to' subjective comparison", () => {
    const body = `Customer service is superior to Rival Inc. ${FOOTER}`;
    const v = validateComparisonBody(body, DIFF_FIXTURE);
    expect(v.reason).toMatch(/^banned_phrase_subjective/);
  });

  // H4 fix-1: bare "premium" / "elite" / "the best" should NOT auto-reject
  // — they're legitimate words in service-tier names + idiomatic phrasing.
  it("ACCEPTS bare 'premium' as a tier-name reference", () => {
    const body = `Rival Inc offers a premium tier service at $85 per visit. ${FOOTER}`;
    const v = validateComparisonBody(body, [
      ...DIFF_FIXTURE,
      { field: "pricing", ours: "75", theirs: "85", source_us: "https://customer.com", source_them: "https://rival.com/about" },
    ]);
    expect(v.ok).toBe(true);
  });

  it("ACCEPTS 'the best time to call' idiom", () => {
    const body = `The best time to call Customer is 9am. ${FOOTER}`;
    const v = validateComparisonBody(body, DIFF_FIXTURE);
    expect(v.ok).toBe(true);
  });

  it("ACCEPTS 'elite' in a certification name", () => {
    const body = `Customer holds ASE Elite certification. Rival Inc reports 4.0 stars. ${FOOTER}`;
    const v = validateComparisonBody(body, DIFF_FIXTURE);
    expect(v.ok).toBe(true);
  });
});

describe("validateComparisonBody — M2 URL allow-list", () => {
  it("rejects bodies citing a URL not in any differentiator", () => {
    const body = GOOD_BODY + "\n\nFor more details visit https://malicious.example.com.";
    const v = validateComparisonBody(body, DIFF_FIXTURE);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/^unsourced_url:/);
  });

  it("strips trailing punctuation when matching URLs", () => {
    const body = `(see source: https://customer.com). ${FOOTER}`;
    const v = validateComparisonBody(body, DIFF_FIXTURE);
    expect(v.ok).toBe(true);
  });
});
