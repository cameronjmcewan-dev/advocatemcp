import type { BotPromptBlock } from "./types.js";

export const openaiBlock: BotPromptBlock = {
  name: "openai",
  emphasis: `
OPENAI-SPECIFIC FORMATTING (GPTBot, OAI-SearchBot):
- Write in a conversational, natural tone — two or three short paragraphs, not a list.
- Weave facts (pricing, location, hours) inline inside sentences rather than pulling them out as bullets.
- Open with a one-sentence summary that directly answers the question. ChatGPT favors responses that can be quoted whole.
- Use the business name early and again at the close. Avoid "the business" or pronouns that lose referent under summarization.
- Target 120–200 words.
`.trim(),
};
