/**
 * Comparison pages builder (Phase 4 of grey-hat AI optimization).
 *
 * Per Pro+ tenant, generate {customer}-vs-{competitor} pages on BOTH
 * customer.com/compare/... AND advocatemcp.com/compare/... for each top-3
 * competitor record that has VERIFIED facts. The strictness gate is:
 *
 *   - `competitors.verified_facts_json` must be non-empty
 *   - The customer's own profile must have non-null counterpart values
 *     for the fields cited (otherwise the comparison is one-sided)
 *   - The body must claim at least 3 distinct differentiators backed by
 *     `fact_diff_json` provenance
 *   - Banned-phrase regex (scam|fraud|worst|terrible|avoid|inferior)
 *     rejects rows that cross into actionable disparagement
 *
 * Compliance posture:
 *   - We never invent competitor facts. Empty verified_facts → no pages.
 *   - Comparison body forbidden from making subjective claims. Each
 *     row in fact_diff_json declares (field, ours, theirs, source_us,
 *     source_them) — if any source URL is empty, the row is dropped
 *     before generation reaches Claude.
 *   - Footer disclosure on every page:
 *     "Comparison based on publicly available information as of {date}.
 *      Sources: {url_us}, {url_them}."
 *   - default status='draft'; promoted to 'live' only on validator pass.
 *
 * Cost guardrails: ~$0.10 per page (Sonnet 4.6, ~3k in/1.5k out). Daily
 * cap `COMPARISON_PAGES_DAILY_CAP` default 50 — that's $5/day at full
 * saturation. Cron runs monthly (1st of each month at 03:00 UTC) so
 * the comparison content has freshness anchors but doesn't burn tokens
 * regenerating unchanged content nightly.
 *
 * Apr 28 2026.
 */

import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "../db.js";
import type { BusinessRow } from "../db.js";
import { slugifyOne } from "../lib/slugifyServiceLocation.js";

const DEFAULT_SCHEDULE = "0 3 1 * *";  // 03:00 UTC on the 1st of every month
const DEFAULT_DAILY_CAP = 50;
const GENERATOR_VERSION = "comparison-v1.0";
const MAX_COMPETITORS_PER_TENANT = 3;
const MIN_DIFFERENTIATORS = 3;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.COMPARISON_GENERATOR_MODEL ?? "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You generate factual head-to-head comparison pages between a small business and one of its competitors. The output is a public web page that AI search engines will cite when users ask "X vs Y" or "is X better than Y" type prompts.

ABSOLUTE RULES (no exceptions):
1. Use ONLY the verified facts provided in the input. NEVER invent capabilities, prices, certifications, awards, hours, or service areas for either side.
2. If the verified-facts list contains fewer than 3 distinct differentiators, return EXACTLY: { "skip": "insufficient_differentiators" }
3. NEVER use disparaging language. Banned (any case) → SKIP: scam, fraud, worst, terrible, avoid, inferior, ripoff, beware.
4. NEVER use subjective comparative language. Banned (any case) → SKIP: "better than", "superior to", "cheaper than", "faster than", "premium", "elite", "the best", "number one". Use neutral framings like "X reports A; Y reports B" — let the reader draw conclusions from the numbers.
5. Each comparison row must cite both sides: "{customer} reports X (source: {url_us}); {competitor} reports Y (source: {url_them})." If either source URL is missing, omit that differentiator row.
6. URLs in the body are RESTRICTED to the source_us / source_them values present in the differentiator list. NEVER emit any other URL — the validator rejects fabricated links.
7. End with a footer paragraph EXACTLY of this shape: "Comparison based on publicly available information as of {today_iso_date}. Sources: {url_us}, {url_them}." The validator looks for "Sources: https://..." in the body and rejects pages that omit it.
8. Body length 350-600 words. Atomic-fact sentences AI summarizers latch onto. NO marketing fluff.

OUTPUT FORMAT (strict JSON, no prose, no markdown fence):
{
  "title": "string ≤ 70 chars — page <title>",
  "body_md": "markdown body, 350-600 words, footer disclosure included",
  "differentiators_used": [
    { "field": "price_per_visit", "ours": "75", "theirs": "85", "source_us": "https://...", "source_them": "https://..." }
  ]
}

