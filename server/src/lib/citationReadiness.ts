/* Citation-readiness scoring for visitor-submitted URLs.
 *
 * Wraps fetchHomepage (SSRF-safe HTML fetcher) + judgeFormat (the same
 * Claude judge we use for our internal harness) to give visitors a
 * score on the same rubric we publish at /methodology.html.
 *
 * Two reasons this works as a marketing tool:
 *   1. The visitor sees their own site's score using the same prompt
 *      we publish, against the same rubric. Verifiable methodology.
 *   2. Their score implicitly positions them on the comparison
 *      distribution (homepage shows 8.5 → 3.8 spread). They see where
 *      they fall, what they're missing, what the next steps are.
 *
 * Cost: ~$0.04 per scored URL. The judge prompt + their HTML is
 * roughly 2-5k tokens input + 200 tokens output → $0.01-0.02 actual.
 * Reservation is generous to cover edge cases (huge pages near the
 * 500kb cap, repeat-evals at higher temperature, etc.).
 *
 * No persistence of the visitor's URL or scoring data here — that's
 * a separate decision (see audit_score_results table proposal).
 * This module is pure: input URL, output score + breakdown.
 */

import { fetchHomepage, type FetchHomepageError, type FetchHomepageSuccess } from "./fetchHomepage.js";
import { judgeFormat } from "../experiments/formatJudge/judges.js";

export interface CitationReadinessSuccess {
  ok:               true;
  url:              string;
  byte_length:      number;
  fetched_at:       string;
  score:            number;     // 1-10
  would_cite:       boolean;
  reasoning:        string;
  signals_present:  string[];   // heuristic — what we found in the fetched HTML
  signals_missing:  string[];   // heuristic — what's notably absent
  improvements:     Array<{ field: string; reason: string; expected_lift: number }>;
  cost_usd:         number;
}

export interface CitationReadinessError {
  ok:        false;
  reason:    FetchHomepageError["reason"] | "judge_failed" | "no_api_key";
  message:   string;
  status?:   number;
}

const JUDGE_MODEL    = "claude-sonnet-4-6";
const HTML_MAX_CHARS = 60_000;  // cap content sent to judge — saves tokens, avoids context-window edge cases

/* Strip noisy / non-content elements from HTML before sending to the
 * judge. The judge cares about extractability of the entity/business
 * facts, not about CSS or JS. Removing this noise both lowers our
 * Claude bill and improves judge accuracy (less for it to summarize). */
