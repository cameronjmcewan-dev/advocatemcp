/**
 * Public GEO Audit — acquisition funnel endpoint.
 *
 * Anyone can POST a domain + category and get a citation report against
 * Perplexity for category-level queries. Free, no signup, rate-limited
 * and budget-capped at the server level so one bad actor can't drain
 * the API budget.
 *
 * Design choices:
 *
 *   - Perplexity only (not OpenAI) — 6x cheaper, enough signal for a
 *     first-impression audit. Upgrading to multi-provider is a Pro-tier
 *     feature, not a free-funnel feature.
 *   - 5 queries per audit, fixed templates (same generator used by the
 *     Competitor Radar). Cost: ~$0.025/audit.
 *   - 24h cache keyed on (domain, category, location). Reloading the
 *     results page or running the same audit twice reuses the prior
 *     result.
 *   - Per-IP rate limit: 3 audits per 24h. Casual abuse cap without
 *     requiring CAPTCHA.
 *   - Daily global budget cap: $5. At $0.025/audit that's 200 audits/
 *     day — plenty for early traffic and a hard ceiling on cost.
 *   - Fails-closed on missing PERPLEXITY_API_KEY. Don't accept audits
 *     we can't fulfill.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import { getDb } from "../db.js";
import { perplexitySearch } from "../lib/perplexity.js";
import { openaiSearch }     from "../lib/openai.js";
import { canonicalDomain, isCitationOfTenant } from "../lib/domainMatch.js";
import { generateAutoQueries } from "../jobs/competitorRadar.js";

/**
 * Audit provider abstraction. Perplexity first (~$0.005/call), OpenAI
 * fallback (~$0.03/call, 6× more expensive) when only the OpenAI key
 * is configured. Both return `citations[]` + `costUsd` so the caller
 * is provider-agnostic.
 *
 * Fails closed: if NEITHER key is set, the endpoint refuses the audit.
 */
interface AuditProvider {
  name:   "perplexity" | "openai";
  search: (q: string) => Promise<{ citations: string[]; costUsd: number }>;
}

function selectAuditProvider(): AuditProvider | null {
  if (process.env.PERPLEXITY_API_KEY) {
    return { name: "perplexity", search: perplexitySearch };
  }
  if (process.env.OPENAI_API_KEY) {
    return { name: "openai", search: openaiSearch };
  }
  return null;
}

export const auditRouter = Router();

/**
 * Open-CORS preflight for both endpoints. The audit page lives on
 * advocatemcp.com (Cloudflare Pages) and POSTs cross-origin to
 * api.advocatemcp.com/audit/run — different subdomains, different
 * browser origins. The audit endpoint is designed to be publicly
 * callable by anyone, so `*` is the right ACAO value. Never sends
 * credentials; no cookies to protect.
 */
auditRouter.options("/audit/run", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age",       "600");
  res.status(204).end();
});
auditRouter.options("/audit/:id", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age",       "600");
  res.status(204).end();
});

const PER_IP_DAILY_CAP  = 3;
const DAILY_BUDGET_USD  = 5;
const CACHE_TTL_HOURS   = 24;

function hashIp(ip: string): string {
  const salt = process.env.AUDIT_IP_SALT ?? "dev-audit-ip-salt";
  return crypto.createHash("sha256").update(`${ip}|${salt}`).digest("hex");
}

function clientIp(req: Request): string {
  const h = req.header("cf-connecting-ip")
    ?? req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.ip
    ?? "";
  return h;
}

interface AuditQueryResult {
  query: string;
  citations: string[];
  cited: boolean;
  cited_rank: number | null;
}

interface StoredAudit {
  id:            string;
  domain:        string;
  category:      string;
  location:      string | null;
  created_at:    string;
  cited_count:   number;
  total_queries: number;
  queries_json:  string;
}

function parseInput(body: unknown): { domain: string; category: string; location: string | null } | { error: string } {
  if (!body || typeof body !== "object") return { error: "missing_body" };
  const b = body as Record<string, unknown>;

  const rawDomain = typeof b.domain === "string" ? b.domain.trim() : "";
  const domain = canonicalDomain(rawDomain);
  if (!domain)                     return { error: "invalid_domain" };
  if (domain.length > 253)         return { error: "domain_too_long" };

  const category = typeof b.category === "string" ? b.category.trim() : "";
  if (!category || category.length > 80) return { error: "invalid_category" };

  const location = typeof b.location === "string" && b.location.trim()
    ? b.location.trim().slice(0, 120)
    : null;

  return { domain, category, location };
}

