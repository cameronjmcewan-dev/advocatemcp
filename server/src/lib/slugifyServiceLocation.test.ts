/**
 * Round-trip + edge-case coverage for the synthetic-page slug helpers.
 * The contract these helpers honor:
 *   - slugifyOne is idempotent
 *   - buildPath × parsePath is a round-trip for all four intents
 *   - parsePath rejects ambiguous catch-all matches (so 'best' can't
 *     accidentally classify as 'specific_service')
 */

import { describe, expect, it } from "vitest";
import { slugifyOne, buildPath, parsePath } from "./slugifyServiceLocation.js";

describe("slugifyOne", () => {
  it("lowercases + hyphenates ascii", () => {
    expect(slugifyOne("Emergency Plumbing")).toBe("emergency-plumbing");
  });

  it("strips diacritics via NFKD", () => {
    expect(slugifyOne("Café Service")).toBe("cafe-service");
  });

  it("collapses runs of non-alphanumerics", () => {
    expect(slugifyOne("water //  heater  -  install")).toBe("water-heater-install");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugifyOne("---foo bar---")).toBe("foo-bar");
  });

  it("is idempotent", () => {
    const once = slugifyOne("Round Rock, TX");
    expect(slugifyOne(once)).toBe(once);
  });
});

describe("buildPath × parsePath round-trip", () => {
  const cases: Array<["best_top" | "affordable" | "emergency" | "specific_service", string, string]> = [
    ["best_top",         "emergency-plumbing", "austin"],
    ["affordable",       "solar-install",      "round-rock"],
    ["emergency",        "water-heater",       "cedar-park"],
    ["specific_service", "tankless-install",   "austin"],
  ];

  it.each(cases)("round-trips intent=%s service=%s location=%s", (intent, service, location) => {
    const path  = buildPath(intent, service, location);
    const back  = parsePath(path);
    expect(back).toEqual({ intent, serviceSlug: service, locationSlug: location });
  });
});

describe("parsePath edge cases", () => {
  it("returns null for unrelated paths", () => {
    expect(parsePath("/about")).toBeNull();
    expect(parsePath("/contact-us")).toBeNull();
    expect(parsePath("/")).toBeNull();
  });

  it("does not double-match best-* via the specific_service catch-all", () => {
    // Long path with multiple '-in-' segments — the ordered matcher must
    // pick best_top first, never specific_service.
    const back = parsePath("/best-emergency-plumbing-in-austin");
    expect(back?.intent).toBe("best_top");
  });

  it("does not double-match affordable-* via the catch-all", () => {
    const back = parsePath("/affordable-roof-repair-in-portland");
    expect(back?.intent).toBe("affordable");
  });

  it("accepts a trailing slash", () => {
    expect(parsePath("/best-x-in-y/")?.intent).toBe("best_top");
  });

  // Reviewer LOW-1 lockdown — multi-token service AND multi-token location
  // must round-trip through the non-greedy regex without the location
  // swallowing service tokens. The first '-in-' wins for the boundary.
  it("round-trips multi-token service AND multi-token location", () => {
    const path = "/best-emergency-plumbing-in-round-rock";
    expect(parsePath(path)).toEqual({
      intent:       "best_top",
      serviceSlug:  "emergency-plumbing",
      locationSlug: "round-rock",
    });
  });

  it("round-trips emergency + multi-token location with -near-", () => {
    const path = "/emergency-water-heater-near-cedar-park";
    expect(parsePath(path)).toEqual({
      intent:       "emergency",
      serviceSlug:  "water-heater",
      locationSlug: "cedar-park",
    });
  });
});
