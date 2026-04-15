import { describe, it, expect } from "vitest";
import { getBotPromptBlock } from "./index.js";

describe("getBotPromptBlock dispatch", () => {
  it("returns default block for null", () => {
    const b = getBotPromptBlock(null);
    expect(b.name).toBe("default");
    expect(b.emphasis).toBe("");
  });

  it("returns default block for empty string", () => {
    const b = getBotPromptBlock("");
    expect(b.name).toBe("default");
  });

  it("returns default block for unknown bot", () => {
    const b = getBotPromptBlock("RandomCrawler/1.0");
    expect(b.name).toBe("default");
  });

  it("is case-insensitive for canonical names", () => {
    const a = getBotPromptBlock("PerplexityBot");
    const b = getBotPromptBlock("perplexitybot");
    expect(a.name).toBe(b.name);
  });

  it("tolerates a full UA string containing the canonical name", () => {
    const b = getBotPromptBlock("Mozilla/5.0 PerplexityBot/1.0");
    expect(b.name).toBe("default"); // in Task 1, everything returns default
  });
});
