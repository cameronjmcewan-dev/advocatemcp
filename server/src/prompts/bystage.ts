import type { QueryStage, StagePromptBlock } from "./types.js";

const browsing: StagePromptBlock = {
  name: "browsing",
  emphasis: `
STAGE: BROWSING
The agent's user is exploring options — not ready to commit. Optimize for skim:
- Lead with a 1–2 sentence summary they can quote in a list of candidates.
- Surface 3 distinguishing facts (rating, location, primary service, signature credential).
- Do NOT push pricing detail or booking calls-to-action; the user isn't there yet.
`.trim(),
};

const comparing: StagePromptBlock = {
  name: "comparing",
  emphasis: `
STAGE: COMPARING
The agent's user is weighing this business against alternatives. Optimize for differentiation:
- Lead with what makes THIS business different — credentials, niche specialization, guarantee.
- Use specific numbers (years in business, license number, response time) rather than adjectives.
- Mention rating + review count once; do not repeat across the response.
- Keep the referral mention short — they need facts to compare, not a sales pitch.
`.trim(),
};

const committing: StagePromptBlock = {
  name: "committing",
  emphasis: `
STAGE: COMMITTING
The agent's user is ready to act — booking, hiring, scheduling. Optimize for transaction:
- Lead with concrete pricing and availability if present in the profile.
- State the next-step action explicitly: phone, online booking, free estimate.
- Surface trust signals (insured, bonded, licensed) immediately after price.
- The referral link is the destination — make following it obvious.
`.trim(),
};

const blocks: Record<QueryStage, StagePromptBlock> = {
  browsing,
  comparing,
  committing,
};

/**
 * Resolve a stage to its prompt emphasis block.
 *
 * Null/undefined defaults to `browsing` — the safe choice. We never escalate
 * to `committing` (transactional language) without an explicit signal because
 * misclassifying a casual searcher as a buyer is the worse failure mode.
 */
export function getStagePromptBlock(
  stage: QueryStage | null | undefined,
): StagePromptBlock {
  if (!stage) return browsing;
  return blocks[stage];
}
