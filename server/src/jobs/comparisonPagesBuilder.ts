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
import {
  buildDifferentiators,
  validateComparisonBody,
  type CompetitorRow,
  type DifferentiatorEntry,
} from "./comparisonValidator.js";

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
4. NEVER use subjective comparative language. Banned phrasings: "better than", "superior to", "cheaper than", "faster than", "more reliable/trustworthy/professional than", "number one", "unmatched", "unbeatable", "second to none". Use neutral framings like "X reports A; Y reports B" — let the reader draw conclusions from the numbers. Bare adjectives like "premium" or "elite" are allowed when they describe a tier name or certification (e.g. "premium plan", "ASE Elite Certified") — but not as comparative claims.
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

interface ComparisonGenerateResult {
  ok:          boolean;
  skip_reason: string | null;
  title:       string;
  body_md:     string;
  fact_diff_json: string;
  cost_cents:  number;
}

// `buildDifferentiators` + `validateComparisonBody` + their types live in
// `./comparisonValidator` so the compliance logic is pure-function unit
// testable (review fix-1: behavioral tests, not snapshot-greps).

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
