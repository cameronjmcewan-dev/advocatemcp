/**
 * Competitor Radar cron handler + pure helpers.
 *
 * This file is the single entry point for P3 polling. v1.1 extends the
 * Perplexity-only fan-out to a provider registry (Perplexity + OpenAI)
 * with independent per-provider daily budget caps and deterministic
 * sentiment-descriptor extraction on cited answers.
 */

import { getDb } from "../db.js";
import pLimit from "p-limit";
import { perplexitySearch } from "../lib/perplexity.js";
import { openaiSearch }     from "../lib/openai.js";
import { canonicalDomain, isCitationOfTenant } from "../lib/domainMatch.js";
import { sendBudgetAlert } from "../lib/alert.js";
import { TokenBucket }     from "../lib/tokenBucket.js";
import { extractSentiment } from "../lib/sentiment.js";

export interface ProfileForSeeding {
  category: string;
  location: string;
  services: string[];
}

/**
 * Produce up to 6 deterministic auto-seed queries from a tenant profile.
 * Field-missing-safe: returns [] if category or location is blank.
 */
export function generateAutoQueries(p: ProfileForSeeding): string[] {
  const cat = p.category.trim();
  const loc = p.location.trim();
  if (!cat || !loc) return [];

  const city = loc.split(",")[0]!.trim();
  const base = [
    `best ${cat} in ${loc}`,
    `top ${cat} in ${city}`,
    `${cat} near me in ${loc}`,
  ];
  const servicesRaw = Array.isArray(p.services) ? p.services : [];
  const services = servicesRaw.slice(0, 3).map((s) => s.trim()).filter(Boolean);
  for (const svc of services) base.push(`${svc} ${cat} ${loc}`);
  return base;
}

/**
 * Fan a stored query into up to 3 phrasing variants. Skips a variant if the
 * query already contains the variant's distinguishing affix (case-insensitive).
 */
export function phrasingVariants(query: string): string[] {
  const lower = query.toLowerCase();
  const out: string[] = [query];
  if (!lower.includes("reviews")) out.push(`${query} reviews`);
  if (!lower.includes("top rated") && !lower.includes("top-rated")) out.push(`top rated ${query}`);
  return out;
}

/**
 * Idempotently seed the auto-query basket for one Pro tenant. No-op if any
 * enabled row already exists (handles Base→Pro→Base→Pro re-activation).
 * Also a no-op for base-tier tenants (defense-in-depth; cron should already filter).
 *
 * Wrapped in a single better-sqlite3 transaction to eliminate the TOCTOU
 * window between COUNT and INSERT when two iterations race.
 */
export function seedBasketIfEmpty(slug: string): void {
  const db = getDb();
  const seed = db.transaction((s: string) => {
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM competitor_query_baskets WHERE slug=? AND enabled=1")
      .get(s) as { count: number };
    if (count > 0) return;

    const biz = db
      .prepare("SELECT category, location, services, plan FROM businesses WHERE slug=?")
      .get(s) as { category: string | null; location: string | null; services: string; plan: string } | undefined;
    if (!biz) return;
    if (biz.plan !== "pro") return;

    let services: string[] = [];
    try { services = JSON.parse(biz.services ?? "[]"); } catch { services = []; }

    const queries = generateAutoQueries({
      category: biz.category ?? "",
      location: biz.location ?? "",
      services,
    });

    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO competitor_query_baskets
         (slug, query, source, enabled, created_at)
       VALUES (?, ?, 'auto', 1, ?)`
    );
    for (const q of queries) insert.run(s, q, now);
  });
  seed(slug);
}

// --- Provider registry -------------------------------------------------------

type ProviderName = "perplexity" | "openai";

interface ProviderConfig {
  name:          ProviderName;
  apiKeyEnv:     string;
  budgetEnvVars: string[];   // first env var set wins; later entries are back-compat fallbacks
  defaultBudget: number;     // USD/day
}

const PROVIDERS: readonly ProviderConfig[] = [
  {
    name:          "perplexity",
    apiKeyEnv:     "PERPLEXITY_API_KEY",
    budgetEnvVars: ["PERPLEXITY_DAILY_BUDGET_USD", "COMPETITOR_POLL_DAILY_BUDGET_USD"],
    defaultBudget: 10,
  },
  {
    name:          "openai",
    apiKeyEnv:     "OPENAI_API_KEY",
    budgetEnvVars: ["OPENAI_DAILY_BUDGET_USD"],
    defaultBudget: 10,
  },
];

function providerBudget(p: ProviderConfig): number {
  for (const ev of p.budgetEnvVars) {
    const raw = process.env[ev];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return p.defaultBudget;
}

/**
 * Direct dispatch so each call goes through the imported module binding,
 * which vitest's `vi.spyOn(perplexity, "perplexitySearch")` pattern can
 * intercept. Wrapping the calls in closures captured at module-load time
 * would break that spy path.
 */
async function callProvider(
  name: ProviderName, q: string,
): Promise<{ citations: string[]; answerText: string; costUsd: number }> {
  if (name === "perplexity") return perplexitySearch(q);
  if (name === "openai")     return openaiSearch(q);
  throw new Error(`unknown provider: ${name}`);
}

// --- Cron entry point --------------------------------------------------------

const CONCURRENCY      = 4;
function rateIntervalMs(): number {
  const raw = process.env.RADAR_RATE_INTERVAL_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1000;
}

interface TenantRow { slug: string; website: string | null; name: string }
interface BasketRow { id: number; query: string }

function todayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Decide which providers can poll today: must have API key set AND be under
 * daily budget cap. Emits a single alert per provider/day on budget breach.
 */
function selectEnabledProviders(db: ReturnType<typeof getDb>): ProviderName[] {
  const since = todayStartIso();
  const rows = db
    .prepare(
      `SELECT bot, COALESCE(SUM(cost_usd), 0) AS spent
         FROM competitor_polls
        WHERE polled_at >= ?
        GROUP BY bot`,
    )
    .all(since) as { bot: string; spent: number }[];
  const spentByBot = new Map(rows.map((r) => [r.bot, r.spent]));

  const enabled: ProviderName[] = [];
  for (const p of PROVIDERS) {
    if (!process.env[p.apiKeyEnv]) continue;
    const cap   = providerBudget(p);
    const spent = spentByBot.get(p.name) ?? 0;
    if (spent >= cap) {
      console.warn(`[radar] provider_cap_hit bot=${p.name} spent=$${spent.toFixed(2)} cap=$${cap}`);
      // Alert is best-effort. A failure to email should never block polling
      // on the other provider.
      void sendBudgetAlert(
        `[radar] daily budget cap hit (${p.name}, $${cap})`,
        `Today's ${p.name} spend: $${spent.toFixed(2)}. Polling paused for ${p.name}.`,
      ).catch(() => { /* non-fatal */ });
      continue;
    }
    enabled.push(p.name);
  }
  return enabled;
}

