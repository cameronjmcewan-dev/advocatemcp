/* Format variant registry. Add new variants by importing them here. */

import { controlJson, controlMarkdown } from "./control.js";
import { perplexityHtml } from "./perplexity.js";
import { openaiHtml } from "./openai.js";
import { claudeHtml } from "./claude.js";
import { googleHtml } from "./google.js";
import type { FormatVariant } from "../types.js";

export const ALL_VARIANTS: FormatVariant[] = [
  controlJson,
  controlMarkdown,
  perplexityHtml,
  openaiHtml,
  claudeHtml,
  googleHtml,
];

export {
  controlJson,
  controlMarkdown,
  perplexityHtml,
  openaiHtml,
  claudeHtml,
  googleHtml,
};
