import { Router } from "express";
import type { Request, Response } from "express";
import { requireSlugOrAdminKey, requireApiKey } from "../middleware/auth.js";
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

const KNOWN_BOTS = new Set(["perplexity", "openai"]);
/** Accept ?bot=perplexity|openai; any other value (including "all") → null (no filter). */
function parseBot(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.toLowerCase().trim();
  return KNOWN_BOTS.has(v) ? v : null;
}

/**
 * GET /api/competitor-radar/:slug/summary?days=30&bot=perplexity
 *
 * Response shape:
 *   {
 *     range_days, total_polls, cited_count, citation_rate, avg_cited_rank,
 *     top_competitor_domains[], last_polled_at,
 *     by_bot:            [{bot, total, cited, citation_rate, avg_rank}],
 *     top_descriptors:   [{descriptor, count}],
 *     bot:               "perplexity" | "openai" | null  // echo of ?bot filter
 *   }
 *
 * Top-level counts are filtered by ?bot when provided; `by_bot` always
 * breaks down every provider the tenant has polled against in the window.
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/summary",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days = parseDays(req.query.days, 30);
    const bot  = parseBot(req.query.bot);
    const since = daysAgoIso(days);
    const db = getDb();

    const biz = db.prepare("SELECT website FROM businesses WHERE slug=?")
      .get(slug) as { website: string | null } | undefined;
    if (!biz) { res.status(404).json({ error: "not_found" }); return; }
    const ownDomain = canonicalDomain(biz.website ?? "");

    // Build WHERE + bind values once; reuse across the aggregate queries so
    // the ?bot filter is applied consistently. `whereBotCp` is the
    // table-qualified variant used inside the top-competitor-domains JOIN.
    const whereBot     = bot ? " AND bot=?"    : "";
    const whereBotCp   = bot ? " AND cp.bot=?" : "";
    const bindBot      = bot ? [bot] as const  : [] as const;

    const polls = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited,
         AVG(CASE WHEN our_domain_cited=1 THEN our_cited_rank END) AS avg_rank,
         MAX(polled_at) AS last_polled_at
       FROM competitor_polls
       WHERE slug=? AND polled_at>=?${whereBot}`
    ).get(slug, since, ...bindBot) as {
      total: number; cited: number | null; avg_rank: number | null; last_polled_at: string | null;
    };

    const top = db.prepare(
      `SELECT cc.domain, COUNT(*) AS cited_count
         FROM competitor_citations cc
         JOIN competitor_polls cp ON cp.id = cc.poll_id
        WHERE cp.slug=? AND cp.polled_at>=? AND cp.our_domain_cited=0 AND cc.domain <> ?${whereBotCp}
        GROUP BY cc.domain
        ORDER BY cited_count DESC
        LIMIT 5`
    ).all(slug, since, ownDomain, ...bindBot) as { domain: string; cited_count: number }[];

    // Per-provider breakdown. Ignores ?bot — the whole point is to compare.
    const byBotRows = db.prepare(
      `SELECT
         bot,
         COUNT(*) AS total,
         SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited,
         AVG(CASE WHEN our_domain_cited=1 THEN our_cited_rank END) AS avg_rank
       FROM competitor_polls
       WHERE slug=? AND polled_at>=?
       GROUP BY bot
       ORDER BY bot ASC`
    ).all(slug, since) as { bot: string; total: number; cited: number | null; avg_rank: number | null }[];
    const by_bot = byBotRows.map((r) => ({
      bot:           r.bot,
      total:         r.total,
      cited:         r.cited ?? 0,
      citation_rate: r.total > 0 ? (r.cited ?? 0) / r.total : 0,
      avg_rank:      r.avg_rank,
    }));

    // Top sentiment descriptors across cited polls in the window. Decoded
    // in JS rather than with SQLite JSON1 to keep the build free of the
    // optional json1 dependency, which isn't guaranteed on every build.
    const descriptorRows = db.prepare(
      `SELECT sentiment_descriptors FROM competitor_polls
        WHERE slug=? AND polled_at>=? AND our_domain_cited=1 AND sentiment_descriptors IS NOT NULL${whereBot}`
    ).all(slug, since, ...bindBot) as { sentiment_descriptors: string }[];
    const descCounts = new Map<string, number>();
    for (const r of descriptorRows) {
      let arr: unknown;
      try { arr = JSON.parse(r.sentiment_descriptors); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const d of arr) {
        if (typeof d !== "string") continue;
        descCounts.set(d, (descCounts.get(d) ?? 0) + 1);
      }
    }
    const top_descriptors = [...descCounts.entries()]
      .map(([descriptor, count]) => ({ descriptor, count }))
      .sort((a, b) => (b.count - a.count) || a.descriptor.localeCompare(b.descriptor))
      .slice(0, 10);

    res.json({
      range_days: days,
      total_polls: polls.total,
      cited_count: polls.cited ?? 0,
      citation_rate: polls.total > 0 ? (polls.cited ?? 0) / polls.total : 0,
      avg_cited_rank: polls.avg_rank,
      top_competitor_domains: top,
      last_polled_at: polls.last_polled_at,
      by_bot,
      top_descriptors,
      bot,
    });
  },
);

/**
 * GET /api/competitor-radar/:slug/losses?days=7&limit=50&bot=openai
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/losses",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days  = parseDays(req.query.days, 7);
    const limit = parseLimit(req.query.limit, 50, 200);
    const bot   = parseBot(req.query.bot);
    const since = daysAgoIso(days);
    const db = getDb();

    const whereBot = bot ? " AND bot=?" : "";
    const bindBot  = bot ? [bot] as const : [] as const;

    const polls = db.prepare(
      `SELECT id, polled_at, phrasing, phrasing_variant, bot
         FROM competitor_polls
        WHERE slug=? AND polled_at>=? AND our_domain_cited=0${whereBot}
        ORDER BY polled_at DESC
        LIMIT ?`
    ).all(slug, since, ...bindBot, limit) as {
      id: number; polled_at: string; phrasing: string; phrasing_variant: number; bot: string;
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
      bot:       p.bot,
      top_citations: citationStmt.all(p.id),
    }));

    res.json({ range_days: days, bot, losses });
  },
);

const BASKET_CAP = 15;
const QUERY_MAX  = 200;

/**
 * GET /api/competitor-basket/:slug
 */
