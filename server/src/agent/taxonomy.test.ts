import { describe, it, expect } from "vitest";
import {
  INDUSTRY_CODES,
  INTENT_V2,
  OUTCOMES,
  classifyIndustry,
  isIndustryCode,
  isIntentV2,
  mergeOutcome,
  computeCostCents,
} from "./taxonomy.js";

describe("frozen enums", () => {
  it("intent v2 vocab includes every category the vision doc calls out", () => {
    for (const required of ["pricing", "hours", "emergency", "comparison", "location", "brand"]) {
      expect(INTENT_V2).toContain(required);
    }
    expect(isIntentV2("pricing")).toBe(true);
    expect(isIntentV2("unknown_intent")).toBe(false);
  });

  it("industry codes end with 'other' as the catchall", () => {
    expect(INDUSTRY_CODES[INDUSTRY_CODES.length - 1]).toBe("other");
    expect(isIndustryCode("other")).toBe(true);
    expect(isIndustryCode("nonsense")).toBe(false);
  });
});

describe("classifyIndustry", () => {
  it("maps free-form categories to frozen codes", () => {
    expect(classifyIndustry("Pediatric Dental Practice")).toBe("healthcare");
    expect(classifyIndustry("Florist")).toBe("events");
    expect(classifyIndustry("Commercial Plumbing")).toBe("home_services");
    expect(classifyIndustry("Land Brokerage")).toBe("real_estate");
    expect(classifyIndustry("Email Marketing Agency")).toBe("professional_svc");
    expect(classifyIndustry("Neighborhood Coffee Shop")).toBe("food_beverage");
  });

  it("lands anything unrecognised in 'other' rather than throwing", () => {
    expect(classifyIndustry("XYZ Corporation")).toBe("other");
    expect(classifyIndustry(null)).toBe("other");
    expect(classifyIndustry(undefined)).toBe("other");
    expect(classifyIndustry("")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(classifyIndustry("RESTAURANT")).toBe("food_beverage");
    expect(classifyIndustry("restaurant")).toBe("food_beverage");
  });
});

describe("mergeOutcome monotonic promotion", () => {
  it("upgrades to a stronger outcome", () => {
    expect(mergeOutcome("none", "click")).toBe("click");
    expect(mergeOutcome("click", "reservation")).toBe("reservation");
    expect(mergeOutcome("reservation", "confirmed")).toBe("confirmed");
    expect(mergeOutcome("confirmed", "handoff")).toBe("handoff");
  });

  it("never downgrades to a weaker outcome", () => {
    expect(mergeOutcome("handoff", "click")).toBe("handoff");
    expect(mergeOutcome("confirmed", "reservation")).toBe("confirmed");
  });

  it("treats 'error' as lateral — doesn't clobber a real outcome", () => {
    expect(mergeOutcome("click", "error")).toBe("click");
    expect(mergeOutcome("none", "error")).toBe("error");
  });

  it("treats null / undefined current as 'none'", () => {
    expect(mergeOutcome(null, "click")).toBe("click");
    expect(mergeOutcome(undefined, "click")).toBe("click");
  });

  it("every OUTCOMES value is recognised by the ranker", () => {
    // Sanity: promoting from none to any real outcome should land on that
    // outcome (except 'error' + 'none' handled above).
    for (const target of OUTCOMES) {
      if (target === "none" || target === "error") continue;
      expect(mergeOutcome("none", target)).toBe(target);
    }
  });
});

describe("computeCostCents", () => {
  it("returns 0 for zero tokens", () => {
    expect(computeCostCents("claude-sonnet-4-6", 0, 0)).toBe(0);
  });

  it("computes sonnet cost to whole-cent precision", () => {
    // 1000 in × $3/Mtok  + 500 out × $15/Mtok = $0.003 + $0.0075 = $0.0105 → 1 cent
    expect(computeCostCents("claude-sonnet-4-6", 1000, 500)).toBe(1);
    // 10000 in + 5000 out = $0.03 + $0.075 = $0.105 → 11 cents (10.5 rounds to 11)
    expect(computeCostCents("claude-sonnet-4-6", 10000, 5000)).toBe(11);
  });

  it("prices haiku materially cheaper than sonnet for the same usage", () => {
    const sonnet = computeCostCents("claude-sonnet-4-6", 5000, 1000);
    const haiku  = computeCostCents("claude-haiku-4-5", 5000, 1000);
    expect(haiku).toBeLessThan(sonnet);
  });

  it("falls back to sonnet pricing on unknown model names", () => {
    const unknown = computeCostCents("claude-imaginary-99", 5000, 1000);
    const sonnet  = computeCostCents("claude-sonnet-4-6", 5000, 1000);
    expect(unknown).toBe(sonnet);
  });
});