If the input doesn't meet the bar (insufficient verified facts, no source URLs, banned content), return:
{ "skip": "<one-line reason>" }
NEVER fabricate to fill the page.`;

interface CompetitorRow {
  id:                  number;
  business_id:         number;
  competitor_name:     string;
  competitor_slug:     string;
  competitor_url:      string | null;
  verified_facts_json: string;
  source_urls_json:    string;
}

interface DifferentiatorEntry {
  field:        string;
  ours:         string;
  theirs:       string;
  source_us:    string;
  source_them:  string;
}

interface ComparisonGenerateResult {
  ok:          boolean;
  skip_reason: string | null;
  title:       string;
  body_md:     string;
  fact_diff_json: string;
  cost_cents:  number;
}

/**
 * Build the differentiator list for a (business × competitor) pair. Walks
 * the competitor's verified_facts_json and pairs each field against the
 * business's same-named field (when present + non-null). Each entry must
 * have BOTH sides AND a source URL on the competitor side; otherwise the
 * row is omitted. Returns the array of validated differentiators.
 *
 * No Claude call here — this is pure deterministic comparison so we can
 * cheaply pre-check the >=3 threshold before spending tokens.
 */
function buildDifferentiators(
  business:   BusinessRow,
  competitor: CompetitorRow,
): DifferentiatorEntry[] {
  let competitorFacts: Record<string, string | number | boolean>;
  let sourceUrls: string[];
  try {
    competitorFacts = JSON.parse(competitor.verified_facts_json) as Record<string, string | number | boolean>;
    sourceUrls      = JSON.parse(competitor.source_urls_json) as string[];
  } catch {
    return [];
  }
  if (!competitorFacts || Object.keys(competitorFacts).length === 0) return [];
  if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) return [];

  // Use the FIRST source URL for the competitor side (per-fact source
  // mapping is a v1.1 follow-up — facts_source_map_json column).
  const competitorSource = sourceUrls[0]!;
  const businessSource = business.referral_url ?? business.website ?? "";
  if (!businessSource) return [];

  // Map known business fields to comparable fact keys. Conservative: only
  // include fields that are typed strings/numbers + have a stable
  // semantic meaning. Subjective fields (description, differentiator)
  // are excluded by design — those don't compare cleanly.
  const businessFields: Record<string, string | number | null | undefined> = {
    years_in_business: business.years_in_business ?? null,
    star_rating:       business.star_rating       ?? null,
    review_count:      business.review_count      ?? null,
    pricing:           business.pricing           ?? null,
    pricing_tier:      business.pricing_tier      ?? null,
    hours_json:        business.hours_json        ?? null,
    certifications:    business.certifications    ?? null,
    service_radius_miles: business.service_radius_miles ?? null,
  };

  const out: DifferentiatorEntry[] = [];
  for (const key of Object.keys(competitorFacts)) {
    const theirs = competitorFacts[key];
    const ours = businessFields[key];
    if (ours === null || ours === undefined || ours === "") continue;
    out.push({
      field:       key,
      ours:        String(ours),
      theirs:      String(theirs),
      source_us:   businessSource,
      source_them: competitorSource,
    });
  }
  return out;
}

async function generateComparisonPage(
  business:        BusinessRow,
  competitor:      CompetitorRow,
  differentiators: DifferentiatorEntry[],
): Promise<ComparisonGenerateResult> {
  const userContent = `Customer:
  - name: ${business.name}
  - location: ${business.location}
  - referral_url: ${business.referral_url ?? business.website ?? "—"}

Competitor:
  - name: ${competitor.competitor_name}
  - url: ${competitor.competitor_url ?? "—"}

Verified differentiators (already pre-validated, both sides present + sourced):
${JSON.stringify(differentiators, null, 2)}

Today: ${new Date().toISOString().slice(0, 10)}

