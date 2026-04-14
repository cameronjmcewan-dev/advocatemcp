import { describe, it, expect } from "vitest";
import { generateAutoQueries, phrasingVariants } from "./competitorRadar.js";

describe("generateAutoQueries", () => {
  it("produces 6 queries when category, location, and 3+ services present", () => {
    const qs = generateAutoQueries({
      category: "plumber",
      location: "Boise, ID",
      services: ["drain", "pipe", "heater", "sewer"],
    });
    expect(qs).toEqual([
      "best plumber in Boise, ID",
      "top plumber in Boise",
      "plumber near me in Boise, ID",
      "drain plumber Boise, ID",
      "pipe plumber Boise, ID",
      "heater plumber Boise, ID",
    ]);
  });

  it("omits service-based queries when services is empty", () => {
    const qs = generateAutoQueries({
      category: "plumber",
      location: "Boise, ID",
      services: [],
    });
    expect(qs).toEqual([
      "best plumber in Boise, ID",
      "top plumber in Boise",
      "plumber near me in Boise, ID",
    ]);
  });

  it("returns [] when category or location missing", () => {
    expect(generateAutoQueries({ category: "", location: "Boise", services: [] })).toEqual([]);
    expect(generateAutoQueries({ category: "plumber", location: "", services: [] })).toEqual([]);
  });
});

describe("phrasingVariants", () => {
  it("fans a plain query into 3 variants", () => {
    expect(phrasingVariants("best plumber Boise")).toEqual([
      "best plumber Boise",
      "best plumber Boise reviews",
      "top rated best plumber Boise",
    ]);
  });

  it("skips variant 1 when query already contains 'reviews'", () => {
    expect(phrasingVariants("plumber reviews Boise")).toEqual([
      "plumber reviews Boise",
      "top rated plumber reviews Boise",
    ]);
  });

  it("skips variant 2 when query already contains 'top rated' (case-insensitive)", () => {
    expect(phrasingVariants("Top Rated plumber")).toEqual([
      "Top Rated plumber",
      "Top Rated plumber reviews",
    ]);
  });

  it("returns only the base variant when both affixes already present", () => {
    expect(phrasingVariants("top rated plumber reviews")).toEqual(["top rated plumber reviews"]);
  });
});
