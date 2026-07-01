import { describe, it, expect } from "vitest";
import { CANONICALS, getBotPromptBlock } from "./index.js";

describe("getBotPromptBlock dispatch", () => {
  it("returns default block for null", () => {
    const b = getBotPromptBlock(null);
    expect(b.name).toBe("default");
    // Phase 6: default block now carries a generic self-reported attribution
    // framing instruction rather than being empty.
    expect(b.emphasis).toMatch(/GENERAL ATTRIBUTION FRAMING/);
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

  it("dispatches Perplexity-User to perplexity module (real-time live-query agent)", () => {
    expect(getBotPromptBlock("Perplexity-User").name).toBe("perplexity");
    expect(getBotPromptBlock("Mozilla/5.0 Perplexity-User/1.0").name).toBe("perplexity");
  });

  it("dispatches GPTBot to openai module", () => {
    expect(getBotPromptBlock("GPTBot").name).toBe("openai");
  });
  it("dispatches OAI-SearchBot to openai module", () => {
    expect(getBotPromptBlock("OAI-SearchBot").name).toBe("openai");
  });
  it("dispatches ChatGPT-User to openai module (real-time live-query agent)", () => {
    expect(getBotPromptBlock("ChatGPT-User").name).toBe("openai");
    expect(getBotPromptBlock("Mozilla/5.0 ChatGPT-User/1.0").name).toBe("openai");
  });

  it("dispatches ClaudeBot to claude module", () => {
    expect(getBotPromptBlock("ClaudeBot").name).toBe("claude");
  });
  it("dispatches Claude-User to claude module (real-time live-query agent)", () => {
    expect(getBotPromptBlock("Claude-User").name).toBe("claude");
    expect(
      getBotPromptBlock(
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com"
      ).name
    ).toBe("claude");
  });
  it("dispatches Claude-SearchBot to claude module (search retrieval agent)", () => {
    expect(getBotPromptBlock("Claude-SearchBot").name).toBe("claude");
    expect(
      getBotPromptBlock(
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com"
      ).name
    ).toBe("claude");
  });

  it("dispatches Googlebot to google module", () => {
    expect(getBotPromptBlock("Googlebot").name).toBe("google");
  });
  it("dispatches Google-Extended to google module", () => {
    expect(getBotPromptBlock("Google-Extended").name).toBe("google");
  });
  it("dispatches GoogleOther to google module", () => {
    expect(getBotPromptBlock("GoogleOther").name).toBe("google");
  });

  it("dispatches Applebot-Extended to training module (Apple Intelligence)", () => {
    expect(getBotPromptBlock("Applebot-Extended").name).toBe("training");
  });
  it("dispatches anthropic-ai to training module", () => {
    expect(getBotPromptBlock("anthropic-ai").name).toBe("training");
  });
  it("dispatches cohere-ai to training module", () => {
    expect(getBotPromptBlock("cohere-ai").name).toBe("training");
  });
  it("dispatches meta-externalagent to training module", () => {
    expect(getBotPromptBlock("meta-externalagent").name).toBe("training");
  });

  it("does not collide: ChatGPT-User must NOT resolve via GPTBot substring", () => {
    // "chatgpt-user" does not contain "gptbot" — but guard the behavior.
    const b = getBotPromptBlock("Mozilla/5.0 ChatGPT-User/1.0");
    expect(b.name).toBe("openai");
  });

  it("pins CANONICALS to the lockstep list shared with the worker and apex router", () => {
    // Exact-list characterization: any add/remove/rename here must land in
    // worker/src/index.ts AI_CRAWLERS and the apex-router-worker repo's
    // src/crawlers.ts in the same change.
    expect([...CANONICALS]).toEqual([
      "PerplexityBot",
      "Perplexity-User",
      "GPTBot",
      "ChatGPT-User",
      "OAI-SearchBot",
      "ClaudeBot",
      "Claude-User",
      "Claude-SearchBot",
      "Google-Extended",
      "Googlebot",
      "GoogleOther",
      "Applebot-Extended",
      "anthropic-ai",
      "cohere-ai",
      "meta-externalagent",
    ]);
  });
});
