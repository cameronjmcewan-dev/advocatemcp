import type { AgentPromptBlock } from "../types.js";
import { defaultBlock } from "./default.js";
import { claudeDesktopBlock } from "./claudeDesktop.js";
import { cursorBlock } from "./cursor.js";
import { gptAgentBlock } from "./gptAgent.js";

// Source of truth for known agent IDs. Add new entries here AND wire a
// dispatch arm below. Lower-case canonical form.
export const KNOWN_AGENTS = ["claude-desktop", "cursor", "gpt-agent"] as const;

export type KnownAgentId = (typeof KNOWN_AGENTS)[number];

/**
 * Resolve an agent_id to its prompt emphasis block.
 *
 * Returns the default (empty) block for unknown or missing IDs. Lookup is
 * case-insensitive on the canonical ID strings.
 *
 * Trust note: `agent_id` is self-asserted by the caller in v1 (no OAuth
 * client_id verification yet). Safe to use for prompt tuning — worst case
 * is wrong style. NOT safe for reputation or rate-limit weighting; that's
 * Session 11, which keys off verified signals (token-bound outcomes).
 */
export function getAgentPromptBlock(
  agentId: string | null | undefined,
): AgentPromptBlock {
  if (!agentId) return defaultBlock;
  const id = agentId.toLowerCase();
  switch (id) {
    case "claude-desktop":
      return claudeDesktopBlock;
    case "cursor":
      return cursorBlock;
    case "gpt-agent":
      return gptAgentBlock;
    default:
      return defaultBlock;
  }
}

export type { AgentPromptBlock } from "../types.js";