Generate a head-to-head comparison page using ONLY the differentiators above. Body must include the footer disclosure paragraph and at least ${MIN_DIFFERENTIATORS} differentiator rows.`;

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  const raw = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/, "");

  const tokensIn  = message.usage.input_tokens;
  const tokensOut = message.usage.output_tokens;
  // Same per-token math as syntheticPagesBuilder. Sonnet 4.6 = $3/$15 per MTok.
  const costCents = tokensIn * 0.0003 + tokensOut * 0.0015;

  let parsed: { skip?: string; title?: string; body_md?: string; differentiators_used?: DifferentiatorEntry[] };
  try { parsed = JSON.parse(raw); } catch {
    return { ok: false, skip_reason: "non_json_output", title: "", body_md: "", fact_diff_json: "[]", cost_cents: costCents };
  }
  if (parsed.skip) {
    return { ok: false, skip_reason: parsed.skip, title: "", body_md: "", fact_diff_json: "[]", cost_cents: costCents };
  }
  if (!parsed.title || !parsed.body_md) {
    return { ok: false, skip_reason: "missing_fields", title: "", body_md: "", fact_diff_json: "[]", cost_cents: costCents };
  }
  // Reviewer HIGH-5: persist the deterministic pre-validated `differentiators`
  // array we passed into the prompt — not the model's echoed copy. Claude
  // could fabricate or drop fields in the round-trip; the persisted
  // provenance must match what we actually authorized as comparable.
  return {
    ok:          true,
    skip_reason: null,
    title:       parsed.title.slice(0, 70),
    body_md:     parsed.body_md,
    fact_diff_json: JSON.stringify({ differentiators }),
    cost_cents:  costCents,
  };
}

/**
 * Validate the generated body against the differentiator provenance.
 *
 * The validator is the last legal-defense layer. Each check below maps
 * to a reviewer-flagged risk:
 *   H1 — Footer must contain "Sources: https://..." disclosure.
 *   H2 — Comparison must not be one-sided slam (customer wins ≥1).
 *   H3 — sourceBlob built ONLY from differentiators, not the full
 *        business row (so unrelated business numerics like phone digits
 *        can't "validate" a fabricated competitor claim).
 *   H4 — Banned-phrase regex extends to subjective comparatives
 *        ("better than", "superior", "premium", etc.) — the actual
 *        Lanham-Act risk surface.
 *   M2 — Every "source: https://..." cited in body must appear in the
 *        differentiator list (no fabricated source URLs).
 */
function validateComparisonBody(
  body: string,
  differentiators: DifferentiatorEntry[],
): { ok: boolean; reason: string | null } {
  // H4 — banned-phrase regex (extended). Two layers:
  //   1. Outright disparaging language (Phase 3 list)
  //   2. Subjective comparative claims (Lanham-Act surface)
  if (/\b(scam|fraud|worst|terrible|avoid|inferior|ripoff|beware)\b/i.test(body)) {
    return { ok: false, reason: "banned_phrase_disparagement" };
  }
  if (/\b(better than|superior to|cheaper than|faster than|premium|elite|the best|number one)\b/i.test(body)) {
    return { ok: false, reason: "banned_phrase_subjective" };
  }

  // H1 — Footer disclosure required. Body must contain a Sources: URL
  // line so any reader (or auditor) can trace claims back to public
  // artifacts. The system prompt asks for it; this enforces it landed.
  if (!/Sources?:\s*https?:\/\//i.test(body)) {
    return { ok: false, reason: "missing_sources_footer" };
  }

  // H3 — sourceBlob restricted to differentiator-only data. Each
  // differentiator has {ours, theirs, source_us, source_them} — that's
  // the full comparable surface. Anything else in the body that cites a
  // year or dollar amount is unsourced.
  const sourceBlob = JSON.stringify(differentiators);
  const claimedYears = Array.from(body.matchAll(/\b(19|20)\d{2}\b/g)).map((m) => m[0]);
  for (const y of claimedYears) {
    if (!sourceBlob.includes(y)) {
      return { ok: false, reason: `unsourced_year:${y}` };
    }
  }
  const claimedDollars = Array.from(body.matchAll(/\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?/g)).map((m) => m[0].replace(/\s/g, ""));
  for (const d of claimedDollars) {
    const numeric = d.replace(/[$,]/g, "");
    if (!sourceBlob.includes(numeric) && !sourceBlob.includes(d)) {
      return { ok: false, reason: `unsourced_dollar:${d}` };
    }
  }

  // M2 — Every URL of the form `https://...` in the body must appear in
  // either source_us or source_them on at least one differentiator.
  // Stops Claude from emitting a footer with a fabricated link.
  const allowedUrls = new Set<string>();
  for (const d of differentiators) {
    if (d.source_us)   allowedUrls.add(d.source_us);
    if (d.source_them) allowedUrls.add(d.source_them);
  }
  const claimedUrls = Array.from(body.matchAll(/https?:\/\/[^\s)>"']+/gi)).map((m) =>
    m[0].replace(/[.,;:)\]>"']+$/, ""),  // trim trailing punctuation
  );
  for (const u of claimedUrls) {
    if (!allowedUrls.has(u)) {
      return { ok: false, reason: `unsourced_url:${u.slice(0, 80)}` };
    }
  }

  // H2 — Balance check. Reject one-sided slam pieces where the customer
  // doesn't "win" on any numeric dimension. We compare ours vs theirs
  // numerically per row when both parse as numbers; if every numeric
  // row goes to the competitor, this is a one-sided take we don't ship.
  let ourWins = 0;
  let theirWins = 0;
  for (const d of differentiators) {
    const ours = Number(String(d.ours).replace(/[^\d.-]/g, ""));
    const theirs = Number(String(d.theirs).replace(/[^\d.-]/g, ""));
    if (Number.isNaN(ours) || Number.isNaN(theirs)) continue;
    // For most fields, higher is "winning" (rating, review_count,
    // years_in_business, certifications count). Pricing fields are the
    // inverse — lower wins. The generator handles framing; here we just
    // count strict wins on either side without assuming directionality.
    if (ours !== theirs) {
      // We can't know directionality without per-field metadata. So:
      // require BOTH sides to have at least one strictly-higher numeric
      // row. That blocks the pathological case (customer numerically
      // identical or worse on every field) without making assumptions
      // about which direction "better" is.
      if (ours > theirs)   ourWins++;
      else                 theirWins++;
    }
  }
  // Only enforce when there's at least 2 numeric comparisons to draw
  // signal from. With 0-1 numeric rows, we can't tell, so allow.
  if (ourWins + theirWins >= 2 && ourWins === 0) {
    return { ok: false, reason: "one_sided_no_customer_wins" };
  }

  return { ok: true, reason: null };
}

