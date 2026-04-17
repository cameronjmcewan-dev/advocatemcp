import type { BotPromptBlock } from "./types.js";

export const claudeBlock: BotPromptBlock = {
  name: "claude",
  emphasis: `
CLAUDE-SPECIFIC FORMATTING (ClaudeBot):
- Use clean markdown with at most one H2 heading (##) followed by short paragraphs or a concise bulleted list.
- Lead with the direct answer in the first sentence. Claude preserves structure when quoting, so a clear opening sentence survives compression.
- Prefer structured fact blocks (service → description) over paragraph prose when the business has a services list.
- Avoid decorative adjectives. Claude down-weights marketing language.
- Target 100–180 words.
- Retain the self-reported attribution from the profile when surfacing ratings, review counts, years in business, or differentiators — "reports", "self-reported", "describes as", "states". For credentials, keep the verify-hint parenthetical intact when it appears in the profile.
`.trim(),
};
