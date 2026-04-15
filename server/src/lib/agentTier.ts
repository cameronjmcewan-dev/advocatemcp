import type Database from "better-sqlite3";
import { getReputation } from "../repos/agentReputation.js";

export type AgentTier = "unverified" | "known" | "trusted";

/**
 * Per-minute request ceilings by tier. The A2A manifest reads these so the
 * published surface stays in lockstep with what rate-limit middleware enforces.
 *
 * Unverified (100/min) preserves today's PER_IP_LIMIT_PER_MINUTE so back-compat
 * is exact. Known and trusted are uplifts, never restrictions.
 */
export const TIER_LIMITS: Record<AgentTier, number> = {
  unverified: 100,
  known: 250,
  trusted: 1000,
};

/**
 * Resolve an agent's tier from the 7d reputation window.
 *
 * Thresholds:
 *   trusted: requests >= 100 AND quality_score >= 0.5
 *   known:   requests >= 10  AND quality_score >= 0.1
 *   unverified: everything else (including no header, no row, low signal)
 *
 * Both keyed off 7d so a single bad week pulls the agent back down — this
 * makes the loop reactive to changes in agent behavior without needing a
 * separate decay job.
 */
export function resolveAgentTier(
  db: Database.Database,
  agentId: string | undefined | null,
): AgentTier {
  if (!agentId) return "unverified";
  const rep = getReputation(db, agentId, "7d");
  if (!rep) return "unverified";
  if (rep.requests >= 100 && rep.quality_score >= 0.5) return "trusted";
  if (rep.requests >= 10 && rep.quality_score >= 0.1) return "known";
  return "unverified";
}