/**
 * POST /audit/run
 */
auditRouter.post("/audit/run", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const provider = selectAuditProvider();
  if (!provider) {
    res.status(503).json({ error: "audit_unavailable", reason: "no_provider_configured" });
    return;
  }

  const parsed = parseInput(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { domain, category, location } = parsed;

  const db = getDb();
  const ip = clientIp(req);
  const ipHash = ip ? hashIp(ip) : "";

  // 1. Cache check. Same (domain, category, location) within the TTL
  //    returns the prior audit unchanged.
  const cacheCutoff = new Date(Date.now() - CACHE_TTL_HOURS * 3600 * 1000).toISOString();
  const cached = db
    .prepare(
      `SELECT id, domain, category, location, created_at, cited_count, total_queries, queries_json
         FROM public_audits
        WHERE domain = ? AND category = ?
          AND ((? IS NULL AND location IS NULL) OR location = ?)
          AND error IS NULL
          AND created_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(domain, category, location, location, cacheCutoff) as StoredAudit | undefined;
  if (cached) {
    res.json({ cached: true, audit: serializeAudit(cached) });
    return;
  }

  // 2. Per-IP rate limit.
  if (ipHash) {
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM public_audits
          WHERE ip_hash = ? AND created_at > ?`,
      )
      .get(ipHash, cacheCutoff) as { count: number };
    if (count >= PER_IP_DAILY_CAP) {
      res.status(429).json({
        error:               "ip_rate_limited",
        limit:               PER_IP_DAILY_CAP,
        retry_after_seconds: 24 * 3600,
      });
      return;
    }
  }

  // 3. Daily global budget cap.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { spent } = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM public_audits
        WHERE created_at >= ?`,
    )
    .get(todayStart.toISOString()) as { spent: number };
  if (spent >= DAILY_BUDGET_USD) {
    res.status(503).json({
      error:      "daily_budget_exhausted",
      try_again: "tomorrow",
    });
    return;
  }

  // 4. Generate and run queries.
  const queries = generateAutoQueries({
    category,
    location: location ?? "",
    services: [],
  }).slice(0, 5);
  if (queries.length === 0) {
    // generateAutoQueries returns [] when location is blank. Fall back to a
    // category-only query so the audit still runs, even if weaker.
    queries.push(`best ${category}`);
  }

  let totalCost = 0;
  const results: AuditQueryResult[] = [];
  let errorMsg: string | null = null;

  for (const q of queries) {
    try {
      const r = await provider.search(q);
      totalCost += r.costUsd;
      const cited = r.citations.findIndex((c) => isCitationOfTenant(c, domain));
      results.push({
        query:      q,
        citations:  r.citations,
        cited:      cited >= 0,
        cited_rank: cited >= 0 ? cited + 1 : null,
      });
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      // Don't abort the batch — record the failure for this query and
      // continue so the audit reflects partial results.
      results.push({ query: q, citations: [], cited: false, cited_rank: null });
    }
  }

  const citedCount = results.filter((r) => r.cited).length;
  const auditId = crypto.randomBytes(8).toString("hex");

  db.prepare(
    `INSERT INTO public_audits
       (id, domain, category, location, ip_hash, created_at, cost_usd,
        queries_json, cited_count, total_queries, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditId, domain, category, location, ipHash, new Date().toISOString(),
    totalCost, JSON.stringify(results), citedCount, results.length, errorMsg,
  );

  res.json({
    cached: false,
    audit: {
      id:            auditId,
      domain,
      category,
      location,
      created_at:    new Date().toISOString(),
      cited_count:   citedCount,
      total_queries: results.length,
      queries:       results,
    },
  });
});

/**
 * GET /audit/:id — retrieve a previously-run audit for sharing.
 */
auditRouter.get("/audit/:id", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, domain, category, location, created_at, cited_count, total_queries, queries_json
         FROM public_audits WHERE id = ?`,
    )
    .get(req.params.id) as StoredAudit | undefined;
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ cached: true, audit: serializeAudit(row) });
});

function serializeAudit(row: StoredAudit) {
  let queries: AuditQueryResult[] = [];
  try { queries = JSON.parse(row.queries_json) as AuditQueryResult[]; } catch { /* ignore */ }
  return {
    id:            row.id,
    domain:        row.domain,
    category:      row.category,
    location:      row.location,
    created_at:    row.created_at,
    cited_count:   row.cited_count,
    total_queries: row.total_queries,
    queries,
  };
}
