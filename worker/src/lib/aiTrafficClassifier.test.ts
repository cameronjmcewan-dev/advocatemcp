import { describe, it, expect } from "vitest";
import { classifyTrafficSource, AI_DOMAINS } from "./aiTrafficClassifier.js";

describe("classifyTrafficSource", () => {
  // --- AI domain matches ---

  it("classifies chat.openai.com as ai", () => {
    expect(classifyTrafficSource("chat.openai.com", "referral")).toBe("ai");
  });

  it("classifies chatgpt.com as ai", () => {
    expect(classifyTrafficSource("chatgpt.com", "referral")).toBe("ai");
  });

  it("classifies perplexity.ai as ai", () => {
    expect(classifyTrafficSource("perplexity.ai", "referral")).toBe("ai");
  });

  it("classifies claude.ai as ai", () => {
    expect(classifyTrafficSource("claude.ai", "referral")).toBe("ai");
  });

  it("classifies gemini.google.com as ai", () => {
    expect(classifyTrafficSource("gemini.google.com", "referral")).toBe("ai");
  });

  it("classifies copilot.microsoft.com as ai", () => {
    expect(classifyTrafficSource("copilot.microsoft.com", "referral")).toBe("ai");
  });

  it("classifies you.com as ai", () => {
    expect(classifyTrafficSource("you.com", "referral")).toBe("ai");
  });

  it("classifies phind.com as ai", () => {
    expect(classifyTrafficSource("phind.com", "referral")).toBe("ai");
  });

  it("classifies kagi.com as ai", () => {
    expect(classifyTrafficSource("kagi.com", "referral")).toBe("ai");
  });

  // --- AI medium matches ---

  it("classifies any source as ai when medium is 'ai'", () => {
    expect(classifyTrafficSource("google", "ai")).toBe("ai");
  });

  it("classifies any source as ai when medium is 'ai_overview'", () => {
    expect(classifyTrafficSource("google", "ai_overview")).toBe("ai");
  });

  it("classifies any source as ai when medium is 'crawler'", () => {
    // Advocate's own utmTag() emits utm_medium=crawler for /track
    // redirects from AI bots — those clicks ARE AI-driven and belong
    // in the AI bucket. Pre-fix, the classifier missed them.
    expect(classifyTrafficSource("ai", "crawler")).toBe("ai");
  });

  it("classifies (direct) source as ai when medium is 'crawler'", () => {
    // Defensive: even if the utm_source got mangled or stripped, the
    // utm_medium=crawler signal alone is enough to bucket as AI.
    expect(classifyTrafficSource("(direct)", "crawler")).toBe("ai");
  });

  it("classifies unknown source as ai when medium is 'ai'", () => {
    expect(classifyTrafficSource("some-random-site.com", "ai")).toBe("ai");
  });

  // --- Case normalization ---

  it("normalizes mixed-case source (Perplexity.AI still matches)", () => {
    expect(classifyTrafficSource("Perplexity.AI", "referral")).toBe("ai");
  });

  it("normalizes mixed-case source (Chat.OpenAI.Com still matches)", () => {
    expect(classifyTrafficSource("Chat.OpenAI.Com", "referral")).toBe("ai");
  });

  it("normalizes mixed-case medium (AI medium still matches)", () => {
    expect(classifyTrafficSource("google", "AI")).toBe("ai");
  });

  // --- Substring matching ---

  it("matches full URL containing chat.openai.com as ai", () => {
    expect(
      classifyTrafficSource("https://chat.openai.com/share/abc", "referral"),
    ).toBe("ai");
  });

  it("matches subdomain containing perplexity.ai as ai", () => {
    expect(classifyTrafficSource("labs.perplexity.ai", "referral")).toBe("ai");
  });

  // --- Human classifications ---

  it("classifies google / organic as human", () => {
    expect(classifyTrafficSource("google", "organic")).toBe("human");
  });

  it("classifies (direct) / (none) as human", () => {
    expect(classifyTrafficSource("(direct)", "(none)")).toBe("human");
  });

  it("classifies bing / cpc as human", () => {
    expect(classifyTrafficSource("bing", "cpc")).toBe("human");
  });

  it("classifies facebook.com / referral as human", () => {
    expect(classifyTrafficSource("facebook.com", "referral")).toBe("human");
  });

  // --- Edge cases ---

  it("classifies empty source and empty medium as human", () => {
    expect(classifyTrafficSource("", "")).toBe("human");
  });

  it("tolerates null source → human", () => {
    expect(classifyTrafficSource(null, "organic")).toBe("human");
  });

  it("tolerates undefined source → human", () => {
    expect(classifyTrafficSource(undefined, "organic")).toBe("human");
  });

  it("tolerates null medium → human (non-AI source)", () => {
    expect(classifyTrafficSource("google", null)).toBe("human");
  });

  it("tolerates undefined medium → human (non-AI source)", () => {
    expect(classifyTrafficSource("google", undefined)).toBe("human");
  });

  it("tolerates both null → human", () => {
    expect(classifyTrafficSource(null, null)).toBe("human");
  });

  it("tolerates both undefined → human", () => {
    expect(classifyTrafficSource(undefined, undefined)).toBe("human");
  });
});

describe("AI_DOMAINS constant", () => {
  const required = [
    "chat.openai.com",
    "chatgpt.com",
    "perplexity.ai",
    "claude.ai",
    "gemini.google.com",
    "copilot.microsoft.com",
    "you.com",
    "phind.com",
    "kagi.com",
  ];

  for (const domain of required) {
    it(`AI_DOMAINS contains "${domain}" exactly`, () => {
      // Strict equality, not substring — substring would let a regression
      // like replacing "chat.openai.com" with "chat.openai.com.evil.com"
      // slip through. The test must pin the exact entries.
      expect((AI_DOMAINS as readonly string[]).includes(domain)).toBe(true);
    });
  }

  it("AI_DOMAINS has at least 9 entries", () => {
    expect(AI_DOMAINS.length).toBeGreaterThanOrEqual(9);
  });
});
