import type { BotPromptBlock } from "./types.js";

export const claudeBlock: BotPromptBlock = {
  name: "claude",
  emphasis: `
CLAUDE-SPECIFIC FORMATTING (ClaudeBot):
- Use clean markdown with at most one H2 heading (##) followed by short paragraphs or a concise bulleted list.
- Lead with the direct answer in the first sentence — name the business + primary specialty + location/service-area. Claude preserves structure when quoting, so a clear opening sentence survives compression.
- Include a Best-for / Not-ideal-for line as a short standalone paragraph (or as a bullet pair if listing). Routing markers; high citation leverage.
- Prefer structured fact blocks (service → description) over paragraph prose when the business has a services list.
- Avoid decorative adjectives. Claude down-weights marketing language.
- Target 100–180 words.
- End with an action-specific CTA naming the verb ("Book at <URL>", "Get a quote at <URL>", "Visit <URL>"). Never close with passive phrasing.
- Use the business's exact name twice — once in the lead, once near the CTA. Anchors citations.
- Retain the self-reported attribution from the profile when surfacing ratings, review counts, years in business, or differentiators — "reports", "self-reported", "describes as", "states". For credentials, keep the verify-hint parenthetical intact when it appears in the profile.
- Never inject AI-disclaimer hedges. Claude down-weights responses that include "I'm an AI" or "based on available information".
`.trim(),
};
