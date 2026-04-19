import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../../db.js";
import { canonicalDomain } from "../../lib/domainMatch.js";

export const adminAuditsRouter = Router();

/**
 * GET /admin/audits
 *
 * Operator dashboard for the GEO audit funnel. Lists recent public
 * audits with their citation outcome and any captured follow-up email,
 * so the operator can run outreach against "ran the audit, got a low
 * score, gave us their email" — the strongest pre-onboarding signal
 * the funnel produces.
 *
 * Bearer auth is enforced by `routes/admin/index.ts` one level up.
 *
 * Query params:
 *   ?days=7              window (default 30, max 365)
 *   ?cited=0             only audits where cited_count == 0 (hottest leads)
 *   ?has_email=1         only audits with at least one follow-up email
 *   ?limit=50            page size (default 100, max 500)
 *
 * Response shape:
 *   {
 *     range_days, total, results: [
 *       { id, domain, category, location, created_at, cited_count,
 *         total_queries, citation_rate, emails: [{email, created_at}] }
 *     ]
 *   }
 */

interface AuditRow {
  id:            string;
  domain:        string;
  category:      string;
  location:      string | null;
  created_at:    string;
  cited_count:   number;
  total_queries: number;
  cost_usd:      number;
  error:         string | null;
}

interface FollowupRow {
  audit_id:   string;
  email:      string;
  created_at: string;
}

function parseInt32(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

adminAuditsRouter.get("/audits", (req: Request, res: Response) => {
  const days  = parseInt32(req.query.days,  30, 365);
  const limit = parseInt32(req.query.limit, 100, 500);
  const cited0    = req.query.cited === "0";
  const hasEmail  = req.query.has_email === "1";

  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const db = getDb();

  // Filter clauses are composed inline (all values are validated above
  // — never user input directly). The "has email" filter joins
  // audit_followups to require at least one follow-up row per audit.
  let where = "created_at > ?";
  const binds: (string | number)[] = [since];
  if (cited0) {
    where += " AND cited_count = 0";
  }
  let sql = `
    SELECT id, domain, category, location, created_at, cited_count,
           total_queries, cost_usd, error
      FROM public_audits
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ?
  `;
  binds.push(limit);
  let rows = db.prepare(sql).all(...binds) as AuditRow[];

  // Pull follow-up emails for the surfaced audit ids in one query —
  // avoids N+1 even when limit is at the cap.
  let emailsByAudit = new Map<string, FollowupRow[]>();
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const fRows = db
      .prepare(
        `SELECT audit_id, email, created_at FROM audit_followups
          WHERE audit_id IN (${placeholders})
            AND unsubscribed_at IS NULL
          ORDER BY created_at DESC`,
      )
      .all(...rows.map((r) => r.id)) as FollowupRow[];
    for (const fr of fRows) {
      const list = emailsByAudit.get(fr.audit_id) ?? [];
      list.push(fr);
      emailsByAudit.set(fr.audit_id, list);
    }
  }

  if (hasEmail) {
    rows = rows.filter((r) => emailsByAudit.has(r.id));
  }

  const results = rows.map((r) => ({
    id:            r.id,
    domain:        r.domain,
    category:      r.category,
    location:      r.location,
    created_at:    r.created_at,
    cited_count:   r.cited_count,
    total_queries: r.total_queries,
    citation_rate: r.total_queries > 0 ? r.cited_count / r.total_queries : 0,
    cost_usd:      r.cost_usd,
    error:         r.error,
    share_url:     `https://advocatemcp.com/r/${r.id}`,
    emails:        (emailsByAudit.get(r.id) ?? []).map((e) => ({
      email: e.email, captured_at: e.created_at,
    })),
  }));

  res.json({
    range_days: days,
    filters:    { cited: cited0 ? 0 : null, has_email: hasEmail || null },
    total:      results.length,
    results,
  });
});

/**
 * GET /admin/audits/analytics
 *
 * Aggregate health signals for the audit funnel over the last N days.
 * Operator dashboard — answer "is the funnel working?" in one request
 * without eyeballing individual audit rows.
 *
 * Query params:
 *   ?days=N   window (default 30, max 365)
 *
 * Response shape:
 *   {
 *     range_days,
 *     total_audits,
 *     total_cost_usd,
 *     by_cited_bucket:    { zero, partial, all },
 *     email_capture_rate,
 *     total_followup_emails,
 *     by_day:             [{ date, count, avg_citation_rate }],
 *     top_categories:     [{ category, count }],
 *     top_competitor_domains_across_audits: [{ domain, appears_in }],
 *   }
 */
