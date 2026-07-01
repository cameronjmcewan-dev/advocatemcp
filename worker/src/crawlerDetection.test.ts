/**
 * Tests for isAiCrawler / crawlerName — the AI_CRAWLERS User-Agent matcher.
 *
 * First executable coverage of the matcher (previously pinned only by
 * source-text contract tests). Added with the Claude-User / Claude-SearchBot
 * lockstep restoration: both retrieval agents were observed live (CF AI Crawl
 * Control, May 21 2026 — Claude-SearchBot hits on www.workmancopyco.com)
 * while still being served the human pass-through.
 *
 * EXPECTED_CANONICALS deliberately duplicates the unexported AI_CRAWLERS
 * array: it is the lockstep pin. If an entry is added, removed, or renamed
 * in index.ts without updating this list (and its mirrors in
 * server/src/prompts/index.ts::CANONICALS and the apex-router-worker repo's
 * src/crawlers.ts), this suite fails.
 */

import { describe, it, expect } from "vitest";
import { isAiCrawler, crawlerName } from "./index";

// Anthropic's documented full UA strings (docs.anthropic.com — "Does
// Anthropic crawl data from the web"). Punctuation reproduced exactly:
// the ClaudeBot UA closes its parenthetical at the end; the two retrieval
// agents close it after "Gecko".
const CLAUDE_USER_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com";
const CLAUDE_SEARCHBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com";
const CLAUDEBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

const EXPECTED_CANONICALS = [
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
] as const;

describe("Anthropic retrieval agents", () => {
  // Claude-User / Claude-SearchBot fetch at retrieval time, on behalf of a
  // live question; neither UA contains "ClaudeBot" or "anthropic-ai", so
  // nothing short of their own entries matches them.
  it("classifies Claude-User as a crawler with its own canonical name", () => {
    expect(isAiCrawler(CLAUDE_USER_UA)).toBe(true);
    expect(crawlerName(CLAUDE_USER_UA)).toBe("Claude-User");
  });

  it("classifies Claude-SearchBot as a crawler with its own canonical name", () => {
    expect(isAiCrawler(CLAUDE_SEARCHBOT_UA)).toBe(true);
    expect(crawlerName(CLAUDE_SEARCHBOT_UA)).toBe("Claude-SearchBot");
  });

  it("keeps the documented ClaudeBot UA on the ClaudeBot entry", () => {
    expect(isAiCrawler(CLAUDEBOT_UA)).toBe(true);
    expect(crawlerName(CLAUDEBOT_UA)).toBe("ClaudeBot");
  });
});

describe("human traffic", () => {
  it("does not classify a browser UA", () => {
    expect(isAiCrawler(BROWSER_UA)).toBe(false);
    expect(crawlerName(BROWSER_UA)).toBe(null);
  });

  it("does not classify an empty UA", () => {
    expect(isAiCrawler("")).toBe(false);
    expect(crawlerName("")).toBe(null);
  });
});

describe("every existing entry classifies unchanged", () => {
  for (const bot of EXPECTED_CANONICALS) {
    it(`${bot} resolves to its own canonical name`, () => {
      const ua = `${bot}/1.0 (+https://example.com/bot)`;
      expect(isAiCrawler(ua)).toBe(true);
      expect(crawlerName(ua)).toBe(bot);
      // Matching is case-insensitive but the returned name keeps the
      // canonical casing stored in the list.
      expect(crawlerName(ua.toLowerCase())).toBe(bot);
    });
  }
});