export interface ComparisonPagesBuilderResult {
  considered:        number;
  skipped_no_facts:  number;
  rejected:          number;
  generated:         number;
  errors:            number;
  cost_cents_total:  number;
}

export async function runComparisonPagesBuilder(
  batchSize = 5,
): Promise<ComparisonPagesBuilderResult> {
  const db = getDb();
  const result: ComparisonPagesBuilderResult = {
    considered: 0, skipped_no_facts: 0, rejected: 0, generated: 0, errors: 0, cost_cents_total: 0,
  };

  const dailyCap = Number.parseInt(
    process.env.COMPARISON_PAGES_DAILY_CAP ?? String(DEFAULT_DAILY_CAP),
    10,
  );
  const todayUtcMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const todayCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM comparison_pages WHERE generated_at >= ?",
  ).get(todayUtcMs) as { n: number } | undefined)?.n ?? 0;
  if (todayCount >= dailyCap) {
    console.warn(`[comparison-pages] daily cap hit (${todayCount}/${dailyCap}); skipping run.`);
    return result;
  }

  const tenants = db.prepare(
    `SELECT * FROM businesses
       WHERE plan IN ('pro', 'enterprise')
         AND api_key <> 'pending'
       LIMIT ?`,
  ).all(batchSize) as BusinessRow[];
  result.considered = tenants.length;

  const competitorsStmt = db.prepare(
    `SELECT id, business_id, competitor_name, competitor_slug, competitor_url,
            verified_facts_json, source_urls_json
       FROM competitors
       WHERE business_id = ?
       LIMIT ?`,
  );
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO comparison_pages
       (business_id, competitor_id, host, path, body_md, schema_jsonld,
        fact_diff_json, generated_at, generator_version, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
  );
  const insertRejectedStmt = db.prepare(
    `INSERT OR IGNORE INTO comparison_pages
       (business_id, competitor_id, host, path, body_md, schema_jsonld,
        fact_diff_json, generated_at, generator_version, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected')`,
  );
  const existsStmt = db.prepare(
    "SELECT 1 FROM comparison_pages WHERE host = ? AND path = ? LIMIT 1",
  );

  for (const biz of tenants) {
    try {
      const competitors = competitorsStmt.all(biz.id, MAX_COMPETITORS_PER_TENANT) as CompetitorRow[];
      if (competitors.length === 0) continue;

      // MEDIUM-4 normalize: customer hostname stripped of leading www.
      // so requests to either www.foo.com OR foo.com resolve. The
      // worker needs the matching normalization (followup PR).
      const customerHost = (() => {
        try {
          const h = new URL(biz.referral_url ?? biz.website ?? "").hostname;
          return h.replace(/^www\./i, "");
        } catch { return null; }
      })();
      const customerSlug = slugifyOne(biz.name ?? biz.slug);

      for (const comp of competitors) {
        if (todayCount + result.generated >= dailyCap) break;

        const differentiators = buildDifferentiators(biz, comp);
        if (differentiators.length < MIN_DIFFERENTIATORS) {
          result.skipped_no_facts++;
          continue;
        }

        const path = `/compare/${customerSlug}-vs-${comp.competitor_slug}`;
        // Two pages per (biz × competitor): central directory copy +
        // customer's host copy (when their referral_url has a hostname).
        const targets: Array<{ host: string; path: string }> = [
          { host: "advocatemcp.com", path },
        ];
        if (customerHost) targets.push({ host: customerHost, path });

        for (const target of targets) {
          if (existsStmt.get(target.host, target.path)) continue;

          const out = await generateComparisonPage(biz, comp, differentiators);
          result.cost_cents_total += out.cost_cents;
          if (!out.ok) {
            result.skipped_no_facts++;
            continue;
          }

          // Validator runs against the deterministic pre-validated
          // differentiator list, NOT against the model-echoed copy
          // (HIGH-3 + HIGH-5 from reviewer). The fact_diff_json on
          // the row records the SAME deterministic list.
          const validation = validateComparisonBody(out.body_md, differentiators);
          if (!validation.ok) {
            result.rejected++;
            console.warn(`[comparison-pages] ${biz.slug} vs ${comp.competitor_slug}: rejected — ${validation.reason}`);
            insertRejectedStmt.run(
              biz.id,
              comp.id,
              target.host,
              target.path,
              out.body_md,
              "{}",
              JSON.stringify({ rejected_reason: validation.reason, fact_diff: out.fact_diff_json }),
              Date.now(),
              GENERATOR_VERSION,
            );
            continue;
          }

          const schema = {
            "@context": "https://schema.org",
            "@type":    "WebPage",
            name:        out.title,
            url:         `https://${target.host}${target.path}`,
            isPartOf:    { "@type": "WebSite", url: `https://${target.host}` },
            about: [
              { "@type": "LocalBusiness", name: biz.name, url: biz.referral_url ?? biz.website },
              { "@type": "Organization",  name: comp.competitor_name, url: comp.competitor_url },
            ],
            datePublished: new Date().toISOString(),
            dateModified:  new Date().toISOString(),
          };

          insertStmt.run(
            biz.id,
            comp.id,
            target.host,
            target.path,
            out.body_md,
            JSON.stringify(schema),
            out.fact_diff_json,
            Date.now(),
            GENERATOR_VERSION,
          );
          result.generated++;
          console.log(`[comparison-pages] ${biz.slug} ${target.host}${target.path} (${out.cost_cents.toFixed(2)}¢)`);

          if (todayCount + result.generated >= dailyCap) {
            console.warn(`[comparison-pages] daily cap hit mid-batch; stopping.`);
            break;
          }
        }
      }
    } catch (err) {
      result.errors++;
      console.error(`[comparison-pages] ${biz.slug}: error`, err);
    }
  }

  return result;
}

export function startComparisonPagesBuilderSchedule(): void {
  const flag = (process.env.FEATURE_COMPARISON_PAGES ?? "").toLowerCase();
  if (flag !== "true" && flag !== "1") {
    console.log("[comparison-pages] FEATURE_COMPARISON_PAGES disabled; cron NOT scheduled.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[comparison-pages] ANTHROPIC_API_KEY missing; cron NOT scheduled.");
    return;
  }
  const schedule = process.env.COMPARISON_PAGES_BUILDER_CRON ?? DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.warn(`[comparison-pages] invalid cron '${schedule}'; cron NOT scheduled.`);
    return;
  }
  cron.schedule(schedule, () => {
    runComparisonPagesBuilder().catch((err) => {
      console.error("[comparison-pages] cron threw:", err);
    });
  });
  console.log(`[comparison-pages] scheduled: ${schedule}`);
}
