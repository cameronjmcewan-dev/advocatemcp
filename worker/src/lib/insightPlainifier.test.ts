/**
 * Tests for the AI Insight plainifier. Each curated mapping in
 * insightPlainifier.ts gets a deterministic input → expected-output
 * assertion. If Claude introduces new jargon and we add a mapping,
 * we add a matching test here.
 */

import { describe, it, expect } from "vitest";
import { plainifyRecommendation, plainifyRecommendationsPayload } from "./insightPlainifier.js";

describe("plainifyRecommendation — derived-field redirects", () => {
  it("rewrites related_field 'foundingDate' to 'years_in_business'", () => {
    const out = plainifyRecommendation({ related_field: "foundingDate", body: "x" });
    expect(out.related_field).toBe("years_in_business");
  });

  it("rewrites related_field 'founding_date' (snake_case variant) to 'years_in_business'", () => {
    const out = plainifyRecommendation({ related_field: "founding_date", body: "x" });
    expect(out.related_field).toBe("years_in_business");
  });

  it("leaves non-derived related_field values unchanged", () => {
    const out = plainifyRecommendation({ related_field: "customer_quotes_json", body: "x" });
    expect(out.related_field).toBe("customer_quotes_json");
  });

  it("ignores related_field when it's not a string", () => {
    const out = plainifyRecommendation({ related_field: 123 as unknown as string, body: "x" });
    expect(out.related_field).toBe(123);
  });
});

describe("plainifyRecommendation — field-name substitutions in title/body", () => {
  it("substitutes 'customer_quotes_json' → 'customer reviews'", () => {
    const out = plainifyRecommendation({
      title: "Populate customer_quotes_json to supply verbatim social proof",
      body:  "Add 3-5 quotes to customer_quotes_json",
    });
    expect(out.title).toContain("customer reviews");
    expect(out.title).not.toContain("customer_quotes_json");
    expect(out.body).toContain("customer reviews");
  });

  it("substitutes 'differentiators_text' → 'what makes you different'", () => {
    const out = plainifyRecommendation({
      title: "Replace hype-flagged differentiators_text with factual claims",
    });
    expect(out.title).toContain("what makes you different");
    expect(out.title).not.toContain("differentiators_text");
  });

  it("substitutes 'ratings_json' → 'star ratings'", () => {
    const out = plainifyRecommendation({
      body: "Add Google reviews to ratings_json (e.g. Capterra, G2, Product Hunt)",
    });
    expect(out.body).toContain("star ratings");
    expect(out.body).not.toContain("ratings_json");
  });

  it("substitutes 'pricing_json_v2' → 'your pricing details'", () => {
    const out = plainifyRecommendation({
      title: "Fill out pricing_json_v2 with concrete tier pricing",
    });
    expect(out.title).toContain("your pricing details");
  });

  it("substitutes 'foundingDate' → 'your founding year' in title text", () => {
    const out = plainifyRecommendation({
      title: "Correct foundingDate mismatch penalizing all four engine scores",
      related_field: "foundingDate",
    });
    expect(out.title).toContain("your founding year");
    expect(out.title).not.toContain("foundingDate");
  });

  it("substitutes 'credentials_json' → 'your licenses and credentials'", () => {
    const out = plainifyRecommendation({
      body: "Populate credentials_json with your bonded license info",
    });
    expect(out.body).toContain("your licenses and credentials");
  });

  it("substitutes 'years_in_business' → 'years in business' (plain casing)", () => {
    const out = plainifyRecommendation({
      body: "Add a years_in_business value above 0",
    });
    expect(out.body).toContain("years in business");
    expect(out.body).not.toContain("years_in_business");
  });
});

