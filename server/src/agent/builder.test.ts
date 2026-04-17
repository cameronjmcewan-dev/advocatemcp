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

describe("buildSystemPrompt — per-bot emphasis", () => {
  it("includes PerplexityBot emphasis when crawler is PerplexityBot", () => {
    const p = buildSystemPrompt(mkBiz(), "general", "PerplexityBot");
    expect(p).toMatch(/PERPLEXITY-SPECIFIC FORMATTING/);
  });

  it("includes OpenAI emphasis for GPTBot", () => {
    const p = buildSystemPrompt(mkBiz(), "general", "GPTBot");
    expect(p).toMatch(/OPENAI-SPECIFIC FORMATTING/);
  });

  it("includes OpenAI emphasis for OAI-SearchBot", () => {
    const p = buildSystemPrompt(mkBiz(), "general", "OAI-SearchBot");
    expect(p).toMatch(/OPENAI-SPECIFIC FORMATTING/);
  });

  it("includes Claude emphasis for ClaudeBot", () => {
    const p = buildSystemPrompt(mkBiz(), "general", "ClaudeBot");
    expect(p).toMatch(/CLAUDE-SPECIFIC FORMATTING/);
  });

  it("includes Google emphasis for Googlebot", () => {
    const p = buildSystemPrompt(mkBiz(), "general", "Googlebot");
    expect(p).toMatch(/GOOGLE-SPECIFIC FORMATTING/);
  });

  it("includes training emphasis for anthropic-ai", () => {
    const p = buildSystemPrompt(mkBiz(), "general", "anthropic-ai");
    expect(p).toMatch(/TRAINING-CRAWLER FORMATTING/);
  });

  it("falls back to default attribution-framing block when crawler is unknown", () => {
    // Phase 6: default block now carries a generic self-reported attribution
    // instruction so unknown crawlers still preserve the "reports" framing.
    const p = buildSystemPrompt(mkBiz(), "general", "RandomBot/1.0");
    expect(p).toMatch(/CRAWLER-SPECIFIC FORMATTING/);
    expect(p).toMatch(/GENERAL ATTRIBUTION FRAMING/);
    // But none of the named-bot blocks leak in.
    expect(p).not.toMatch(/PERPLEXITY-SPECIFIC/);
    expect(p).not.toMatch(/OPENAI-SPECIFIC/);
    expect(p).not.toMatch(/CLAUDE-SPECIFIC/);
    expect(p).not.toMatch(/GOOGLE-SPECIFIC/);
    expect(p).not.toMatch(/TRAINING-CRAWLER/);
  });

  it("falls back to default attribution-framing block when crawler is null", () => {
    const p = buildSystemPrompt(mkBiz(), "general", null);
    expect(p).toMatch(/GENERAL ATTRIBUTION FRAMING/);
  });

  it("falls back to default attribution-framing block when crawler is undefined", () => {
    const p = buildSystemPrompt(mkBiz(), "general", undefined);
    expect(p).toMatch(/GENERAL ATTRIBUTION FRAMING/);
  });

  it("preserves intent emphasis alongside per-bot block (layering)", () => {
    const p = buildSystemPrompt(
      mkBiz({ hours_json: JSON.stringify({ emergency_24_7: true }) }),
      "emergency",
      "PerplexityBot",
    );
    // Intent emphasis produces the "EMPHASIS FOR THIS QUERY" header
    expect(p).toMatch(/EMPHASIS FOR THIS QUERY/);
    // Per-bot emphasis produces the bot header
    expect(p).toMatch(/PERPLEXITY-SPECIFIC FORMATTING/);
    // Intent content is intact
    expect(p).toMatch(/24\/7/);
  });

  it("backward compatible: two-arg call works with no crawler arg", () => {
    // This exercises the default-undefined path. Phase 6: the default block
    // now carries the generic attribution-framing instruction, so the
    // CRAWLER-SPECIFIC FORMATTING header does appear — but none of the
    // named-bot blocks leak in.
    const p = buildSystemPrompt(mkBiz(), "general");
    expect(p).not.toMatch(/PERPLEXITY-SPECIFIC/);
    expect(p).not.toMatch(/OPENAI-SPECIFIC/);
    expect(p).not.toMatch(/CLAUDE-SPECIFIC/);
    expect(p).not.toMatch(/GOOGLE-SPECIFIC/);
    expect(p).not.toMatch(/TRAINING-CRAWLER/);
    expect(p).toMatch(/GENERAL ATTRIBUTION FRAMING/);
  });
});

