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
import { buildMentionsGraph } from "../../experiments/formatJudge/formats/shared.js";
import type { FormatVariant } from "../../experiments/formatJudge/types.js";
import type { BusinessRow } from "../../db.js";
import type { AgentQueryResult } from "../query.js";
import { getDb } from "../../db.js";

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

/* Per-business mentions-graph cache. Holds {mentions, sameAs} arrays
 * built from synthetic_pages + comparison_pages rows. These tables grow
 * slowly (daily / monthly cron) so a 60s TTL is plenty.
 *
 * The cache is keyed on business.id; entries expire after CACHE_TTL_MS
 * to ensure a freshly-generated synthetic page shows up in the next
 * crawler render within a minute. Bounded to MAX_ENTRIES so memory
 * doesn't grow unbounded across many tenants — eviction is LRU-on-write
 * (simple Map insertion order semantics).
 */
const MENTIONS_CACHE_TTL_MS = 60_000;
const MENTIONS_CACHE_MAX_ENTRIES = 256;
type MentionsCacheEntry = {
  expiresAt: number;
  graph: { mentions: Array<{ "@type": string; url: string; name?: string }>; sameAs: string[] };
};
const mentionsCache: Map<number, MentionsCacheEntry> = new Map();

interface SyntheticPageRow { host: string; path: string; title: string; }
interface ComparisonPageRow { host: string; path: string; }

function loadMentionsGraph(business: BusinessRow): { mentions: Array<{ "@type": string; url: string; name?: string }>; sameAs: string[] } {
  const now = Date.now();
  const cached = mentionsCache.get(business.id);
  if (cached && cached.expiresAt > now) return cached.graph;

  // Cold lookup. Wrap in try/catch so a DB hiccup degrades to "no graph"
  // rather than 5xx-ing the bot response.
  try {
    const db = getDb();
    const synthetic = db.prepare(
      "SELECT host, path, title FROM synthetic_pages WHERE business_id = ? AND status = 'live'",
    ).all(business.id) as SyntheticPageRow[];
    const comparison = db.prepare(
      "SELECT host, path FROM comparison_pages WHERE business_id = ? AND status = 'live'",
    ).all(business.id) as ComparisonPageRow[];

    const customerHost = (() => {
      try { return new URL(business.referral_url ?? business.website ?? "").hostname.replace(/^www\./i, ""); }
      catch { return null; }
    })();
    const graph = buildMentionsGraph(synthetic, comparison, customerHost);

    // LRU-on-write: evict oldest entry when over cap.
    if (mentionsCache.size >= MENTIONS_CACHE_MAX_ENTRIES) {
      const firstKey = mentionsCache.keys().next().value;
      if (firstKey !== undefined) mentionsCache.delete(firstKey);
    }
    mentionsCache.set(business.id, { expiresAt: now + MENTIONS_CACHE_TTL_MS, graph });
    return graph;
  } catch (_err) {
    return { mentions: [], sameAs: [] };
  }
}

/** Test-only — drops the cache so unit tests can assert fresh DB lookups. */
export function _resetMentionsCacheForTests(): void {
  mentionsCache.clear();
}

/* Render the agent's answer for a bot. Inputs come from the
 * agent endpoint after queryAgent() returns:
 *   - business: the BusinessRow (loaded for queryAgent)
 *   - result:   the AgentQueryResult (response, referral_url, etc.)
 *   - query:    the question that prompted the answer
 *   - botType:  canonical bot name (Perplexity / GPTBot / ClaudeBot / ...)
 *
 * Builds the Phase 4 mentions/sameAs graph from this business's live
 * synthetic + comparison pages and threads it into the renderer so
 * the Organization JSON-LD can splice it in. The query is bounded by
 * a 60s in-process LRU so the render hot path stays fast.
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
  const mentionsGraph = loadMentionsGraph(args.business);
  const html = renderer.render({
    business:    args.business,
    answerText:  args.result.response,
    query:       args.query,
    referralUrl: args.result.referral_url ?? args.business.website ?? "",
    mentionsGraph,
  });
  return { html, renderer_id: renderer.id };
}