describe("plainifyRecommendation — jargon-phrase substitutions", () => {
  it("rewrites 'JSON-LD' to plain English", () => {
    const out = plainifyRecommendation({ body: "Your JSON-LD output is missing fields" });
    expect(out.body).toContain("the structured info AI engines read");
    expect(out.body).not.toContain("JSON-LD");
  });

  it("rewrites 'schema.org' to plain English (case-insensitive)", () => {
    const out = plainifyRecommendation({ body: "Update your schema.org markup" });
    expect(out.body).toContain("the format AI engines understand");
  });

  it("rewrites 'citation score' to 'how often AI search names you'", () => {
    const out = plainifyRecommendation({ body: "Your citation score dropped this week" });
    expect(out.body).toContain("how often AI search names you");
    expect(out.body).not.toContain("citation score");
  });

  it("rewrites 'engine scores' to 'AI visibility scores'", () => {
    const out = plainifyRecommendation({
      title: "Correct mismatch penalizing all four engine scores",
    });
    expect(out.title).toContain("AI visibility scores");
  });

  it("rewrites 'per-engine variants' to plain English", () => {
    const out = plainifyRecommendation({ body: "Review per-engine variants for inconsistencies" });
    expect(out.body).toContain("how each AI tool sees your business");
  });

  it("rewrites 'hype-flagged' to 'flagged as too promotional'", () => {
    const out = plainifyRecommendation({ title: "Replace hype-flagged copy" });
    expect(out.title).toContain("flagged as too promotional");
    expect(out.title).not.toContain("hype-flagged");
  });

  it("rewrites 'low-trust signal' to 'weak credibility signal'", () => {
    // Replacement uses "credibility" (not "trust") so the generic
    // `trust signal` → `credibility signals` rule below doesn't
    // cascade-rewrite this output. Same final user-facing meaning;
    // implementation detail of the cascade.
    const out = plainifyRecommendation({
      title: "Grow Google review count to fix low-trust signal",
    });
    expect(out.title).toContain("weak credibility signal");
    expect(out.title).not.toContain("low-trust signal");
  });

  it("rewrites 'verbatim social proof' to 'real customer quotes'", () => {
    const out = plainifyRecommendation({
      title: "Add verbatim social proof from reviewers",
    });
    expect(out.title).toContain("real customer quotes");
  });

  it("rewrites 'Populate X to ...' action-verb pattern", () => {
    const out = plainifyRecommendation({
      title: "Populate customer reviews to supply trust signals",
    });
    expect(out.title?.toString().startsWith("Add")).toBe(true);
  });

  it("rewrites 'Grow X beyond N to ...' action-verb pattern", () => {
    const out = plainifyRecommendation({
      title: "Grow Google review count beyond 1 to fix weak trust signal",
    });
    expect(out.title).toContain("Get more Google review count");
  });

  it("strips quote-wrapped year literals ('2025' → 2025)", () => {
    const out = plainifyRecommendation({
      body: "Your JSON emits foundingDate '2025' but description says 2026",
    });
    expect(out.body).toContain("2025");
    expect(out.body).not.toMatch(/'2025'/);
    expect(out.body).not.toContain("foundingDate"); // also field-substituted
  });
});

describe("plainifyRecommendation — pass-through behavior", () => {
  it("preserves non-rewritten fields untouched", () => {
    const input = {
      expected_lift: 0.3,
      priority: "high",
      expected_score_delta: 0.4,
      action_url: "/BusinessProfile.html?focus=positioning",
      title: "x",
    };
    const out = plainifyRecommendation(input);
    expect(out.expected_lift).toBe(0.3);
    expect(out.priority).toBe("high");
    expect(out.expected_score_delta).toBe(0.4);
    expect(out.action_url).toBe("/BusinessProfile.html?focus=positioning");
  });

  it("returns input unchanged when not an object", () => {
    expect(plainifyRecommendation(null as unknown as Record<string, unknown>))
      .toBeNull();
  });

  it("returns input unchanged for empty object", () => {
    const out = plainifyRecommendation({});
    expect(out).toEqual({});
  });

  it("does not mutate the input object", () => {
    const input = { title: "Populate customer_quotes_json", related_field: "foundingDate" };
    plainifyRecommendation(input);
    // Original should be unchanged
    expect(input.title).toBe("Populate customer_quotes_json");
    expect(input.related_field).toBe("foundingDate");
  });
});

describe("plainifyRecommendationsPayload — Railway response wrapper", () => {
  it("rewrites each recommendation in the array", () => {
    const payload = {
      recommendations: [
        { title: "Populate customer_quotes_json" },
        { title: "Correct foundingDate mismatch" },
      ],
      other_field: "preserved",
    } as unknown;
    const out = plainifyRecommendationsPayload(payload) as { recommendations: Array<{ title: string }>; other_field: string };
    expect(out.recommendations[0].title).toContain("customer reviews");
    expect(out.recommendations[1].title).toContain("your founding year");
    expect(out.other_field).toBe("preserved");
  });

  it("returns payload unchanged when no `recommendations` array", () => {
    const payload = { error: "plan_required" };
    const out = plainifyRecommendationsPayload(payload);
    expect(out).toEqual(payload);
  });

  it("returns payload unchanged for null / non-object inputs", () => {
    expect(plainifyRecommendationsPayload(null)).toBeNull();
    expect(plainifyRecommendationsPayload("string")).toBe("string");
  });
});