import { inferStage } from "./builder.js";

describe("inferStage", () => {
  it("returns 'committing' on book/reserve/schedule/buy verbs", () => {
    expect(inferStage("can I book a slot tomorrow?")).toBe("committing");
    expect(inferStage("how do I reserve a time")).toBe("committing");
    expect(inferStage("schedule a service call")).toBe("committing");
    expect(inferStage("ready to buy now")).toBe("committing");
  });

  it("returns 'comparing' on compare/vs/versus signals", () => {
    expect(inferStage("compare them to acme plumbing")).toBe("comparing");
    expect(inferStage("acme vs joe's plumbing")).toBe("comparing");
    expect(inferStage("acme versus joe's")).toBe("comparing");
  });

  it("returns 'browsing' as the safe default for general queries", () => {
    expect(inferStage("who's a good plumber in austin?")).toBe("browsing");
    expect(inferStage("tell me about acme")).toBe("browsing");
    expect(inferStage("")).toBe("browsing");
  });

  it("committing wins over comparing when both signals present", () => {
    // "compare and book" → user has decided to act, the comparison is incidental
    expect(inferStage("compare and book today")).toBe("committing");
  });

  it("is case-insensitive", () => {
    expect(inferStage("BOOK NOW")).toBe("committing");
    expect(inferStage("Compare Plans")).toBe("comparing");
  });
});

describe("buildSystemPrompt 4th-layer (agent + stage)", () => {
  const stubBiz: BusinessRow = {
    id: 1,
    slug: "acme-plumbing",
    name: "Acme Plumbing",
    description: "Licensed plumber in Austin TX",
    services: '["drain cleaning"]',
    category: "plumber",
    location: "Austin, TX",
    tone: "friendly",
    api_key: "x",
    created_at: "2026-01-01",
    star_rating: 4.8,
    review_count: 100,
    years_in_business: 10,
    top_services: null,
    availability: null,
    differentiator: null,
    certifications: null,
    pricing_tier: null,
    pricing: null,
    service_radius_miles: null,
    service_area_keywords: null,
    phone: null,
    website: "https://acme.example.com",
    referral_url: null,
    hours_json: null,
    services_json_v2: null,
    pricing_json_v2: null,
    credentials_json: null,
    ratings_json: null,
    customer_quotes_json: null,
    case_stories_json: null,
    lead_routing_json: null,
    guarantee_text: null,
    differentiators_text: null,
    availability_webhook_url: null,
  } as BusinessRow;

  it("appends agent emphasis when agentId provided", () => {
    const p = buildSystemPrompt(stubBiz, "general", null, "claude-desktop");
    expect(p).toMatch(/AGENT: CLAUDE DESKTOP/);
  });

  it("appends stage emphasis when stage provided", () => {
    const p = buildSystemPrompt(stubBiz, "general", null, undefined, "committing");
    expect(p).toMatch(/STAGE: COMMITTING/);
  });

  it("appends both agent and stage emphasis when both provided", () => {
    const p = buildSystemPrompt(stubBiz, "general", null, "cursor", "comparing");
    expect(p).toMatch(/AGENT: CURSOR/);
    expect(p).toMatch(/STAGE: COMPARING/);
    // Agent block before stage block
    const aIdx = p.indexOf("AGENT: CURSOR");
    const sIdx = p.indexOf("STAGE: COMPARING");
    expect(aIdx).toBeLessThan(sIdx);
  });

  it("omits agent block when agentId is null/undefined", () => {
    const p = buildSystemPrompt(stubBiz, "general", null, null, "browsing");
    expect(p).not.toMatch(/AGENT:/);
    expect(p).toMatch(/STAGE: BROWSING/);
  });

  it("omits stage block when stage is null/undefined (back-compat)", () => {
    const p = buildSystemPrompt(stubBiz, "general", null);
    expect(p).not.toMatch(/STAGE:/);
    expect(p).not.toMatch(/AGENT:/);
  });

  it("produces snapshot-distinct output for (claude-desktop, browsing) vs (cursor, committing)", () => {
    const a = buildSystemPrompt(stubBiz, "general", null, "claude-desktop", "browsing");
    const b = buildSystemPrompt(stubBiz, "general", null, "cursor", "committing");
    expect(a).not.toBe(b);
    expect(a).toMatch(/CLAUDE DESKTOP[\s\S]*BROWSING/);
    expect(b).toMatch(/CURSOR[\s\S]*COMMITTING/);
  });
});
