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
import { scoreCitationReadiness } from "../lib/citationReadiness.js";
import {
  reserve as budgetReserve,
  record as budgetRecord,
  release as budgetRelease,
} from "../middleware/budgetKillSwitch.js";

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
  search: (q: string) => Promise<{ citations: string[]; costUsd: number; answerText: string }>;
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
// IMPORTANT: this OPTIONS handler MUST be registered before the
// /audit/:id wildcard handler below, otherwise Express matches
// "/audit/citation-readiness" against the :id pattern first and
// responds with Allow-Methods: GET, OPTIONS — which fails the
// browser's CORS preflight (the actual call is POST). Found and
// fixed Apr 26 2026 after the audit page widget threw "TypeError:
// Failed to fetch" with /audit/citation-readiness preflight returning
// the wrong Allow-Methods. The matching POST handler is at the
// bottom of this file and is fine there since there's no POST
// /:id route to shadow it.
auditRouter.options("/audit/citation-readiness", (_req: Request, res: Response) => {
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
auditRouter.options("/audit/:id/follow-up", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
  /** First 240 chars of the provider's answer — diagnostic surface so
   *  a zero-citations audit can be debugged by reading what the model
   *  actually said. Not used by the audit.js UI. */
  answer_excerpt: string;
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
 * Core audit-runner. Used by the public POST /audit/run endpoint and
 * the admin batch endpoint. Handles cache lookup, rate limit, budget
 * cap, query fan-out, and persistence — returns either an audit
 * payload or a structured error.
 *
 * `skipIpRateLimit` is for admin operator paths (batch endpoint) — the
 * per-IP cap is anti-abuse for the public form, not for authenticated
 * operators running outreach. Daily budget cap STILL applies even for
 * admin so a runaway batch can't drain the API budget.
 */
export interface RunAuditOptions {
  domain:           string;
  category:         string;
  location:         string | null;
  ipHash:           string;
  skipIpRateLimit?: boolean;
}

export type RunAuditResult =
  | { ok: true;  cached: boolean; audit: ReturnType<typeof serializeAudit> & { id: string } }
  | { ok: false; status: number; error: string; meta?: Record<string, unknown> };

export async function runAudit(opts: RunAuditOptions): Promise<RunAuditResult> {
  const provider = selectAuditProvider();
  if (!provider) {
    return { ok: false, status: 503, error: "audit_unavailable", meta: { reason: "no_provider_configured" } };
  }

  const { domain, category, location, ipHash } = opts;
  const skipIpRateLimit = opts.skipIpRateLimit === true;
  const db = getDb();

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
    return { ok: true, cached: true, audit: serializeAudit(cached) };
  }

  // 2. Per-IP rate limit (skipped for admin operator paths).
  if (ipHash && !skipIpRateLimit) {
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM public_audits
          WHERE ip_hash = ? AND created_at > ?`,
      )
      .get(ipHash, cacheCutoff) as { count: number };
    if (count >= PER_IP_DAILY_CAP) {
      return {
        ok: false, status: 429, error: "ip_rate_limited",
        meta: { limit: PER_IP_DAILY_CAP, retry_after_seconds: 24 * 3600 },
      };
    }
  }

  // 3. Daily global budget cap (always enforced — admin too).
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { spent } = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM public_audits
        WHERE created_at >= ?`,
    )
    .get(todayStart.toISOString()) as { spent: number };
  if (spent >= DAILY_BUDGET_USD) {
    return { ok: false, status: 503, error: "daily_budget_exhausted", meta: { try_again: "tomorrow" } };
  }

  // 4. Generate and run queries.
  const queries = generateAutoQueries({
    category,
    location: location ?? "",
    services: [],
  }).slice(0, 5);
  if (queries.length === 0) {
    queries.push(`best ${category}`);
  }

  const queryResults = await Promise.all(queries.map(async (q): Promise<{
    result:  AuditQueryResult;
    cost:    number;
    error?:  string;
  }> => {
    try {
      const r = await provider.search(q);
      const cited = r.citations.findIndex((c) => isCitationOfTenant(c, domain));
      return {
        cost: r.costUsd,
        result: {
          query:          q,
          citations:      r.citations,
          cited:          cited >= 0,
          cited_rank:     cited >= 0 ? cited + 1 : null,
          answer_excerpt: (r.answerText ?? "").slice(0, 240),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        cost: 0, error: msg,
        result: {
          query: q, citations: [], cited: false, cited_rank: null,
          answer_excerpt: `[error: ${msg.slice(0, 220)}]`,
        },
      };
    }
  }));

  const results: AuditQueryResult[] = queryResults.map((r) => r.result);
  const totalCost: number            = queryResults.reduce((sum, r) => sum + r.cost, 0);
  const errorMsg: string | null      = queryResults.find((r) => r.error)?.error ?? null;
  const citedCount = results.filter((r) => r.cited).length;
  const auditId = crypto.randomBytes(8).toString("hex");
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO public_audits
       (id, domain, category, location, ip_hash, created_at, cost_usd,
        queries_json, cited_count, total_queries, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditId, domain, category, location, ipHash, createdAt,
    totalCost, JSON.stringify(results), citedCount, results.length, errorMsg,
  );

  return {
    ok: true, cached: false,
    audit: {
      id:            auditId,
      domain,
      category,
      location,
      created_at:    createdAt,
      cited_count:   citedCount,
      total_queries: results.length,
      queries:       results,
    },
  };
}

/**
 * POST /audit/run
 */
auditRouter.post("/audit/run", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const parsed = parseInput(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const ip = clientIp(req);
  const ipHash = ip ? hashIp(ip) : "";

  const result = await runAudit({
    domain:   parsed.domain,
    category: parsed.category,
    location: parsed.location,
    ipHash,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error, ...(result.meta ?? {}) });
    return;
  }

  res.json({ cached: result.cached, audit: result.audit });
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOLLOWUP_PER_IP_PER_DAY = 10;

/**
 * POST /audit/:id/follow-up
 *
 * Lead capture attached to an audit. The visitor opts in to a future
 * monthly re-audit by submitting their email at the bottom of the
 * results card. Stored in `audit_followups`. Idempotent: same audit +
 * same email = 200 with no new row, so reloading the page doesn't
 * inflate the count.
 *
 * Anti-abuse: a per-IP/day cap on follow-up writes prevents one bad
 * actor from filling the table. Uses the same hashed-IP scheme as
 * the audit endpoint.
 */
auditRouter.post("/audit/:id/follow-up", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const auditId = req.params.id;
  const raw     = req.body?.email;
  const email   = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }

  const db = getDb();
  const audit = db.prepare("SELECT id FROM public_audits WHERE id = ?").get(auditId) as { id: string } | undefined;
  if (!audit) {
    res.status(404).json({ error: "audit_not_found" });
    return;
  }

  const ip = clientIp(req);
  const ipHash = ip ? hashIp(ip) : "";
  if (ipHash) {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = db
      .prepare(`SELECT COUNT(*) AS count FROM audit_followups WHERE ip_hash = ? AND created_at > ?`)
      .get(ipHash, dayAgo) as { count: number };
    if (count >= FOLLOWUP_PER_IP_PER_DAY) {
      res.status(429).json({ error: "ip_rate_limited", limit: FOLLOWUP_PER_IP_PER_DAY });
      return;
    }
  }

  const info = db.prepare(
    `INSERT OR IGNORE INTO audit_followups (audit_id, email, ip_hash, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(auditId, email, ipHash, new Date().toISOString());

  res.json({ ok: true, audit_id: auditId, email, created: info.changes > 0 });
});

/**
 * POST /audit/citation-readiness
 *
 * Public, unauth, IP-rate-limited. Visitor pastes their site URL,
 * we fetch their homepage HTML server-side (SSRF-safe), run our
 * format-judge harness against it, and return the citability
 * score + signals breakdown + improvement suggestions.
 *
 * Body: { url: string }
 * Returns:
 *   { ok: true, score, would_cite, reasoning, signals_present[],
 *     signals_missing[], improvements[], cost_usd }
 *   { ok: false, reason, message, status? } on error
 *
 * Cost: ~$0.01-0.04 per call (judge call + token-priced inputs).
 * Reservation: $0.10 per call to give 2-3x headroom against pricing
 * surprises on large pages near the 500kb cap.
 *
 * Rate limits:
 *   - Per-IP: 5 per UTC day (twice the visibility-audit cap, since
 *     visitors are more likely to retry the readiness check after
 *     making site changes — we want them to come back).
 *   - Global: $25/day kill-switch (existing budget module).
 */
const READINESS_PER_IP_DAILY_CAP = 5;
const READINESS_RESERVATION_USD  = 0.10;

// NOTE: the OPTIONS preflight handler for this route is registered
// at the top of this file (alongside the other /audit/* OPTIONS
// handlers) so it wins over the /audit/:id wildcard. Don't add a
// second one here — Express would match the first by registration
// order and the second would never fire.
auditRouter.post("/audit/citation-readiness", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!rawUrl || rawUrl.length > 2000) {
    res.status(400).json({ ok: false, reason: "invalid_url", message: "Provide a `url` field (https only)." });
    return;
  }

  const ip = clientIp(req);
  const ipHash = ip ? hashIp(ip) : "";

  // Per-IP cap: count today's readiness calls from this IP. Stored in
  // the same audit_followups table is the wrong place; we need a
  // dedicated counter. Quick approach: use the existing `public_audits`
  // table's ip_hash column with a synthetic category="__readiness__"
  // marker so cap counting reuses the existing index. Cleaner long-
  // term: separate `audit_readiness_results` table (proposal in chat,
  // not built yet — needs disclosure decision).
  if (ipHash) {
    const db = getDb();
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM public_audits
          WHERE ip_hash = ? AND category = '__readiness__' AND created_at > ?`,
      )
      .get(ipHash, cutoff) as { count: number };
    if (count >= READINESS_PER_IP_DAILY_CAP) {
      res.status(429).json({
        ok: false, reason: "ip_rate_limited",
        message: `Daily limit of ${READINESS_PER_IP_DAILY_CAP} readiness checks reached for your IP. Resets in 24h.`,
        meta: { limit: READINESS_PER_IP_DAILY_CAP },
      });
      return;
    }
  }

  // Global daily kill-switch reservation. Releases on error, records
  // actual cost on success.
  const budget = budgetReserve(READINESS_RESERVATION_USD);
  if (!budget.allowed) {
    res.status(503).json({
      ok: false, reason: "budget_exhausted",
      message: `Daily AI budget exhausted ($${budget.capUsd.toFixed(2)} cap, $${budget.remainingUsd.toFixed(2)} left). Try again after UTC midnight.`,
    });
    return;
  }

  let result;
  try {
    result = await scoreCitationReadiness(rawUrl);
  } catch (err) {
    budgetRelease(READINESS_RESERVATION_USD);
    console.error("[audit/citation-readiness] unexpected:", err);
    res.status(500).json({ ok: false, reason: "internal_error", message: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!result.ok) {
    // No spend incurred when the failure was at fetch / DNS / private-IP.
    // Only spend incurred if we got far enough to call the judge.
    if (result.reason === "judge_failed") {
      budgetRecord(READINESS_RESERVATION_USD, 0.04);
    } else {
      budgetRelease(READINESS_RESERVATION_USD);
    }
    const status = result.status
      ?? (result.reason === "no_api_key" ? 503
      : result.reason === "private_address" || result.reason === "non_https" || result.reason === "invalid_url" ? 400
      : result.reason === "wrong_content_type" || result.reason === "too_large" || result.reason === "too_many_redirects" ? 422
      : result.reason === "timeout" || result.reason === "dns_lookup_failed" || result.reason === "network_error" ? 502
      : 500);
    res.status(status).json({ ok: false, reason: result.reason, message: result.message });
    return;
  }

  // Successful judge call — record the actual cost (or our best
  // estimate when input/output token counts are absent).
  budgetRecord(READINESS_RESERVATION_USD, result.cost_usd || 0.04);

  // Stamp a counter row so per-IP rate-limit lookup works on the next
  // call. Minimal data — id, ip_hash, created_at, category=__readiness__.
  // We deliberately do NOT persist the URL or score here; the disclosure
  // story is "we scored your site, no per-result retention." The data-
  // capture proposal in chat is a separate, opt-in decision.
  if (ipHash) {
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO public_audits
          (id, domain, category, location, ip_hash,
           queries_json, cited_count, total_queries, error,
           cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        "__readiness__",          // synthetic domain (not the visitor's URL)
        "__readiness__",          // marker for the per-IP counter
        null,
        ipHash,
        "[]",
        0, 0, null,
        result.cost_usd || 0.04,
        new Date().toISOString(),
      );
    } catch (err) {
      // Cap-counter write is best-effort. If it fails we still return
      // the readiness result; the cap just gets one extra slip-through.
      console.warn("[audit/citation-readiness] cap-counter write failed:", err);
    }
  }

  res.json({
    ok:               true,
    url:              result.url,
    score:            result.score,
    score_max:        10,
    would_cite:       result.would_cite,
    reasoning:        result.reasoning,
    signals_present:  result.signals_present,
    signals_missing:  result.signals_missing,
    improvements:     result.improvements,
    fetched_at:       result.fetched_at,
    byte_length:      result.byte_length,
  });
});
