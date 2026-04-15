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
    expect(a.name).toBe("perplexity");
    expect(b.name).toBe("perplexity");
  });

  it("tolerates a full UA string containing the canonical name", () => {
    const b = getBotPromptBlock("Mozilla/5.0 PerplexityBot/1.0");
    expect(b.name).toBe("perplexity");
  });

  it("matches canonical name at the end of a UA string", () => {
    const b = getBotPromptBlock("bot-version=/something PerplexityBot");
    expect(b.name).toBe("perplexity");
  });

  it("picks the first canonical that appears when multiple match", () => {
    // CANONICALS order is: PerplexityBot, GPTBot, OAI-SearchBot, ...
    // A string with both PerplexityBot and GPTBot should resolve to PerplexityBot.
    const b = getBotPromptBlock("PerplexityBot GPTBot");
    expect(b.name).toBe("perplexity");
  });

  it("handles very long UA strings without catastrophic slowdown", () => {
    const longUa = "x".repeat(8192) + " PerplexityBot";
    const start = performance.now();
    const b = getBotPromptBlock(longUa);
    const elapsed = performance.now() - start;
    expect(b.name).toBe("perplexity");
    expect(elapsed).toBeLessThan(50); // indexOf-based includes() is linear, not regex
  });

  it("dispatches PerplexityBot to perplexity module", () => {
    const b = getBotPromptBlock("PerplexityBot");
    expect(b.name).toBe("perplexity");
  });

  it("dispatches a PerplexityBot UA string to perplexity module", () => {
    const b = getBotPromptBlock("Mozilla/5.0 PerplexityBot/1.0");
    expect(b.name).toBe("perplexity");
  });

  it("dispatches GPTBot to openai module", () => {
    expect(getBotPromptBlock("GPTBot").name).toBe("openai");
  });
  it("dispatches OAI-SearchBot to openai module", () => {
    expect(getBotPromptBlock("OAI-SearchBot").name).toBe("openai");
  });

  it("dispatches ClaudeBot to claude module", () => {
    expect(getBotPromptBlock("ClaudeBot").name).toBe("claude");
  });
});
