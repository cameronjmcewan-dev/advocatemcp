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

  it("matches canonical name at the end of a UA string", () => {
    const b = getBotPromptBlock("bot-version=/something PerplexityBot");
    expect(b.name).toBe("default"); // Task 1: every match returns default
  });

  it("picks the first canonical that appears when multiple match", () => {
    // CANONICALS order is: PerplexityBot, GPTBot, OAI-SearchBot, ...
    // A string with both PerplexityBot and GPTBot should resolve to PerplexityBot.
    const b = getBotPromptBlock("PerplexityBot GPTBot");
    expect(b.name).toBe("default"); // Task 1: both canonicals return default; dispatch precedence asserted in Task 2+
  });

  it("handles very long UA strings without catastrophic slowdown", () => {
    const longUa = "x".repeat(8192) + " PerplexityBot";
    const start = performance.now();
    const b = getBotPromptBlock(longUa);
    const elapsed = performance.now() - start;
    expect(b.name).toBe("default");
    expect(elapsed).toBeLessThan(50); // indexOf-based includes() is linear, not regex
  });
});
