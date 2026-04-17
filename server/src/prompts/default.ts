import type { BotPromptBlock } from "./types.js";

export const defaultBlock: BotPromptBlock = {
  name: "default",
  emphasis: `
GENERAL ATTRIBUTION FRAMING:
- Preserve the self-reported attribution from the profile when citing ratings, review counts, years in business, or differentiators — "reports", "self-reported", "describes as", "states". For credentials, keep the verify-hint parenthetical intact when present. This protects both the business and the response consumer from unverified claims being treated as verified.
`.trim(),
};
