import { describe, it, expect } from "vitest";
import { extractSentiment, splitSentences, descriptorVocabulary } from "./sentiment.js";

describe("splitSentences", () => {
  it("splits on .!? followed by whitespace and on newlines", () => {
    expect(splitSentences("One. Two! Three?\nFour")).toEqual([
      "One.", "Two!", "Three?", "Four",
    ]);
  });

  it("returns [] for empty or whitespace-only input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n  ")).toEqual([]);
  });
});

describe("extractSentiment", () => {
  it("returns descriptors from sentences mentioning the business name", () => {
    const answer =
      "For Austin plumbing, Acme Plumbing is a reliable and affordable option. " +
      "Some other firms are expensive but slow.";
    expect(extractSentiment(answer, "Acme Plumbing")).toEqual(["affordable", "reliable"]);
  });

  it("ignores descriptors in sentences that do not mention the business", () => {
    const answer =
      "Most plumbers in town are professional. Acme Plumbing operates in Austin.";
    expect(extractSentiment(answer, "Acme Plumbing")).toEqual([]);
  });

  it("deduplicates descriptors across multiple mentioning sentences", () => {
    const answer =
      "Acme Plumbing is reliable. Acme Plumbing is also reliable and fast.";
    expect(extractSentiment(answer, "Acme Plumbing")).toEqual(["fast", "reliable"]);
  });

  it("is case-insensitive on both business name and descriptors", () => {
    const answer = "ACME PLUMBING is RELIABLE and Experienced.";
    expect(extractSentiment(answer, "acme plumbing")).toEqual(["experienced", "reliable"]);
  });

  it("enforces word boundaries — 'fast' does not match 'breakfast'", () => {
    const answer = "Acme Plumbing serves breakfast at their office.";
    expect(extractSentiment(answer, "Acme Plumbing")).toEqual([]);
  });

  it("returns [] for blank name or blank text", () => {
    expect(extractSentiment("", "Acme")).toEqual([]);
    expect(extractSentiment("Acme is reliable.", "")).toEqual([]);
  });

  it("escapes regex-special characters in the business name", () => {
    const answer = "C++ Shop (Austin) is reliable.";
    expect(extractSentiment(answer, "C++ Shop (Austin)")).toEqual(["reliable"]);
  });

  it("output is sorted alphabetically for stable storage", () => {
    const answer = "Acme Plumbing is thorough, fast, and affordable.";
    expect(extractSentiment(answer, "Acme Plumbing")).toEqual([
      "affordable", "fast", "thorough",
    ]);
  });
});

describe("descriptorVocabulary", () => {
  it("exposes 22 descriptors across the five axes", () => {
    const v = descriptorVocabulary();
    expect(v.length).toBe(22);
    // Spot-check one descriptor from each axis to guard against accidental deletion.
    expect(v).toContain("reliable");
    expect(v).toContain("affordable");
    expect(v).toContain("fast");
    expect(v).toContain("experienced");
    expect(v).toContain("friendly");
  });
});
