import type { BotPromptBlock } from "./types.js";

export const googleBlock: BotPromptBlock = {
  name: "google",
  emphasis: `
GOOGLE-SPECIFIC FORMATTING (Googlebot, Google-Extended):
- The first sentence must stand alone as a featured-snippet answer: business name + core service + location + one differentiator. Under 160 characters.
- Follow the lead sentence with 3–5 terse bullets of hard facts (hours, phone, service radius, price tier, rating).
- Repeat the business name and city at least twice for entity anchoring.
- Avoid conversational filler. Google excerpts the densest fact-per-word passage.
- Target 90–150 words total.
`.trim(),
};
