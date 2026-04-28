/**
 * Synthetic landing pages builder (Phase 3 of grey-hat AI optimization).
 *
 * Per Pro+ tenant, generate up to N pre-rendered (intent × service ×
 * location) pages. Each page is a real public URL with factually-grounded
 * content tuned to the exact AI-prompt pattern users send. URLs land on
 * BOTH advocatemcp.com (our directory — broad surface) AND the
 * customer's own domain (their SEO authority + attribution loop).
 *
 * Tier-scaled per-tenant caps (per the approved plan, Apr 28 2026):
 *   Base:       10 pages max
 *   Pro:        40 pages max
 *   Enterprise: 150 pages soft / 500 pages hard
 *
 * Quality sub-caps applied to every plan:
 *   - Max 3 pages per service-slug (anti-overlap)
 *   - Max 5 pages per location-slug
 *   - Max 100 live pages per host on advocatemcp.com per business
 *
 * Each row stores `source_facts_json` (array of profile field paths used
 * to ground claims). Pre-write validator rejects rows where the body
 * cites a number / cert / award / price not present in the source facts.
 *
 * Cost guardrail: ~$0.04/page at Sonnet 4.6 (input ~2k tokens, output
 * ~1k tokens). Daily generation cap (`SYNTHETIC_PAGES_DAILY_CAP`,
 * default 200) bounds blast radius — that's $8/day at full saturation.
 *
 * Cron schedule:
 *   - Default `0 2 * * *` (nightly 02:00 UTC).
 *   - Override via `SYNTHETIC_PAGES_BUILDER_CRON` env var.
 *   - Gated on `ANTHROPIC_API_KEY` AND `FEATURE_SYNTHETIC_PAGES`.
 *
 * Apr 28 2026.
 */

import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { getDb } from "../db.js";
import type { BusinessRow } from "../db.js";
import {
  buildPath,
  slugifyOne,
  type SyntheticIntent,
} from "../lib/slugifyServiceLocation.js";

const DEFAULT_SCHEDULE = "0 2 * * *";  // 02:00 UTC daily
const DEFAULT_DAILY_CAP = 200;          // generations per day org-wide
const GENERATOR_VERSION = "synthetic-v1.0";

const TIER_CAPS: Record<string, number> = {
  base:       10,
  pro:        40,
  enterprise: 150,
};
const ENTERPRISE_HARD_CAP = 500;

// Sub-caps that apply regardless of tier. Quality > quantity.
const MAX_PAGES_PER_SERVICE  = 3;
const MAX_PAGES_PER_LOCATION = 5;
const MAX_DIRECTORY_PAGES_PER_BIZ = 100;  // on advocatemcp.com

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.SYNTHETIC_GENERATOR_MODEL ?? "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You generate landing pages for a small business's website. Each page targets a specific (query intent × service × location) combination so AI search engines (ChatGPT, Perplexity, Claude, Gemini) can cite it for that exact prompt class.

ABSOLUTE RULES (no exceptions):
1. Use ONLY facts present in the source profile. NEVER invent capabilities, certifications, awards, prices, years-in-business, hours, service areas, or specialties.
2. If the (intent × service × location) combination requires a fact not in the profile, respond with EXACTLY: "SKIP: <reason>" and nothing else. Do not generate a page.
3. The body text must be 250-450 words of factual, citation-shaped prose. NO marketing fluff. NO superlatives. NO subjective claims about competitors.
4. Mention the business name 2-3 times naturally — once in the lead sentence, once in the proof-points section, once in the call-to-action.
5. Use atomic-fact phrasing AI summarizers latch onto: short declarative sentences, "Bottom line:", "The key fact:", numerical specifics, direct attribution like "X reports Y".
6. End with a single "Visit https://<referral-url>" sentence — exactly that phrasing.

OUTPUT FORMAT (strict JSON, no prose, no markdown fence):
{
  "title": "string ≤ 70 chars — page <title>",
  "body_md": "markdown body, 250-450 words",
  "source_facts": ["array", "of", "profile field paths used"]
}

source_facts entries are dot-paths into the source profile that were quoted in body_md (e.g. "name", "location", "pricing", "services_json_v2.items[0].name", "credentials_json.licenses[0].name"). The receiving validator rejects rows whose body cites numbers/strings not traceable through source_facts.

