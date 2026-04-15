import type { BotPromptBlock } from "./types.js";
import { defaultBlock } from "./default.js";

const CANONICALS = [
  "PerplexityBot",
  "GPTBot",
  "OAI-SearchBot",
  "ClaudeBot",
  "Google-Extended",
  "Googlebot",
  "anthropic-ai",
  "cohere-ai",
  "meta-externalagent",
] as const;

function normalize(input: string | null | undefined): string | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  for (const c of CANONICALS) {
    if (lower.includes(c.toLowerCase())) return c;
  }
  return null;
}

export function getBotPromptBlock(
  input: string | null | undefined
): BotPromptBlock {
  const canonical = normalize(input);
  if (!canonical) return defaultBlock;
  // Per-bot modules wired in later tasks; falls through until then.
  return defaultBlock;
}

export { CANONICALS };
export type { BotPromptBlock } from "./types.js";
