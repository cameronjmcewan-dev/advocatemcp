import { Router } from "express";
import type { Request, Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { canonicalDomain } from "../lib/domainMatch.js";

export const competitorRadarRouter = Router();

function parseDays(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : fallback;
}
function parseLimit(raw: unknown, fallback: number, cap: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), cap);
}
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/**
 * GET /api/competitor-radar/:slug/summary?days=30
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/summary",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days = parseDays(req.query.days, 30);
    const since = daysAgoIso(days);
    const db = getDb();

    const biz = db.prepare("SELECT website FROM businesses WHERE slug=?")
      .get(slug) as { website: string | null } | undefined;
    if (!biz) { res.status(404).json({ error: "not_found" }); return; }
    const ownDomain = canonicalDomain(biz.website ?? "");

    const polls = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited,
         AVG(CASE WHEN our_domain_cited=1 THEN our_cited_rank END) AS avg_rank,
         MAX(polled_at) AS last_polled_at
       FROM competitor_polls
       WHERE slug=? AND polled_at>=?`
    ).get(slug, since) as {
      total: number; cited: number | null; avg_rank: number | null; last_polled_at: string | null;
    };

    const top = db.prepare(
      `SELECT cc.domain, COUNT(*) AS cited_count
         FROM competitor_citations cc
         JOIN competitor_polls cp ON cp.id = cc.poll_id
        WHERE cp.slug=? AND cp.polled_at>=? AND cp.our_domain_cited=0 AND cc.domain <> ?
        GROUP BY cc.domain
        ORDER BY cited_count DESC
        LIMIT 5`
    ).all(slug, since, ownDomain) as { domain: string; cited_count: number }[];

    res.json({
      range_days: days,
      total_polls: polls.total,
      cited_count: polls.cited ?? 0,
      citation_rate: polls.total > 0 ? (polls.cited ?? 0) / polls.total : 0,
      avg_cited_rank: polls.avg_rank,
      top_competitor_domains: top,
      last_polled_at: polls.last_polled_at,
    });
  },
);

/**
 * GET /api/competitor-radar/:slug/losses?days=7&limit=50
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/losses",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days  = parseDays(req.query.days, 7);
    const limit = parseLimit(req.query.limit, 50, 200);
    const since = daysAgoIso(days);
    const db = getDb();

    const polls = db.prepare(
      `SELECT id, polled_at, phrasing, phrasing_variant
         FROM competitor_polls
        WHERE slug=? AND polled_at>=? AND our_domain_cited=0
        ORDER BY polled_at DESC
        LIMIT ?`
    ).all(slug, since, limit) as {
      id: number; polled_at: string; phrasing: string; phrasing_variant: number;
    }[];

    const citationStmt = db.prepare(
      `SELECT rank, domain, title FROM competitor_citations
        WHERE poll_id=? ORDER BY rank ASC LIMIT 5`
    );

    const losses = polls.map((p) => ({
      poll_id:   p.id,
      polled_at: p.polled_at,
      phrasing:  p.phrasing,
      variant:   p.phrasing_variant,
      top_citations: citationStmt.all(p.id),
    }));

    res.json({ range_days: days, losses });
  },
);