adminAuditsRouter.get("/audits/analytics", (req: Request, res: Response) => {
  const days  = parseInt32(req.query.days, 30, 365);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const db = getDb();

  // Headline counts.
  const totals = db.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(cost_usd), 0) AS cost,
       COALESCE(SUM(CASE WHEN cited_count = 0                         THEN 1 ELSE 0 END), 0) AS zero_bucket,
       COALESCE(SUM(CASE WHEN cited_count > 0 AND cited_count < total_queries THEN 1 ELSE 0 END), 0) AS partial_bucket,
       COALESCE(SUM(CASE WHEN cited_count > 0 AND cited_count = total_queries THEN 1 ELSE 0 END), 0) AS all_bucket
     FROM public_audits
     WHERE created_at > ?`,
  ).get(since) as {
    total: number; cost: number;
    zero_bucket: number; partial_bucket: number; all_bucket: number;
  };

  // Email capture rate — audits that have at least one follow-up email.
  const { captured } = db.prepare(
    `SELECT COUNT(DISTINCT f.audit_id) AS captured
       FROM audit_followups f
       JOIN public_audits a ON a.id = f.audit_id
      WHERE a.created_at > ? AND f.unsubscribed_at IS NULL`,
  ).get(since) as { captured: number };

  const { total_emails } = db.prepare(
    `SELECT COUNT(*) AS total_emails
       FROM audit_followups f
       JOIN public_audits a ON a.id = f.audit_id
      WHERE a.created_at > ? AND f.unsubscribed_at IS NULL`,
  ).get(since) as { total_emails: number };

  // Daily buckets — useful for a sparkline chart later.
  const byDayRows = db.prepare(
    `SELECT substr(created_at, 1, 10) AS date,
            COUNT(*) AS count,
            AVG(CASE WHEN total_queries > 0
                     THEN CAST(cited_count AS REAL) / total_queries
                     ELSE 0 END) AS avg_citation_rate
       FROM public_audits
      WHERE created_at > ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY date ASC`,
  ).all(since) as { date: string; count: number; avg_citation_rate: number }[];

  // Top categories by audit count.
  const topCategories = db.prepare(
    `SELECT category, COUNT(*) AS count FROM public_audits
      WHERE created_at > ?
      GROUP BY category
      ORDER BY count DESC, category ASC
      LIMIT 10`,
  ).all(since) as { category: string; count: number }[];

  // Top competitor domains across every audit in the window. Parses
  // queries_json in JS because SQLite JSON1 isn't guaranteed on every
  // build — same pattern as the competitor radar summary endpoint.
  const queriesRows = db.prepare(
    `SELECT id, domain, queries_json FROM public_audits
      WHERE created_at > ? AND queries_json IS NOT NULL`,
  ).all(since) as { id: string; domain: string; queries_json: string }[];

  const competitorCounts = new Map<string, Set<string>>();
  for (const r of queriesRows) {
    let parsed: unknown;
    try { parsed = JSON.parse(r.queries_json); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    const ownDomain = canonicalDomain(r.domain);
    const auditDomainsSeen = new Set<string>();
    for (const q of parsed) {
      if (!q || typeof q !== "object") continue;
      const citations = (q as { citations?: unknown }).citations;
      if (!Array.isArray(citations)) continue;
      for (const c of citations) {
        if (typeof c !== "string") continue;
        const dom = canonicalDomain(c);
        if (!dom || dom === ownDomain) continue;
        // Skip Google Maps "search shim" URLs — same as the frontend leaderboard.
        if (dom === "google.com" && /maps\/search\//i.test(c)) continue;
        auditDomainsSeen.add(dom);
      }
    }
    for (const dom of auditDomainsSeen) {
      const set = competitorCounts.get(dom) ?? new Set<string>();
      set.add(r.id);
      competitorCounts.set(dom, set);
    }
  }
  const topCompetitorDomains = [...competitorCounts.entries()]
    .map(([domain, auditIds]) => ({ domain, appears_in: auditIds.size }))
    .sort((a, b) => b.appears_in - a.appears_in || a.domain.localeCompare(b.domain))
    .slice(0, 10);

  res.json({
    range_days: days,
    total_audits: totals.total,
    total_cost_usd: Number(totals.cost.toFixed(4)),
    by_cited_bucket: {
      zero:    totals.zero_bucket,
      partial: totals.partial_bucket,
      all:     totals.all_bucket,
    },
    email_capture_rate: totals.total > 0 ? captured / totals.total : 0,
    total_followup_emails: total_emails,
    by_day: byDayRows,
    top_categories: topCategories,
    top_competitor_domains_across_audits: topCompetitorDomains,
  });
});
