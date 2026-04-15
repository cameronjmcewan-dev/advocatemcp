/**
 * Competitor Radar cron handler + pure helpers.
 *
 * This file is the single entry point for P3 polling. The cron-scheduled
 * `pollAll()` will be added in a later task. For now it exports two pure
 * helpers used by seeding and the fan-out loop.
 */

import { getDb } from "../db.js";
import pLimit from "p-limit";
import { perplexitySearch } from "../lib/perplexity.js";
import { canonicalDomain, isCitationOfTenant } from "../lib/domainMatch.js";
import { sendBudgetAlert } from "../lib/alert.js";
import { TokenBucket } from "../lib/tokenBucket.js";

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

const BOT          = "perplexity";
const CONCURRENCY  = 4;
const RATE_INTERVAL_MS = 1000;

interface TenantRow { slug: string; website: string | null }
interface BasketRow { id: number; query: string }

function todayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function budgetCapUsd(): number {
  const raw = process.env.COMPETITOR_POLL_DAILY_BUDGET_USD;
  const n = raw ? Number(raw) : 10;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/**
 * Main cron entry point. Called by node-cron; also callable manually for smoke tests.
 */
export async function pollAll(): Promise<void> {
  const db = getDb();

  // 1. Budget gate.
  const cap = budgetCapUsd();
  const { spent } = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM competitor_polls WHERE polled_at >= ?`)
    .get(todayStartIso()) as { spent: number };
  if (spent >= cap) {
    console.warn(`[radar] budget_cap_hit spent=$${spent.toFixed(2)} cap=$${cap}`);
    await sendBudgetAlert(
      `[radar] daily budget cap hit ($${cap})`,
      `Today's Perplexity spend: $${spent.toFixed(2)}. Polling skipped.`,
    );
    return;
  }

  // 2. Load Pro tenants.
  const tenants = db
    .prepare(`SELECT slug, website FROM businesses WHERE plan='pro' AND api_key <> 'pending'`)
    .all() as TenantRow[];

  // 3. Seed + poll each tenant with bounded concurrency.
  const limit  = pLimit(CONCURRENCY);
  const bucket = new TokenBucket({ intervalMs: RATE_INTERVAL_MS });

  let totalPolls = 0, totalCitations = 0, totalErrors = 0, totalCost = 0;

  await Promise.all(tenants.map((t) => limit(async () => {
    seedBasketIfEmpty(t.slug);

    const basket = db
      .prepare(`SELECT id, query FROM competitor_query_baskets WHERE slug=? AND enabled=1`)
      .all(t.slug) as BasketRow[];

    const pollInsert = db.prepare(
      `INSERT INTO competitor_polls
         (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at,
          our_domain_cited, our_cited_rank, citation_count, cost_usd, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const citInsert = db.prepare(
      `INSERT INTO competitor_citations (poll_id, rank, url, domain, title) VALUES (?, ?, ?, ?, ?)`
    );
    const insertCitations = db.transaction((pollId: number, rows: { rank: number; url: string }[]) => {
      for (const c of rows) citInsert.run(pollId, c.rank, c.url, canonicalDomain(c.url), null);
    });

    for (const row of basket) {
      for (const [variantIdx, phrasing] of phrasingVariants(row.query).entries()) {
        await bucket.acquire();

        let citations: string[] = [];
        let errorMsg: string | null = null;
        let costUsd = 0;
        try {
          const r = await perplexitySearch(phrasing);
          citations = r.citations;
          costUsd   = r.costUsd;
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
          totalErrors++;
        }

        const cited      = citations.findIndex((c) => isCitationOfTenant(c, t.website));
        const citedRank  = cited >= 0 ? cited + 1 : null;
        const info = pollInsert.run(
          t.slug, row.id, BOT, phrasing, variantIdx, new Date().toISOString(),
          citedRank !== null ? 1 : 0, citedRank, citations.length, costUsd, errorMsg,
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
  })));

  console.log(`[radar] run_complete tenants=${tenants.length} polls=${totalPolls} citations=${totalCitations} errors=${totalErrors} cost=$${totalCost.toFixed(4)}`);
}
