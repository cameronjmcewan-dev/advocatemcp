/**
 * Competitor co-mention extractor.
 *
 * Scans a query text for any competitor names listed on the tenant's
 * businesses.competitors column (comma-separated). Returns the
 * matched competitors as a de-duplicated array so the caller can
 * persist them to queries.competitors_mentioned.
 *
 * Why deterministic regex rather than an LLM call: this runs
 * per-query on the hot-path-adjacent fire-and-forget queue and
 * needs to be cheap + predictable. Fuzzy matches ("Scrnch") will
 * be handled in a later Haiku-fallback pass if the signal is worth
 * the cost. For v1, exact word-boundary matches cover the obvious
 * cases (brand names in full) without adding Claude API load.
 *
 * Matching rules:
 *   - Case-insensitive
 *   - Word-boundary-aware so "Pro" in the tenant's list doesn't
 *     match inside "product"
 *   - Whitespace-collapsed so "Scrunch  AI" matches "Scrunch AI"
 *   - Order-preserving + dedup so the output is stable regardless
 *     of which spelling the query used first
 *
 * Empty tenant list → returns []. Empty query → returns [].
 */

import { getDb } from "../db.js";

/** Parse the stored comma-separated string into a trimmed unique array. */
export function parseCompetitorsList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const name = piece.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Escape regex special characters in a competitor name. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract competitor mentions from a query text given the tenant's
 * competitor list. Returns the canonical spellings from the list (not
 * whatever the query used) so downstream aggregation doesn't need a
 * normalization step.
 */
export function extractCompetitorMentions(
  queryText: string,
  competitorsList: string[],
): string[] {
  if (!queryText || competitorsList.length === 0) return [];
  // Collapse runs of whitespace in the query so "Scrunch    AI" matches.
  const haystack = queryText.replace(/\s+/g, " ");
  const hits: string[] = [];
  for (const canonical of competitorsList) {
    const pattern = escapeRegex(canonical).replace(/\\ /g, "\\s+");
    // Word boundaries on both sides. JS regex \b doesn't handle
    // apostrophes/hyphens inside names cleanly, so we use a manual
    // boundary: either start/end of string OR non-alphanumeric.
    const re = new RegExp(`(?:^|[^A-Za-z0-9])(${pattern})(?=$|[^A-Za-z0-9])`, "i");
    if (re.test(haystack)) hits.push(canonical);
  }
  return hits;
}

/**
 * Fire-and-forget persister. Caller supplies the just-inserted
 * queries.id and its business_slug. We load the tenant's
 * competitors list, run the extractor, and UPDATE the row. Errors
 * are logged and swallowed — competitor data is enrichment, not
 * core functionality, so a failed extraction never affects the
 * user-visible response path.
 *
 * Kill switch: DISABLE_COMPETITOR_EXTRACTOR=true matches the shape
 * of DISABLE_INTENT_CLASSIFIER / DISABLE_EMBEDDINGS for consistency.
 */
export function extractAndPersist(queryId: number, businessSlug: string, queryText: string): void {
  if (process.env.DISABLE_COMPETITOR_EXTRACTOR === "true") return;

  // Run synchronously since the extractor is pure + fast; only the
  // DB roundtrip touches I/O. Wrapped in try/catch so a DB hiccup
  // doesn't escape into the caller's event loop.
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT competitors FROM businesses WHERE slug = ?`)
      .get(businessSlug) as { competitors: string | null } | undefined;

    const list = parseCompetitorsList(row?.competitors);
    if (list.length === 0) {
      // Nothing configured — still stamp an empty array so the backfill
      // job can tell "scanned with no list" apart from "never scanned".
      db.prepare(
        `UPDATE queries SET competitors_mentioned = COALESCE(competitors_mentioned, '[]') WHERE id = ?`,
      ).run(queryId);
      return;
    }

    const hits = extractCompetitorMentions(queryText, list);
    db.prepare(
      `UPDATE queries SET competitors_mentioned = COALESCE(competitors_mentioned, ?) WHERE id = ?`,
    ).run(JSON.stringify(hits), queryId);
  } catch (err) {
    console.error(JSON.stringify({
      event: "competitor_extract_error",
      query_id: queryId,
      error: String(err instanceof Error ? err.message : err),
    }));
  }
}
