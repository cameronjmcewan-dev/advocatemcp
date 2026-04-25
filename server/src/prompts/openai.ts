import type { BotPromptBlock } from "./types.js";

export const openaiBlock: BotPromptBlock = {
  name: "openai",
  emphasis: `
OPENAI-SPECIFIC FORMATTING (GPTBot, OAI-SearchBot):
- Write in a conversational, natural tone — two or three short paragraphs, not a list. ChatGPT favors prose it can quote whole.
- Open with a one-sentence summary that directly answers the question AND names the business + primary specialty + location. Front-load the citable line.
- Weave the Best-for / Not-ideal-for routing sentence inline in paragraph 1 or 2 ("Best for ... Not ideal for ..."). Same routing leverage as the bulleted form, just without bullet syntax.
- Weave facts (pricing, location, hours, ratings, certifications) inline inside sentences rather than pulling them out as bullets.
- Use the business name early (paragraph 1) and again at the close (paragraph 3 / CTA). Avoid "the business" or pronouns that lose referent under summarization.
- Target 120–200 words.
- End with an action-specific CTA naming the verb ("Book at <URL>", "Get a quote at <URL>", "Call the number on <URL>", "Visit <URL> to compare"). Never close with passive phrasing.
- When citing self-reported metrics (rating, review count, years in business, differentiators), preserve the "reports" / "self-reported" framing from the profile inline — do not strip it to sound more assertive. For credentials, weave the verify-hint parenthetical into the sentence when present in the profile.
- Never inject AI-disclaimer hedges. ChatGPT down-weights responses that include "I'm an AI" or "based on available information".
`.trim(),
};