competitorRadarRouter.get(
  "/api/competitor-basket/:slug",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const db = getDb();
    const queries = db.prepare(
      `SELECT id, query, source FROM competitor_query_baskets
        WHERE slug=? AND enabled=1
        ORDER BY created_at ASC`
    ).all(slug) as { id: number; query: string; source: string }[];
    res.json({ slug, queries });
  },
);

/**
 * POST /api/competitor-basket/:slug/queries
 */
competitorRadarRouter.post(
  "/api/competitor-basket/:slug/queries",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const raw = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!raw || raw.length > QUERY_MAX) {
      res.status(400).json({ error: "query must be 1..200 chars" });
      return;
    }

    const db = getDb();
    const { count } = db.prepare(
      "SELECT COUNT(*) AS count FROM competitor_query_baskets WHERE slug=? AND enabled=1"
    ).get(slug) as { count: number };
    if (count >= BASKET_CAP) {
      res.status(400).json({ error: `basket cap reached (${BASKET_CAP} enabled queries)` });
      return;
    }

    try {
      const info = db.prepare(
        `INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
         VALUES (?, ?, 'tenant', 1, ?)`
      ).run(slug, raw, new Date().toISOString());
      res.status(201).json({ id: Number(info.lastInsertRowid), slug, query: raw, source: "tenant" });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        res.status(409).json({ error: "duplicate query for this tenant" });
        return;
      }
      throw err;
    }
  },
);

/**
 * DELETE /api/competitor-basket/:slug/queries/:id  — soft delete
 */
competitorRadarRouter.delete(
  "/api/competitor-basket/:slug/queries/:id",
  requireApiKey,
  (req: Request, res: Response) => {
    const { slug, id } = req.params;
    const numId = Number(id);
    if (!Number.isFinite(numId)) { res.status(404).json({ error: "not_found" }); return; }

    const db = getDb();
    const info = db.prepare(
      "UPDATE competitor_query_baskets SET enabled=0 WHERE id=? AND slug=? AND enabled=1"
    ).run(numId, slug);
    if (info.changes === 0) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ ok: true });
  },
);
