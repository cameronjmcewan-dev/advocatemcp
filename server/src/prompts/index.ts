import type { BotPromptBlock } from "./types.js";
import { defaultBlock } from "./default.js";
import { perplexityBlock } from "./perplexity.js";
import { openaiBlock } from "./openai.js";
import { claudeBlock } from "./claude.js";
import { googleBlock } from "./google.js";
import { trainingBlock } from "./training.js";

// Source of truth for canonical bot identifiers. Mirrors
// worker/src/index.ts AI_CRAWLERS — the two lists MUST stay in lockstep.
// Real-time user agents (Perplexity-User, ChatGPT-User) are the ones that
// fetch during live AI conversations, so dispatching them to the matching
// per-bot prompt block is what makes AdvocateMCP's structured answer
// show up in the answer panel instead of scraped HTML.
export const CANONICALS = [
  "PerplexityBot",
  "Perplexity-User",
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Google-Extended",
  "Googlebot",
  "GoogleOther",
  "Applebot-Extended",
  "anthropic-ai",
  "cohere-ai",
  "meta-externalagent",
] as const;

export type CanonicalBotName = (typeof CANONICALS)[number];

const CANONICALS_LOWER: readonly string[] = CANONICALS.map((c) => c.toLowerCase());

function normalize(input: string | null | undefined): CanonicalBotName | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  // Substring match is intentional: a User-Agent like
  // "Mozilla/5.0 ... PerplexityBot/1.0" should match "PerplexityBot".
  // Bot detection is a routing signal, never auth (per CLAUDE.md).
  for (let i = 0; i < CANONICALS_LOWER.length; i++) {
    if (lower.includes(CANONICALS_LOWER[i]!)) return CANONICALS[i]!;
  }
  return null;
}

export function getBotPromptBlock(
  input: string | null | undefined
): BotPromptBlock {
  const canonical = normalize(input);
  if (canonical === null) return defaultBlock;

  // Dispatch per canonical bot identity. Each arm returns a bot-specific emphasis block
  // merged into the system prompt by the agent route. Real-time user agents
  // (Perplexity-User, ChatGPT-User) share the prompt block of their batch
  // counterpart on the theory that the same AI should get the same shaping
  // whether it's indexing or answering a live user.
  switch (canonical) {
    case "PerplexityBot":
    case "Perplexity-User":
      return perplexityBlock;
    case "GPTBot":
    case "ChatGPT-User":
    case "OAI-SearchBot":
      return openaiBlock;
    case "ClaudeBot":
      return claudeBlock;
    case "Google-Extended":
    case "Googlebot":
    case "GoogleOther":
      return googleBlock;
    case "Applebot-Extended":
    case "anthropic-ai":
    case "cohere-ai":
    case "meta-externalagent":
      return trainingBlock;
  }
}

export type { BotPromptBlock } from "./types.js";