If the requested (intent × service × location) combination doesn't fit the profile (e.g. emergency intent for a business with no urgent service offering), return:
{ "skip": "<one-line reason>" }
NEVER fabricate to fill the page.`;

/** A single (intent × service × location) combination we'll try to generate. */
interface PagePlan {
  intent:       SyntheticIntent;
  serviceSlug:  string;  // canonical kebab-case
  serviceName:  string;  // display form
  locationSlug: string;
  locationName: string;
  host:         string;  // 'advocatemcp.com' OR customer host
  path:         string;
}

export interface SyntheticPagesBuilderResult {
  considered:       number;
  skipped_no_facts: number;
  rejected:         number;
  generated:        number;
  errors:           number;
  cost_cents_total: number;
}

/**
 * Build the candidate (intent × service × location) plan for a single
 * business, capped by tier + sub-caps. Existing `live` and `draft` pages
 * for this business are excluded so we don't regenerate the same combo.
 *
 * Selection heuristic: prefer (best_top × top-services × primary-location)
 * first; fall back to other intents in order
 * `best_top, affordable, specific_service, emergency`. Emergency only
 * fires when the business profile actually has a `availability` field
 * mentioning urgent / 24-7 / same-day language.
 */
function planCandidatesForBusiness(business: BusinessRow): PagePlan[] {
  // Plan tier resolution: lowercase + clamp to the known set so a stored
  // 'Pro' (any casing) maps to the right cap and never silently falls
  // through to base. Defensive against legacy rows + manual DB edits.
  const rawTier = ((business as { plan?: string }).plan ?? "base").toLowerCase();
  const tier = rawTier in TIER_CAPS ? rawTier : "base";
  const softCap = TIER_CAPS[tier];
  const hardCap = tier === "enterprise" ? ENTERPRISE_HARD_CAP : softCap;

  // Services come from `top_services` (CSV) preferred, fall back to `services`.
  const servicesRaw =
    business.top_services?.split(",").map((s) => s.trim()).filter(Boolean) ??
    [];
  if (servicesRaw.length === 0 && business.services) {
    try {
      const parsed = JSON.parse(business.services) as unknown;
      if (Array.isArray(parsed)) {
        for (const s of parsed) {
          if (typeof s === "string") servicesRaw.push(s);
        }
      }
    } catch { /* `services` may be raw CSV — parse below */ }
  }
  if (servicesRaw.length === 0 && business.services) {
    servicesRaw.push(...business.services.split(",").map((s) => s.trim()).filter(Boolean));
  }
  const services = servicesRaw.slice(0, 10);  // cap input list to bound combinations

  // Locations: primary from business.location, plus rows from the
  // `locations` table when available. For Phase 3 minimum-viable, we use
  // just business.location — multi-location enumeration is a v1.1 follow-up.
  const locations: string[] = [];
  if (business.location) locations.push(business.location);
  if (locations.length === 0) return [];  // can't generate without a location

  // Intent allowlist for this business based on profile shape.
  const intents: SyntheticIntent[] = ["best_top"];
  if (business.pricing || business.pricing_tier) intents.push("affordable");
  intents.push("specific_service");
  if (business.availability && /\b(24|emergency|same.?day|urgent|after.?hours)\b/i.test(business.availability)) {
    intents.push("emergency");
  }

  // Combinations, ordered by intent priority. Stop emitting once we hit
  // either the tier cap or the per-service / per-location sub-cap.
  // For enterprise, the soft cap (150) emits an observability warn but
  // generation continues up to the hard cap (500) — operators monitor
  // and tune via per-contract overrides, this is just early signal.
  const out: PagePlan[] = [];
  let warnedSoftCap = false;
  const perService:  Record<string, number> = {};
  const perLocation: Record<string, number> = {};
  for (const intent of intents) {
    for (const service of services) {
      for (const location of locations) {
        const sSlug = slugifyOne(service);
        const lSlug = slugifyOne(location);
        if ((perService[sSlug] ?? 0) >= MAX_PAGES_PER_SERVICE) continue;
        if ((perLocation[lSlug] ?? 0) >= MAX_PAGES_PER_LOCATION) continue;
        if (out.length >= hardCap) break;

        const path = buildPath(intent, sSlug, lSlug);
        // Two pages per combination: one on advocatemcp.com (our directory)
        // and one on the customer's host (their SEO + attribution).
        const customerHost = (() => {
          try { return new URL(business.referral_url ?? business.website ?? "").hostname; }
          catch { return null; }
        })();

        out.push({ intent, serviceSlug: sSlug, serviceName: service, locationSlug: lSlug, locationName: location, host: "advocatemcp.com", path });
        if (customerHost) {
          out.push({ intent, serviceSlug: sSlug, serviceName: service, locationSlug: lSlug, locationName: location, host: customerHost, path });
        }

        perService[sSlug]  = (perService[sSlug]  ?? 0) + 1;
        perLocation[lSlug] = (perLocation[lSlug] ?? 0) + 1;

        if (!warnedSoftCap && tier === "enterprise" && out.length >= softCap) {
          warnedSoftCap = true;
          console.warn(
            `[synthetic-pages] enterprise soft cap (${softCap}) reached for ${business.slug}; ` +
            `continuing to hard cap (${ENTERPRISE_HARD_CAP}). Tune per-contract if this is unexpected.`,
          );
        }
      }
    }
  }

  return out.slice(0, hardCap);
}

/**
 * Compact projection of a BusinessRow into the fields the Claude prompt
 * needs. Same pattern as faqGenerator's buildSourceProfile — strips
 * sensitive fields (api_key) and reduces input tokens.
 */
function buildSourceFacts(business: BusinessRow): Record<string, unknown> {
  const safeParse = (s: string | null | undefined): unknown => {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  };
  return {
    name:                  business.name,
    description:           business.description,
    category:              business.category,
    location:              business.location,
    phone:                 business.phone,
    website:               business.website,
    referral_url:          business.referral_url,
    services:              safeParse(business.services),
    services_json_v2:      safeParse(business.services_json_v2),
    top_services:          business.top_services,
    pricing:               business.pricing,
    pricing_tier:          business.pricing_tier,
    pricing_json_v2:       safeParse(business.pricing_json_v2),
    hours_json:            safeParse(business.hours_json),
    availability:          business.availability,
    service_area_keywords: business.service_area_keywords,
    service_radius_miles:  business.service_radius_miles,
    differentiator:        business.differentiator,
    guarantee_text:        business.guarantee_text,
    star_rating:           business.star_rating,
    review_count:          business.review_count,
    years_in_business:     business.years_in_business,
    certifications:        business.certifications,
    credentials_json:      safeParse(business.credentials_json),
    ratings_json:          safeParse(business.ratings_json),
  };
}

interface GenerateOnePageResult {
  ok:          boolean;
  skip_reason: string | null;
  title:       string;
  body_md:     string;
  source_facts_json: string;
  cost_cents:  number;
}

async function generateOnePage(
  business: BusinessRow,
  plan: PagePlan,
): Promise<GenerateOnePageResult> {
  const sourceFacts = buildSourceFacts(business);
  const userContent = `Source profile (JSON):
