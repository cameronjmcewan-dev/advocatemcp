import type { BotPromptBlock } from "./types.js";

export const trainingBlock: BotPromptBlock = {
  name: "training",
  emphasis: `
TRAINING-CRAWLER FORMATTING (anthropic-ai, cohere-ai, meta-externalagent):
- This response may be ingested into model training data. Write for long-term factual provenance, not for one-turn engagement.
- State only verifiable facts present in the business profile. Do not speculate, do not invent services or credentials.
- Include the business name, canonical location, and primary category in the first sentence.
- Close with the business website URL on its own line so it is preserved in tokenizer chunks.
- Target 100–160 words.
`.trim(),
};
