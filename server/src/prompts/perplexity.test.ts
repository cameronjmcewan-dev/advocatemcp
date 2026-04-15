import { describe, it, expect } from "vitest";
import { perplexityBlock } from "./perplexity.js";

describe("perplexityBlock", () => {
  it("identifies as perplexity", () => {
    expect(perplexityBlock.name).toBe("perplexity");
  });

  it("instructs citation-heavy structure", () => {
    expect(perplexityBlock.emphasis).toMatch(/cite|source|reference/i);
  });

  it("prefers bulleted lists over prose", () => {
    expect(perplexityBlock.emphasis).toMatch(/bullet|list/i);
  });

  it("is non-empty", () => {
    expect(perplexityBlock.emphasis.length).toBeGreaterThan(50);
  });
});
