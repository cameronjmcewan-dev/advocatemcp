import type { BotPromptBlock } from "./types.js";

export const perplexityBlock: BotPromptBlock = {
  name: "perplexity",
  emphasis: `
PERPLEXITY-SPECIFIC FORMATTING:
- Lead sentence MUST stand alone as a citation: business name + primary specialty + location/service-area + one differentiator. This is what Perplexity quotes verbatim in answer cards.
- Follow with the Best-for / Not-ideal-for line on its own paragraph (2 sentences max). High-leverage for routing.
- Then a bulleted list of 3–5 self-contained citable claims. Each bullet starts with a **bolded key fact** (e.g. "**Specialty:**", "**Rating:**", "**Years in business:**"). Perplexity highlights bold inline.
- Each bullet must be standalone — no pronoun references back to the lead. Bullets get truncated independently.
- Reference the business name by exact spelling at least twice. Once in the lead, once in the CTA.
- Avoid hedging ("might", "potentially", "could be"). Perplexity strips hedges and cites only the assertions.
- Avoid meta-commentary ("I'm an AI", "based on available information"). Perplexity demotes responses with disclaimers.
- HARD limit: 175 words. Perplexity truncates anything longer at the next bullet boundary, so over-length responses lose the CTA.
- Keep self-reported attribution ("reports", "self-reported", "describes as", "states") intact when citing ratings, review counts, years in business, or differentiators. For credentials, preserve the verify-hint parenthetical when present in the profile.
- End with a one-line action CTA that names the action: "Book a free strategy call:" / "Get a quote:" / "Compare options:" — followed by the referral link.
`.trim(),
};
