/* Per-bot HTML renderer dispatcher — picks the right format variant for
 * an incoming bot's user-agent and renders the agent answer wrapped
 * in HTML+JSON-LD instead of JSON.
 *
 * The renderer code itself lives in
 * server/src/experiments/formatJudge/formats/ — promoted from the
 * measurement harness to production. Iteration 7 of the LLM-as-judge
 * harness validated all four per-bot HTML variants at 8/10 with 100%
 * cite rate, vs the JSON envelope (current production) at 4/10 with
 * 0% cite rate. Each variant was tuned through 8 distinct bug fixes
 * surfaced by judge feedback.
 *
 * Mapping from canonical bot name (set by the worker's bot detection
 * layer in worker/src/lib/bot-detection.ts) to the matching renderer.
 * Unknown bots fall through to the default renderer (currently
 * perplexity_html — the "tied for best" v0 default with broad bullet
 * + JSON-LD coverage).
 *
 * Adding a new bot:
 *   1. Edit BOT_RENDERER_MAP below.
 *   2. Add a new format file under
 *      server/src/experiments/formatJudge/formats/ if the existing
 *      formats don't match the bot's preferences.
 *   3. Run the format-judge experiment for that bot to validate the
 *      pick before shipping.
 */

import {
  perplexityHtml,
  openaiHtml,
  claudeHtml,
  googleHtml,
} from "../../experiments/formatJudge/formats/index.js";
import type { FormatVariant } from "../../experiments/formatJudge/types.js";
import type { BusinessRow } from "../../db.js";
import type { AgentQueryResult } from "../query.js";

/* Canonical bot names emitted by worker/src/lib/bot-detection.ts. Matches
 * the prompt-tuning logic in server/src/prompts/index.ts so prose and
 * HTML stay in lockstep when we tune by bot. */
const BOT_RENDERER_MAP: Record<string, FormatVariant> = {
  // Perplexity family
  PerplexityBot: perplexityHtml,
  Perplexity:    perplexityHtml,

  // OpenAI family
  GPTBot:         openaiHtml,
  "OAI-SearchBot": openaiHtml,
  ChatGPT:         openaiHtml,
  "OAI-User":      openaiHtml,

  // Anthropic family
  ClaudeBot:    claudeHtml,
  "anthropic-ai": claudeHtml,
  Claude:        claudeHtml,

  // Google family
  Googlebot:        googleHtml,
  "Google-Extended": googleHtml,
  Google:           googleHtml,
};

/* Default renderer when bot is unknown or null. Perplexity-style is
 * the broadest superset — bullets + bold + ProfessionalService + FAQPage
 * + Reviews — and ranked tied-for-best in iter7. */
const DEFAULT_RENDERER: FormatVariant = perplexityHtml;

export function pickRenderer(botType: string | null | undefined): FormatVariant {
  if (!botType) return DEFAULT_RENDERER;
  return BOT_RENDERER_MAP[botType] ?? DEFAULT_RENDERER;
}

/* Render the agent's answer for a bot. Inputs come from the
 * agent endpoint after queryAgent() returns:
 *   - business: the BusinessRow (loaded for queryAgent)
 *   - result:   the AgentQueryResult (response, referral_url, etc.)
 *   - query:    the question that prompted the answer
 *   - botType:  canonical bot name (Perplexity / GPTBot / ClaudeBot / ...)
 *
 * Returns a single string: the HTML page the bot should receive in
 * place of a JSON envelope. */
export function renderForBot(args: {
  business:  BusinessRow;
  result:    AgentQueryResult;
  query:     string;
  botType?:  string | null;
}): { html: string; renderer_id: string } {
  const renderer = pickRenderer(args.botType);
  const html = renderer.render({
    business:    args.business,
    answerText:  args.result.response,
    query:       args.query,
    referralUrl: args.result.referral_url ?? args.business.website ?? "",
  });
  return { html, renderer_id: renderer.id };
}