/**
 * Main cron entry point. Called by node-cron; also callable manually for smoke tests.
 */
export async function pollAll(): Promise<void> {
  const db = getDb();

  const providers = selectEnabledProviders(db);
  if (providers.length === 0) {
    console.warn(`[radar] no_providers_enabled`);
    return;
  }

  const tenants = db
    .prepare(`SELECT slug, website, name FROM businesses WHERE plan='pro' AND api_key <> 'pending'`)
    .all() as TenantRow[];

  const limit  = pLimit(CONCURRENCY);
  const bucket = new TokenBucket({ intervalMs: rateIntervalMs() });

  let totalPolls = 0, totalCitations = 0, totalErrors = 0, totalCost = 0;

  await Promise.all(tenants.map((t) => limit(async () => {
    seedBasketIfEmpty(t.slug);

    const basket = db
      .prepare(`SELECT id, query FROM competitor_query_baskets WHERE slug=? AND enabled=1`)
      .all(t.slug) as BasketRow[];

    const pollInsert = db.prepare(
      `INSERT INTO competitor_polls
         (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at,
          our_domain_cited, our_cited_rank, citation_count, cost_usd, error,
          sentiment_descriptors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const citInsert = db.prepare(
      `INSERT INTO competitor_citations (poll_id, rank, url, domain, title) VALUES (?, ?, ?, ?, ?)`
    );
    const insertCitations = db.transaction((pollId: number, rows: { rank: number; url: string }[]) => {
      for (const c of rows) citInsert.run(pollId, c.rank, c.url, canonicalDomain(c.url), null);
    });

    for (const row of basket) {
      for (const [variantIdx, phrasing] of phrasingVariants(row.query).entries()) {
        for (const bot of providers) {
          await bucket.acquire();

          let citations:  string[] = [];
          let answerText: string   = "";
          let errorMsg:   string | null = null;
          let costUsd               = 0;
          try {
            const r = await callProvider(bot, phrasing);
            citations  = r.citations;
            answerText = r.answerText;
            costUsd    = r.costUsd;
          } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            totalErrors++;
          }

          const cited      = citations.findIndex((c) => isCitationOfTenant(c, t.website));
          const citedRank  = cited >= 0 ? cited + 1 : null;

          // Sentiment descriptors only for cited polls — nothing tenant-
          // specific to extract when they're not mentioned. Empty arrays
          // are stored as NULL to match the migration comment and keep the
          // "non-empty means extraction ran" semantic.
          //
          // If t.name is empty (data-integrity edge case: tenant name
          // accidentally cleared during onboarding or admin action),
          // fall back to t.slug so extraction still runs. Slugs are
          // typically derived from the name (e.g. "workman-copy-co"),
          // so the regex match will still hit reasonable sentence
          // boundaries. Log a structured warning so ops can detect
          // and repair the underlying data issue — silent skipping
          // was the bug. (Audit followup, Apr 26 2026.)
          let descriptorsJson: string | null = null;
          if (citedRank !== null && answerText) {
            const brandToken = t.name && t.name.trim().length > 0
              ? t.name
              : (t.slug || "").replace(/-/g, " ");
            if (!t.name || t.name.trim().length === 0) {
              console.warn(JSON.stringify({
                metric: "radar_tenant_name_missing",
                slug:   t.slug,
                using:  "slug_fallback",
                hint:   "Tenant has empty name field; sentiment extraction is using slug as fallback. Repair the businesses.name column to restore proper extraction.",
              }));
            }
            if (brandToken) {
              const descriptors = extractSentiment(answerText, brandToken);
              if (descriptors.length > 0) descriptorsJson = JSON.stringify(descriptors);
            }
          }

          const info = pollInsert.run(
            t.slug, row.id, bot, phrasing, variantIdx, new Date().toISOString(),
            citedRank !== null ? 1 : 0, citedRank, citations.length, costUsd, errorMsg,
            descriptorsJson,
          );
          const pollId = Number(info.lastInsertRowid);

          if (citations.length > 0) {
            insertCitations(pollId, citations.map((url, i) => ({ rank: i + 1, url })));
            totalCitations += citations.length;
          }

          totalPolls++;
          totalCost += costUsd;
        }
      }
    }
  })));

  console.log(
    `[radar] run_complete tenants=${tenants.length} providers=${providers.join(",")} ` +
    `polls=${totalPolls} citations=${totalCitations} errors=${totalErrors} cost=$${totalCost.toFixed(4)}`,
  );
}
