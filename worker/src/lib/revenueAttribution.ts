/**
 * First-touch attribution for verified-revenue webhooks.
 *
 * For a given (business_slug, occurred_at), look up click_events in a
 * 24h window before occurred_at. If any AI-classified click is found,
 * return {classification:'ai', source, medium, clicked_at}. Else
 * {classification:'unknown'}.
 *
 * Returns 'unknown' rather than 'human' so we never claim attribution
 * we can't prove. The frontend renders unknown rows as
 * "Source unknown" rather than counting them in either AI or Human
 * revenue totals — this is honest and matches the
 * no-fabricated-data rule in CLAUDE.md.
 *
 * Phase 4 PR 1 ships this with time-window matching only. A future PR
 * will add deterministic UTM-parameter threading (customer adds a UTM
 * to checkout, captures it in Stripe metadata, webhook payload echoes
 * it, we match deterministically). Both methods coexist; deterministic
 * wins when both produce a result.
 *
 * Reuses the existing `classifyTrafficSource` from
 * `lib/aiTrafficClassifier.ts` so the AI-domain list stays
 * single-sourced across the GA4 + revenue paths.
 *
 * click_events lives primarily on Railway (server SQLite). The D1
 * click_events mirror is populated by a follow-up sync job. If the
 * table doesn't exist yet in D1, the query throws and we gracefully
 * return 'unknown' — no events lost, attribution degrades safely.
 */

import { classifyTrafficSource } from "./aiTrafficClassifier";

const ATTRIBUTION_WINDOW_HOURS = 24;

// Bot UA names (from the worker's AI_CRAWLERS list) that represent AI search
// products — i.e., traffic that a user originated from an AI answer. Googlebot
// and GoogleOther are excluded: they're traditional crawlers, not AI search
// agents that generate referral traffic to customers.
//
// These are the canonical bot names stored in click_events.ref. They don't
// contain domain strings, so classifyTrafficSource (which matches against
// AI_DOMAINS) can't classify them. We maintain this parallel list here so
// the attribution lookup stays self-contained.
//
// Rule: if click_events.ref contains any substring below → it's an AI referral.
// lowercase compare; ref values are already canonical (set by crawlerName()).
const AI_BOT_NAME_FRAGMENTS = [
  "perplexitybot",
  "perplexity-user",
  "gptbot",
  "chatgpt-user",
  "oai-searchbot",
  "claudebot",
  "google-extended",
  "applebot-extended",
  "anthropic-ai",
  "cohere-ai",
  "meta-externalagent",
] as const;

/**
 * Classify a click_events.ref value (bot UA canonical name) as 'ai' or
 * 'unknown'. Never returns 'human'.
 *
 * Falls back to classifyTrafficSource for non-bot-name refs (e.g. a domain
 * string that somehow ended up in ref), keeping the AI_DOMAINS list
 * single-sourced.
 */
function classifyRef(ref: string): "ai" | "unknown" {
  const lower = ref.toLowerCase();
  if (AI_BOT_NAME_FRAGMENTS.some((f) => lower.includes(f))) return "ai";
  // Fallback: treat ref as a domain/source string.
  // classifyTrafficSource returns "human" for non-AI sources; map to "unknown"
  // since we still don't want to claim "human" attribution here.
  const cls = classifyTrafficSource(ref, "referral");
  return cls === "ai" ? "ai" : "unknown";
}

export interface RevenueAttribution {
  classification:         "ai" | "unknown";
  first_touch_source?:    string | null;
  first_touch_medium?:    string | null;
  first_touch_clicked_at?: string | null;
}

export async function lookupFirstTouchAttribution(
  db: D1Database,
  businessSlug: string,
  occurredAt: string,
): Promise<RevenueAttribution> {
  const occurredMs = new Date(occurredAt).getTime();
  if (isNaN(occurredMs)) {
    return { classification: "unknown" };
  }
  const windowStart = new Date(
    occurredMs - ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // click_events stores ref = bot UA name (e.g. "PerplexityBot"). The
  // schema doesn't track medium separately for the worker-D1 click_events,
  // so we infer medium="referral" for AI rows and pass ref directly as
  // source. classifyTrafficSource handles the matching.
  //
  // We only return AI matches — if no AI click exists in the window,
  // return 'unknown' (NOT 'human'). This is the no-fabricated-attribution
  // rule.
  //
  // click_events may not exist yet in D1 (mirror is a follow-up). Catch
  // the error so attribution degrades to 'unknown' rather than breaking
  // the webhook receiver.
  let rows: Array<{ ref: string | null; timestamp: string }> = [];
  try {
    const result = await db
      .prepare(
        `SELECT ref, timestamp
           FROM click_events
          WHERE business_slug = ?
            AND timestamp >= ?
            AND timestamp <= ?
          ORDER BY timestamp DESC
          LIMIT 50`,
      )
      .bind(businessSlug, windowStart, occurredAt)
      .all<{ ref: string | null; timestamp: string }>();
    rows = result.results ?? [];
  } catch {
    // Table likely doesn't exist in D1 yet — mirror is a follow-up.
    // Degrade gracefully; the event is still recorded, just unattributed.
    return { classification: "unknown" };
  }

  for (const row of rows) {
    if (!row.ref) continue;
    const cls = classifyRef(row.ref);
    if (cls === "ai") {
      return {
        classification:         "ai",
        first_touch_source:     row.ref,
        first_touch_medium:     "referral",
        first_touch_clicked_at: row.timestamp,
      };
    }
  }

  return { classification: "unknown" };
}