function stripNoise(html: string): string {
  return html
    // Strip script/style/noscript blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    // Strip HTML comments (often vendor cruft, build hashes)
    .replace(/<!--[\s\S]*?-->/g, "")
    // Collapse runs of whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/* Detect signals present in the HTML. Used to populate the
 * "what you have" / "what's missing" lists shown to the visitor. This
 * is heuristic (regex-based) — the judge's reasoning is the source
 * of truth for the score, but visitors find the signal-checklist UX
 * more actionable than a paragraph of judge prose. */
function detectSignals(html: string): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  const checks: Array<{ name: string; positive: RegExp }> = [
    { name: "Schema.org JSON-LD",                positive: /application\/ld\+json/i },
    { name: "LocalBusiness or Organization schema", positive: /"@type"\s*:\s*"(LocalBusiness|Organization|ProfessionalService|Restaurant|Dentist|MedicalBusiness|HomeAndConstructionBusiness|LegalService)"/ },
    { name: "AggregateRating",                   positive: /"@type"\s*:\s*"AggregateRating"|"aggregateRating"\s*:/ },
    { name: "FAQPage schema",                    positive: /"@type"\s*:\s*"FAQPage"|"@type"\s*:\s*"Question"/ },
    { name: "Service or Offer schema",           positive: /"@type"\s*:\s*"(Service|Offer|OfferCatalog)"/ },
    { name: "OpeningHoursSpecification",         positive: /"@type"\s*:\s*"OpeningHoursSpecification"|"openingHours"\s*:/ },
    { name: "Review schema",                     positive: /"@type"\s*:\s*"Review"|"reviewBody"\s*:/ },
    { name: "sameAs links to third-party profiles", positive: /"sameAs"\s*:\s*\[/ },
    { name: "Speakable annotation",              positive: /"@type"\s*:\s*"SpeakableSpecification"|"speakable"\s*:/ },
    { name: "Open Graph metadata",               positive: /<meta[^>]+property=["']og:(title|description|type)["']/i },
    { name: "Phone number prominently in HTML",  positive: /tel:|"telephone"\s*:/ },
    { name: "Address (street + city)",           positive: /"streetAddress"\s*:|"addressLocality"\s*:/ },
  ];
  for (const c of checks) {
    if (c.positive.test(html)) present.push(c.name);
    else missing.push(c.name);
  }
  return { present, missing };
}

/* Map common judge reasoning phrases to actionable improvement
 * suggestions. Each improvement carries an expected_lift so the
 * UI can rank them. Lifts are rough heuristics derived from harness
 * iteration data (we know +1 for adding ratings, +0.5 for FAQ, etc.). */
function buildImprovements(
  reasoning: string,
  missing: string[],
): Array<{ field: string; reason: string; expected_lift: number }> {
  const out: Array<{ field: string; reason: string; expected_lift: number }> = [];
  const lower = reasoning.toLowerCase();

  // Hand-tuned mapping. Each row: detector → improvement to suggest.
  if (missing.includes("AggregateRating") || /aggregat[ei] rating|missing.*ratings?|no review schema/i.test(reasoning)) {
    out.push({
      field: "ratings_json",
      reason: "Add verified third-party ratings (Google, Yelp, Facebook) so AI engines can cite an AggregateRating block.",
      expected_lift: 1.5,
    });
  }
  if (missing.includes("FAQPage schema") || /no faq schema|missing.*faq/i.test(reasoning)) {
    out.push({
      field: "faq_schema",
      reason: "Add FAQ schema for the top intent queries in your category — AI engines preferentially cite Q&A blocks over prose.",
      expected_lift: 1.0,
    });
  }
  if (missing.includes("Service or Offer schema") || /no service.*schema|generic.*services|service inventory/i.test(reasoning)) {
    out.push({
      field: "services",
      reason: "Mark up your services with Service or Offer schema (not just bullet points). Each service becomes its own citable entity.",
      expected_lift: 0.8,
    });
  }
  if (missing.includes("Schema.org JSON-LD") || /no json-ld|missing.*structured data/i.test(reasoning)) {
    out.push({
      field: "_structured_data",
      reason: "Add a basic LocalBusiness JSON-LD block to your homepage. This is the single largest deduction across our harness.",
      expected_lift: 2.0,
    });
  }
  if (/marketing|hype|world.class|amazing|best.in.class/i.test(reasoning)) {
    out.push({
      field: "differentiator",
      reason: "Replace marketing language with specific, citable facts (years in business, license number, certifications, capacity).",
      expected_lift: 0.5,
    });
  }
  if (lower.includes("speakable") && missing.includes("Speakable annotation")) {
    out.push({
      field: "speakable",
      reason: "Add Speakable annotations to the contact + hours blocks. Helps voice-AI engines cite cleanly.",
      expected_lift: 0.3,
    });
  }
  if (out.length === 0) {
    // Fallback: surface the highest-impact missing item even if the
    // judge didn't flag it explicitly.
    if (missing.length > 0) {
      out.push({
        field: "_general",
        reason: `Add ${missing[0]} — judge didn't call this out specifically but it's the biggest gap relative to peers.`,
        expected_lift: 0.5,
      });
    }
  }
  return out.slice(0, 4);
}

/* Synthesize a sensible default query for an arbitrary visitor URL.
 * The judge needs a query (it's scoring "would AI cite this for THIS
 * question") and the visitor doesn't tell us their category. We pick
 * a generic "tell me about" query that probes general extractability.
 * If the visitor already provided a category via the existing audit
 * flow, the caller can override this. */
function defaultQueryForUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return `Tell me about ${host} — what do they offer and how would I get in touch?`;
  } catch {
    return `Tell me about this business and how I would get in touch.`;
  }
}

export async function scoreCitationReadiness(
  rawUrl: string,
  optional?: { queryOverride?: string },
): Promise<CitationReadinessSuccess | CitationReadinessError> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: "no_api_key", message: "Anthropic API key not configured." };
  }

  const fetched = await fetchHomepage(rawUrl);
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason, message: fetched.message, status: fetched.status };
  }

  const stripped = stripNoise(fetched.html);
  const truncated = stripped.length > HTML_MAX_CHARS
    ? stripped.slice(0, HTML_MAX_CHARS) + "\n\n[content truncated for length]"
    : stripped;

  const signals = detectSignals(fetched.html);
  const query   = optional?.queryOverride ?? defaultQueryForUrl(fetched.url);

  let trial;
  try {
    trial = await judgeFormat({
      judgeModel:    JUDGE_MODEL,
      query,
      rendered:      truncated,
      variantId:     "visitor_audit",
      businessSlug:  new URL(fetched.url).hostname,
    });
  } catch (err) {
    return {
      ok: false, reason: "judge_failed",
      message: `Judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const improvements = buildImprovements(trial.reasoning ?? "", signals.missing);

  return {
    ok:               true,
    url:              fetched.url,
    byte_length:      fetched.byte_length,
    fetched_at:       fetched.fetched_at,
    score:            trial.citability_score,
    would_cite:       trial.would_cite,
    reasoning:        trial.reasoning,
    signals_present:  signals.present,
    signals_missing:  signals.missing,
    improvements,
    // Sonnet pricing: $3/Mtok input, $15/Mtok output (Apr 2026).
    // Mirrors the SONNET_*_PER_TOK constants in judges.ts.
    cost_usd:         trial.input_tokens * (3 / 1_000_000) + trial.output_tokens * (15 / 1_000_000),
  };
}
