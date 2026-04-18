import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../../db.js";

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
