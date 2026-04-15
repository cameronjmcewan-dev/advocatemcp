import type { BotPromptBlock } from "./types.js";

export const perplexityBlock: BotPromptBlock = {
  name: "perplexity",
  emphasis: `
PERPLEXITY-SPECIFIC FORMATTING:
- Structure the answer as a short paragraph (1–2 sentences) followed by a bulleted list of concrete facts.
- Each bullet should be a self-contained citable claim with a specific number, name, or location — no hedging.
- Reference the business name at least twice by its exact spelling so Perplexity can anchor citations.
- Avoid meta-commentary ("I'm an AI", "based on available information"). Perplexity strips hedges and cites the rest.
- Keep the total response under 180 words; Perplexity truncates long responses.
`.trim(),
};