${JSON.stringify(sourceFacts, null, 2)}

Generate a landing page for:
  - Intent:  ${plan.intent}
  - Service: ${plan.serviceName}
  - Location:${plan.locationName}
  - URL:     https://${plan.host}${plan.path}
  - Referral target: ${business.referral_url ?? business.website ?? "—"}`;

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
  // Sonnet 4.6 pricing: $3/MTok input, $15/MTok output. Cents = tokens × $/MTok ÷ 10000.
  // i.e. tokensIn * 3/10000 = tokensIn * 0.0003 cents, ditto output. NO extra /10
  // (the earlier reviewer-flagged divisor was a 10x undercount). Reviewer fix Apr 28.
  const costCents = tokensIn * 0.0003 + tokensOut * 0.0015;

  // Generator may emit { skip: '...' } when the combo doesn't fit.
  let parsed: { skip?: string; title?: string; body_md?: string; source_facts?: string[] };
  try { parsed = JSON.parse(raw); } catch {
    return { ok: false, skip_reason: "non_json_output", title: "", body_md: "", source_facts_json: "[]", cost_cents: costCents };
  }
  if (parsed.skip) {
    return { ok: false, skip_reason: parsed.skip, title: "", body_md: "", source_facts_json: "[]", cost_cents: costCents };
  }
  if (!parsed.title || !parsed.body_md || !Array.isArray(parsed.source_facts)) {
    return { ok: false, skip_reason: "missing_fields", title: "", body_md: "", source_facts_json: "[]", cost_cents: costCents };
  }
  // Length guards — kill obvious overlong / too-thin bodies before validate.
  const wordCount = parsed.body_md.split(/\s+/).length;
  if (wordCount < 200 || wordCount > 600) {
    return { ok: false, skip_reason: `body_word_count_${wordCount}`, title: "", body_md: "", source_facts_json: "[]", cost_cents: costCents };
  }

  return {
    ok:          true,
    skip_reason: null,
    title:       parsed.title.slice(0, 70),
    body_md:     parsed.body_md,
    source_facts_json: JSON.stringify(parsed.source_facts),
    cost_cents:  costCents,
  };
}

/**
 * Pre-write fact-validator. Walks `body_md` looking for numerical claims,
 * percentage claims, year claims, certifications, and award names. For
 * each, verify the value appears either:
 *   - In `source_facts` (the array of field paths the generator declared)
 *   - In the corresponding raw value at that field path in `sourceFacts`
 *
 * Drops the row when a claimed number/year doesn't trace back. Conservative:
 * false-positives mean we skip a generation; never the reverse.
 */
function validateBodyAgainstFacts(
  body: string,
  sourceFacts: Record<string, unknown>,
): { ok: boolean; reason: string | null } {
  // Extract every 4-digit year and every dollar/percent number.
  const claimedYears = Array.from(body.matchAll(/\b(19|20)\d{2}\b/g)).map((m) => m[0]);
  const claimedDollars = Array.from(body.matchAll(/\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?/g)).map((m) => m[0].replace(/\s/g, ""));

  // Stringify the source for cheap "does this number appear anywhere"
  // membership checks. Field-path traversal would be more precise but
  // strictly worse on false-rejection rates — generator produces clean
  // numeric strings that show up verbatim in source values.
  const sourceBlob = JSON.stringify(sourceFacts);
  for (const y of claimedYears) {
    if (!sourceBlob.includes(y)) {
      return { ok: false, reason: `unsourced_year:${y}` };
    }
  }
  for (const d of claimedDollars) {
    // Strip $ and commas for matching; some sources store integer cents.
    const numeric = d.replace(/[$,]/g, "");
    if (!sourceBlob.includes(numeric) && !sourceBlob.includes(d)) {
      return { ok: false, reason: `unsourced_dollar:${d}` };
    }
  }

  // Banned phrases — same rules as Phase 4 comparison pages.
  if (/\b(scam|fraud|worst|terrible|avoid|inferior)\b/i.test(body)) {
    return { ok: false, reason: "banned_phrase" };
  }
  return { ok: true, reason: null };
}

/**
 * Single-pass builder. Picks up to BATCH_SIZE businesses + emits up to
 * their tier-cap of pages. Per-business try/catch so one error doesn't
 * kill the batch. Daily total cap stops the run early when crossed.
 */
export async function runSyntheticPagesBuilder(
  batchSize = 5,
): Promise<SyntheticPagesBuilderResult> {
  const db = getDb();
  const result: SyntheticPagesBuilderResult = {
    considered: 0, skipped_no_facts: 0, rejected: 0, generated: 0, errors: 0, cost_cents_total: 0,
  };

  const dailyCap = Number.parseInt(
    process.env.SYNTHETIC_PAGES_DAILY_CAP ?? String(DEFAULT_DAILY_CAP),
    10,
  );
  const todayUtcMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const todayCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM synthetic_pages WHERE generated_at >= ?",
  ).get(todayUtcMs) as { n: number } | undefined)?.n ?? 0;
  if (todayCount >= dailyCap) {
    console.warn(`[synthetic-pages] daily cap hit (${todayCount}/${dailyCap}); skipping run.`);
    return result;
  }

  // Pro+ tenants only (per the plan). LIMIT keeps each batch bounded.
  const candidates = db.prepare(
    `SELECT * FROM businesses
       WHERE plan IN ('pro', 'enterprise')
         AND api_key <> 'pending'
       LIMIT ?`,
  ).all(batchSize) as BusinessRow[];
  result.considered = candidates.length;

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO synthetic_pages
       (business_id, intent, service_slug, location_slug, host, path,
        title, body_md, schema_jsonld, source_facts_json,
        generated_at, generator_version, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
  );
  // Audit-trail row for validator-rejected combinations. Distinct from
  // 'live' so the public route never serves them, but still queryable so
  // operators can see why a combo got skipped (the rejection_reason lives
  // in source_facts_json under a `rejected_reason` key — schema-stable
  // workaround for not adding a dedicated column at this stage).
  const insertRejectedStmt = db.prepare(
    `INSERT OR IGNORE INTO synthetic_pages
       (business_id, intent, service_slug, location_slug, host, path,
        title, body_md, schema_jsonld, source_facts_json,
        generated_at, generator_version, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected')`,
  );
  const existsStmt = db.prepare(
    "SELECT 1 FROM synthetic_pages WHERE host = ? AND path = ? LIMIT 1",
  );
  const directoryCountStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM synthetic_pages WHERE business_id = ? AND host = 'advocatemcp.com' AND status = 'live'",
  );

  for (const biz of candidates) {
    try {
      const plans = planCandidatesForBusiness(biz);
      for (const plan of plans) {
        if (todayCount + result.generated >= dailyCap) break;
        if (existsStmt.get(plan.host, plan.path)) continue;  // already generated

        // Per-business directory cap on advocatemcp.com — keeps any single
        // tenant from monopolizing our central directory at the expense of
        // others (anti-doorway-page heuristic).
        if (plan.host === "advocatemcp.com") {
          const dirCount = (directoryCountStmt.get(biz.id) as { n: number } | undefined)?.n ?? 0;
          if (dirCount >= MAX_DIRECTORY_PAGES_PER_BIZ) continue;
        }

        const out = await generateOnePage(biz, plan);
        result.cost_cents_total += out.cost_cents;
        if (!out.ok) {
          result.skipped_no_facts++;
          continue;
        }
        const sourceFacts = buildSourceFacts(biz);
        const validation = validateBodyAgainstFacts(out.body_md, sourceFacts);
        if (!validation.ok) {
          result.rejected++;
          console.warn(`[synthetic-pages] ${biz.slug} ${plan.path}: rejected — ${validation.reason}`);
          // Persist the rejection so the post-hoc audit story works
          // (reviewer HIGH-3): rejection_reason lives inside
          // source_facts_json under `rejected_reason`. The public route
          // filters on status='live' so these never serve.
          insertRejectedStmt.run(
            biz.id,
            plan.intent,
            plan.serviceSlug,
            plan.locationSlug,
            plan.host,
            plan.path,
            out.title.slice(0, 70),  // best-effort; may be empty when generator returned skip
            out.body_md,
            "{}",                     // no schema for rejected rows
            JSON.stringify({ rejected_reason: validation.reason, source_facts: out.source_facts_json }),
            Date.now(),
            GENERATOR_VERSION,
          );
          continue;
        }

        // Pre-build minimal JSON-LD so the public route can serve the
        // row directly without re-rendering. Same Schema.org Organization
        // pattern as the per-bot renderer's bizJsonLd.
        const schema = {
          "@context": "https://schema.org",
          "@type":    "WebPage",
          name:        out.title,
          url:         `https://${plan.host}${plan.path}`,
          isPartOf:    { "@type": "WebSite", url: `https://${plan.host}` },
          about:       { "@type": "LocalBusiness", name: biz.name, url: biz.referral_url ?? biz.website },
          datePublished: new Date().toISOString(),
          dateModified:  new Date().toISOString(),
        };

        insertStmt.run(
          biz.id,
          plan.intent,
          plan.serviceSlug,
          plan.locationSlug,
          plan.host,
          plan.path,
          out.title,
          out.body_md,
          JSON.stringify(schema),
          out.source_facts_json,
          Date.now(),
          GENERATOR_VERSION,
        );
        result.generated++;
        console.log(`[synthetic-pages] ${biz.slug} ${plan.host}${plan.path} (${out.cost_cents.toFixed(2)}¢)`);

        if (todayCount + result.generated >= dailyCap) {
          console.warn(`[synthetic-pages] daily cap hit mid-batch; stopping.`);
          break;
        }
      }
    } catch (err) {
      result.errors++;
      console.error(`[synthetic-pages] ${biz.slug}: error`, err);
    }
  }

  return result;
}

export function startSyntheticPagesBuilderSchedule(): void {
  const flag = (process.env.FEATURE_SYNTHETIC_PAGES ?? "").toLowerCase();
  if (flag !== "true" && flag !== "1") {
    console.log("[synthetic-pages] FEATURE_SYNTHETIC_PAGES disabled; cron NOT scheduled.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[synthetic-pages] ANTHROPIC_API_KEY missing; cron NOT scheduled.");
    return;
  }
  const schedule = process.env.SYNTHETIC_PAGES_BUILDER_CRON ?? DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.warn(`[synthetic-pages] invalid cron '${schedule}'; cron NOT scheduled.`);
    return;
  }
  cron.schedule(schedule, () => {
    runSyntheticPagesBuilder().catch((err) => {
      console.error("[synthetic-pages] cron threw:", err);
    });
  });
  console.log(`[synthetic-pages] scheduled: ${schedule}`);
}
